package main

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"
)

func tid(n int) string { return fmt.Sprintf("%08x-0000-4000-a000-000000000000", n) }
func TestHistoryPagesSurviveRestartWithoutTimeOrderedIDs(t *testing.T) {
	h := &HistoryStore{dir: t.TempDir()}
	next := "native-old"
	head := Snapshot{Thread: Thread{ID: threadID}, Turns: []Turn{{ID: tid(1)}, {ID: tid(2)}}, NextCursor: &next}
	if err := h.save("ai", head, true, false); err != nil {
		t.Fatal(err)
	}
	older := Snapshot{Thread: head.Thread, Turns: []Turn{{ID: tid(100)}, {ID: tid(99)}}}
	if err := h.save("ai", older, false, true); err != nil {
		t.Fatal(err)
	}
	h = &HistoryStore{dir: h.dir}
	cursor := h.cursor("ai", threadID, head)
	if cursor == nil {
		t.Fatal("history cursor lost")
	}
	page, err := h.page("ai", threadID, *cursor, head.Thread)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Turns) != 2 || page.Turns[0].ID != tid(100) || page.Turns[1].ID != tid(99) || page.NextCursor != nil {
		t.Fatalf("wrong native order: %+v", page)
	}
	if _, err = h.page("secondary", threadID, *cursor, head.Thread); err == nil {
		t.Fatal("cross-scope history accepted")
	}
	// A fresh head replaces its tail after rollback, preserving older pages.
	head.Turns = head.Turns[:1]
	if err = h.save("ai", head, true, false); err != nil {
		t.Fatal(err)
	}
	index, _ := h.indexLocked("ai", threadID)
	if len(index.Turns) != 3 || index.Turns[2] != tid(1) {
		t.Fatal(index.Turns)
	}
}
func TestSnapshotConditionalReadHasNoBodyOffline(t *testing.T) {
	g := testGateway(t)
	if err := g.apply(snapshotFrame(1)); err != nil {
		t.Fatal(err)
	}
	g.flush()
	r := httptest.NewRequest("GET", "/sync/v1/w/ai/thread/"+threadID, nil)
	r.Header.Set("X-BETTER_CODEX-Authenticated", "1")
	w := httptest.NewRecorder()
	g.Handler().ServeHTTP(w, r)
	if w.Code != 200 || w.Header().Get("ETag") == "" {
		t.Fatal(w.Code, w.Body.String())
	}
	var result map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	if result["online"] != false {
		t.Fatal("offline state missing")
	}
	r.Header.Set("If-None-Match", w.Header().Get("ETag"))
	w = httptest.NewRecorder()
	g.Handler().ServeHTTP(w, r)
	if w.Code != 304 || w.Body.Len() != 0 {
		t.Fatal("unchanged body retransmitted", w.Code, w.Body.Len())
	}
	// An actual text delta must invalidate the version.
	_ = g.apply(frame{Epoch: "source", Seq: 2, Scope: "ai", ThreadID: threadID, Event: Event{Type: "delta", TurnID: turnID, ItemID: "message", Delta: " changed"}})
	w = httptest.NewRecorder()
	g.Handler().ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal("changed content suppressed", w.Code)
	}
}

func TestPendingApprovalSurvivesBrowserReopen(t *testing.T) {
	g := testGateway(t)
	_ = g.apply(snapshotFrame(1))
	request := json.RawMessage(`{"id":7,"method":"item/commandExecution/requestApproval","threadId":"` + threadID + `"}`)
	_ = g.apply(frame{Epoch: "source", Seq: 2, Scope: "ai", ThreadID: threadID, Event: Event{Type: "approval", Request: request}})
	r := httptest.NewRequest("GET", "/sync/v1/w/ai/thread/"+threadID, nil)
	r.Header.Set("X-BETTER_CODEX-Authenticated", "1")
	w := httptest.NewRecorder()
	g.Handler().ServeHTTP(w, r)
	var value struct {
		Approvals []json.RawMessage `json:"approvals"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &value)
	if len(value.Approvals) != 1 {
		t.Fatal("pending approval lost on new snapshot")
	}
	r.Header.Set("If-None-Match", w.Header().Get("ETag"))
	w = httptest.NewRecorder()
	g.Handler().ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal("pending decision hidden by 304")
	}
	_ = g.apply(frame{Epoch: "source", Seq: 3, Scope: "ai", ThreadID: threadID, Event: Event{Type: "approvalResolved", RequestID: json.RawMessage(`7`)}})
	w = httptest.NewRecorder()
	g.Handler().ServeHTTP(w, r)
	if w.Code != 304 {
		t.Fatal("resolved approval still pending")
	}
}
