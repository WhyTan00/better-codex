package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestStorageStartupDoesNotRequireReadableWritableCache(t *testing.T) {
	for _, damage := range []string{"directory", "corrupt"} {
		t.Run(damage, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "read-model-v1.sqlite")
			if damage == "directory" {
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			} else if err := os.WriteFile(path, []byte("unreadable optional cache"), 0600); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if value := recover(); value != nil {
					t.Fatalf("optional cache prevented relay startup: %T", value)
				}
			}()
			g := NewGateway(dir, "http://127.0.0.1", []byte(strings.Repeat("a", 32)), false)
			defer g.durable.close()
			g.agentEpoch = "source"
			if err := g.apply(snapshotFrame(1)); err != nil {
				t.Fatal("live source event blocked by cache", err)
			}
			if g.agentSeq != 1 {
				t.Fatal("live source cursor did not advance")
			}
		})
	}
}

func exhaustOptionalSQLite(t *testing.T, g *Gateway) {
	t.Helper()
	var pages int
	if err := g.durable.db.QueryRow("PRAGMA page_count").Scan(&pages); err != nil {
		t.Fatal(err)
	}
	if _, err := g.durable.db.Exec("PRAGMA max_page_count=" + strconv.Itoa(pages)); err != nil {
		t.Fatal(err)
	}
}

func TestStorageFullKeepsAuthenticatedBridgeEventsAndControl(t *testing.T) {
	g, _, bridge := readBridgeFixture(t)
	if err := g.apply(snapshotFrame(1)); err != nil {
		t.Fatal(err)
	}
	subscriber := &browser{send: make(chan any, 8)}
	g.mu.Lock()
	g.topicLocked("ai", "").Subscribers[subscriber] = true
	g.mu.Unlock()
	exhaustOptionalSQLite(t, g)
	payload, _ := json.Marshal(map[string]any{"text": strings.Repeat("x", 1<<20)})
	record := NativeRecord{SourceGeneration: "native-source", Scope: "ai", Key: "turn:" + threadID + ":" + turnID, Kind: "turn", ThreadID: threadID, Generation: "native-generation", Revision: 1, Payload: payload, Bytes: len(payload)}
	raw, _ := json.Marshal(record)
	f := frame{Type: "publish", Epoch: "source", Seq: 2, Scope: "ai", ThreadID: threadID, Event: Event{Type: "nativeRecord"}, Data: raw}
	if err := bridge.WriteJSON(f); err != nil {
		t.Fatal(err)
	}
	var ack map[string]any
	if err := bridge.ReadJSON(&ack); err != nil {
		t.Fatal("cache exhaustion disconnected live relay", err)
	}
	if ack["type"] != "ack" || ack["seq"] != float64(2) || ack["cachePersistence"] != "memory" {
		t.Fatal("volatile relay acknowledgement was not explicit", ack)
	}
	select {
	case <-subscriber.send:
	case <-time.After(time.Second):
		t.Fatal("live event was blocked by exhausted cache")
	}
	if err := g.apply(f); err != nil {
		t.Fatal("same source publication was not idempotent", err)
	}
	f.Data = append(raw[:len(raw)-1:len(raw)-1], []byte(",\"different\":true}")...)
	if err := g.apply(f); err == nil {
		t.Fatal("changed publication with same identity accepted")
	}
	if g.agentSeq != 2 {
		t.Fatal("duplicate advanced source cursor")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		_, err := g.call(ctx, "ai", "command", map[string]any{"requestId": "stable-command", "op": "stop", "threadId": threadID, "turnId": turnID})
		result <- err
	}()
	var command map[string]any
	if err := bridge.ReadJSON(&command); err != nil {
		t.Fatal("control forwarding lost with cache", err)
	}
	if command["type"] != "request" || command["op"] != "command" || command["body"].(map[string]any)["requestId"] != "stable-command" {
		t.Fatal("command identity changed", command)
	}
	if err := bridge.WriteJSON(map[string]any{"type": "reply", "id": command["id"], "result": map[string]any{"accepted": true}}); err != nil {
		t.Fatal(err)
	}
	if err := <-result; err != nil {
		t.Fatal(err)
	}
}

func TestStorageReadOnlyAndLegacyFileFailureKeepSourceProjection(t *testing.T) {
	for _, damage := range []string{"readonly", "history-path"} {
		t.Run(damage, func(t *testing.T) {
			g := testGateway(t)
			if err := g.apply(snapshotFrame(1)); err != nil {
				t.Fatal(err)
			}
			if damage == "readonly" {
				if _, err := g.durable.db.Exec("PRAGMA query_only=ON"); err != nil {
					t.Fatal(err)
				}
			} else {
				g.history.dir = filepath.Join(g.dir, "broken-history")
				if err := os.WriteFile(g.history.dir, []byte("optional cache path unavailable"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			f := snapshotFrame(2)
			f.Event.Snapshot.Turns[0].Items[0].Text = "new live value"
			if err := g.apply(f); err != nil {
				t.Fatal("source update blocked by optional storage", err)
			}
			if g.cachePersistence() != "memory" || g.agentSeq != 2 || g.topics[topicKey("ai", threadID)].Snapshot.Turns[0].Items[0].Text != "new live value" {
				t.Fatal("live projection did not survive storage failure")
			}
			if err := g.apply(snapshotFrame(1)); err != nil {
				t.Fatal("prior source identity was lost during fallback", err)
			}
			old := snapshotFrame(1)
			old.Event.Snapshot.Thread.Name = "changed old identity"
			if g.apply(old) == nil {
				t.Fatal("fallback accepted changed historical identity")
			}
		})
	}
}

func TestStorageMemoryModeDoesNotFakePersistentNotifications(t *testing.T) {
	g := newPushTest(t)
	g.agentEpoch = "source"
	if _, err := g.durable.db.Exec("PRAGMA query_only=ON"); err != nil {
		t.Fatal(err)
	}
	if err := g.apply(snapshotFrame(1)); err != nil {
		t.Fatal(err)
	}
	if g.cachePersistence() != "memory" {
		t.Fatal("storage mode unchanged")
	}
	if g.push.sendNext(context.Background()) {
		t.Fatal("volatile state started persistent notification work")
	}
	if _, err := newPushService(g); err == nil {
		t.Fatal("memory mode created another notification authority")
	}
	var jobs int
	if err := g.cacheStore().reader.QueryRow("SELECT count(*) FROM push_jobs").Scan(&jobs); err != nil || jobs != 0 {
		t.Fatal("volatile projection fabricated a notification receipt", err)
	}
}

func TestStorageLostVolatileProjectionRotatesReplayEpochWithoutACommand(t *testing.T) {
	g, _, bridge := readBridgeFixture(t)
	subscriber := &browser{send: make(chan any, 4)}
	g.mu.Lock()
	g.topicLocked("ai", "").Subscribers[subscriber] = true
	previous := g.epoch
	g.mu.Unlock()
	// Mac already acknowledged these derived frames in memory. An older disk
	// cache cannot reuse its old replay namespace when it resumes at that ACK.
	if err := bridge.WriteJSON(map[string]any{"type": "reset", "epoch": "source", "baseSeq": 8}); err != nil {
		t.Fatal(err)
	}
	var ack map[string]any
	if err := bridge.ReadJSON(&ack); err != nil {
		t.Fatal(err)
	}
	if ack["type"] != "ack" || ack["seq"] != float64(8) {
		t.Fatal("cache reset not acknowledged", ack)
	}
	select {
	case raw := <-subscriber.send:
		value := raw.(map[string]any)
		if value["type"] != "resync" || value["epoch"] == previous || value["reason"] != "projection_rebuilt" {
			t.Fatal("old replay cursor was reused", value)
		}
	case <-time.After(time.Second):
		t.Fatal("subscriber did not learn projection loss")
	}
	if g.cacheStore().meta("serverEpoch") == previous || g.agentEpoch != "source" {
		t.Fatal("replay epoch was not recorded separately from source identity")
	}
}

func TestStorageMemoryReadCacheEvictsEvenProtectedBatchInsteadOfGrowingWithoutLimit(t *testing.T) {
	store, err := openMemoryCache()
	if err != nil {
		t.Fatal(err)
	}
	defer store.close()
	if err = store.reset("source", 0); err != nil {
		t.Fatal(err)
	}
	// A whole protected publication batch can exceed the cache budget. The
	// source remains authoritative; ACKed projections are safe to evict.
	payload, _ := json.Marshal(map[string]any{"text": strings.Repeat("x", 9<<20)})
	frames := make([]frame, 0, 8)
	for index := 1; index <= 8; index++ {
		record := NativeRecord{Scope: "ai", Key: "synthetic-" + strconv.Itoa(index), Kind: "head", ThreadID: threadID, SourceGeneration: "native-source", Generation: "generation", Revision: uint64(index), Payload: payload, Bytes: len(payload)}
		raw, _ := json.Marshal(record)
		frames = append(frames, frame{Type: "publish", Epoch: "source", Seq: uint64(index), Scope: "ai", ThreadID: threadID, Event: Event{Type: "nativeRecord"}, Data: raw})
	}
	if err = store.commitBatch(frames, nil, &publicationMetrics{}); err != nil {
		t.Fatal(err)
	}
	var bytes, proofs, topics int64
	if err = store.reader.QueryRow("SELECT COALESCE(SUM(length(payload)),0) FROM native_records").Scan(&bytes); err != nil || bytes > 64<<20 {
		t.Fatal("memory cache exceeded its payload budget", bytes, err)
	}
	_ = store.reader.QueryRow("SELECT count(*) FROM received").Scan(&proofs)
	_ = store.reader.QueryRow("SELECT count(*) FROM topics").Scan(&topics)
	if proofs != 8 || topics != 0 || store.meta("adapterSeq") != "8" {
		t.Fatal("eviction changed source cursor or duplicated topic bodies", proofs, topics)
	}
}
