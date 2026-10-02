package main

import (
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestQuietSubscriberKeepsImmediateEventsAndCanReturnActive(t *testing.T) {
	g := testGateway(t)
	_ = g.apply(snapshotFrame(1))
	server := httptest.NewServer(g.Handler())
	defer server.Close()
	g.origin = server.URL
	u := "ws" + strings.TrimPrefix(server.URL, "http") + "/sync/v1/w/ai/events/" + threadID + "?epoch=" + g.epoch + "&after=1"
	c, _, e := websocket.DefaultDialer.Dial(u, http.Header{"Origin": {server.URL}, "X-DSH-Authenticated": {"1"}})
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	var value map[string]any
	if e = c.ReadJSON(&value); e != nil || value["syncPolicyVersion"] != float64(1) {
		t.Fatalf("capability: %v %v", value, e)
	}
	for _, mode := range []string{"idle", "active"} {
		if e = c.WriteJSON(map[string]any{"type": "syncPolicy", "mode": mode}); e != nil {
			t.Fatal(e)
		}
		if e = c.ReadJSON(&value); e != nil {
			t.Fatal(e)
		}
		policy, _ := subscriberHeartbeat(mode)
		if value["mode"] != mode || value["heartbeatMs"] != float64(policy.interval.Milliseconds()) {
			t.Fatal(value)
		}
		if mode == "idle" {
			// Changing keepalive cadence cannot delay newly arriving final/text events.
			if e = g.apply(frame{Type: "publish", Epoch: "source", Seq: 2, Scope: "ai", ThreadID: threadID, Event: Event{Type: "delta", TurnID: turnID, ItemID: "message", Delta: " now"}}); e != nil {
				t.Fatal(e)
			}
			if e = c.ReadJSON(&value); e != nil || value["seq"] != float64(2) {
				t.Fatalf("idle event delivery: %v %v", value, e)
			}
		}
	}
	if _, ok := subscriberHeartbeat("unbounded"); ok {
		t.Fatal("unbounded policy accepted")
	}
	if p, _ := subscriberHeartbeat("idle"); p.interval != 120*time.Second {
		t.Fatal(p)
	}
	// A quiet but healthy connection still yields an observable heartbeat;
	// the application reply is accepted without a business event or disk write.
	_ = c.SetReadDeadline(time.Now().Add(20 * time.Second))
	if e = c.ReadJSON(&value); e != nil || value["type"] != "heartbeat" {
		t.Fatalf("heartbeat: %v %v", value, e)
	}
	if e = c.WriteJSON(map[string]any{"type": "ping"}); e != nil {
		t.Fatal(e)
	}
	if e = c.WriteJSON(map[string]any{"type": "syncPolicy", "mode": "idle"}); e != nil {
		t.Fatal(e)
	}
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	if e = c.ReadJSON(&value); e != nil || value["mode"] != "idle" {
		t.Fatalf("reply path: %v %v", value, e)
	}
}

func TestSyncPolicyDiagnosticsKeepBoundedMetadata(t *testing.T) {
	result := safeClientDiagnostic(map[string]any{"reason": "sync_policy", "syncMode": "idle", "heartbeatMs": 120000, "catalogIntervalMs": 300000, "text": "PRIVATE"})
	if result["syncMode"] != "idle" || result["reason"] != "sync_policy" || result["heartbeatMs"] != 120000 || result["catalogIntervalMs"] != 300000 {
		t.Fatal(result)
	}
	if _, ok := result["text"]; ok {
		t.Fatal("private text retained")
	}
	if _, ok := safeClientDiagnostic(map[string]any{"syncMode": "PRIVATE"})["syncMode"]; ok {
		t.Fatal("unbounded mode accepted")
	}
}
