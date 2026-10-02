package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func waitRealtime(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("background cache condition did not finish")
		}
		time.Sleep(time.Millisecond)
	}
}
func realtimeGateway(t *testing.T) *Gateway {
	t.Helper()
	g := testGateway(t)
	if err := g.enableRealtimeCache(); err != nil {
		t.Fatal(err)
	}
	return g
}
func TestRealtimeACKEventsAndControlDoNotWaitForReplica(t *testing.T) {
	g, _, c := readBridgeFixture(t, true)
	waitRealtime(t, func() bool { return g.replica.committed.Load().epoch == "source" })
	blocked, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	g.replica.storageMu.Lock()
	g.replica.beforeWrite = func() { once.Do(func() { close(blocked) }); <-release }
	g.replica.storageMu.Unlock()
	t.Cleanup(func() { close(release) })
	subscriber := &browser{send: make(chan any, 8)}
	g.mu.Lock()
	g.topicLocked("ai", threadID).Subscribers[subscriber] = true
	g.mu.Unlock()
	if err := c.WriteJSON(snapshotFrame(1)); err != nil {
		t.Fatal(err)
	}
	var ack map[string]any
	if err := c.ReadJSON(&ack); err != nil {
		t.Fatal(err)
	}
	if ack["type"] != "ack" || ack["seq"] != float64(1) {
		t.Fatal("live ACK was not accepted", ack)
	}
	select {
	case <-blocked:
	case <-time.After(time.Second):
		t.Fatal("replica did not enter held write")
	}
	state := ack["cacheReplica"].(map[string]any)
	if state["persistedSeq"] != float64(0) || state["projectionCommitted"] != false {
		t.Fatal("RAM ACK fabricated disk commit", state)
	}
	select {
	case <-subscriber.send:
	case <-time.After(time.Second):
		t.Fatal("event waited for cache writer")
	}
	delta := frame{Type: "publish", Epoch: "source", Seq: 2, Scope: "ai", ThreadID: threadID, Event: Event{Type: "delta", TurnID: turnID, ItemID: "message", Delta: " new"}}
	if err := c.WriteJSON(delta); err != nil {
		t.Fatal(err)
	}
	if err := c.ReadJSON(&ack); err != nil {
		t.Fatal(err)
	}
	if ack["seq"] != float64(2) {
		t.Fatal("second live ACK waited for held replica", ack)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := g.call(ctx, "ai", "command", map[string]any{"requestId": "stable", "op": "stop", "threadId": threadID, "turnId": turnID})
		done <- err
	}()
	var request map[string]any
	if err := c.ReadJSON(&request); err != nil {
		t.Fatal(err)
	}
	if request["op"] != "command" || request["body"].(map[string]any)["requestId"] != "stable" {
		t.Fatal("control identity changed")
	}
	if err := c.WriteJSON(map[string]any{"type": "reply", "id": request["id"], "result": map[string]any{"accepted": true}}); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal("command waited for cache", err)
	}
	if g.replica.committed.Load().sequence != 0 {
		t.Fatal("held optional cache committed")
	}
}
func TestRealtimeColdCacheLookupHasIndependentBudget(t *testing.T) {
	g := realtimeGateway(t)
	var held []*sql.Conn
	for i := 0; i < 4; i++ {
		conn, err := g.durable.reader.Conn(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		held = append(held, conn)
	}
	t.Cleanup(func() {
		for _, conn := range held {
			conn.Close()
		}
	})
	start := time.Now()
	r, err := g.cacheStore().nativeRecordContext(context.Background(), "ai", "missing", nil, "")
	if r != nil || err == nil || time.Since(start) > 250*time.Millisecond {
		t.Fatal("cold cache borrowed the Native operation budget", err, time.Since(start))
	}
}
func TestRealtimeLegacyHistoryCannotHoldForegroundOrGrowWaiters(t *testing.T) {
	g := realtimeGateway(t)
	g.history.mu.Lock()
	locked := true
	defer func() {
		if locked {
			g.history.mu.Unlock()
		}
	}()
	start := time.Now()
	for i := 0; i < 6; i++ {
		if _, err := g.boundedHistoryPage(context.Background(), "ai", threadID, "cached:"+turnID, Thread{ID: threadID}); err == nil {
			t.Fatal("busy history accepted")
		}
	}
	if time.Since(start) > 400*time.Millisecond || len(g.replica.lookups) != 4 {
		t.Fatal("old pages blocked or created unbounded readers")
	}
	g.history.mu.Unlock()
	locked = false
	waitRealtime(t, func() bool { return len(g.replica.lookups) == 0 })
}
func TestRealtimeLostProjectionDoesNotReuseStaleCacheOrEpoch(t *testing.T) {
	g, _, c := readBridgeFixture(t, true)
	previous := g.epoch
	if err := c.WriteJSON(map[string]any{"type": "reset", "epoch": "source", "baseSeq": 8}); err != nil {
		t.Fatal(err)
	}
	var ack map[string]any
	if err := c.ReadJSON(&ack); err != nil {
		t.Fatal(err)
	}
	g.mu.Lock()
	epoch, seq := g.epoch, g.agentSeq
	g.mu.Unlock()
	if ack["seq"] != float64(8) || epoch == previous || seq != 8 || !g.cacheStore().catalogLimited.Load() || g.cacheStore().fallback.Load() != nil {
		t.Fatal("lost derived projection reused cache authority")
	}
}
func TestRealtimeOptionalStorageFailuresKeepLiveProjection(t *testing.T) {
	for _, damage := range []string{"readonly", "full"} {
		t.Run(damage, func(t *testing.T) {
			g := realtimeGateway(t)
			if damage == "readonly" {
				if _, err := g.durable.db.Exec("PRAGMA query_only=ON"); err != nil {
					t.Fatal(err)
				}
			} else {
				exhaustOptionalSQLite(t, g)
			}
			payload, _ := json.Marshal(map[string]any{"text": strings.Repeat("x", 1<<20)})
			record := NativeRecord{Scope: "ai", Key: "test", Kind: "head", ThreadID: threadID, SourceGeneration: "native-source", Generation: "thread", Revision: 1, Payload: payload, Bytes: len(payload)}
			raw, _ := json.Marshal(record)
			if err := g.apply(frame{Epoch: "source", Seq: 1, Scope: "ai", ThreadID: threadID, Event: Event{Type: "nativeRecord"}, Data: raw}); err != nil {
				t.Fatal(err)
			}
			waitRealtime(t, func() bool { return g.cachePersistence() == "memory" })
			if err := g.apply(snapshotFrame(2)); err != nil {
				t.Fatal("live source stopped after replica failure", err)
			}
			if g.agentSeq != 2 || g.topics[topicKey("ai", threadID)].Snapshot.Turns[0].Items[0].Text != "base" {
				t.Fatal("live projection lost")
			}
		})
	}
}
func TestRealtimeQueueCountsSnapshotBodiesAndStopsOnlyCache(t *testing.T) {
	g := realtimeGateway(t)
	tpc := &Topic{Snapshot: &Snapshot{Thread: Thread{ID: threadID}, Turns: []Turn{{ID: turnID, Items: []Item{{Text: strings.Repeat("x", 2<<20)}}}}}, List: map[string]Thread{}, Approvals: map[string]json.RawMessage{}}
	g.replica.queuedBytes.Store(replicaQueueBudget - (1 << 20))
	g.mirrorBatch(nil, map[string]*Topic{"ai:" + threadID: tpc})
	if g.cachePersistence() != "memory" || g.cacheStore().fallback.Load() != nil {
		t.Fatal("snapshot bodies escaped replica capacity accounting")
	}
	if err := g.apply(snapshotFrame(1)); err != nil {
		t.Fatal("cache capacity stopped relay", err)
	}
}
func TestRealtimeNotificationMigrationAndCacheIsolation(t *testing.T) {
	g := newPushTest(t)
	subscribeTest(t, g, "ai")
	catalogPushTest(t, g, "ai", map[string]any{"threadSource": "user"})
	completeTest(t, g, "ai", "migrated", float64(time.Now().UnixMilli())/1000)
	var oldID, receipt string
	if err := g.durable.db.QueryRow("SELECT id,receipt FROM push_jobs").Scan(&oldID, &receipt); err != nil {
		t.Fatal(err)
	}
	if err := g.enableRealtimeCache(); err != nil {
		t.Fatal(err)
	}
	p, err := newPushService(g)
	if err != nil {
		t.Fatal(err)
	}
	g.push = p
	var owner, gotReceipt string
	var devices, jobs int
	p.store.db.QueryRow("SELECT recipient FROM push_device_owners").Scan(&owner)
	p.store.db.QueryRow("SELECT receipt FROM push_jobs WHERE id=?", oldID).Scan(&gotReceipt)
	p.store.db.QueryRow("SELECT count(*) FROM push_devices WHERE enabled=1").Scan(&devices)
	if owner != "ai" || receipt != gotReceipt || devices != 1 {
		t.Fatal("migration lost ownership, opt-in or receipt")
	}
	g.disableCacheReplica("test_storage")
	if !p.notificationAvailable() {
		t.Fatal("large cache disabled separate notification store")
	}
	catalogPushTest(t, g, "ai", map[string]any{"threadSource": "user"})
	completeTest(t, g, "ai", "new-completion", float64(time.Now().UnixMilli())/1000)
	p.store.db.QueryRow("SELECT count(*) FROM push_jobs").Scan(&jobs)
	if jobs != 2 {
		t.Fatal("completion was lost or duplicated", jobs)
	}
	completeTest(t, g, "ai", "new-completion", float64(time.Now().UnixMilli())/1000)
	p.store.db.QueryRow("SELECT count(*) FROM push_jobs").Scan(&jobs)
	if jobs != 2 {
		t.Fatal("completion replay created another job")
	}
	catalogPushTest(t, g, "ai", map[string]any{"threadSource": "subagent"})
	completeTest(t, g, "ai", "child", float64(time.Now().UnixMilli())/1000)
	p.store.db.QueryRow("SELECT count(*) FROM push_jobs").Scan(&jobs)
	if jobs != 2 {
		t.Fatal("subagent notified")
	}
	w := pushRequest(g, "ai", "push-received", map[string]any{"jobId": oldID, "receipt": receipt})
	if w.Code != 204 {
		t.Fatal("migrated receipt failed", w.Code)
	}
	w = pushRequest(g, "ai", "push-disable", map[string]string{"deviceKey": pushDevice})
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	legacyJobs := 0
	g.durable.db.QueryRow("SELECT count(*) FROM push_jobs").Scan(&legacyJobs)
	if legacyJobs != 1 {
		t.Fatal("large replica became a second notification authority")
	}
	health := httptest.NewRecorder()
	g.Handler().ServeHTTP(health, httptest.NewRequest("GET", "/__sync_health", nil))
	if !strings.Contains(health.Body.String(), `"notifications":true`) {
		t.Fatal("health coupled notifications to large cache", health.Body.String())
	}
	if err := p.store.close(); err != nil {
		t.Fatal(err)
	}
	restored, err := newPushService(g)
	if err != nil {
		t.Fatal(err)
	}
	g.push = restored
	restored.store.db.QueryRow("SELECT count(*) FROM push_devices WHERE enabled=1").Scan(&devices)
	if devices != 0 {
		t.Fatal("restart remigrated an obsolete opt-in")
	}
	restored.store.db.QueryRow("SELECT receipt FROM push_jobs WHERE id=?", oldID).Scan(&gotReceipt)
	if gotReceipt != receipt {
		t.Fatal("restart changed receipt")
	}
}
func TestRealtimeCompletionACKIncludesDurableNotificationIntent(t *testing.T) {
	g, _, c := readBridgeFixture(t, true)
	var err error
	g.push, err = newPushService(g)
	if err != nil {
		t.Fatal(err)
	}
	subscribeTest(t, g, "ai")
	payload, _ := json.Marshal(map[string]any{"displayTitle": "synthetic", "nativeThread": map[string]any{"id": threadID, "threadSource": "user"}})
	record := NativeRecord{Scope: "ai", Key: "thread:" + threadID, Kind: "catalog", ThreadID: threadID, SourceGeneration: "native", Generation: "thread", Revision: 1, Payload: payload}
	raw, _ := json.Marshal(record)
	if err := c.WriteJSON(frame{Type: "publish", Epoch: "source", Seq: 1, Scope: "ai", ThreadID: threadID, Event: Event{Type: "nativeRecord"}, Data: raw}); err != nil {
		t.Fatal(err)
	}
	var ack map[string]any
	if err := c.ReadJSON(&ack); err != nil {
		t.Fatal(err)
	}
	g.disableCacheReplica("test_storage")
	now := float64(time.Now().UnixMilli()) / 1000
	completion := &Turn{ID: turnID, Status: "completed", CompletedAt: &now, Items: []Item{{ID: "final", TurnID: turnID, Type: "agentMessage", Text: "synthetic final answer"}}}
	if err := c.WriteJSON(frame{Type: "publish", Epoch: "source", Seq: 2, Scope: "ai", ThreadID: threadID, Event: Event{Type: "turn", Turn: completion}}); err != nil {
		t.Fatal(err)
	}
	if err := c.ReadJSON(&ack); err != nil {
		t.Fatal(err)
	}
	if ack["type"] != "ack" || ack["seq"] != float64(2) {
		t.Fatal(ack)
	}
	var jobs int
	var summary string
	g.push.store.db.QueryRow("SELECT count(*) FROM push_jobs").Scan(&jobs)
	g.push.store.db.QueryRow("SELECT summary FROM push_completion_content WHERE turn_id=?", turnID).Scan(&summary)
	if jobs != 1 || summary != "synthetic final answer" {
		t.Fatal("completion ACK retired source before reliable intent/preview", jobs, summary)
	}
}
