package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestNativeCommittedReadBypassesUnrelatedWriter(t *testing.T) {
	g := testGateway(t)
	r := NativeRecord{SourceGeneration: "source", Scope: "ai", Key: "read:test", Kind: "history", ThreadID: threadID, Generation: "generation", Revision: 1, Payload: json.RawMessage(`{"text":"committed"}`)}
	raw, _ := json.Marshal(r)
	if err := g.apply(frame{Epoch: "source", Seq: 1, Scope: "ai", ThreadID: threadID, Event: Event{Type: "nativeRecord"}, Data: raw}); err != nil {
		t.Fatal(err)
	}
	tx, err := g.durable.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = tx.Exec("UPDATE native_records SET payload=? WHERE scope='ai' AND key='read:test'", []byte(`{"payload":{"text":"uncommitted"}}`)); err != nil {
		t.Fatal(err)
	}
	type result struct {
		record *NativeRecord
		err    error
	}
	done := make(chan result, 1)
	go func() { record, e := g.durable.nativeRecord("ai", "read:test"); done <- result{record, e} }()
	select {
	case got := <-done:
		if got.err != nil || got.record == nil || string(got.record.Payload) != string(r.Payload) {
			t.Fatalf("read did not return the committed version: %v", got.err)
		}
	case <-time.After(300 * time.Millisecond):
		tx.Rollback()
		<-done
		t.Fatal("committed read waited for an unrelated writer")
	}
}

func priorityBridge(t *testing.T, g *Gateway) *websocket.Conn {
	t.Helper()
	server := httptest.NewServer(g.Handler())
	t.Cleanup(server.Close)
	g.origin = server.URL
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/_sync-agent", http.Header{"Authorization": {"Bearer " + string(g.secret)}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	var message map[string]any
	if err = conn.ReadJSON(&message); err != nil {
		t.Fatal(err)
	}
	if err = conn.WriteJSON(map[string]any{"type": "reset", "epoch": "source", "baseSeq": g.agentSeq}); err != nil {
		t.Fatal(err)
	}
	if err = conn.ReadJSON(&message); err != nil || message["type"] != "ack" {
		t.Fatal("reset not committed", err)
	}
	return conn
}

func TestBridgeReplyBypassesBlockedPublication(t *testing.T) {
	g := testGateway(t)
	conn := priorityBridge(t, g)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := g.call(ctx, "ai", "native-read", map[string]any{}); done <- err }()
	var request map[string]any
	if err := conn.ReadJSON(&request); err != nil {
		t.Fatal(err)
	}
	g.persistMu.Lock()
	locked := true
	defer func() {
		if locked {
			g.persistMu.Unlock()
		}
	}()
	if err := conn.WriteJSON(snapshotFrame(1)); err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteJSON(map[string]any{"type": "reply", "id": request["id"], "result": map[string]any{"ok": true}}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(300 * time.Millisecond):
		g.persistMu.Unlock()
		locked = false
		<-done
		t.Fatal("control reply waited for unrelated publication persistence")
	}
	// Priority must not acknowledge or expose the uncommitted publication.
	if g.agentSeq != 0 {
		t.Fatal("publication acknowledged before commit")
	}
	g.persistMu.Unlock()
	locked = false
	var ack map[string]any
	if err := conn.ReadJSON(&ack); err != nil || ack["type"] != "ack" || ack["seq"] != float64(1) {
		t.Fatal("publication did not commit in order", err)
	}
}

func TestFreshHTTPReadCompletesWhileBackgroundStorageAndTopicsAreBlocked(t *testing.T) {
	g := testGateway(t)
	params := map[string]any{"threadId": threadID, "includeTurns": false}
	key, _ := json.Marshal([]any{"thread/read", params})
	record := NativeRecord{SourceGeneration: "source", Scope: "ai", Key: "read:" + string(key), Kind: "history", ThreadID: threadID, Generation: "generation", Revision: 41, Payload: json.RawMessage(`{"result":{"thread":{"id":"` + threadID + `","preview":"committed final body"}}}`)}
	raw, _ := json.Marshal(record)
	if err := g.apply(frame{Epoch: "source", Seq: 1, Scope: "ai", ThreadID: threadID, Event: Event{Type: "nativeRecord"}, Data: raw}); err != nil {
		t.Fatal(err)
	}
	conn := priorityBridge(t, g)
	tx, err := g.durable.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	g.persistMu.Lock()
	g.mu.Lock()
	locked := true
	defer func() {
		if locked {
			g.mu.Unlock()
			g.persistMu.Unlock()
		}
	}()
	body, _ := json.Marshal(map[string]any{"method": "thread/read", "params": params, "fresh": true})
	request, _ := http.NewRequest("POST", g.origin+"/sync/v1/w/ai/native-read", bytes.NewReader(body))
	request.Header.Set("Origin", g.origin)
	request.Header.Set("X-DSH-Authenticated", "1")
	request.Header.Set("X-DSH-Diagnostic-Trace", "55555555-5555-4555-a555-555555555555")
	type result struct {
		status int
		body   []byte
		err    error
	}
	done := make(chan result, 1)
	go func() {
		res, e := http.DefaultClient.Do(request)
		if e != nil {
			done <- result{err: e}
			return
		}
		defer res.Body.Close()
		raw, e := io.ReadAll(res.Body)
		done <- result{res.StatusCode, raw, e}
	}()
	var message map[string]any
	if err = conn.ReadJSON(&message); err != nil {
		t.Fatal(err)
	}
	if message["type"] != "request" {
		t.Fatal("missing native read")
	}
	if err = conn.WriteJSON(snapshotFrame(2)); err != nil {
		t.Fatal(err)
	}
	if err = conn.WriteJSON(map[string]any{"type": "reply", "id": message["id"], "result": map[string]any{"scope": "ai", "key": record.Key, "revision": 41, "sourceGeneration": "source", "generation": "generation"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-done:
		if got.err != nil || got.status != 200 || !bytes.Contains(got.body, []byte("committed final body")) {
			t.Fatalf("read lost committed body: %d %v", got.status, got.err)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("fresh HTTP read still waits for unrelated database/topic persistence")
	}
	tx.Rollback()
	g.mu.Unlock()
	g.persistMu.Unlock()
	locked = false
	if err = conn.ReadJSON(&message); err != nil || message["type"] != "ack" || message["seq"] != float64(2) {
		t.Fatal("background order lost", err)
	}
}

func TestQueuedCommitFailureDoesNotACKOrAdvance(t *testing.T) {
	g := testGateway(t)
	conn := priorityBridge(t, g)
	if _, err := g.durable.db.Exec(`CREATE TRIGGER reject_queued BEFORE INSERT ON received BEGIN SELECT RAISE(ABORT,'simulated failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteJSON(snapshotFrame(1)); err != nil {
		t.Fatal(err)
	}
	var message map[string]any
	if err := conn.ReadJSON(&message); err == nil {
		t.Fatal("failed commit returned a frame", message["type"])
	}
	g.mu.Lock()
	seq := g.agentSeq
	g.mu.Unlock()
	if seq != 0 || g.durable.meta("adapterSeq") != "0" {
		t.Fatal("failed commit advanced durable cursor")
	}
}

func TestPublicationQueueBoundsAndOrderedReplay(t *testing.T) {
	q := newPublicationQueue()
	if !q.offer(frame{Seq: 1}, 64<<20) || q.offer(frame{Seq: 2}, 1) {
		t.Fatal("publication byte bound not enforced")
	}
	first := <-q.jobs
	q.taken(first)
	for i := 1; i <= maxPublicationFrames; i++ {
		if !q.offer(frame{Seq: uint64(i)}, 1) {
			t.Fatal("queue unexpectedly full")
		}
	}
	if q.offer(frame{Seq: maxPublicationFrames + 1}, 1) {
		t.Fatal("publication frame bound not enforced")
	}
	for i := 1; i <= maxPublicationFrames; i++ {
		job := <-q.jobs
		q.taken(job)
		if job.frame.Seq != uint64(i) {
			t.Fatal("source order changed")
		}
	}
	frames, bytes := q.size()
	if frames != 0 || bytes != 0 {
		t.Fatal("queue accounting leak")
	}
}

func TestAccessRecencyIsCoalescedAndCannotWriteThroughReader(t *testing.T) {
	g := testGateway(t)
	r := NativeRecord{SourceGeneration: "source", Scope: "ai", Key: "history:test", Kind: "history", ThreadID: threadID, Generation: "generation", Revision: 1, Payload: json.RawMessage(`{"body":"committed"}`)}
	raw, _ := json.Marshal(r)
	if err := g.apply(frame{Epoch: "source", Seq: 1, Scope: "ai", ThreadID: threadID, Event: Event{Type: "nativeRecord"}, Data: raw}); err != nil {
		t.Fatal(err)
	}
	if _, err := g.durable.db.Exec("UPDATE native_records SET accessed_at=1"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if _, err := g.durable.nativeRecord("ai", r.Key); err != nil {
			t.Fatal(err)
		}
	}
	var accessed int64
	if err := g.durable.db.QueryRow("SELECT accessed_at FROM native_records WHERE scope='ai' AND key=?", r.Key).Scan(&accessed); err != nil || accessed != 1 {
		t.Fatal("read performed a synchronous recency write", err)
	}
	if _, err := g.durable.reader.Exec("UPDATE native_records SET accessed_at=2"); err == nil {
		t.Fatal("read pool can mutate history")
	}
	if err := g.apply(snapshotFrame(2)); err != nil {
		t.Fatal(err)
	}
	if err := g.durable.db.QueryRow("SELECT accessed_at FROM native_records WHERE scope='ai' AND key=?", r.Key).Scan(&accessed); err != nil || accessed <= 1 {
		t.Fatal("recency did not join the next transaction", err)
	}
}

func TestBatchCommitRollsBackAllFramesAndPublishesOnlyAfterCommit(t *testing.T) {
	for _, reject := range []bool{false, true} {
		t.Run(map[bool]string{false: "committed", true: "last_frame_failure"}[reject], func(t *testing.T) {
			g := testGateway(t)
			b := &browser{send: make(chan any, 10)}
			g.topicLocked("ai", threadID).Subscribers[b] = true
			if reject {
				if _, err := g.durable.db.Exec(`CREATE TRIGGER reject_batch BEFORE INSERT ON received WHEN NEW.seq=3 BEGIN SELECT RAISE(ABORT,'last frame rejected'); END`); err != nil {
					t.Fatal(err)
				}
			}
			frames := []frame{snapshotFrame(1), {Epoch: "source", Seq: 2, Scope: "ai", ThreadID: threadID, Event: Event{Type: "delta", TurnID: turnID, ItemID: "message", Delta: " two"}}, {Epoch: "source", Seq: 3, Scope: "ai", ThreadID: threadID, Event: Event{Type: "delta", TurnID: turnID, ItemID: "message", Delta: " three"}}}
			jobs := make([]queuedPublication, len(frames))
			for i, f := range frames {
				jobs[i] = queuedPublication{frame: f, at: time.Now()}
			}
			err := g.applyBatchFromBridge(jobs, nil)
			var received int
			g.durable.db.QueryRow("SELECT count(*) FROM received").Scan(&received)
			if reject {
				if err == nil || g.agentSeq != 0 || received != 0 || len(b.send) != 0 {
					t.Fatal("partial batch became visible", err, g.agentSeq, received, len(b.send))
				}
				return
			}
			if err != nil || g.agentSeq != 3 || received != 3 || len(b.send) != 3 {
				t.Fatal("batch did not commit every ordered frame", err)
			}
			if got := g.topics[topicKey("ai", threadID)].Snapshot.Turns[0].Items[0].Text; got != "base two three" {
				t.Fatal("batch changed source order", got)
			}
			other := NewGateway(g.dir, g.origin, g.secret, false)
			defer other.durable.close()
			if other.agentSeq != 3 || other.topics[topicKey("ai", threadID)].Snapshot.Turns[0].Items[0].Text != "base two three" {
				t.Fatal("acknowledged batch lost on restart")
			}
			if err = other.applyBatchFromBridge(jobs, nil); err != nil {
				t.Fatal("identical batch replay rejected", err)
			}
			frames[1].Event.Delta = "different"
			jobs[1].frame = frames[1]
			if err = other.applyBatchFromBridge(jobs, nil); err == nil {
				t.Fatal("same sequence with changed body accepted")
			}
		})
	}
}

func TestQueuedBurstUsesCumulativeACKAndKeepsLatestNativeRecord(t *testing.T) {
	g := testGateway(t)
	conn := priorityBridge(t, g)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := g.call(ctx, "ai", "native-read", map[string]any{}); done <- err }()
	var request map[string]any
	if err := conn.ReadJSON(&request); err != nil {
		t.Fatal(err)
	}
	g.persistMu.Lock()
	locked := true
	defer func() {
		if locked {
			g.persistMu.Unlock()
		}
	}()
	for i := 1; i <= 24; i++ {
		r := NativeRecord{SourceGeneration: "source", Scope: "ai", Key: "read:batch", Kind: "history", ThreadID: threadID, Generation: "generation", Revision: uint64(i), Payload: json.RawMessage(`{"body":"versioned"}`)}
		raw, _ := json.Marshal(r)
		if err := conn.WriteJSON(frame{Type: "publish", Epoch: "source", Seq: uint64(i), Scope: "ai", ThreadID: threadID, Event: Event{Type: "nativeRecord"}, Data: raw}); err != nil {
			t.Fatal(err)
		}
	}
	if err := conn.WriteJSON(map[string]any{"type": "reply", "id": request["id"], "result": map[string]any{"ok": true}}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("reply did not bypass queued burst")
	}
	g.persistMu.Unlock()
	locked = false
	last := 0
	batched := false
	for last < 24 {
		var ack map[string]any
		if err := conn.ReadJSON(&ack); err != nil {
			t.Fatal(err)
		}
		seq := int(ack["seq"].(float64))
		if ack["type"] != "ack" || seq <= last || seq > 24 {
			t.Fatal("invalid cumulative ACK", ack)
		}
		batched = batched || seq-last > 1
		last = seq
	}
	if !batched {
		t.Fatal("queued burst still fsyncs every record")
	}
	r, err := g.durable.nativeRecord("ai", "read:batch")
	if err != nil || r == nil || r.Revision != 24 {
		t.Fatal("latest committed native version lost", err)
	}
}
