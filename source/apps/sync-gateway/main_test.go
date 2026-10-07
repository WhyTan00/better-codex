package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

const threadID = "11111111-1111-4111-a111-111111111111"
const turnID = "22222222-2222-4222-a222-222222222222"

func testGateway(t *testing.T) *Gateway {
	t.Helper()
	g := NewGateway(t.TempDir(), "http://127.0.0.1", []byte(strings.Repeat("a", 32)), false)
	g.agentEpoch = "source"
	t.Cleanup(func() { g.agentHandlers.Wait(); g.closeCaches() })
	return g
}
func snapshotFrame(seq uint64) frame {
	return frame{Type: "publish", Epoch: "source", Seq: seq, Scope: "ai", ThreadID: threadID, Event: Event{Type: "snapshot", Snapshot: &Snapshot{Thread: Thread{ID: threadID, Name: "test", Status: Status{Type: "active"}}, Turns: []Turn{{ID: turnID, Status: "inProgress", Items: []Item{{ID: "message", TurnID: turnID, Type: "agentMessage", Text: "base"}}}}}}}
}
func TestSequenceGapAndDuplicates(t *testing.T) {
	g := testGateway(t)
	if err := g.apply(snapshotFrame(1)); err != nil {
		t.Fatal(err)
	}
	delta := frame{Type: "publish", Epoch: "source", Seq: 2, Scope: "ai", ThreadID: threadID, Event: Event{Type: "delta", TurnID: turnID, ItemID: "message", Delta: " new"}}
	if err := g.apply(delta); err != nil {
		t.Fatal(err)
	}
	if err := g.apply(delta); err != nil {
		t.Fatal(err)
	}
	topic := g.topics[topicKey("ai", threadID)]
	if got := topic.Snapshot.Turns[0].Items[0].Text; got != "base new" {
		t.Fatal(got)
	}
	delta.Seq = 4
	if g.apply(delta) == nil {
		t.Fatal("gap accepted")
	}
	if g.agentSeq != 2 {
		t.Fatal("gap advanced cursor")
	}
	delta.Seq = 3
	delta.Scope = "unknown"
	if g.apply(delta) == nil {
		t.Fatal("unknown scope accepted")
	}
}
func TestReplaySnapshotIsImmutable(t *testing.T) {
	g := testGateway(t)
	_ = g.apply(snapshotFrame(1))
	_ = g.apply(frame{Epoch: "source", Seq: 2, Scope: "ai", ThreadID: threadID, Event: Event{Type: "delta", TurnID: turnID, ItemID: "message", Delta: " later"}})
	first := g.topics[topicKey("ai", threadID)].Events[0]
	if first.Event.Snapshot.Turns[0].Items[0].Text != "base" {
		t.Fatal("snapshot replay changed after publication")
	}
}
func TestSSOAndOriginRequired(t *testing.T) {
	g := testGateway(t)
	server := httptest.NewServer(g.Handler())
	defer server.Close()
	g.origin = server.URL
	for _, test := range []struct {
		path, origin, auth string
		status             int
	}{{"/app", "", "", 401}, {"/app", "https://attacker.invalid", "1", 401}, {"/app", "", "1", 303}, {"/sync/v1/w/other/threads", "", "1", 404}, {"/sync/v1/w/ai/thread/../../other", "", "1", 400}} {
		r, _ := http.NewRequest("GET", server.URL+test.path, nil)
		r.Header.Set("Origin", test.origin)
		if test.origin != "" {
			r.Header.Set("Sec-Fetch-Mode", "cors")
			r.Header.Set("Sec-Fetch-Dest", "empty")
		}
		r.Header.Set("X-DSH-Authenticated", test.auth)
		client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		response, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != test.status {
			t.Errorf("%s got %d want %d", test.path, response.StatusCode, test.status)
		}
	}
}
func TestStoredSnapshotsSurviveOfflineRestart(t *testing.T) {
	g := testGateway(t)
	_ = g.apply(snapshotFrame(1))
	g.flush()
	name := snapshotFile(g.dir, "ai", threadID)
	info, err := os.Stat(name)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatal("cache is not private")
	}
	other := NewGateway(g.dir, g.origin, g.secret, false)
	if other.epoch != g.epoch {
		t.Fatal("durable server generation changed")
	}
	topic := other.topics[topicKey("ai", threadID)]
	if topic == nil || topic.Snapshot.Thread.Name != "test" {
		t.Fatal("snapshot not restored")
	}
	if other.nativeOnline {
		t.Fatal("stale cache reported online")
	}
}
func TestBrowserReplaysOnlyItsScopeAndRequestsResyncForExpiredCursor(t *testing.T) {
	g := testGateway(t)
	_ = g.apply(snapshotFrame(1))
	server := httptest.NewServer(g.Handler())
	defer server.Close()
	g.origin = server.URL
	headers := http.Header{"Origin": {server.URL}, "X-DSH-Authenticated": {"1"}}
	u := "ws" + strings.TrimPrefix(server.URL, "http") + "/sync/v1/w/ai/events/" + threadID + "?epoch=" + g.epoch + "&after=0"
	conn, _, err := websocket.DefaultDialer.Dial(u, headers)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(time.Second))
	var event Envelope
	if err = conn.ReadJSON(&event); err != nil {
		t.Fatal(err)
	}
	if event.Scope != "ai" || event.Seq != 1 || event.ThreadID != threadID {
		t.Fatalf("bad replay %#v", event)
	}
	g.mu.Lock()
	topic := g.topics[topicKey("ai", threadID)]
	topic.Events = nil
	topic.Seq = 10
	g.mu.Unlock()
	other, _, err := websocket.DefaultDialer.Dial(u, headers)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	other.SetReadDeadline(time.Now().Add(time.Second))
	var value map[string]any
	if err = other.ReadJSON(&value); err != nil {
		t.Fatal(err)
	}
	if value["type"] != "resync" {
		t.Fatal("expired empty buffer did not request resync")
	}
	z := "ws" + strings.TrimPrefix(server.URL, "http") + "/sync/v1/w/zyy/events/" + threadID + "?epoch=" + g.epoch + "&after=0"
	third, _, err := websocket.DefaultDialer.Dial(z, headers)
	if err != nil {
		t.Fatal(err)
	}
	defer third.Close()
	third.SetReadDeadline(time.Now().Add(time.Second))
	if err = third.ReadJSON(&value); err != nil {
		t.Fatal(err)
	}
	if value["type"] != "hello" {
		t.Fatal("AI event leaked into ZYY")
	}
}
func TestAgentRequiresSeparateCredentialAndRejectsBrowserOrigin(t *testing.T) {
	g := testGateway(t)
	server := httptest.NewServer(g.Handler())
	defer server.Close()
	u := "ws" + strings.TrimPrefix(server.URL, "http") + "/_sync-agent"
	for _, header := range []http.Header{{}, {"Authorization": {"Bearer " + string(g.secret)}, "Origin": {"https://workbench.example.test"}}} {
		conn, r, err := websocket.DefaultDialer.Dial(u, header)
		if conn != nil {
			conn.Close()
		}
		if err == nil {
			t.Fatal("unauthorized agent connected")
		}
		if r == nil || r.StatusCode < 400 {
			t.Fatal("missing denial")
		}
	}
}
func TestCachedReadDoesNotWaitForMac(t *testing.T) {
	g := testGateway(t)
	_ = g.apply(snapshotFrame(1))
	server := httptest.NewServer(g.Handler())
	defer server.Close()
	request, _ := http.NewRequest("GET", server.URL+"/sync/v1/w/ai/thread/"+threadID, nil)
	request.Header.Set("X-DSH-Authenticated", "1")
	start := time.Now()
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	var value map[string]any
	_ = json.Unmarshal(data, &value)
	if response.StatusCode != 200 || value["online"] != false || value["cached"] != true {
		t.Fatalf("bad cached response %s", data)
	}
	if time.Since(start) > time.Second {
		t.Fatal("cached read waited for source")
	}
}
