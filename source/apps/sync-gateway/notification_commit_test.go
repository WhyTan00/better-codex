package main

import (
	"testing"
	"time"
)

func TestNotificationFailureCannotACKAndReplayDurablyDeduplicates(t *testing.T) {
	g := realtimeGateway(t)
	var err error
	g.push, err = newPushService(g)
	if err != nil {
		t.Fatal(err)
	}
	if !g.push.isolated {
		t.Fatal("fixture did not use separate authority")
	}
	subscribeTest(t, g, "ai")
	g.agentEpoch = "test"
	now := float64(time.Now().UnixMilli()) / 1000
	f := frame{Epoch: "test", Seq: g.agentSeq + 1, Scope: "ai", ThreadID: pushThread, Event: Event{Type: "turn", Turn: &Turn{ID: "notification-commit", Status: "completed", CompletedAt: &now}}}
	before := g.agentSeq
	if _, err = g.push.store.db.Exec("PRAGMA query_only=ON"); err != nil {
		t.Fatal(err)
	}
	if g.apply(f) == nil {
		t.Fatal("source acknowledged without notification authority")
	}
	if g.agentSeq != before {
		t.Fatal("failure advanced source ACK")
	}
	if _, err = g.push.store.db.Exec("PRAGMA query_only=OFF"); err != nil {
		t.Fatal(err)
	}
	if err = g.apply(f); err != nil {
		t.Fatal(err)
	}
	if g.agentSeq != f.Seq {
		t.Fatal("restored authority did not advance source")
	}
	if err = g.apply(f); err != nil {
		t.Fatal(err)
	}
	var n int
	if err = g.push.store.db.QueryRow("SELECT count(*) FROM push_jobs WHERE turn_id=?", "notification-commit").Scan(&n); err != nil || n != 1 {
		t.Fatal("replay lost or duplicated durable intent", n, err)
	}
	if g.push.projectionFailed.Load() {
		t.Fatal("failure never recovered")
	}
}
