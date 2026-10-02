package main

import (
	"bytes"
	"context"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

const pushThread = "11111111-1111-4111-a111-111111111111"
const pushDevice = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func newPushTest(t *testing.T) *Gateway {
	t.Helper()
	g := NewGateway(t.TempDir(), "https://example.invalid", []byte(strings.Repeat("s", 32)), false)
	var e error
	g.push, e = newPushService(g)
	if e != nil {
		t.Fatal(e)
	}
	g.agentEpoch = "test"
	t.Cleanup(func() { g.closeCaches() })
	return g
}
func testSubscription(t *testing.T) webpush.Subscription {
	t.Helper()
	_, x, y, e := elliptic.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	return webpush.Subscription{Endpoint: "https://fcm.googleapis.com/fcm/send/test-only", Keys: webpush.Keys{Auth: base64.RawURLEncoding.EncodeToString(make([]byte, 16)), P256dh: base64.RawURLEncoding.EncodeToString(elliptic.Marshal(elliptic.P256(), x, y))}}
}
func pushRequest(g *Gateway, scope, op string, body any) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(body)
	r := httptest.NewRequest("POST", "/sync/v1/w/"+scope+"/"+op, bytes.NewReader(raw))
	r.Header.Set("X-DSH-Authenticated", "1")
	r.Header.Set("Origin", g.origin)
	w := httptest.NewRecorder()
	g.Handler().ServeHTTP(w, r)
	return w
}
func subscribeTest(t *testing.T, g *Gateway, scope string) {
	t.Helper()
	pushRequest(g, scope, "push-device-owner", map[string]any{"deviceKey": pushDevice, "recipient": scope})
	w := pushRequest(g, scope, "push-subscribe", map[string]any{"deviceKey": pushDevice, "recipient": scope, "subscription": testSubscription(t)})
	if w.Code != 200 {
		t.Fatalf("subscribe %d %s", w.Code, w.Body.String())
	}
}
func completeTest(t *testing.T, g *Gateway, scope, id string, completed float64) {
	t.Helper()
	e := g.apply(frame{Epoch: "test", Seq: g.agentSeq + 1, Scope: scope, ThreadID: pushThread, Event: Event{Type: "turn", Turn: &Turn{ID: id, Status: "completed", CompletedAt: &completed}}})
	if e != nil {
		t.Fatal(e)
	}
}
func jobCount(t *testing.T, g *Gateway) int {
	t.Helper()
	var n int
	if e := g.durable.db.QueryRow("SELECT count(*) FROM push_jobs").Scan(&n); e != nil {
		t.Fatal(e)
	}
	return n
}
func TestPushOptInCompletionAndReplay(t *testing.T) {
	g := newPushTest(t)
	now := float64(time.Now().UnixMilli()) / 1000
	completeTest(t, g, "ai", "before-opt-in", now)
	if jobCount(t, g) != 0 {
		t.Fatal("not opted in")
	}
	subscribeTest(t, g, "ai")
	now = float64(time.Now().UnixMilli()) / 1000
	completeTest(t, g, "ai", "complete", now)
	if jobCount(t, g) != 1 {
		t.Fatal("missing completion")
	}
	completeTest(t, g, "ai", "complete", now)
	if jobCount(t, g) != 1 {
		t.Fatal("duplicate completion")
	}
	completeTest(t, g, "zyy", "other-scope", now)
	if jobCount(t, g) != 1 {
		t.Fatal("cross-scope delivery")
	}
	completeTest(t, g, "ai", "old-replay", now-3600)
	if jobCount(t, g) != 1 {
		t.Fatal("historical delivery")
	}
	for _, event := range []Event{{Type: "status", Status: &Status{Type: "idle"}}, {Type: "turn", Turn: &Turn{ID: "interrupted", Status: "interrupted"}}, {Type: "snapshot", Snapshot: &Snapshot{Thread: Thread{ID: pushThread}, Turns: []Turn{{ID: "22222222-2222-4222-a222-222222222222", Status: "completed"}}}}} {
		if e := g.apply(frame{Epoch: "test", Seq: g.agentSeq + 1, Scope: "ai", ThreadID: pushThread, Event: event}); e != nil {
			t.Fatal(e)
		}
	}
	if jobCount(t, g) != 1 {
		t.Fatal("non-completion notified")
	}
	w := pushRequest(g, "ai", "push-disable", map[string]string{"deviceKey": pushDevice})
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	var state string
	_ = g.durable.db.QueryRow("SELECT state FROM push_jobs").Scan(&state)
	if state != "cancelled" {
		t.Fatal(state)
	}
}
func TestPushAuthAndEndpointValidation(t *testing.T) {
	g := newPushTest(t)
	r := httptest.NewRequest("GET", "/sync/v1/w/ai/push-config", nil)
	w := httptest.NewRecorder()
	g.Handler().ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("anonymous config")
	}
	r.Header.Set("X-DSH-Authenticated", "1")
	r.Header.Set("Origin", "https://attacker.invalid")
	w = httptest.NewRecorder()
	g.Handler().ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("cross origin config")
	}
	s := testSubscription(t)
	for _, endpoint := range []string{"http://fcm.googleapis.com/x", "https://127.0.0.1/x", "https://fcm.googleapis.com.attacker.invalid/x", "https://user@fcm.googleapis.com/x", "https://fcm.googleapis.com:443/x", "https://attacker.invalid/x"} {
		s.Endpoint = endpoint
		if validPushSubscription(s) {
			t.Fatal(endpoint)
		}
	}
	s = testSubscription(t)
	if !validPushSubscription(s) {
		t.Fatal("valid rejected")
	}
	s.Keys.P256dh = "not-a-key"
	if validPushSubscription(s) {
		t.Fatal("invalid public key")
	}
}

type pushClientFunc func(*http.Request) (*http.Response, error)

func (f pushClientFunc) Do(r *http.Request) (*http.Response, error) { return f(r) }
func TestPushEncryptedSendReceiptAndRestart(t *testing.T) {
	g := newPushTest(t)
	subscribeTest(t, g, "ai")
	w := pushRequest(g, "ai", "push-test", map[string]string{"deviceKey": pushDevice})
	if w.Code != 202 {
		t.Fatal(w.Code)
	}
	var id, receipt string
	_ = g.durable.db.QueryRow("SELECT id,receipt FROM push_jobs").Scan(&id, &receipt)
	// Process restart preserves pending work and the original VAPID identity.
	key := g.push.keys.Public
	var e error
	g.push, e = newPushService(g)
	if e != nil || g.push.keys.Public != key {
		t.Fatal("unstable key")
	}
	count := 0
	g.push.client = pushClientFunc(func(r *http.Request) (*http.Response, error) {
		count++
		b, _ := io.ReadAll(r.Body)
		if bytes.Contains(b, []byte("后台通知")) || r.Header.Get("Authorization") == "" || r.Header.Get("Content-Encoding") != "aes128gcm" {
			t.Fatal("unencrypted request")
		}
		return &http.Response{StatusCode: 201, Body: io.NopCloser(strings.NewReader(""))}, nil
	})
	if !g.push.sendNext(context.Background()) || count != 1 {
		t.Fatal("not sent")
	}
	if g.push.sendNext(context.Background()) {
		t.Fatal("sent twice")
	}
	w = pushRequest(g, "zyy", "push-received", map[string]string{"jobId": id, "receipt": receipt})
	if w.Code != 404 {
		t.Fatal("cross-scope receipt")
	}
	w = pushRequest(g, "ai", "push-received", map[string]string{"jobId": id, "receipt": strings.Repeat("0", 32)})
	if w.Code != 404 {
		t.Fatal("forged receipt")
	}
	w = pushRequest(g, "ai", "push-received", map[string]string{"jobId": id, "receipt": receipt})
	if w.Code != 204 {
		t.Fatal(w.Code)
	}
	w = pushRequest(g, "ai", "push-status", map[string]string{"deviceKey": pushDevice})
	var status map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &status)
	if status["lastReceivedJob"] != id || status["lastReceivedAt"] == nil {
		t.Fatal("receipt not visible")
	}
}
func TestPushExpiredEndpointDisablesDevice(t *testing.T) {
	g := newPushTest(t)
	subscribeTest(t, g, "ai")
	pushRequest(g, "ai", "push-test", map[string]string{"deviceKey": pushDevice})
	g.push.client = pushClientFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 410, Body: io.NopCloser(strings.NewReader(""))}, nil
	})
	g.push.sendNext(context.Background())
	var enabled int
	_ = g.durable.db.QueryRow("SELECT enabled FROM push_devices").Scan(&enabled)
	if enabled != 0 {
		t.Fatal("expired subscription retained")
	}
}

func TestPushReinstallDoesNotDuplicateEndpoint(t *testing.T) {
	g := newPushTest(t)
	s := testSubscription(t)
	for _, key := range []string{pushDevice, strings.Repeat("b", 64)} {
		pushRequest(g, "ai", "push-device-owner", map[string]any{"deviceKey": key, "recipient": "ai"})
		w := pushRequest(g, "ai", "push-subscribe", map[string]any{"deviceKey": key, "recipient": "ai", "subscription": s})
		if w.Code != 200 {
			t.Fatal(w.Code)
		}
	}
	var n int
	_ = g.durable.db.QueryRow("SELECT count(*) FROM push_devices WHERE scope='ai' AND enabled=1").Scan(&n)
	if n != 1 {
		t.Fatal("same endpoint enabled twice")
	}
}

func TestPushOwnerIsIndependentOfViewedWorkspace(t *testing.T) {
	g := newPushTest(t)
	subscribeTest(t, g, "ai")
	w := pushRequest(g, "zyy", "push-status", map[string]any{"deviceKey": pushDevice})
	var status map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &status)
	if w.Code != 200 || status["recipient"] != "ai" || status["enabled"] != true {
		t.Fatal(w.Code, w.Body.String())
	}
	w = pushRequest(g, "zyy", "push-subscribe", map[string]any{"deviceKey": pushDevice, "recipient": "zyy", "subscription": testSubscription(t)})
	if w.Code != 409 {
		t.Fatal("view silently changed recipient", w.Code)
	}
	now := float64(time.Now().UnixMilli()) / 1000
	completeTest(t, g, "zyy", "foreign", now)
	if jobCount(t, g) != 0 {
		t.Fatal("foreign completion enqueued")
	}
	completeTest(t, g, "ai", "own", now)
	if jobCount(t, g) != 1 {
		t.Fatal("own completion missing")
	}
}
func TestPushChangingOwnerCancelsPendingAndRequiresFreshOptIn(t *testing.T) {
	g := newPushTest(t)
	subscribeTest(t, g, "ai")
	completeTest(t, g, "ai", "queued", float64(time.Now().UnixMilli())/1000)
	w := pushRequest(g, "ai", "push-device-owner", map[string]any{"deviceKey": pushDevice, "recipient": "zyy"})
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	var enabled int
	var state string
	_ = g.durable.db.QueryRow("SELECT sum(enabled) FROM push_devices").Scan(&enabled)
	_ = g.durable.db.QueryRow("SELECT state FROM push_jobs").Scan(&state)
	if enabled != 0 || state != "cancelled" {
		t.Fatal(enabled, state)
	}
	g.push.client = pushClientFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("must not deliver after owner change")
		return nil, nil
	})
	if g.push.sendNext(context.Background()) {
		t.Fatal("pending recipient was retained")
	}
	w = pushRequest(g, "ai", "push-subscribe", map[string]any{"deviceKey": pushDevice, "recipient": "ai", "subscription": testSubscription(t)})
	if w.Code != 409 {
		t.Fatal("old tab re-enabled former owner")
	}
	completeTest(t, g, "zyy", "before-reopt", float64(time.Now().UnixMilli())/1000)
	if jobCount(t, g) != 1 {
		t.Fatal("new owner opted in automatically")
	}
	subscribeTest(t, g, "zyy")
	completeTest(t, g, "zyy", "after-reopt", float64(time.Now().UnixMilli())/1000)
	if jobCount(t, g) != 2 {
		t.Fatal("new owner missing")
	}
}
func TestPushSameEndpointCannotBelongToBothPeople(t *testing.T) {
	g := newPushTest(t)
	s := testSubscription(t)
	for _, v := range []struct{ scope, key string }{{"ai", pushDevice}, {"zyy", strings.Repeat("b", 64)}} {
		pushRequest(g, v.scope, "push-device-owner", map[string]any{"deviceKey": v.key, "recipient": v.scope})
		w := pushRequest(g, v.scope, "push-subscribe", map[string]any{"deviceKey": v.key, "recipient": v.scope, "subscription": s})
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	var n int
	_ = g.durable.db.QueryRow("SELECT count(*) FROM push_devices WHERE enabled=1").Scan(&n)
	if n != 1 {
		t.Fatal("same endpoint receives two identities", n)
	}
}
func TestPushUnassignedLegacyDeviceDoesNotReceive(t *testing.T) {
	g := newPushTest(t)
	subscribeTest(t, g, "ai")
	completeTest(t, g, "ai", "queued", float64(time.Now().UnixMilli())/1000)
	_, _ = g.durable.db.Exec("DELETE FROM push_device_owners")
	completeTest(t, g, "ai", "unassigned", float64(time.Now().UnixMilli())/1000)
	if jobCount(t, g) != 1 {
		t.Fatal("unassigned device enqueued")
	}
	g.push.client = pushClientFunc(func(*http.Request) (*http.Response, error) { t.Fatal("unassigned device sent"); return nil, nil })
	if g.push.sendNext(context.Background()) {
		t.Fatal("unassigned pending selected")
	}
}
func TestPushTwoDevicesKeepSeparateRecipientsAfterRestart(t *testing.T) {
	g := newPushTest(t)
	for _, v := range []struct{ scope, key string }{{"ai", pushDevice}, {"zyy", strings.Repeat("b", 64)}} {
		s := testSubscription(t)
		s.Endpoint += "-" + v.scope
		pushRequest(g, v.scope, "push-device-owner", map[string]any{"deviceKey": v.key, "recipient": v.scope})
		w := pushRequest(g, v.scope, "push-subscribe", map[string]any{"deviceKey": v.key, "recipient": v.scope, "subscription": s})
		if w.Code != 200 {
			t.Fatal(w.Code)
		}
	}
	var err error
	g.push, err = newPushService(g)
	if err != nil {
		t.Fatal(err)
	}
	now := float64(time.Now().UnixMilli()) / 1000
	completeTest(t, g, "ai", "ai", now)
	completeTest(t, g, "zyy", "zyy", now)
	for _, scope := range []string{"ai", "zyy"} {
		var n int
		_ = g.durable.db.QueryRow("SELECT count(*) FROM push_jobs j JOIN push_device_owners o ON j.device_id=o.device_id AND j.scope=o.recipient WHERE j.scope=?", scope).Scan(&n)
		if n != 1 {
			t.Fatal(scope, n)
		}
	}
}
