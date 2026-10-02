package main

import (
	"context"
	"crypto/elliptic"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// Opt-in subscriptions and pending deliveries live in a private durable store.
// Replayed completions never enqueue twice; realtime mode isolates this store
// from the optional reading replica.
const pushSchema = `
CREATE TABLE IF NOT EXISTS push_device_owners(device_id TEXT PRIMARY KEY,recipient TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS push_devices(scope TEXT,device_id TEXT,subscription BLOB NOT NULL,enabled INTEGER NOT NULL,enabled_at INTEGER NOT NULL,last_received_at INTEGER NOT NULL DEFAULT 0,last_received_job TEXT NOT NULL DEFAULT '',last_failure TEXT NOT NULL DEFAULT '',last_test_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope,device_id));
CREATE TABLE IF NOT EXISTS push_completion_content(scope TEXT,thread_id TEXT,turn_id TEXT,title TEXT NOT NULL,summary TEXT NOT NULL,PRIMARY KEY(scope,thread_id,turn_id));
CREATE TABLE IF NOT EXISTS push_completions(scope TEXT,thread_id TEXT,turn_id TEXT,observed_at INTEGER NOT NULL,PRIMARY KEY(scope,thread_id,turn_id));
CREATE TABLE IF NOT EXISTS push_jobs(id TEXT PRIMARY KEY,scope TEXT,device_id TEXT,thread_id TEXT,turn_id TEXT,receipt TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,created_at INTEGER NOT NULL,last_http INTEGER NOT NULL DEFAULT 0,UNIQUE(scope,device_id,thread_id,turn_id));
CREATE INDEX IF NOT EXISTS push_jobs_pending ON push_jobs(state,next_at);`

type vapidKeys struct {
	Public  string `json:"public"`
	Private string `json:"private"`
}
type PushService struct {
	gateway          *Gateway
	store            *DurableStore
	keys             vapidKeys
	origin           string
	client           webpush.HTTPClient
	wake             chan struct{}
	isolated         bool
	projectionFailed atomic.Bool
}

func newPushService(g *Gateway) (*PushService, error) {
	if g.cachePersistence() == "memory" && g.replica == nil {
		return nil, errors.New("persistent notification storage unavailable")
	}
	p := &PushService{gateway: g, store: g.durable, origin: g.origin, wake: make(chan struct{}, 1), client: &http.Client{Timeout: 12 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	if g.replica != nil {
		store, err := openNotificationStore(g.dir)
		if err != nil {
			return nil, err
		}
		p.store = store
		p.isolated = true
	}
	succeeded := false
	defer func() {
		if !succeeded && p.isolated {
			_ = p.store.close()
		}
	}()
	path := filepath.Join(g.dir, "push-vapid-v1.json")
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		p.keys.Private, p.keys.Public, err = webpush.GenerateVAPIDKeys()
		if err != nil {
			return nil, err
		}
		raw, _ = json.Marshal(p.keys)
		f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			return nil, e
		}
		_, err = f.Write(raw)
		if err == nil {
			err = f.Sync()
		}
		_ = f.Close()
		if err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	}
	if json.Unmarshal(raw, &p.keys) != nil || len(p.keys.Public) < 80 || len(p.keys.Private) < 40 {
		return nil, errors.New("invalid notification key file")
	}
	_, err = p.store.db.Exec("UPDATE push_jobs SET state='queued' WHERE state='sending'")
	succeeded = err == nil
	return p, err
}
func deviceID(key string) string {
	if len(key) != 64 {
		return ""
	}
	if _, e := hex.DecodeString(key); e != nil {
		return ""
	}
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}
func validPushSubscription(s webpush.Subscription) bool {
	u, e := url.Parse(s.Endpoint)
	if e != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || u.Port() != "" || len(s.Endpoint) > 4096 {
		return false
	}
	host := strings.ToLower(u.Hostname())
	allowed := host == "fcm.googleapis.com" || host == "updates.push.services.mozilla.com" || host == "web.push.apple.com" || strings.HasSuffix(host, ".notify.windows.com")
	if !allowed || u.Path == "" || u.Path == "/" {
		return false
	}
	decode := func(v string) ([]byte, error) { return base64.RawURLEncoding.DecodeString(strings.TrimRight(v, "=")) }
	auth, e := decode(s.Keys.Auth)
	if e != nil || len(auth) != 16 {
		return false
	}
	pub, e := decode(s.Keys.P256dh)
	if e != nil {
		return false
	}
	x, y := elliptic.Unmarshal(elliptic.P256(), pub)
	return x != nil && y != nil
}

func enqueueCompletion(tx *sql.Tx, f frame, now int64) error {
	if f.Event.Type != "turn" || f.Event.Turn == nil || f.Event.Turn.Status != "completed" || !validScope(f.Scope) || !validID(f.ThreadID) || f.Event.Turn.ID == "" {
		return nil
	}
	if completionIsSubagent(tx, f.Scope, f.ThreadID) {
		return nil
	}
	turn := f.Event.Turn
	completed := now
	if turn.CompletedAt != nil {
		completed = int64(*turn.CompletedAt * 1000)
	}
	// Historical snapshots and late replay from before this opt-in do not notify.
	if completed < now-int64(15*time.Minute/time.Millisecond) || completed > now+60000 {
		return nil
	}
	result, e := tx.Exec("INSERT OR IGNORE INTO push_completions VALUES(?,?,?,?)", f.Scope, f.ThreadID, turn.ID, now)
	if e != nil {
		return e
	}
	count, _ := result.RowsAffected()
	if count == 0 {
		return nil
	}
	rows, e := tx.Query("SELECT d.device_id FROM push_devices d JOIN push_device_owners o ON o.device_id=d.device_id AND o.recipient=d.scope WHERE d.scope=? AND d.enabled=1 AND d.enabled_at<=?", f.Scope, completed)
	if e != nil {
		return e
	}
	var devices []string
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			rows.Close()
			return e
		}
		devices = append(devices, id)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	title, summary := completionContent(tx, f.Scope, f.ThreadID, turn.ID)
	if _, e = tx.Exec("INSERT OR IGNORE INTO push_completion_content VALUES(?,?,?,?,?)", f.Scope, f.ThreadID, turn.ID, title, summary); e != nil {
		return e
	}
	for _, device := range devices {
		if _, e = tx.Exec("INSERT OR IGNORE INTO push_jobs(id,scope,device_id,thread_id,turn_id,receipt,state,next_at,created_at) VALUES(?,?,?,?,?,?,'queued',?,?)", nonce(), f.Scope, device, f.ThreadID, turn.ID, nonce(), now, now); e != nil {
			return e
		}
	}
	return nil
}
func (p *PushService) signal() {
	select {
	case p.wake <- struct{}{}:
	default:
	}
}
func (p *PushService) run(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	p.signal()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-p.wake:
		}
		for i := 0; i < 32 && ctx.Err() == nil; i++ {
			if !p.sendNext(ctx) {
				break
			}
		}
	}
}

type pushJob struct {
	ID, Scope, Device, Thread, Turn, Receipt string
	Created                                  int64
	Attempts                                 int
	Subscription                             webpush.Subscription
}

func (p *PushService) sendNext(ctx context.Context) bool {
	if !p.notificationAvailable() {
		return false
	}
	now := time.Now().UnixMilli()
	_, _ = p.store.db.Exec("UPDATE push_jobs SET state='expired' WHERE state IN ('queued','sending') AND created_at<?", now-int64(15*time.Minute/time.Millisecond))
	var j pushJob
	var raw []byte
	classification := `EXISTS (SELECT 1 FROM native_records n WHERE n.scope=j.scope AND n.key='thread:'||j.thread_id AND n.deleted=0)`
	if p.isolated {
		classification = `EXISTS (SELECT 1 FROM notification_threads n WHERE n.scope=j.scope AND n.thread_id=j.thread_id AND n.known=1)`
	}
	err := p.store.db.QueryRow(`SELECT j.id,j.scope,j.device_id,j.thread_id,j.turn_id,j.receipt,j.created_at,j.attempts,d.subscription FROM push_jobs j JOIN push_devices d ON d.scope=j.scope AND d.device_id=j.device_id JOIN push_device_owners o ON o.device_id=j.device_id AND o.recipient=j.scope WHERE j.state='queued' AND j.next_at<=? AND d.enabled=1 AND (j.thread_id='' OR `+classification+`) ORDER BY j.created_at LIMIT 1`, now).Scan(&j.ID, &j.Scope, &j.Device, &j.Thread, &j.Turn, &j.Receipt, &j.Created, &j.Attempts, &raw)
	if err != nil {
		return false
	}
	known, child := completionThreadClassification(p.store.db, j.Scope, j.Thread)
	if p.isolated {
		_ = p.store.db.QueryRow("SELECT known,child FROM notification_threads WHERE scope=? AND thread_id=?", j.Scope, j.Thread).Scan(&known, &child)
	}
	if j.Thread != "" && (!known || child) {
		_, _ = p.store.db.Exec("UPDATE push_jobs SET state='cancelled' WHERE id=? AND state='queued'", j.ID)
		return true
	}
	if json.Unmarshal(raw, &j.Subscription) != nil || !validPushSubscription(j.Subscription) {
		_, _ = p.store.db.Exec("UPDATE push_jobs SET state='failed' WHERE id=?", j.ID)
		return true
	}
	result, err := p.store.db.Exec("UPDATE push_jobs SET state='sending',attempts=attempts+1 WHERE id=? AND state='queued'", j.ID)
	if err != nil {
		return false
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return true
	}
	j.Attempts++
	title, body := p.notificationContent(j)
	if strings.HasPrefix(j.Turn, "test-") {
		title, body = "Codex · "+strings.ToUpper(j.Scope)+" 测试通知", "后台通知已到达这台设备。"
	}
	target := "/?workspace=" + j.Scope + "&view=chat&nativeList=1&fromNotification=1"
	if validID(j.Thread) {
		target = "/local/" + j.Thread + "?workspace=" + j.Scope + "&fromNotification=1"
	}
	payload, _ := json.Marshal(map[string]any{"title": title, "body": body, "tag": "dsh-" + j.ID, "scope": j.Scope, "recipient": j.Scope, "url": target, "jobId": j.ID, "receipt": j.Receipt})
	requestCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	resp, err := webpush.SendNotificationWithContext(requestCtx, payload, &j.Subscription, &webpush.Options{HTTPClient: p.client, Subscriber: p.origin, TTL: 900, Urgency: webpush.UrgencyNormal, Topic: j.ID, VAPIDPublicKey: p.keys.Public, VAPIDPrivateKey: p.keys.Private})
	code := 0
	if resp != nil {
		code = resp.StatusCode
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()
	}
	state := "failed"
	failure := "推送服务暂不可达"
	next := now
	if err == nil && code >= 200 && code < 300 {
		state = "sent"
		failure = ""
	} else if code == 404 || code == 410 {
		failure = "订阅已失效，请重新开启通知"
		_, _ = p.store.db.Exec("UPDATE push_devices SET enabled=0 WHERE scope=? AND device_id=?", j.Scope, j.Device)
	} else if (err != nil || code == 429 || code >= 500) && j.Attempts < 4 {
		state = "queued"
		next = now + int64(j.Attempts*j.Attempts)*30000
	} else if code != 0 {
		failure = fmt.Sprintf("推送服务返回 %d", code)
	}
	// A fast worker receipt can arrive before the provider's HTTP response.
	_, _ = p.store.db.Exec("UPDATE push_jobs SET state=?,next_at=?,last_http=? WHERE id=? AND state='sending'", state, next, code, j.ID)
	_, _ = p.store.db.Exec("UPDATE push_devices SET last_failure=? WHERE scope=? AND device_id=?", failure, j.Scope, j.Device)
	return true
}

func (g *Gateway) servePush(w http.ResponseWriter, r *http.Request, scope, op string) {
	if g.push == nil || !g.push.notificationAvailable() {
		writeJSON(w, 503, map[string]any{"error": "通知服务尚未就绪"})
		return
	}
	if op == "push-config" && r.Method == "GET" {
		writeJSON(w, 200, map[string]any{"available": true, "publicKey": g.push.keys.Public})
		return
	}
	if r.Method != "POST" {
		http.Error(w, "method", 405)
		return
	}
	if r.Header.Get("Origin") != g.origin {
		http.Error(w, "origin required", 403)
		return
	}
	var body struct {
		DeviceKey    string               `json:"deviceKey"`
		Recipient    string               `json:"recipient"`
		Subscription webpush.Subscription `json:"subscription"`
		JobID        string               `json:"jobId"`
		Receipt      string               `json:"receipt"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 12<<10)
	if json.NewDecoder(r.Body).Decode(&body) != nil {
		http.Error(w, "invalid request", 400)
		return
	}
	db := g.push.store.db
	now := time.Now().UnixMilli()
	if op == "push-received" {
		if len(body.JobID) != 32 || len(body.Receipt) != 32 {
			http.Error(w, "invalid receipt", 400)
			return
		}
		tx, e := db.Begin()
		if e != nil {
			http.Error(w, "storage unavailable", 503)
			return
		}
		defer tx.Rollback()
		var device string
		if tx.QueryRow("SELECT device_id FROM push_jobs WHERE id=? AND scope=? AND receipt=?", body.JobID, scope, body.Receipt).Scan(&device) != nil {
			http.Error(w, "receipt unavailable", 404)
			return
		}
		if _, e = tx.Exec("UPDATE push_jobs SET state='received' WHERE id=?", body.JobID); e == nil {
			_, e = tx.Exec("UPDATE push_devices SET last_received_at=?,last_received_job=?,last_failure='' WHERE scope=? AND device_id=?", now, body.JobID, scope, device)
		}
		if e != nil || tx.Commit() != nil {
			http.Error(w, "storage unavailable", 503)
			return
		}
		w.WriteHeader(204)
		return
	}
	id := deviceID(body.DeviceKey)
	if id == "" {
		http.Error(w, "device key required", 400)
		return
	}
	// A device belongs to one recipient regardless of which workspace it is viewing.
	var recipient string
	if e := db.QueryRow("SELECT recipient FROM push_device_owners WHERE device_id=?", id).Scan(&recipient); e != nil && !errors.Is(e, sql.ErrNoRows) {
		http.Error(w, "storage unavailable", 503)
		return
	}
	switch op {
	case "push-device-owner":
		if !validScope(body.Recipient) {
			writeJSON(w, 400, map[string]any{"error": "请选择这台设备的使用者"})
			return
		}
		tx, e := db.Begin()
		if e != nil {
			http.Error(w, "storage unavailable", 503)
			return
		}
		defer tx.Rollback()
		var current string
		if e = tx.QueryRow("SELECT recipient FROM push_device_owners WHERE device_id=?", id).Scan(&current); e != nil && !errors.Is(e, sql.ErrNoRows) {
			http.Error(w, "storage unavailable", 503)
			return
		}
		if current != body.Recipient {
			if _, e = tx.Exec("UPDATE push_devices SET enabled=0 WHERE device_id=?", id); e == nil {
				_, e = tx.Exec("UPDATE push_jobs SET state='cancelled' WHERE device_id=? AND state IN ('queued','sending')", id)
			}
			if e == nil {
				_, e = tx.Exec("INSERT INTO push_device_owners VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET recipient=excluded.recipient,updated_at=excluded.updated_at", id, body.Recipient, now)
			}
		} else {
			e = nil
		}
		if e != nil || tx.Commit() != nil {
			http.Error(w, "storage unavailable", 503)
			return
		}
		writeJSON(w, 200, map[string]any{"recipient": body.Recipient})
	case "push-status":
		var enabled, at int64
		var last, failure string
		e := db.QueryRow("SELECT enabled,last_received_at,last_received_job,last_failure FROM push_devices WHERE scope=? AND device_id=?", recipient, id).Scan(&enabled, &at, &last, &failure)
		if e != nil && !errors.Is(e, sql.ErrNoRows) {
			http.Error(w, "storage unavailable", 503)
			return
		}
		var stamp any
		if at > 0 {
			stamp = time.UnixMilli(at).UTC().Format(time.RFC3339)
		}
		writeJSON(w, 200, map[string]any{"recipient": recipient, "enabled": validScope(recipient) && enabled == 1, "lastReceivedAt": stamp, "lastReceivedJob": last, "lastFailure": failure})
	case "push-subscribe":
		if recipient != scope || body.Recipient != recipient || !validScope(recipient) {
			writeJSON(w, 409, map[string]any{"error": "请先更新应用并确认这台设备的通知归属"})
			return
		}
		if !validPushSubscription(body.Subscription) {
			writeJSON(w, 400, map[string]any{"error": "浏览器通知订阅无效或不受支持"})
			return
		}
		raw, _ := json.Marshal(body.Subscription)
		tx, e := db.Begin()
		if e != nil {
			http.Error(w, "storage unavailable", 503)
			return
		}
		defer tx.Rollback()
		// Recheck inside the same transaction so an old tab cannot race an owner switch.
		var current string
		if tx.QueryRow("SELECT recipient FROM push_device_owners WHERE device_id=?", id).Scan(&current) != nil || current != scope {
			writeJSON(w, 409, map[string]any{"error": "设备使用者已改变，请重新打开设置"})
			return
		}
		// One browser endpoint cannot stay subscribed under two identities or workspaces.
		if _, e = tx.Exec("UPDATE push_devices SET enabled=0 WHERE (device_id=? OR json_extract(subscription,'$.endpoint')=?) AND NOT(scope=? AND device_id=?)", id, body.Subscription.Endpoint, scope, id); e == nil {
			_, e = tx.Exec("UPDATE push_jobs SET state='cancelled' WHERE state IN ('queued','sending') AND EXISTS (SELECT 1 FROM push_devices d WHERE d.scope=push_jobs.scope AND d.device_id=push_jobs.device_id AND d.enabled=0)")
		}
		if e == nil {
			_, e = tx.Exec(`INSERT INTO push_devices(scope,device_id,subscription,enabled,enabled_at) VALUES(?,?,?,1,?) ON CONFLICT(scope,device_id) DO UPDATE SET subscription=excluded.subscription,enabled=1,enabled_at=CASE WHEN push_devices.enabled=1 THEN push_devices.enabled_at ELSE excluded.enabled_at END,last_failure=''`, scope, id, raw, now)
		}
		if e != nil || tx.Commit() != nil {
			http.Error(w, "storage unavailable", 503)
			return
		}
		writeJSON(w, 200, map[string]any{"enabled": true})
	case "push-disable":
		tx, e := db.Begin()
		if e != nil {
			http.Error(w, "storage unavailable", 503)
			return
		}
		defer tx.Rollback()
		if _, e = tx.Exec("UPDATE push_devices SET enabled=0 WHERE device_id=?", id); e == nil {
			_, e = tx.Exec("UPDATE push_jobs SET state='cancelled' WHERE device_id=? AND state IN ('queued','sending')", id)
		}
		if e != nil || tx.Commit() != nil {
			http.Error(w, "storage unavailable", 503)
			return
		}
		writeJSON(w, 200, map[string]any{"enabled": false})
	case "push-test":
		if recipient != scope || !validScope(recipient) {
			writeJSON(w, 409, map[string]any{"error": "通知归属已改变，请重新打开设置"})
			return
		}
		tx, e := db.Begin()
		if e != nil {
			http.Error(w, "storage unavailable", 503)
			return
		}
		defer tx.Rollback()
		var enabled, last int64
		if tx.QueryRow("SELECT enabled,last_test_at FROM push_devices WHERE scope=? AND device_id=?", scope, id).Scan(&enabled, &last) != nil || enabled != 1 {
			writeJSON(w, 409, map[string]any{"error": "请先开启通知"})
			return
		}
		if now-last < 30000 {
			writeJSON(w, 429, map[string]any{"error": "请稍等30秒再测试"})
			return
		}
		job := nonce()
		if _, e = tx.Exec("INSERT INTO push_jobs(id,scope,device_id,thread_id,turn_id,receipt,state,next_at,created_at) VALUES(?,?,?,'',?,?,'queued',?,?)", job, scope, id, "test-"+job, nonce(), now, now); e == nil {
			_, e = tx.Exec("UPDATE push_devices SET last_test_at=?,last_failure='' WHERE scope=? AND device_id=?", now, scope, id)
		}
		if e != nil || tx.Commit() != nil {
			http.Error(w, "storage unavailable", 503)
			return
		}
		g.push.signal()
		writeJSON(w, 202, map[string]any{"jobId": job, "state": "queued"})
	default:
		http.NotFound(w, r)
	}
}
