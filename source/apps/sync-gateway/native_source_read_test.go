package main

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/gorilla/websocket"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func readBridgeFixture(t *testing.T, realtime ...bool) (*Gateway, *httptest.Server, *websocket.Conn) {
	t.Helper()
	g := testGateway(t)
	if len(realtime) > 0 && realtime[0] {
		if err := g.enableRealtimeCache(); err != nil {
			t.Fatal(err)
		}
	}
	s := httptest.NewServer(g.Handler())
	g.origin = s.URL
	t.Cleanup(s.Close)
	c, _, e := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(s.URL, "http")+"/_sync-agent", http.Header{"Authorization": {"Bearer " + string(g.secret)}})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { c.Close() })
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	var msg map[string]any
	if e = c.ReadJSON(&msg); e != nil {
		t.Fatal(e)
	}
	c.WriteJSON(map[string]any{"type": "reset", "epoch": "source", "baseSeq": 0})
	if e = c.ReadJSON(&msg); e != nil {
		t.Fatal(e)
	}
	return g, s, c
}
func TestSourceReadBypassesUncommittedQueueAndRejectsMismatches(t *testing.T) {
	for _, variant := range []string{"valid", "withTurns", "notLoaded", "full", "items", "older", "scope", "key", "payload", "large", "generation", "commit", "history", "unnegotiated"} {
		t.Run(variant, func(t *testing.T) {
			g, s, c := readBridgeFixture(t)
			id := "11111111-1111-4111-a111-111111111111"
			method := "thread/read"
			p := map[string]any{"threadId": id, "includeTurns": false}
			if variant == "withTurns" {
				p["includeTurns"] = true
			}
			if variant == "notLoaded" || variant == "full" {
				method = "thread/turns/list"
				p = normalizeNativeParams(method, map[string]any{"threadId": id, "itemsView": variant, "limit": float64(2)})
			}
			if variant == "items" {
				method = "thread/items/list"
				p = normalizeNativeParams(method, map[string]any{"threadId": id, "turnId": "turn", "cursor": "older"})
			}
			if variant == "older" {
				method = "thread/turns/list"
				p = normalizeNativeParams(method, map[string]any{"threadId": id, "cursor": "older"})
			}
			if variant == "unnegotiated" {
				p["includeTurns"] = "invalid"
			}
			input, _ := json.Marshal(map[string]any{"method": method, "params": p, "fresh": true, "sourceReadVersion": 999})
			req, _ := http.NewRequest("POST", s.URL+"/sync/v1/w/ai/native-read", bytes.NewReader(input))
			req.Header.Set("X-DSH-Authenticated", "1")
			req.Header.Set("Origin", s.URL)
			type result struct {
				status int
				raw    []byte
				err    error
			}
			done := make(chan result, 1)
			go func() {
				r, e := http.DefaultClient.Do(req)
				if e != nil {
					done <- result{err: e}
					return
				}
				defer r.Body.Close()
				raw, e := io.ReadAll(r.Body)
				done <- result{r.StatusCode, raw, e}
			}()
			var request map[string]any
			if e := c.ReadJSON(&request); e != nil {
				t.Fatal(e)
			}
			b := request["body"].(map[string]any)
			if variant != "unnegotiated" && b["sourceReadVersion"] != float64(sourceReadVersion) {
				t.Fatal("capability not set by gateway")
			}
			if request["readDeadlineMs"].(float64) > 25000 {
				t.Fatal("read budget grew")
			}
			key, _ := json.Marshal([]any{method, p})
			nativeResult := map[string]any{"thread": map[string]any{"id": id}}
			if method != "thread/read" {
				nativeResult = map[string]any{"data": []any{map[string]any{"id": "turn", "items": []any{}}}, "nextCursor": "preserved-native-cursor"}
			}
			payload, _ := json.Marshal(map[string]any{"method": method, "params": p, "result": nativeResult})
			r := map[string]any{"scope": "ai", "threadId": id, "key": "read:" + string(key), "kind": "history", "revision": 42, "sourceGeneration": "source", "generation": "generation", "bytes": len(payload), "payload": json.RawMessage(payload), "readDelivery": map[string]any{"version": sourceReadVersion, "sourceVerified": true, "projectionCommitted": false}}
			switch variant {
			case "scope":
				r["scope"] = "zyy"
			case "key":
				r["key"] = "wrong"
			case "payload":
				r["payload"] = map[string]any{"method": method, "params": map[string]any{"threadId": "wrong"}, "result": map[string]any{}}
			case "large":
				r["bytes"] = maxSourcePayloadBytes + 1
			case "generation":
				r["generation"] = ""
			case "commit":
				r["readDelivery"].(map[string]any)["projectionCommitted"] = true
			case "history":
				r["kind"] = "bootstrap"
			}
			// Simulate a held projection writer: a valid inline response must not enter
			// the durable writer/readback path after the native request has dispatched.
			g.persistMu.Lock()
			if e := c.WriteJSON(map[string]any{"type": "reply", "id": request["id"], "result": r}); e != nil {
				g.persistMu.Unlock()
				t.Fatal(e)
			}
			var got result
			select {
			case got = <-done:
			case <-time.After(time.Second):
				g.persistMu.Unlock()
				t.Fatal("source read waited for unrelated durable writer")
			}
			g.persistMu.Unlock()
			if got.err != nil {
				t.Fatal(got.err)
			}
			if variant == "valid" || variant == "withTurns" || variant == "notLoaded" || variant == "full" || variant == "items" || variant == "older" {
				if got.status != 200 || !bytes.Contains(got.raw, []byte(`"projectionCommitted":false`)) {
					t.Fatal(got.status, string(got.raw))
				}
				row, e := g.durable.nativeRecord("ai", "read:"+string(key))
				if e != nil || row != nil {
					t.Fatal("inline read fabricated cloud commit")
				}
				if g.agentSeq != 0 {
					t.Fatal("inline read advanced ACK")
				}
			} else if got.status != 502 {
				t.Fatal("accepted mismatched inline record", variant, got.status)
			}
		})
	}
}
func TestReadCancellationIsPropagatedButCommandsAreNotCanceled(t *testing.T) {
	for _, op := range []string{"native-read", "command"} {
		t.Run(op, func(t *testing.T) {
			g, _, c := readBridgeFixture(t)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			done := make(chan error, 1)
			go func() { _, err := g.call(ctx, "ai", op, map[string]any{}); done <- err }()
			var req map[string]any
			if e := c.ReadJSON(&req); e != nil {
				t.Fatal(e)
			}
			cancel()
			if e := <-done; e == nil {
				t.Fatal("canceled call succeeded")
			}
			g.controlMu.Lock()
			pending := len(g.pending)
			g.controlMu.Unlock()
			if pending != 0 {
				t.Fatal("pending waiter retained")
			}
			c.SetReadDeadline(time.Now().Add(150 * time.Millisecond))
			var message map[string]any
			err := c.ReadJSON(&message)
			if op == "native-read" {
				if err != nil || message["type"] != "cancel-read" || message["id"] != req["id"] || message["scope"] != "ai" || message["reason"] != "canceled" {
					t.Fatal("missing scoped cancel", message, err)
				}
			} else if err == nil {
				t.Fatal("command cancellation sent", message)
			}
		})
	}
}
func TestReadDeadlineWhileBridgeWriterBusy(t *testing.T) {
	g, _, _ := readBridgeFixture(t)
	g.controlMu.Lock()
	a := g.bridge
	g.controlMu.Unlock()
	a.mu.Lock()
	defer a.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := g.call(ctx, "ai", "native-read", map[string]any{})
	if err == nil || time.Since(start) > 200*time.Millisecond {
		t.Fatal("read blocked behind unrelated writer", err)
	}
}
func TestApprovalReconciliationPublishesExistingEventsAndRollsBackInvalidScope(t *testing.T) {
	g := testGateway(t)
	old := json.RawMessage(`{"id":"old","threadId":"11111111-1111-4111-a111-111111111111"}`)
	if e := g.apply(frame{Epoch: "source", Seq: 1, Scope: "ai", ThreadID: threadID, Event: Event{Type: "approval", Request: old}}); e != nil {
		t.Fatal(e)
	}
	if e := g.apply(frame{Epoch: "source", Seq: 2, Scope: "ai", ThreadID: threadID, Event: Event{Type: "approvals", Approvals: []json.RawMessage{json.RawMessage(`{"id":"wrong","threadId":"different"}`)}}}); e == nil {
		t.Fatal("cross thread approval accepted")
	}
	if g.agentSeq != 1 || len(g.topics[topicKey("ai", threadID)].Approvals) != 1 {
		t.Fatal("failed reconcile changed durable state")
	}
	if e := g.apply(frame{Epoch: "source", Seq: 2, Scope: "ai", ThreadID: threadID, Event: Event{Type: "approvals", Approvals: []json.RawMessage{}}}); e != nil {
		t.Fatal(e)
	}
	topic := g.topics[topicKey("ai", threadID)]
	if len(topic.Approvals) != 0 {
		t.Fatal("old approval remained")
	}
	if topic.Events[len(topic.Events)-1].Event.Type != "approvalResolved" {
		t.Fatal("client contract changed")
	}
}
