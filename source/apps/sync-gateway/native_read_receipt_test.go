package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestNativeReadCompactReceiptRequiresCommittedDataAndPreservesTrace(t *testing.T) {
	for _, committed := range []bool{true, false} {
		t.Run(map[bool]string{true: "committed", false: "missing_commit"}[committed], func(t *testing.T) {
			g := testGateway(t)
			server := httptest.NewServer(g.Handler())
			defer server.Close()
			g.origin = server.URL
			conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/_sync-agent", http.Header{"Authorization": {"Bearer " + string(g.secret)}})
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			conn.SetReadDeadline(time.Now().Add(3 * time.Second))
			var envelope map[string]any
			if err = conn.ReadJSON(&envelope); err != nil {
				t.Fatal(err)
			}
			if err = conn.WriteJSON(map[string]any{"type": "reset", "epoch": "source", "baseSeq": 0}); err != nil {
				t.Fatal(err)
			}
			if err = conn.ReadJSON(&envelope); err != nil {
				t.Fatal(err)
			}

			var logs bytes.Buffer
			oldWriter, oldFlags := log.Writer(), log.Flags()
			log.SetOutput(&logs)
			log.SetFlags(0)
			defer func() { log.SetOutput(oldWriter); log.SetFlags(oldFlags) }()
			traceID := "44444444-4444-4444-a444-444444444444"
			params := map[string]any{"threadId": threadID, "includeTurns": false}
			body, _ := json.Marshal(map[string]any{"method": "thread/read", "params": params, "fresh": true, "knownRecord": map[string]any{"sourceGeneration": "forged", "generation": "forged", "revision": 999}})
			r, _ := http.NewRequest("POST", server.URL+"/sync/v1/w/ai/native-read", bytes.NewReader(body))
			r.Header.Set("X-DSH-Authenticated", "1")
			r.Header.Set("Origin", server.URL)
			r.Header.Set("X-DSH-Diagnostic-Trace", traceID)
			type response struct {
				status int
				body   []byte
				err    error
			}
			done := make(chan response, 1)
			go func() {
				res, e := http.DefaultClient.Do(r)
				if e != nil {
					done <- response{err: e}
					return
				}
				defer res.Body.Close()
				raw, e := io.ReadAll(res.Body)
				done <- response{status: res.StatusCode, body: raw, err: e}
			}()
			if err = conn.ReadJSON(&envelope); err != nil {
				t.Fatal(err)
			}
			if envelope["type"] != "request" || envelope["traceId"] != traceID {
				t.Fatalf("trace not forwarded: %#v", envelope)
			}
			requestID := envelope["id"].(string)
			if envelope["body"].(map[string]any)["knownRecord"] != nil {
				t.Fatal("client supplied cache attestation was trusted")
			}
			keyBytes, _ := json.Marshal([]any{"thread/read", params})
			record := NativeRecord{Scope: "ai", SourceGeneration: "source", Generation: "source", ThreadID: threadID, Key: "read:" + string(keyBytes), Kind: "history", Revision: 42, Payload: json.RawMessage(`{"result":{"thread":{"id":"11111111-1111-4111-a111-111111111111","preview":"PRIVATE_BODY"}}}`)}
			if committed {
				raw, _ := json.Marshal(record)
				if err = conn.WriteJSON(frame{Type: "publish", Epoch: "source", Seq: 1, Scope: "ai", ThreadID: threadID, Event: Event{Type: "nativeRecord"}, Data: raw}); err != nil {
					t.Fatal(err)
				}
				if err = conn.ReadJSON(&envelope); err != nil {
					t.Fatal(err)
				}
				if envelope["type"] != "ack" {
					t.Fatal("not durably acknowledged")
				}
			}
			if err = conn.WriteJSON(map[string]any{"type": "reply", "id": requestID, "result": map[string]any{"scope": "ai", "key": record.Key, "revision": 42}}); err != nil {
				t.Fatal(err)
			}
			res := <-done
			if res.err != nil {
				t.Fatal(res.err)
			}
			if committed && (res.status != 200 || !bytes.Contains(res.body, []byte("PRIVATE_BODY"))) {
				t.Fatalf("did not return full committed record: %d", res.status)
			}
			if !committed && res.status != 503 {
				t.Fatal("accepted uncommitted receipt", res.status)
			}
			if strings.Contains(logs.String(), "PRIVATE_BODY") || strings.Contains(logs.String(), record.Key) {
				t.Fatal("history leaked into diagnostics")
			}
			digest := sha256.Sum256([]byte(requestID))
			wantedHash := hex.EncodeToString(digest[:8])
			stages := map[string]bool{}
			for _, line := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
				var event map[string]any
				if json.Unmarshal([]byte(line), &event) != nil || event["event"] != "read" {
					continue
				}
				if event["traceId"] != traceID || event["readIdHash"] != wantedHash || event["threadId"] != threadID {
					t.Fatal("broken read correlation", event)
				}
				stages[event["readPhase"].(string)+":"+event["stage"].(string)] = true
			}
			if !stages["bridge_dispatch:dispatch"] || !stages["bridge_reply:received"] {
				t.Fatal("missing bridge stages", stages)
			}
			if committed && !stages["cloud_readback:committed"] || !committed && !stages["cloud_readback:failed"] {
				t.Fatal("missing readback result", stages)
			}
			if committed {
				for _, generation := range []string{"source", "reverted"} {
					req, _ := http.NewRequest("POST", server.URL+"/sync/v1/w/ai/native-read", bytes.NewReader(body))
					req.Header.Set("X-DSH-Authenticated", "1")
					req.Header.Set("Origin", server.URL)
					go func() {
						res, e := http.DefaultClient.Do(req)
						if e != nil {
							done <- response{err: e}
							return
						}
						defer res.Body.Close()
						raw, e := io.ReadAll(res.Body)
						done <- response{status: res.StatusCode, body: raw, err: e}
					}()
					if err = conn.ReadJSON(&envelope); err != nil {
						t.Fatal(err)
					}
					known := envelope["body"].(map[string]any)["knownRecord"].(map[string]any)
					if known["revision"] != float64(42) || known["generation"] != "source" || known["sourceGeneration"] != "source" {
						t.Fatal("attestation did not come from committed row", known)
					}
					if err = conn.WriteJSON(map[string]any{"type": "reply", "id": envelope["id"], "result": map[string]any{"scope": "ai", "key": record.Key, "revision": 42, "sourceGeneration": "source", "generation": generation}}); err != nil {
						t.Fatal(err)
					}
					res := <-done
					if res.err != nil {
						t.Fatal(res.err)
					}
					if generation == "source" && (res.status != 200 || !bytes.Contains(res.body, []byte("PRIVATE_BODY"))) {
						t.Fatal("could not reuse committed record", res.status)
					}
					if generation == "reverted" && res.status != 503 {
						t.Fatal("served a different generation", res.status)
					}
				}
			}
		})
	}
}
