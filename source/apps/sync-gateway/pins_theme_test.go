package main

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestPinsPersistAndSortAheadOfRecent(t *testing.T) {
	g := testGateway(t)
	_ = g.apply(snapshotFrame(1))
	data, _ := json.Marshal(map[string]any{"ids": []string{threadID}, "data": []Thread{{ID: threadID, Name: "pinned", UpdatedAt: 1}}})
	if err := g.apply(frame{Epoch: "source", Seq: 2, Scope: "ai", Event: Event{Type: "pins"}, Data: data}); err != nil {
		t.Fatal(err)
	}
	if err := g.apply(frame{Epoch: "source", Seq: 3, Scope: "ai", Event: Event{Type: "thread", Thread: &Thread{ID: turnID, UpdatedAt: 100}}}); err != nil {
		t.Fatal(err)
	}
	g.flush()
	g = NewGateway(g.dir, g.origin, g.secret, false)
	r := httptest.NewRequest("GET", "/sync/v1/w/ai/threads", nil)
	r.Header.Set("X-BETTER_CODEX-Authenticated", "1")
	w := httptest.NewRecorder()
	g.Handler().ServeHTTP(w, r)
	var result struct {
		Data []Thread `json:"data"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	if len(result.Data) != 2 || result.Data[0].ID != threadID || !result.Data[0].Pinned || result.Data[1].Pinned {
		t.Fatal(result)
	}
	if len(g.topicLocked("secondary", "").PinnedIDs) != 0 {
		t.Fatal("pins crossed scope")
	}
}
func TestBothManifestColorsKeepNativeListEntry(t *testing.T) {
	g := testGateway(t)
	for _, mode := range []string{"light", "dark"} {
		r := httptest.NewRequest("GET", "/app/manifest.webmanifest?theme="+mode, nil)
		r.Header.Set("X-BETTER_CODEX-Authenticated", "1")
		w := httptest.NewRecorder()
		g.Handler().ServeHTTP(w, r)
		var m map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &m)
		color := "#ffffff"
		if mode == "dark" {
			color = "#000000"
		}
		if m["theme_color"] != color || m["background_color"] != color {
			t.Fatal(mode, m)
		}
		if m["start_url"] != "/?workspace=ai&view=chat&nativeList=1&pwa=ai&launch=1" || m["id"] != "/workspaces/ai" {
			t.Fatal("native entry or existing identity lost", m)
		}
	}
}
