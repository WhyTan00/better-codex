package main

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
)

func TestHistoryRetentionKeepsServingPagesAndDeliveryIdentity(t *testing.T) {
	g := testGateway(t)
	f := snapshotFrame(1)
	if err := g.apply(f); err != nil {
		t.Fatal(err)
	}
	page := Snapshot{Thread: Thread{ID: threadID}, Turns: []Turn{{ID: tid(100)}}}
	raw, _ := json.Marshal(page)
	f = frame{Epoch: "source", Seq: 2, Scope: "ai", ThreadID: threadID, Event: Event{Type: "historyPage"}, Data: raw}
	if err := g.apply(f); err != nil {
		t.Fatal(err)
	}
	var count int
	g.durable.reader.QueryRow("SELECT count(*) FROM history_pages").Scan(&count)
	if count != 0 {
		t.Fatal("write-only archive grew")
	}
	for i := 0; i < 270; i++ {
		if _, err := g.durable.db.Exec("INSERT INTO history_pages VALUES(?,?,?,?)", "ai", threadID, fmt.Sprint(i), []byte(`old`)); err != nil {
			t.Fatal(err)
		}
	}
	g.persistMu.Lock()
	n, err := g.pruneUnusedHistory(context.Background())
	g.persistMu.Unlock()
	if err != nil || n != 0 {
		t.Fatal("maintenance delayed active writer", n, err)
	}
	n, err = g.pruneUnusedHistory(context.Background())
	if err != nil || n != 256 {
		t.Fatal(n, err)
	}
	if g.durable.meta("adapterSeq") != "2" {
		t.Fatal("receipt changed")
	}
	if err = g.apply(f); err != nil {
		t.Fatal("exact replay identity lost", err)
	}
	reopened := NewGateway(g.dir, g.origin, g.secret, false)
	defer reopened.durable.close()
	index, err := reopened.history.indexLocked("ai", threadID)
	if err != nil || len(index.Turns) == 0 || index.Turns[0] != tid(100) {
		t.Fatal("serving history lost", err, index)
	}
	g.durable.reader.QueryRow("SELECT count(*) FROM history_pages").Scan(&count)
	if count != 14 {
		t.Fatal(count)
	}
}

func TestHistoryRetentionFailureRollsBackBatch(t *testing.T) {
	g := testGateway(t)
	for i := 0; i < 3; i++ {
		g.durable.db.Exec("INSERT INTO history_pages VALUES(?,?,?,?)", "ai", threadID, fmt.Sprint(i), []byte(`old`))
	}
	g.durable.db.Exec("CREATE TRIGGER reject_gc BEFORE DELETE ON history_pages WHEN OLD.page_hash='1' BEGIN SELECT RAISE(ABORT,'fixture'); END")
	if _, err := g.pruneUnusedHistory(context.Background()); err == nil {
		t.Fatal("failed GC accepted")
	}
	var count int
	g.durable.reader.QueryRow("SELECT count(*) FROM history_pages").Scan(&count)
	if count != 3 {
		t.Fatal("partial cleanup committed", count)
	}
}
