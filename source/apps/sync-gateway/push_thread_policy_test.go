package main

import (
	"testing"
	"time"
)

func TestSilentThreadPolicyPreservesOtherPushAndCancelsOnlyItsQueuedJobs(t *testing.T) {
	for _, realtime := range []bool{false, true} {
		t.Run(map[bool]string{false: "legacy", true: "isolated"}[realtime], func(t *testing.T) {
			g := newPushTest(t)
			if realtime {
				if e := g.enableRealtimeCache(); e != nil {
					t.Fatal(e)
				}
				var e error
				g.push, e = newPushService(g)
				if e != nil {
					t.Fatal(e)
				}
			}
			subscribeTest(t, g, "ai")
			catalogPushTest(t, g, "ai", map[string]any{"threadSource": "user"})
			completeTest(t, g, "ai", "before-policy", float64(time.Now().UnixMilli())/1000)
			w := pushRequest(g, "ai", "push-thread-policy", map[string]any{"threadId": pushThread, "silent": true})
			if w.Code != 200 {
				t.Fatalf("policy %d %s", w.Code, w.Body.String())
			}
			var queued, cancelled int
			g.push.store.db.QueryRow("SELECT count(*) FROM push_jobs WHERE thread_id=? AND state='queued'", pushThread).Scan(&queued)
			g.push.store.db.QueryRow("SELECT count(*) FROM push_jobs WHERE thread_id=? AND state='cancelled'", pushThread).Scan(&cancelled)
			if queued != 0 || cancelled != 1 {
				t.Fatalf("queued=%d cancelled=%d", queued, cancelled)
			}
			completeTest(t, g, "ai", "silent-result", float64(time.Now().UnixMilli())/1000)
			g.push.store.db.QueryRow("SELECT count(*) FROM push_jobs WHERE thread_id=?", pushThread).Scan(&queued)
			if queued != 1 {
				t.Fatalf("silent completion produced another job: %d", queued)
			}
			if w = pushRequest(g, "zyy", "push-thread-policy", map[string]any{"threadId": pushThread, "silent": true}); w.Code != 404 {
				t.Fatalf("wrong scope %d", w.Code)
			}
			if w = pushRequest(g, "ai", "push-thread-policy", map[string]any{"threadId": pushThread, "silent": false}); w.Code != 200 {
				t.Fatalf("restore %d", w.Code)
			}
			completeTest(t, g, "ai", "normal-result", float64(time.Now().UnixMilli())/1000)
			g.push.store.db.QueryRow("SELECT count(*) FROM push_jobs WHERE thread_id=? AND state='queued'", pushThread).Scan(&queued)
			if queued != 1 {
				t.Fatalf("other/normal pushes affected %d", queued)
			}
		})
	}
}
