package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

//go:embed public/*
var assets embed.FS
var buildVersion = "development"
var idPattern = regexp.MustCompile(`^[0-9a-fA-F-]{36}$`)

func validID(id string) bool           { return idPattern.MatchString(id) }
func validScope(s string) bool         { return s == "ai" || s == "secondary" }
func nonce() string                    { b := make([]byte, 16); _, _ = rand.Read(b); return hex.EncodeToString(b) }
func topicKey(scope, id string) string { return scope + ":" + id }

type Envelope struct {
	Epoch    string `json:"epoch"`
	Seq      uint64 `json:"seq"`
	Scope    string `json:"scope"`
	ThreadID string `json:"threadId"`
	Event    Event  `json:"event"`
}
type Topic struct {
	Seq         uint64
	Events      []Envelope
	Bytes       int
	Snapshot    *Snapshot
	Dirty       bool
	List        map[string]Thread
	PinnedIDs   []string
	NextCursor  *string
	Approvals   map[string]json.RawMessage
	Subscribers map[*browser]bool
}
type browser struct {
	conn *websocket.Conn
	send chan any
	once sync.Once
	done chan struct{}
}

func (b *browser) close() { b.once.Do(func() { close(b.done); _ = b.conn.Close() }) }

type agent struct {
	conn *websocket.Conn
	mu   sync.Mutex
	id   string
}

func (a *agent) send(v any) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	_ = a.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return a.conn.WriteJSON(v)
}

type reply struct {
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
	Status int             `json:"status"`
}
type frame struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	Epoch     string          `json:"epoch"`
	Seq       uint64          `json:"seq"`
	BaseSeq   uint64          `json:"baseSeq"`
	Scope     string          `json:"scope"`
	ThreadID  string          `json:"threadId"`
	Event     Event           `json:"event"`
	Data      json.RawMessage `json:"data"`
	Result    json.RawMessage `json:"result"`
	Error     string          `json:"error"`
	Status    int             `json:"status"`
	MessageID string          `json:"messageId"`
	Index     int             `json:"index"`
	Count     int             `json:"count"`
	Payload   string          `json:"payload"`
}
type assembly struct {
	parts [][]byte
	size  int
	next  int
	at    time.Time
}
type Gateway struct {
	push         *PushService
	durable      *DurableStore
	staging      map[string]*Topic
	stagedEvents []Envelope
	storeID      string
	history      *HistoryStore
	persistMu    sync.Mutex
	mu           sync.Mutex
	epoch        string
	agentEpoch   string
	agentSeq     uint64
	bridge       *agent
	nativeOnline bool
	topics       map[string]*Topic
	pending      map[string]chan reply
	uiEvents     map[string][]map[string]any
	refreshing   map[string]bool
	dir          string
	secret       []byte
	origin       string
	local        bool
}

func NewGateway(dir, origin string, secret []byte, local bool) *Gateway {
	g := &Gateway{epoch: nonce(), topics: map[string]*Topic{}, pending: map[string]chan reply{}, uiEvents: map[string][]map[string]any{}, refreshing: map[string]bool{}, dir: dir, secret: secret, origin: origin, local: local}
	g.history = &HistoryStore{dir: filepath.Join(dir, "history")}
	_ = os.MkdirAll(dir, 0700)
	idFile := filepath.Join(dir, ".cache-id")
	existing, err := os.ReadFile(idFile)
	if err == nil {
		g.storeID = strings.TrimSpace(string(existing))
	}
	if g.storeID == "" {
		g.storeID = nonce()
		_ = os.WriteFile(idFile, []byte(g.storeID), 0600)
	}
	for _, s := range readSnapshots(dir) {
		t := g.topicLocked(s.Scope, s.Snapshot.Thread.ID)
		snapshot := s.Snapshot
		t.Snapshot = &snapshot
		g.topicLocked(s.Scope, "").List[snapshot.Thread.ID] = snapshot.Thread
	}
	for _, scope := range []string{"ai", "secondary"} {
		data, err := os.ReadFile(filepath.Join(dir, "catalog-"+scope+".json"))
		if err == nil {
			var list []Thread
			if json.Unmarshal(data, &list) == nil {
				for _, thread := range list {
					if validID(thread.ID) {
						g.topicLocked(scope, "").List[thread.ID] = thread
					}
				}
			}
		}
	}
	for _, scope := range []string{"ai", "secondary"} {
		data, err := os.ReadFile(filepath.Join(dir, "pins-"+scope+".json"))
		if err == nil {
			var ids []string
			if json.Unmarshal(data, &ids) == nil {
				for _, id := range ids {
					if validID(id) {
						g.topicLocked(scope, "").PinnedIDs = append(g.topicLocked(scope, "").PinnedIDs, id)
					}
				}
			}
		}
	}

	var durableErr error
	g.durable, durableErr = openDurable(dir)
	if durableErr != nil {
		panic(fmt.Errorf("durable read model unavailable: %w", durableErr))
	}
	if saved := g.durable.meta("serverEpoch"); saved != "" {
		g.epoch = saved
	} else if e := g.durable.setMeta("serverEpoch", g.epoch); e != nil {
		panic(e)
	}
	g.agentEpoch = g.durable.meta("adapterEpoch")
	g.agentSeq, _ = strconv.ParseUint(g.durable.meta("adapterSeq"), 10, 64)
	if g.durable.meta("initialized") == "" {
		if e := g.durable.seed(g.topics); e != nil {
			panic(e)
		}
	} else {
		g.topics = map[string]*Topic{}
	}
	if e := g.durable.restore(g); e != nil {
		panic(e)
	}
	return g
}
func (g *Gateway) topicLocked(scope, id string) *Topic {
	key := topicKey(scope, id)
	if g.staging != nil {
		if _, seen := g.staging[key]; !seen {
			g.staging[key] = g.topics[key]
			if old := g.topics[key]; old != nil {
				g.topics[key] = cloneTopic(old)
			}
		}
	}
	if t := g.topics[key]; t != nil {
		return t
	}
	t := &Topic{List: map[string]Thread{}, Approvals: map[string]json.RawMessage{}, Subscribers: map[*browser]bool{}}
	g.topics[key] = t
	return t
}
func (g *Gateway) publishLocked(scope, id string, e Event) {
	t := g.topicLocked(scope, id)
	var prior *Topic
	if g.staging == nil && g.durable != nil {
		prior = cloneTopic(t)
	}
	t.Seq++
	encoded, _ := json.Marshal(e)
	var immutable Event
	_ = json.Unmarshal(encoded, &immutable)
	envelope := Envelope{Epoch: g.epoch, Seq: t.Seq, Scope: scope, ThreadID: id, Event: immutable}
	data, _ := json.Marshal(envelope)
	t.Events = append(t.Events, envelope)
	t.Bytes += len(data)
	for len(t.Events) > 512 || t.Bytes > 512<<10 {
		old, _ := json.Marshal(t.Events[0])
		t.Bytes -= len(old)
		t.Events = t.Events[1:]
	}
	if g.staging != nil {
		g.stagedEvents = append(g.stagedEvents, envelope)
		return
	}
	if g.staging == nil && g.durable != nil {
		if err := g.durable.saveTopic(topicKey(scope, id), t); err != nil {
			g.topics[topicKey(scope, id)] = prior
			log.Printf("topic persistence failed: %v", err)
			return
		}
	}
	g.deliverLocked(envelope)
}
func (g *Gateway) deliverLocked(envelope Envelope) {
	t := g.topics[topicKey(envelope.Scope, envelope.ThreadID)]
	if t == nil {
		return
	}
	for b := range t.Subscribers {
		select {
		case b.send <- envelope:
		default:
			b.close()
			delete(t.Subscribers, b)
		}
	}
}
func (g *Gateway) apply(f frame) error {
	g.persistMu.Lock()
	defer g.persistMu.Unlock()
	g.mu.Lock()
	defer g.mu.Unlock()
	if f.Epoch != g.agentEpoch {
		return errors.New("adapter epoch mismatch")
	}
	if f.Seq <= g.agentSeq {
		if g.durable != nil {
			return g.durable.checkDuplicate(f)
		}
		return nil
	}
	if f.Seq != g.agentSeq+1 {
		return errors.New("adapter sequence gap")
	}
	committed := false
	oldOnline := g.nativeOnline
	g.staging = map[string]*Topic{}
	g.stagedEvents = nil
	defer func() {
		if !committed {
			for key, old := range g.staging {
				if old == nil {
					delete(g.topics, key)
				} else {
					g.topics[key] = old
				}
			}
			g.nativeOnline = oldOnline
		}
		g.staging = nil
		g.stagedEvents = nil
	}()
	if f.Event.Type == "host" {
		g.nativeOnline = f.Event.Online != nil && *f.Event.Online
		for key := range g.topics {
			p := strings.SplitN(key, ":", 2)
			g.publishLocked(p[0], p[1], f.Event)
		}
	} else {
		if !validScope(f.Scope) || (f.ThreadID != "" && !validID(f.ThreadID)) {
			return errors.New("invalid publication scope")
		}

		if f.Event.Type == "nativeRecord" {
			var record NativeRecord
			if json.Unmarshal(f.Data, &record) != nil || record.Scope != f.Scope || record.ThreadID != f.ThreadID {
				return errors.New("invalid native record")
			}
			g.publishLocked(f.Scope, "", Event{Type: "nativeChanged", ThreadID: f.ThreadID, CacheKey: record.Key, Revision: record.Revision, Generation: record.Generation})
		} else if f.Event.Type == "pins" {
			var value struct {
				IDs  []string `json:"ids"`
				Data []Thread `json:"data"`
			}
			if json.Unmarshal(f.Data, &value) != nil {
				return errors.New("invalid pins")
			}
			t := g.topicLocked(f.Scope, "")
			t.PinnedIDs = []string{}
			for _, id := range value.IDs {
				if validID(id) {
					t.PinnedIDs = append(t.PinnedIDs, id)
				}
			}
			for _, thread := range value.Data {
				if validID(thread.ID) {
					t.List[thread.ID] = thread
				}
			}
			if err := atomicJSON(filepath.Join(g.dir, "pins-"+f.Scope+".json"), t.PinnedIDs); err != nil {
				return err
			}
			g.publishLocked(f.Scope, "", Event{Type: "catalogChanged"})
		} else if f.Event.Type == "catalogComplete" {
			var full struct {
				IDs []string `json:"ids"`
			}
			if json.Unmarshal(f.Data, &full) != nil {
				return errors.New("invalid full catalog")
			}
			seen := map[string]bool{}
			for _, id := range full.IDs {
				seen[id] = true
			}
			t := g.topicLocked(f.Scope, "")
			for id := range t.List {
				if !seen[id] {
					delete(t.List, id)
				}
			}
			g.publishLocked(f.Scope, "", Event{Type: "catalogChanged"})
		} else if f.Event.Type == "historyPage" {
			var page Snapshot
			if json.Unmarshal(f.Data, &page) != nil || page.Thread.ID != f.ThreadID {
				return errors.New("invalid history page")
			}
			if err := g.history.save(f.Scope, page, false, page.NextCursor == nil); err != nil {
				return err
			}
		} else if f.Event.Type == "catalog" || f.Event.Type == "catalogPage" {
			var v struct {
				Data       []Thread `json:"data"`
				NextCursor *string  `json:"nextCursor"`
			}
			if json.Unmarshal(f.Data, &v) != nil {
				return errors.New("invalid catalog")
			}
			t := g.topicLocked(f.Scope, "")
			t.NextCursor = v.NextCursor
			// Merge catalog pages; full sweep removes absent entries separately.
			for _, thread := range v.Data {
				if validID(thread.ID) {
					t.List[thread.ID] = thread
				}
			}
			if f.Event.Type == "catalog" {
				g.publishLocked(f.Scope, "", Event{Type: "catalogChanged"})
			}
		} else if f.ThreadID == "" {
			t := g.topicLocked(f.Scope, "")
			if f.Event.Thread != nil && validID(f.Event.Thread.ID) {
				t.List[f.Event.Thread.ID] = *f.Event.Thread
			}
			if f.Event.ThreadID != "" {
				v := t.List[f.Event.ThreadID]
				v.ID = f.Event.ThreadID
				if f.Event.Status != nil {
					v.Status = *f.Event.Status
				}
				if f.Event.Name != "" {
					v.Name = f.Event.Name
				}
				t.List[v.ID] = v
			}
			g.publishLocked(f.Scope, "", f.Event)
		} else {
			t := g.topicLocked(f.Scope, f.ThreadID)
			if f.Event.Type == "approval" {
				var request struct {
					ID json.RawMessage `json:"id"`
				}
				if json.Unmarshal(f.Event.Request, &request) == nil && len(request.ID) > 0 {
					t.Approvals[string(request.ID)] = append(json.RawMessage{}, f.Event.Request...)
				}
			}
			if f.Event.Type == "approvalResolved" {
				delete(t.Approvals, string(f.Event.RequestID))
			}
			if t.Snapshot == nil {
				t.Snapshot = &Snapshot{Thread: Thread{ID: f.ThreadID}, Turns: []Turn{}}
			}
			applyEvent(t.Snapshot, f.Event)
			if f.Event.Type == "snapshot" {
				if err := saveSnapshot(g.dir, f.Scope, *t.Snapshot); err != nil {
					return err
				}
				if err := g.history.save(f.Scope, *t.Snapshot, true, t.Snapshot.NextCursor == nil); err != nil {
					return err
				}
			}
			t.Dirty = true
			g.topicLocked(f.Scope, "").List[f.ThreadID] = t.Snapshot.Thread
			g.publishLocked(f.Scope, f.ThreadID, f.Event)
		}
	}

	changed := map[string]*Topic{}
	for key := range g.staging {
		changed[key] = g.topics[key]
	}
	if g.durable != nil {
		if e := g.durable.commit(f, changed); e != nil {
			return fmt.Errorf("durable commit: %w", e)
		}
	}
	g.agentSeq = f.Seq
	committed = true
	if g.push != nil {
		g.push.signal()
	}
	for _, envelope := range g.stagedEvents {
		g.deliverLocked(envelope)
	}
	return nil
}
func (g *Gateway) call(ctx context.Context, scope, op string, body any) (json.RawMessage, error) {
	g.mu.Lock()
	a := g.bridge
	if a == nil || !g.nativeOnline {
		g.mu.Unlock()
		return nil, errors.New("Mac 暂未连接")
	}
	if len(g.pending) >= 128 {
		g.mu.Unlock()
		return nil, errors.New("请求较多，请稍后重试")
	}
	id := nonce()
	channel := make(chan reply, 1)
	g.pending[id] = channel
	g.mu.Unlock()
	defer func() { g.mu.Lock(); delete(g.pending, id); g.mu.Unlock() }()
	if err := a.send(map[string]any{"type": "request", "id": id, "scope": scope, "op": op, "body": body}); err != nil {
		return nil, errors.New("连接中断；发送结果需核对")
	}
	select {
	case value := <-channel:
		if value.Error != "" {
			return nil, errors.New(value.Error)
		}
		return value.Result, nil
	case <-ctx.Done():
		return nil, errors.New("确认尚未收到，请核对请求状态")
	}
}
func (g *Gateway) refresh(scope, id string) {
	key := topicKey(scope, id)
	g.mu.Lock()
	if g.refreshing[key] || g.bridge == nil {
		g.mu.Unlock()
		return
	}
	g.refreshing[key] = true
	g.mu.Unlock()
	go func() {
		defer func() { g.mu.Lock(); delete(g.refreshing, key); g.mu.Unlock() }()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		op := "watch"
		if id == "" {
			op = "catalog"
		}
		_, _ = g.call(ctx, scope, op, map[string]any{"threadId": id})
	}()
}
func (g *Gateway) flush() {
	g.persistMu.Lock()
	defer g.persistMu.Unlock()
	g.mu.Lock()
	values := []Stored{}
	for key, t := range g.topics {
		if !t.Dirty || t.Snapshot == nil {
			continue
		}
		data, _ := json.Marshal(t.Snapshot)
		var snapshot Snapshot
		_ = json.Unmarshal(data, &snapshot)
		values = append(values, Stored{Scope: strings.SplitN(key, ":", 2)[0], Snapshot: snapshot})
		t.Dirty = false
	}
	catalogs := map[string][]Thread{}
	for _, scope := range []string{"ai", "secondary"} {
		for _, thread := range g.topicLocked(scope, "").List {
			catalogs[scope] = append(catalogs[scope], thread)
		}
	}
	g.mu.Unlock()
	for scope, list := range catalogs {
		_ = atomicJSON(filepath.Join(g.dir, "catalog-"+scope+".json"), list)
	}
	for _, v := range values {
		_ = saveSnapshot(g.dir, v.Scope, v.Snapshot)
		_ = g.history.save(v.Scope, v.Snapshot, true, v.Snapshot.NextCursor == nil)
	}
	pruneStore(g.dir, 64<<20)
}
func (g *Gateway) serveAgent(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if len(token) != len(g.secret) || subtle.ConstantTimeCompare([]byte(token), g.secret) != 1 {
		http.Error(w, "unauthorized", 401)
		return
	}
	if r.Header.Get("Origin") != "" {
		http.Error(w, "browser cannot publish", 403)
		return
	}
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }, ReadBufferSize: 4096, WriteBufferSize: 4096}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	conn.SetReadLimit(2 << 20)
	_ = conn.SetReadDeadline(time.Now().Add(45 * time.Second))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(45 * time.Second)) })
	a := &agent{conn: conn, id: nonce()}
	g.mu.Lock()
	previous := g.bridge
	g.bridge = a
	resumeEpoch, ack := g.agentEpoch, g.agentSeq
	g.mu.Unlock()
	if previous != nil {
		_ = previous.conn.Close()
	}
	defer func() {
		g.mu.Lock()
		if g.bridge == a {
			g.bridge = nil
			g.nativeOnline = false
			for key := range g.topics {
				p := strings.SplitN(key, ":", 2)
				online := false
				g.publishLocked(p[0], p[1], Event{Type: "host", Online: &online})
			}
			for _, c := range g.pending {
				select {
				case c <- reply{Error: "Mac 连接中断；请求结果待核对"}:
				default:
				}
			}
		}
		g.mu.Unlock()
	}()
	_ = a.send(map[string]any{"type": "hello", "serverEpoch": g.epoch, "adapterEpoch": resumeEpoch, "ack": ack, "protocol": 2, "storeID": g.storeID})
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)) != nil {
					conn.Close()
					return
				}
			case <-done:
				return
			}
		}
	}()
	chunks := map[string]*assembly{}
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(45 * time.Second))
		var f frame
		if json.Unmarshal(raw, &f) != nil {
			return
		}
		if f.Type == "chunk" {
			if f.Count < 1 || f.Count > 1536 || f.Index < 0 || f.Index >= f.Count || len(f.MessageID) > 80 {
				return
			}
			part, err := base64.StdEncoding.DecodeString(f.Payload)
			if err != nil || len(part) > 65536 {
				return
			}
			for k, v := range chunks {
				if time.Since(v.at) > 30*time.Second {
					delete(chunks, k)
				}
			}
			v := chunks[f.MessageID]
			if v == nil {
				if len(chunks) >= 8 || f.Index != 0 {
					return
				}
				v = &assembly{parts: make([][]byte, f.Count), at: time.Now()}
				chunks[f.MessageID] = v
			}
			if v.next != f.Index || len(v.parts) != f.Count {
				return
			}
			v.parts[f.Index] = part
			v.next++
			v.at = time.Now()
			v.size += len(part)
			if v.size > 64<<20 {
				return
			}
			if v.next < f.Count {
				continue
			}
			raw = []byte{}
			for _, part := range v.parts {
				raw = append(raw, part...)
			}
			delete(chunks, f.MessageID)
			if json.Unmarshal(raw, &f) != nil {
				return
			}
		}
		switch f.Type {
		case "reset":
			g.mu.Lock()
			if err := g.durable.reset(f.Epoch, f.BaseSeq); err != nil {
				g.mu.Unlock()
				return
			}
			g.agentEpoch = f.Epoch
			g.agentSeq = f.BaseSeq
			g.nativeOnline = true
			g.mu.Unlock()
			_ = a.send(map[string]any{"type": "ack", "epoch": f.Epoch, "seq": f.BaseSeq})
			g.mu.Lock()
			subscriptions := []string{}
			for key, topic := range g.topics {
				if len(topic.Subscribers) > 0 {
					subscriptions = append(subscriptions, key)
				}
			}
			g.mu.Unlock()
			for _, key := range subscriptions {
				parts := strings.SplitN(key, ":", 2)
				g.refresh(parts[0], parts[1])
			}
		case "publish":
			if err := g.apply(f); err != nil {
				if strings.Contains(err.Error(), "sequence gap") || strings.Contains(err.Error(), "epoch mismatch") {
					_ = a.send(map[string]any{"type": "resync", "reason": "sequence_gap"})
					continue
				}
				log.Printf("sync commit rejected: %v", err)
				return
			}
			_ = a.send(map[string]any{"type": "ack", "epoch": f.Epoch, "seq": f.Seq})
		case "reply":
			g.mu.Lock()
			ch := g.pending[f.ID]
			g.mu.Unlock()
			if ch != nil {
				select {
				case ch <- reply{Result: f.Result, Error: f.Error, Status: f.Status}:
				default:
				}
			}
		}
	}
}
func (g *Gateway) browserAllowed(r *http.Request) bool {
	if !g.local && r.Header.Get("X-BETTER_CODEX-Authenticated") != "1" {
		return false
	}
	// Authentication remains mandatory. Installed-PWA/SSO document navigation
	// is distinct from cross-origin API access, matching the original front.
	if r.Method == "GET" && (r.URL.Path == "/" || r.URL.Path == "/app" || strings.HasPrefix(r.URL.Path, "/app/thread/")) {
		mode, dest := r.Header.Get("Sec-Fetch-Mode"), r.Header.Get("Sec-Fetch-Dest")
		accept := r.Header.Get("Accept")
		legacy := mode == "" && dest == "" && (accept == "" || accept == "*/*" || strings.Contains(accept, "text/html"))
		if mode == "navigate" && (dest == "" || dest == "document" || dest == "empty") || legacy {
			return true
		}
	}
	origin := r.Header.Get("Origin")
	if origin != "" && origin != g.origin {
		return false
	}
	return r.Header.Get("Sec-Fetch-Site") != "cross-site"
}
func (g *Gateway) serveEvents(w http.ResponseWriter, r *http.Request, scope, id string) {
	origin := r.Header.Get("Origin")
	if origin != g.origin {
		http.Error(w, "invalid origin", 403)
		return
	}
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	b := &browser{conn: conn, send: make(chan any, 1024), done: make(chan struct{})}
	defer b.close()
	after, _ := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)
	epoch := r.URL.Query().Get("epoch")
	g.mu.Lock()
	t := g.topicLocked(scope, id)
	t.Subscribers[b] = true
	if epoch != g.epoch || after > t.Seq || (after < t.Seq && (len(t.Events) == 0 || after+1 < t.Events[0].Seq)) {
		b.send <- map[string]any{"type": "resync", "reason": "cursor_expired", "epoch": g.epoch, "seq": t.Seq}
	} else {
		for _, e := range t.Events {
			if e.Seq > after {
				select {
				case b.send <- e:
				default:
					b.close()
				}
			}
		}
	}
	online := g.bridge != nil && g.nativeOnline
	b.send <- map[string]any{"type": "hello", "epoch": g.epoch, "online": online}
	g.mu.Unlock()
	defer func() { g.mu.Lock(); delete(t.Subscribers, b); g.mu.Unlock() }()
	g.refresh(scope, id)
	conn.SetReadLimit(2048)
	_ = conn.SetReadDeadline(time.Now().Add(45 * time.Second))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(45 * time.Second)) })
	go func() {
		defer b.close()
		for {
			var value struct {
				Type string `json:"type"`
				Seq  uint64 `json:"seq"`
			}
			if conn.ReadJSON(&value) != nil {
				return
			}
			_ = conn.SetReadDeadline(time.Now().Add(45 * time.Second))
			if value.Type != "ack" && value.Type != "ping" {
				return
			}
		}
	}()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case value := <-b.send:
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if conn.WriteJSON(value) != nil {
				return
			}
		case <-ticker.C:
			if conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)) != nil {
				return
			}
		case <-b.done:
			return
		}
	}
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func (g *Gateway) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Accept-CH", "Sec-CH-Prefers-Color-Scheme")
		if r.URL.Path == "/__sync_health" {
			g.mu.Lock()
			online := g.bridge != nil && g.nativeOnline
			count := len(g.topics)
			g.mu.Unlock()
			writeJSON(w, 200, map[string]any{"service": "betterCodex-sync-gateway", "online": online, "topics": count, "build": buildVersion, "notifications": g.push != nil})
			return
		}
		if r.URL.Path == "/_sync-agent" {
			g.serveAgent(w, r)
			return
		}
		if !g.browserAllowed(r) {
			http.Error(w, "authentication required", 401)
			return
		}
		if g.serveNativeShell(w, r) {
			return
		}
		if strings.HasPrefix(r.URL.Path, "/app/thread/") && r.Method == "GET" {
			id := strings.TrimPrefix(r.URL.Path, "/app/thread/")
			if !validID(id) {
				http.NotFound(w, r)
				return
			}
			scope := r.URL.Query().Get("workspace")
			if !validScope(scope) {
				scope = "ai"
			}
			w.Header().Set("Cache-Control", "no-store")
			http.Redirect(w, r, "/local/"+id+"?workspace="+scope, 303)
			return
		}
		if r.URL.Path == "/app" && r.Method == "GET" {
			scope := r.URL.Query().Get("workspace")
			if !validScope(scope) {
				scope = "ai"
			}
			w.Header().Set("Cache-Control", "no-store")
			http.Redirect(w, r, "/?workspace="+scope+"&view=chat&nativeList=1", 303)
			return
		}
		if r.URL.Path == "/" {
			scope := r.URL.Query().Get("workspace")
			if !validScope(scope) {
				scope = "ai"
			}
			http.Redirect(w, r, "/?workspace="+scope+"&view=chat&nativeList=1", 303)
			return
		}
		for url, file := range map[string]string{
			"/official-patched-v1002/assets/app-initial-cadb12d4a15e.js": "${BETTER_CODEX_RUNTIME}/native-assets/v1002/app-initial-cadb12d4a15e.js",
			"/official-patched-v1004/assets/app-initial-cadb12d4a15e.js": "${BETTER_CODEX_RUNTIME}/native-assets/v1004/app-initial-cadb12d4a15e.js",
			"/official-patched-v1004/assets/app-primary-6cd7b8b3f5e3.js": "${BETTER_CODEX_RUNTIME}/native-assets/v1004/app-primary-6cd7b8b3f5e3.js",
		} {
			if r.URL.Path != url {
				continue
			}
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
			w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
			http.ServeFile(w, r, file)
			return
		}
		if r.URL.Path == "/app/sw.js" || r.URL.Path == "/app/manifest.webmanifest" || r.URL.Path == "/manifest.webmanifest" {
			name := "manifest.webmanifest"
			w.Header().Set("Content-Type", "application/manifest+json")
			if r.URL.Path == "/app/sw.js" {
				name = "sw.js"
				w.Header().Set("Content-Type", "application/javascript")
				w.Header().Set("Service-Worker-Allowed", "/app")
			}
			w.Header().Set("Cache-Control", "no-cache")
			data, _ := assets.ReadFile("public/" + name)
			if name == "manifest.webmanifest" {
				var manifest map[string]any
				_ = json.Unmarshal(data, &manifest)
				color := "#ffffff"
				mode := r.URL.Query().Get("theme")
				if mode == "" {
					if c, err := r.Cookie("betterCodex-theme"); err == nil {
						mode = c.Value
					} else if strings.Contains(r.Header.Get("Sec-CH-Prefers-Color-Scheme"), "dark") {
						mode = "dark"
					}
				}
				scope := r.URL.Query().Get("workspace")
				if !validScope(scope) {
					scope = "ai"
				}
				manifest["id"] = "/workspaces/" + scope
				manifest["name"] = "Codex · " + strings.ToUpper(scope)
				manifest["short_name"] = "Codex " + strings.ToUpper(scope)
				manifest["start_url"] = "/?workspace=" + scope + "&view=chat&nativeList=1&pwa=" + scope + "&launch=1"
				manifest["scope"] = "/"
				w.Header().Set("Vary", "Cookie, Sec-CH-Prefers-Color-Scheme")
				if mode == "dark" {
					color = "#000000"
				}
				manifest["background_color"] = color
				manifest["theme_color"] = color
				data, _ = json.Marshal(manifest)
			}
			_, _ = w.Write(data)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/app/assets/") {
			if r.Method != "GET" && r.Method != "HEAD" {
				http.Error(w, "method", 405)
				return
			}
			name := strings.TrimPrefix(r.URL.Path, "/app/assets/")
			if strings.Contains(name, "/") || strings.Contains(name, "..") {
				http.NotFound(w, r)
				return
			}
			if data, err := assets.ReadFile("public/" + name); err == nil {
				sum := sha256.Sum256(data)
				tag := `"` + hex.EncodeToString(sum[:16]) + `"`
				w.Header().Set("ETag", tag)
				if r.Header.Get("If-None-Match") == tag {
					w.Header().Set("Cache-Control", "private, no-cache")
					w.WriteHeader(304)
					return
				}
			}
			sub, _ := fs.Sub(assets, "public")
			w.Header().Set("Cache-Control", "private, no-cache")
			http.StripPrefix("/app/assets/", http.FileServer(http.FS(sub))).ServeHTTP(w, r)
			return
		}
		if r.URL.Path == "/app" || strings.HasPrefix(r.URL.Path, "/app/thread/") {
			if r.Method != "GET" {
				http.Error(w, "method", 405)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'sha256-X5t6fu7gAQKQ2N27Fo/+fnF2iybwU4eXxaIuDLLs2Fg='; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
			data, _ := assets.ReadFile("public/index.html")
			_, _ = w.Write(data)
			return
		}
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if len(parts) < 5 || parts[0] != "sync" || parts[1] != "v1" || parts[2] != "w" || !validScope(parts[3]) {
			http.NotFound(w, r)
			return
		}
		scope, op := parts[3], parts[4]
		if strings.HasPrefix(op, "push-") && len(parts) == 5 {
			g.servePush(w, r, scope, op)
			return
		}
		id := ""
		if len(parts) > 5 {
			id = parts[5]
		}
		if id != "" && !validID(id) {
			http.Error(w, "invalid thread", 400)
			return
		}
		if op == "native-cursors" && r.Method == "GET" {
			g.serveNativeCursors(w, r, scope)
			return
		}
		if op == "native-bootstrap" && r.Method == "GET" {
			g.serveNativeBootstrap(w, r, scope)
			return
		}
		if op == "native-catalog" && r.Method == "GET" {
			g.serveNativeCatalog(w, r, scope)
			return
		}
		if op == "native-read" && r.Method == "POST" {
			g.serveNativeRead(w, r, scope)
			return
		}
		if op == "performance" {
			g.servePerformance(w, r, scope)
			return
		}
		if op == "events" && r.Method == "GET" {
			g.serveEvents(w, r, scope, id)
			return
		}
		if op == "threads" && r.Method == "GET" {
			g.serveCatalog(w, r, scope)
			return
		}

		if op == "thread" && r.Method == "GET" && id != "" {
			g.serveSnapshot(w, r, scope, id)
			return
		}

		if op == "request" && r.Method == "GET" {
			ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
			defer cancel()
			result, err := g.call(ctx, scope, "request-status", map[string]any{"requestId": r.URL.Query().Get("id")})
			if err != nil {
				writeJSON(w, 503, map[string]any{"error": err.Error()})
				return
			}
			writeJSON(w, 200, json.RawMessage(result))
			return
		}
		if op == "command" && r.Method == "POST" {
			if r.Header.Get("Origin") != g.origin {
				http.Error(w, "origin required", 403)
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, 256<<10)
			var body map[string]any
			decoder := json.NewDecoder(r.Body)
			if decoder.Decode(&body) != nil {
				http.Error(w, "invalid request", 400)
				return
			}
			requestID, _ := body["requestId"].(string)
			if !validID(requestID) {
				http.Error(w, "invalid request identity", 400)
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
			defer cancel()
			result, err := g.call(ctx, scope, "command", body)
			if err != nil {
				writeJSON(w, 202, map[string]any{"state": "unknown", "requestId": requestID, "error": err.Error()})
				return
			}
			writeJSON(w, 200, json.RawMessage(result))
			return
		}
		if op == "approval-details" && r.Method == "GET" && id != "" {
			ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
			defer cancel()
			result, err := g.call(ctx, scope, "approval-details", map[string]any{"threadId": id, "approvalId": r.URL.Query().Get("approvalId")})
			if err != nil {
				writeJSON(w, 503, map[string]any{"error": err.Error()})
				return
			}
			writeJSON(w, 200, json.RawMessage(result))
			return
		}
		if op == "details" && r.Method == "GET" && id != "" {
			ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
			defer cancel()
			result, err := g.call(ctx, scope, "details", map[string]any{"threadId": id, "turnId": r.URL.Query().Get("turnId"), "cursor": r.URL.Query().Get("cursor")})
			if err != nil {
				writeJSON(w, 503, map[string]any{"error": err.Error()})
				return
			}
			writeJSON(w, 200, json.RawMessage(result))
			return
		}
		http.NotFound(w, r)
	})
}
func main() {
	listen := flag.String("listen", "127.0.0.1:18985", "")
	dir := flag.String("state-dir", "", "")
	keyFile := flag.String("key-file", "", "")
	origin := flag.String("origin", "http://localhost:3080", "")
	local := flag.Bool("local-development", false, "")
	flag.Parse()
	host, _, err := net.SplitHostPort(*listen)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		log.Fatal("loopback listener required")
	}
	parsed, err := url.Parse(*origin)
	if err != nil || parsed.Host == "" {
		log.Fatal("origin required")
	}
	if *local && parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost" {
		log.Fatal("local development requires loopback origin")
	}
	if *dir == "" || *keyFile == "" {
		log.Fatal("state-dir and key-file required")
	}
	key, err := os.ReadFile(*keyFile)
	if err != nil {
		log.Fatal("bridge credential unavailable")
	}
	key = []byte(strings.TrimSpace(string(key)))
	if len(key) < 32 {
		log.Fatal("invalid bridge credential")
	}
	abs, _ := filepath.Abs(*dir)
	g := NewGateway(abs, *origin, key, *local)
	defer g.flush()
	server := &http.Server{Addr: *listen, Handler: g.Handler(), ReadHeaderTimeout: 10 * time.Second, MaxHeaderBytes: 32 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	g.push, err = newPushService(g)
	if err != nil {
		log.Print("notification service unavailable")
	} else {
		go g.push.run(ctx)
	}
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				g.flush()
			case <-ctx.Done():
				g.flush()
				return
			}
		}
	}()
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(c)
	}()
	fmt.Printf("{\"service\":\"betterCodex-sync-gateway\",\"listen\":%q}\n", *listen)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal("gateway stopped")
	}
}

var _ = io.EOF
