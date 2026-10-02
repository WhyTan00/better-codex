package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// The fixture produces wire bytes with the real JS SyncAdapter, its real
// source-read selection, canonical keys and lazy chunk sender. Go does not
// reconstruct or repair any producer field before the consumer sees it.
func sourcePageFrames(t *testing.T, request map[string]any) [][]byte {
	t.Helper()
	input, err := json.Marshal(map[string]any{"request": request})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	producer := os.Getenv("DSH_SOURCE_PAGE_PRODUCER")
	if producer == "" {
		producer = "../native-codex-web/test/fixtures/source-page-producer.mjs"
	}
	cmd := exec.CommandContext(ctx, "node", producer)
	cmd.Stdin = bytes.NewReader(input)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	raw, err := cmd.Output()
	if err != nil {
		t.Fatalf("producer failed: %v; %s", err, stderr.String())
	}
	var frames [][]byte
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	scanner.Buffer(make([]byte, 4096), 128<<10)
	for scanner.Scan() {
		frames = append(frames, bytes.Clone(scanner.Bytes()))
	}
	if scanner.Err() != nil {
		t.Fatal(scanner.Err())
	}
	if len(frames) < 2 {
		t.Fatal("fixture did not exercise a chunked page")
	}
	return frames
}

func TestSourcePageActualProducerBypassesBlockedACKAndDisconnectFails(t *testing.T) {
	for _, variant := range []string{"large-full", "older-turns", "items", "disconnect", "cache-readonly", "cache-reader-unavailable", "realtime", "realtime-items", "realtime-readonly"} {
		t.Run(variant, func(t *testing.T) {
			realtime := strings.HasPrefix(variant, "realtime")
			g, s, c := readBridgeFixture(t, realtime)
			version := 2
			if realtime {
				version = 3
			}
			if variant == "cache-readonly" || variant == "realtime-readonly" {
				if _, err := g.durable.db.Exec("PRAGMA query_only=ON"); err != nil {
					t.Fatal(err)
				}
				if err := g.apply(snapshotFrame(1)); err != nil {
					t.Fatal(err)
				}
				if realtime {
					waitRealtime(t, func() bool { return g.cachePersistence() == "memory" })
				}
				if g.cachePersistence() != "memory" {
					t.Fatal("cache did not degrade")
				}
			}
			if variant == "cache-reader-unavailable" {
				g.durable.reader.Close()
			}
			initialSequence := g.agentSeq
			method := "thread/turns/list"
			params := map[string]any{"threadId": threadID, "itemsView": "full", "limit": 2}
			if variant == "older-turns" {
				params["cursor"] = "opaque-older"
				params["sortDirection"] = "asc"
			}
			if variant == "items" || variant == "realtime-items" {
				method = "thread/items/list"
				params = map[string]any{"threadId": threadID, "turnId": "synthetic-turn", "cursor": "opaque-items"}
			}
			input, _ := json.Marshal(map[string]any{"method": method, "params": params, "fresh": true})
			req, _ := http.NewRequest("POST", s.URL+"/sync/v1/w/ai/native-read", bytes.NewReader(input))
			req.Header.Set("X-DSH-Authenticated", "1")
			req.Header.Set("Origin", s.URL)
			type response struct {
				status int
				body   []byte
				err    error
			}
			done := make(chan response, 1)
			go func() {
				r, err := http.DefaultClient.Do(req)
				if err != nil {
					done <- response{err: err}
					return
				}
				defer r.Body.Close()
				raw, err := io.ReadAll(r.Body)
				done <- response{r.StatusCode, raw, err}
			}()
			var wireRequest map[string]any
			if err := c.ReadJSON(&wireRequest); err != nil {
				t.Fatal(err)
			}
			if wireRequest["body"].(map[string]any)["sourceReadVersion"] != float64(version) {
				t.Fatal("missing source negotiation")
			}
			frames := sourcePageFrames(t, wireRequest)
			g.persistMu.Lock()
			locked := true
			defer func() {
				if locked {
					g.persistMu.Unlock()
				}
			}()
			for index, raw := range frames {
				if err := c.WriteMessage(1, raw); err != nil {
					t.Fatal(err)
				}
				if variant == "disconnect" && index == 0 {
					c.Close()
					break
				}
			}
			select {
			case got := <-done:
				g.persistMu.Unlock()
				locked = false
				if got.err != nil {
					t.Fatal(got.err)
				}
				if variant == "disconnect" {
					if got.status != 503 {
						t.Fatal("partial read became success", got.status)
					}
				} else {
					if got.status != 200 {
						t.Fatal("source page failed", got.status, string(got.body))
					}
					var result struct {
						NativeRecord
						ReadDelivery struct {
							Version             int
							SourceVerified      bool
							ProjectionCommitted bool
							SourceOnly          bool
						}
					}
					if err := json.Unmarshal(got.body, &result); err != nil {
						t.Fatal(err)
					}
					if result.ReadDelivery.Version != version || result.ReadDelivery.SourceOnly != realtime || !result.ReadDelivery.SourceVerified || result.ReadDelivery.ProjectionCommitted || result.Bytes < 1<<20 || !bytes.Contains(result.Payload, []byte("unchanged-native-cursor")) {
						t.Fatal("page identity or payload changed")
					}
					if row, err := g.cacheStore().nativeRecord("ai", result.Key); row != nil || (err != nil && variant != "cache-reader-unavailable") {
						t.Fatal("foreground page claimed a durable commit")
					}
				}
			case <-time.After(2 * time.Second):
				t.Fatal("source page waited for held projection writer")
			}
			g.mu.Lock()
			seq := g.agentSeq
			g.mu.Unlock()
			if seq != initialSequence {
				t.Fatal("source page advanced global ACK", seq)
			}
		})
	}
}

func TestCanceledReadAssembliesDoNotExhaustBridgeAndLateChunksCannotReply(t *testing.T) {
	g, _, c := readBridgeFixture(t)
	for i := 0; i < 10; i++ {
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { _, err := g.call(ctx, "ai", "native-read", map[string]any{}); done <- err }()
		var request map[string]any
		if err := c.ReadJSON(&request); err != nil {
			t.Fatal(err)
		}
		id := request["id"].(string)
		if err := c.WriteJSON(map[string]any{"type": "chunk", "messageId": fmt.Sprintf("partial-%d", i), "readId": id, "scope": "ai", "index": 0, "count": 2, "payload": base64.StdEncoding.EncodeToString([]byte(`{"type":"reply",`))}); err != nil {
			t.Fatal(err)
		}
		cancel()
		if err := <-done; err == nil {
			t.Fatal("canceled read succeeded")
		}
		var canceled map[string]any
		if err := c.ReadJSON(&canceled); err != nil {
			t.Fatal(err)
		}
		if canceled["type"] != "cancel-read" {
			t.Fatal("read cancellation missing")
		}
		// Omit the optional cancellation marker to exercise pending-owner cleanup.
		if err := c.WriteJSON(map[string]any{"type": "chunk", "messageId": fmt.Sprintf("partial-%d", i), "readId": id, "scope": "ai", "index": 1, "count": 2, "payload": base64.StdEncoding.EncodeToString([]byte(`"result":{}}`))}); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := g.call(ctx, "ai", "command", map[string]any{}); done <- err }()
	var command map[string]any
	if err := c.ReadJSON(&command); err != nil {
		t.Fatal(err)
	}
	if err := c.WriteJSON(map[string]any{"type": "reply", "id": command["id"], "result": map[string]any{"accepted": true}}); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal("abandoned reads broke command channel", err)
	}
}

func TestReadChunkCancellationIsScopedAndCannotCancelPublications(t *testing.T) {
	g, _, c := readBridgeFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := g.call(ctx, "ai", "native-read", map[string]any{}); done <- err }()
	var request map[string]any
	if err := c.ReadJSON(&request); err != nil {
		t.Fatal(err)
	}
	id := request["id"].(string)
	raw, _ := json.Marshal(map[string]any{"type": "reply", "id": id, "result": map[string]any{"read": true}})
	split := len(raw) / 2
	chunk := func(index int, part []byte) map[string]any {
		return map[string]any{"type": "chunk", "messageId": "scoped-partial", "readId": id, "scope": "ai", "index": index, "count": 2, "payload": base64.StdEncoding.EncodeToString(part)}
	}
	if err := c.WriteJSON(chunk(0, raw[:split])); err != nil {
		t.Fatal(err)
	}
	for _, wrong := range []map[string]any{
		{"type": "cancel-read-chunks", "messageId": "scoped-partial", "readId": id, "scope": "zyy"},
		{"type": "cancel-read-chunks", "messageId": "scoped-partial", "readId": "other", "scope": "ai"},
	} {
		if err := c.WriteJSON(wrong); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.WriteJSON(chunk(1, raw[split:])); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal("wrong cancellation removed live read", err)
	}
	publication, _ := json.Marshal(map[string]any{"type": "publish", "epoch": "source", "seq": 1, "scope": "ai", "threadId": threadID, "event": map[string]any{"type": "host", "online": true}})
	for index, part := range [][]byte{publication[:len(publication)/2], publication[len(publication)/2:]} {
		if index == 1 {
			c.WriteJSON(map[string]any{"type": "cancel-read-chunks", "messageId": "publication", "readId": id, "scope": "ai"})
		}
		if err := c.WriteJSON(map[string]any{"type": "chunk", "messageId": "publication", "index": index, "count": 2, "payload": base64.StdEncoding.EncodeToString(part)}); err != nil {
			t.Fatal(err)
		}
	}
	var ack map[string]any
	if err := c.ReadJSON(&ack); err != nil {
		t.Fatal(err)
	}
	if ack["type"] != "ack" || ack["seq"] != float64(1) {
		t.Fatal("read cancellation damaged publication", ack)
	}
}
