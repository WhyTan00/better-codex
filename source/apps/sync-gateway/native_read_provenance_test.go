package main

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

// Exercise the actual HTTP handler, bridge reply and durable store together.
// Android consumes this envelope; a fixture must not invent its source field.
func TestNativeItemReadProvenance(t *testing.T) {
	for _, variant := range []string{"fresh_committed", "fresh_newer_cache", "not_fresh", "missing_commit", "generation_mismatch", "cached_offline"} {
		t.Run(variant, func(t *testing.T) {
			g, _, bridge := readBridgeFixture(t)
			id, turn := "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"
			params := normalizeNativeParams("thread/items/list", map[string]any{"threadId": id, "turnId": turn})
			key, _ := json.Marshal([]any{"thread/items/list", params})
			payload, _ := json.Marshal(map[string]any{"method": "thread/items/list", "params": params,
				"result": map[string]any{"data": []any{}, "nextCursor": nil, "backwardsCursor": nil}})
			record := NativeRecord{Scope: "ai", Key: "read:" + string(key), Kind: "history", ThreadID: id,
				SourceGeneration: "g1", Generation: "g1", Revision: 42, Payload: payload, Bytes: len(payload)}
			committed := record
			if variant == "fresh_newer_cache" {
				committed.Revision++
			}
			if variant == "generation_mismatch" {
				committed.Generation = "other"
			}
			if variant != "missing_commit" {
				raw, _ := json.Marshal(committed)
				if err := g.apply(frame{Epoch: "source", Seq: 1, Scope: "ai", ThreadID: id, Event: Event{Type: "nativeRecord"}, Data: raw}); err != nil {
					t.Fatal(err)
				}
			}
			g.controlMu.Lock()
			g.nativeOnline = variant != "cached_offline"
			g.controlMu.Unlock()
			body, _ := json.Marshal(map[string]any{"method": "thread/items/list", "params": params, "fresh": variant != "not_fresh"})
			req := httptest.NewRequest("POST", "/sync/v1/w/ai/native-read", bytes.NewReader(body))
			response := httptest.NewRecorder()
			done := make(chan struct{})
			go func() { g.serveNativeRead(response, req, "ai"); close(done) }()
			if variant != "cached_offline" && variant != "not_fresh" {
				var request map[string]any
				if err := bridge.ReadJSON(&request); err != nil {
					t.Fatal(err)
				}
				if request["type"] != "request" {
					t.Fatal("expected real bridge request")
				}
				if err := bridge.WriteJSON(map[string]any{"type": "reply", "id": request["id"], "result": record}); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				t.Fatal("read did not finish")
			}
			if variant == "missing_commit" || variant == "generation_mismatch" {
				if response.Code != 503 {
					t.Fatal("unverified receipt accepted", response.Code)
				}
				return
			}
			var envelope map[string]any
			if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
				t.Fatal(err)
			}
			wanted := "cloud-cache"
			if variant == "fresh_committed" {
				wanted = "native"
				if path := os.Getenv("DSH_GATEWAY_ITEMS_FIXTURE"); path != "" {
					if err := os.WriteFile(path, response.Body.Bytes(), 0600); err != nil {
						t.Fatal(err)
					}
				}
			}
			if response.Code != 200 || envelope["source"] != wanted {
				t.Fatalf("source contract: status=%d source=%v want=%s", response.Code, envelope["source"], wanted)
			}
		})
	}
}

func TestNativeCachedHeadPreservesPayloadEncoding(t *testing.T) {
	g := testGateway(t)
	id := "11111111-1111-4111-8111-111111111111"
	params := map[string]any{"threadId": id, "includeTurns": false}
	key, _ := json.Marshal([]any{"thread/read", params})
	payload := json.RawMessage(`{"method":"thread/read","params":{"threadId":"` + id + `","includeTurns":false},"result":{"thread":{"id":"` + id + `","historyMode":"paginated","status":{"type":"idle"},"turns":[]}}}`)
	record := NativeRecord{Scope: "ai", Key: "read:" + string(key), Kind: "history", ThreadID: id,
		SourceGeneration: "g1", Generation: "g1", Revision: 42, Payload: payload, Bytes: len(payload)}
	raw, _ := json.Marshal(record)
	if err := g.apply(frame{Epoch: "source", Seq: 1, Scope: "ai", ThreadID: id, Event: Event{Type: "nativeRecord"}, Data: raw}); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{"method": "thread/read", "params": params, "fresh": false})
	response := httptest.NewRecorder()
	g.serveNativeRead(response, httptest.NewRequest("POST", "/sync/v1/w/ai/native-read", bytes.NewReader(body)), "ai")
	if prefix := os.Getenv("DSH_GATEWAY_HEAD_FIXTURE"); prefix != "" {
		if err := os.WriteFile(prefix+"-cache-envelope.json", response.Body.Bytes(), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(prefix+"-native-record.json", raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	var envelope struct {
		Source  string          `json:"source"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if response.Code != 200 || envelope.Source != "cloud-cache" {
		t.Fatal("cached response contract changed")
	}
	if !bytes.Equal(envelope.Payload, payload) {
		t.Fatal("cache envelope reserialized the immutable Native payload")
	}
}
