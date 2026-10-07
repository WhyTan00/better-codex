package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNativeShellAssetsAndBootstrapWithoutMac(t *testing.T) {
	g := testGateway(t)
	defer g.durable.close()
	version := "0123456789abcdef"
	dir := filepath.Join(g.dir, "native-ui", version)
	os.MkdirAll(dir, 0700)
	manifest := map[string]any{"schemaVersion": 1, "version": version, "shell": "/dsh-native-assets/" + version + "/shell.html"}
	raw, _ := json.Marshal(manifest)
	os.WriteFile(filepath.Join(g.dir, "native-ui", "manifest.json"), raw, 0600)
	os.WriteFile(filepath.Join(dir, "shell.html"), []byte("<html>native shell</html>"), 0600)
	for _, url := range []string{"http://127.0.0.1/local/" + threadID + "?workspace=ai", "http://127.0.0.1/?view=chat&workspace=ai", "http://127.0.0.1" + manifest["shell"].(string)} {
		r := httptest.NewRequest("GET", url, nil)
		w := httptest.NewRecorder()
		if !g.serveNativeShell(w, r) || w.Code != 200 || w.Header().Get("X-DSH-Credential-Free-Shell") != "1" || !strings.Contains(w.Body.String(), "native shell") {
			t.Fatal("shell not served", url, w.Code)
		}
	}
	w := httptest.NewRecorder()
	g.serveNativeShell(w, httptest.NewRequest("GET", "http://127.0.0.1/?view=chat&workspace=unknown", nil))
	if w.Code != 403 {
		t.Fatal("unknown workspace accepted")
	}
	record := NativeRecord{Scope: "ai", Key: "bootstrap", Kind: "bootstrap", SourceGeneration: "source-db", Generation: "g", Revision: 1, Payload: json.RawMessage(`{"config":{"workspaceRoots":["/workspace/example"]}}`)}
	raw, _ = json.Marshal(record)
	if e := g.apply(frame{Epoch: "source", Seq: 1, Scope: "ai", Event: Event{Type: "nativeRecord"}, Data: raw}); e != nil {
		t.Fatal(e)
	}
	w = httptest.NewRecorder()
	g.serveNativeBootstrap(w, httptest.NewRequest("GET", "http://127.0.0.1/sync/v1/w/ai/native-bootstrap", nil), "ai")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"nativeOnline":false`) {
		t.Fatal("offline bootstrap unavailable", w.Body.String())
	}
	w = httptest.NewRecorder()
	g.serveNativeBootstrap(w, httptest.NewRequest("GET", "http://127.0.0.1/sync/v1/w/zyy/native-bootstrap", nil), "zyy")
	if w.Code == 200 || strings.Contains(w.Body.String(), "/workspace/example") {
		t.Fatal("bootstrap crossed scope")
	}
}
func TestHistoryEvictionProtectsCatalogTombstonesAndCurrentReply(t *testing.T) {
	g := testGateway(t)
	defer g.durable.close()
	for _, v := range []struct {
		key, kind string
		deleted   bool
		at        int
	}{{"catalog", "catalog", false, 0}, {"deleted", "history", true, 0}, {"old", "history", false, 1}, {"new", "history", false, 2}} {
		_, e := g.durable.db.Exec("INSERT INTO native_records VALUES(?,?,?,?,?,?,?,?,?)", "ai", v.key, v.kind, threadID, "g", 1, []byte(strings.Repeat("x", 100)), v.deleted, v.at)
		if e != nil {
			t.Fatal(e)
		}
	}
	tx, _ := g.durable.db.Begin()
	if e := pruneNativeHistory(tx, "ai", "new", 100); e != nil {
		t.Fatal(e)
	}
	if e := tx.Commit(); e != nil {
		t.Fatal(e)
	}
	var count int
	g.durable.db.QueryRow("SELECT count(*) FROM native_records").Scan(&count)
	if count != 3 {
		t.Fatal("wrong eviction", count)
	}
	g.durable.db.QueryRow("SELECT count(*) FROM native_records WHERE key='old'").Scan(&count)
	if count != 0 {
		t.Fatal("old history not evicted")
	}
}

func TestCompletedItemHeadReuseKeepsOpaquePagingAndGeneration(t *testing.T) {
	g := testGateway(t)
	defer g.durable.close()
	params := map[string]any{"threadId": threadID, "turnId": turnID, "cursor": "new-head", "limit": float64(20), "sortDirection": "desc"}
	aliasKey, _ := json.Marshal([]any{threadID, turnID, 20, "desc"})
	records := []NativeRecord{
		{Key: "history-cursors:" + threadID, Kind: "historyCursor", Payload: json.RawMessage(`{"itemsBackwardsCursor":"new-head","turnsBackwardsCursor":"turn-head"}`)},
		{Key: "turn:" + threadID + ":" + turnID, Kind: "turn", Payload: json.RawMessage(`{"turn":{"status":"completed"}}`)},
		{Key: "old-page", Kind: "history", Payload: json.RawMessage(`{"method":"thread/items/list","params":{"cursor":"old-head"},"result":{"data":[{"opaqueNumber":12345678901234567890}],"nextCursor":"native-next"}}`)},
		{Key: "stable-item-head:" + string(aliasKey), Kind: "readAlias", Payload: json.RawMessage(`{"targetKey":"old-page"}`)},
	}
	for i := range records {
		r := &records[i]
		r.Scope = "ai"
		r.SourceGeneration = "source-db"
		r.Generation = "g"
		r.Revision = uint64(i + 1)
		r.ThreadID = threadID
		raw, _ := json.Marshal(r)
		if e := g.apply(frame{Epoch: "source", Seq: uint64(i + 1), Scope: "ai", ThreadID: threadID, Event: Event{Type: "nativeRecord"}, Data: raw}); e != nil {
			t.Fatal(e)
		}
	}
	cached, e := g.stableNativeItemHead("ai", "new-page", params)
	if e != nil || cached == nil || cached.Key != "new-page" || !strings.Contains(string(cached.Payload), "12345678901234567890") || !strings.Contains(string(cached.Payload), "native-next") {
		t.Fatal("native page lost", e)
	}
	if other, _ := g.stableNativeItemHead("zyy", "new-page", params); other != nil {
		t.Fatal("scope crossed")
	}
	records[1].Generation = "rewrite"
	records[1].Revision = 5
	raw, _ := json.Marshal(records[1])
	if e := g.apply(frame{Epoch: "source", Seq: 5, Scope: "ai", ThreadID: threadID, Event: Event{Type: "nativeRecord"}, Data: raw}); e != nil {
		t.Fatal(e)
	}
	if other, _ := g.stableNativeItemHead("ai", "new-page", params); other != nil {
		t.Fatal("history generation crossed")
	}
}
