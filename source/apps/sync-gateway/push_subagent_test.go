package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func catalogPushTest(t *testing.T, g *Gateway, scope string, fields map[string]any) {
	t.Helper()
	fields["id"] = pushThread
	payload, _ := json.Marshal(map[string]any{"nativeThread": fields})
	r := NativeRecord{SourceGeneration: "test-db", Scope: scope, Key: "thread:" + pushThread, Kind: "catalog", ThreadID: pushThread, Generation: "test", Revision: g.agentSeq + 1, Payload: payload}
	raw, _ := json.Marshal(r)
	if err := g.apply(frame{Epoch: "test", Seq: g.agentSeq + 1, Scope: scope, ThreadID: pushThread, Event: Event{Type: "nativeRecord"}, Data: raw}); err != nil {
		t.Fatal(err)
	}
}

func TestSubagentCompletionPolicy(t *testing.T) {
	for _, tc := range []struct {
		name   string
		fields map[string]any
		child  bool
	}{
		{"native-user", map[string]any{"threadSource": "user", "source": "vscode", "parentThreadId": nil}, false},
		{"ordinary-fork", map[string]any{"forkedFromId": "parent", "source": "cli"}, false},
		{"source-tag", map[string]any{"threadSource": "subagent"}, true},
		{"parent", map[string]any{"parentThreadId": "parent"}, true},
		{"native-source", map[string]any{"source": map[string]any{"subAgent": map[string]any{"thread_spawn": map[string]any{"parent_thread_id": "parent"}}}}, true},
		{"legacy-source", map[string]any{"source": "subAgentThreadSpawn"}, true},
		{"null-parent", map[string]any{"parentThreadId": "null"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := newPushTest(t)
			subscribeTest(t, g, "ai")
			catalogPushTest(t, g, "ai", tc.fields)
			completeTest(t, g, "ai", "complete", float64(time.Now().UnixMilli())/1000)
			want := 1
			if tc.child {
				want = 0
			}
			if jobCount(t, g) != want {
				t.Fatal("wrong notification admission")
			}
		})
	}
}

func TestCompletionBeforeCatalogWaitsThenClassifies(t *testing.T) {
	for _, child := range []bool{false, true} {
		name := "root"
		if child {
			name = "child"
		}
		t.Run(name, func(t *testing.T) {
			g := newPushTest(t)
			subscribeTest(t, g, "ai")
			calls := 0
			g.push.client = pushClientFunc(func(*http.Request) (*http.Response, error) {
				calls++
				return &http.Response{StatusCode: 201, Body: io.NopCloser(strings.NewReader(""))}, nil
			})
			completeTest(t, g, "ai", "complete", float64(time.Now().UnixMilli())/1000)
			catalogPushTest(t, g, "zyy", map[string]any{"threadSource": "user"})
			if g.push.sendNext(context.Background()) || calls != 0 {
				t.Fatal("unknown identity or other scope allowed delivery")
			}
			fields := map[string]any{"threadSource": "user"}
			if child {
				fields["threadSource"] = "subagent"
			}
			catalogPushTest(t, g, "ai", fields)
			if !g.push.sendNext(context.Background()) {
				t.Fatal("catalog did not unblock job")
			}
			want := 1
			stateWant := "sent"
			if child {
				want = 0
				stateWant = "cancelled"
			}
			var state string
			g.durable.db.QueryRow("SELECT state FROM push_jobs").Scan(&state)
			if calls != want || state != stateWant {
				t.Fatalf("calls=%d state=%s", calls, state)
			}
		})
	}
}
