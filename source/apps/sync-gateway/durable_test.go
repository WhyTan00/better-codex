package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCommittedDeltaAndCursorSurviveWithoutFlush(t *testing.T) {
	g := testGateway(t)
	if e := g.apply(snapshotFrame(1)); e != nil {
		t.Fatal(e)
	}
	f := frame{Epoch: "source", Seq: 2, Scope: "ai", ThreadID: threadID, Event: Event{Type: "delta", TurnID: turnID, ItemID: "agent", Delta: "persisted delta"}}
	if e := g.apply(f); e != nil {
		t.Fatal(e)
	}
	other := NewGateway(g.dir, g.origin, g.secret, false)
	defer other.durable.close()
	if other.agentSeq != 2 || other.agentEpoch != "source" {
		t.Fatal("committed sender cursor not restored")
	}
	raw, _ := json.Marshal(other.topics[topicKey("ai", threadID)].Snapshot)
	if !strings.Contains(string(raw), "persisted delta") {
		t.Fatal("acknowledged delta lost")
	}
	if e := other.apply(f); e != nil {
		t.Fatal("identical replay rejected", e)
	}
	f.Event.Delta = "different"
	if e := other.apply(f); e == nil {
		t.Fatal("same sequence with different payload accepted")
	}
}
func TestFailedCommitNeitherPublishesNorAdvancesAndDoesNotRecoverShadowFile(t *testing.T) {
	g := testGateway(t)
	b := &browser{send: make(chan any, 10)}
	g.topicLocked("ai", threadID).Subscribers[b] = true
	if _, e := g.durable.db.Exec(`CREATE TRIGGER reject_commit BEFORE INSERT ON received BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END`); e != nil {
		t.Fatal(e)
	}
	if e := g.apply(snapshotFrame(1)); e == nil {
		t.Fatal("commit failure acknowledged")
	}
	if g.agentSeq != 0 {
		t.Fatal("failed cursor advanced")
	}
	if len(b.send) != 0 {
		t.Fatal("uncommitted event published")
	}
	other := NewGateway(g.dir, g.origin, g.secret, false)
	defer other.durable.close()
	if value := other.topics[topicKey("ai", threadID)]; value != nil && value.Snapshot != nil {
		t.Fatal("uncommitted shadow file became authority")
	}
}
func TestNativeFullDTOAndCatalogTombstoneRemainScopedAfterRestart(t *testing.T) {
	g := testGateway(t)
	r := NativeRecord{SourceGeneration: "source-db", Scope: "ai", Key: "thread:" + threadID, Kind: "catalog", ThreadID: threadID, Generation: "generation", Revision: 1, Payload: json.RawMessage(`{"displayTitle":"native title","nativeThread":{"id":"` + threadID + `","opaqueNewNativeField":{"keep":true}}}`)}
	raw, _ := json.Marshal(r)
	if e := g.apply(frame{Epoch: "source", Seq: 1, Scope: "ai", ThreadID: threadID, Event: Event{Type: "nativeRecord"}, Data: raw}); e != nil {
		t.Fatal(e)
	}
	other := NewGateway(g.dir, g.origin, g.secret, false)
	defer other.durable.close()
	got, e := other.durable.nativeRecord("ai", r.Key)
	if e != nil || got == nil || !strings.Contains(string(got.Payload), "opaqueNewNativeField") {
		t.Fatal("full native DTO lost", e)
	}
	if got, e = other.durable.nativeRecord("zyy", r.Key); e != nil || got != nil {
		t.Fatal("cache crossed workspace")
	}
	r.Revision = 2
	r.Deleted = true
	r.Payload = json.RawMessage(`null`)
	raw, _ = json.Marshal(r)
	if e = other.apply(frame{Epoch: "source", Seq: 2, Scope: "ai", ThreadID: threadID, Event: Event{Type: "nativeRecord"}, Data: raw}); e != nil {
		t.Fatal(e)
	}
	req := httptest.NewRequest("GET", "/sync/v1/w/ai/native-catalog?after=1", nil)
	req.Header.Set("X-DSH-Authenticated", "1")
	w := httptest.NewRecorder()
	other.Handler().ServeHTTP(w, req)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"deleted":true`) {
		t.Fatal("tombstone not delivered", w.Body.String())
	}
}
