package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var nativeAssetPath = regexp.MustCompile(`^/dsh-native-assets/([a-f0-9]{16})/(scope\.js|runtime\.js|pwa\.js|pwa\.css|loader\.js|turn\.js|shell\.html)$`)
var patchedNativeAsset = regexp.MustCompile(`^/official-patched-v([0-9]+)/assets/(app-initial-cadb12d4a15e\.js|app-primary-6cd7b8b3f5e3\.js)$`)

func (g *Gateway) nativeManifest() (map[string]any, error) {
	raw, e := os.ReadFile(filepath.Join(g.dir, "native-ui", "manifest.json"))
	if e != nil {
		return nil, e
	}
	var m map[string]any
	e = json.Unmarshal(raw, &m)
	if e != nil {
		return nil, e
	}
	shell, _ := m["shell"].(string)
	if !nativeAssetPath.MatchString(shell) {
		return nil, os.ErrInvalid
	}
	return m, nil
}
func (g *Gateway) serveNativeShell(w http.ResponseWriter, r *http.Request) bool {
	route := r.URL.Path
	if match := patchedNativeAsset.FindStringSubmatch(route); match != nil {
		file := filepath.Join("/opt/dsh-sync/native-assets", "v"+match[1], match[2])
		if _, e := os.Stat(file); e == nil {
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
			w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
			http.ServeFile(w, r, file)
			return true
		}
	}
	if route == "/workbench-sw.js" || route == "/sw.js" || route == "/dsh-offline.html" {
		name, contentType := "worker.js", "text/javascript; charset=utf-8"
		if route == "/dsh-offline.html" {
			name, contentType = "offline.html", "text/html; charset=utf-8"
		}
		file := filepath.Join(g.dir, "native-ui", name)
		if _, e := os.Stat(file); e != nil {
			return false
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Cache-Control", "no-cache")
		if name == "worker.js" {
			w.Header().Set("Service-Worker-Allowed", "/")
		}
		http.ServeFile(w, r, file)
		return true
	}
	if route == "/dsh-native-release.json" {
		m, e := g.nativeManifest()
		if e != nil {
			writeJSON(w, 503, map[string]any{"error": "原生界面尚未准备完成"})
			return true
		}
		writeJSON(w, 200, m)
		return true
	}
	direct := nativeAssetPath.FindStringSubmatch(route)
	entry := (route == "/" && r.URL.Query().Get("view") == "chat") || (strings.HasPrefix(route, "/local/") && validID(strings.TrimPrefix(route, "/local/")))
	if direct == nil && !entry {
		return false
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		http.Error(w, "method", 405)
		return true
	}
	if entry {
		scope := r.URL.Query().Get("workspace")
		if scope != "" && !validScope(scope) {
			http.Error(w, "workspace", 403)
			return true
		}
		m, e := g.nativeManifest()
		if e != nil {
			return false
		}
		direct = nativeAssetPath.FindStringSubmatch(m["shell"].(string))
	}
	file := filepath.Join(g.dir, "native-ui", direct[1], direct[2])
	if _, e := os.Stat(file); e != nil {
		http.NotFound(w, r)
		return true
	}
	if strings.HasSuffix(file, ".html") {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("X-DSH-Credential-Free-Shell", "1")
	} else if strings.HasSuffix(file, ".css") {
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
	} else {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	}
	if entry {
		w.Header().Set("Cache-Control", "no-store")
	} else {
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	}
	http.ServeFile(w, r, file)
	return true
}
func (g *Gateway) serveNativeBootstrap(w http.ResponseWriter, r *http.Request, scope string) {
	source := "cloud-cache"
	record, e := g.cacheStore().nativeRecord(scope, "bootstrap")
	if (e != nil || record == nil) && g.nativeOnlineNow() {
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		result, err := g.call(ctx, scope, "native-bootstrap", map[string]any{})
		var supplied NativeRecord
		if err == nil && json.Unmarshal(result, &supplied) == nil && supplied.Scope == scope && supplied.Key == "bootstrap" && supplied.Kind == "bootstrap" && !supplied.Deleted && supplied.SourceGeneration != "" {
			record, e = &supplied, nil
			source = "mac-cache"
		}
	}
	if e != nil || record == nil || record.Deleted {
		writeJSON(w, 503, map[string]any{"error": "此工作区的启动状态尚未缓存"})
		return
	}
	var payload map[string]any
	if json.Unmarshal(record.Payload, &payload) != nil {
		writeJSON(w, 503, map[string]any{"error": "启动缓存暂不可读"})
		return
	}
	writeJSON(w, 200, map[string]any{"config": payload["config"], "source": source, "nativeOnline": g.nativeOnlineNow(), "confirmedAt": record.ConfirmedAt, "generation": record.SourceGeneration})
}

func (g *Gateway) serveNativeCursors(w http.ResponseWriter, r *http.Request, scope string) {
	id := r.URL.Query().Get("threadId")
	if !validID(id) {
		writeJSON(w, 400, map[string]any{"error": "会话标识无效"})
		return
	}
	record, e := g.cacheStore().nativeRecord(scope, "history-cursors:"+id)
	if (e != nil || record == nil || g.cachePersistence() == "memory") && g.nativeOnlineNow() {
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		result, err := g.call(ctx, scope, "native-cursors", map[string]any{"threadId": id})
		var supplied struct {
			Scope    string          `json:"scope"`
			ThreadID string          `json:"threadId"`
			Cursors  json.RawMessage `json:"cursors"`
		}
		if err == nil && json.Unmarshal(result, &supplied) == nil && supplied.Scope == scope && supplied.ThreadID == id {
			writeJSON(w, 200, map[string]any{"cursors": supplied.Cursors, "source": "mac-cache"})
			return
		}
	}
	if e != nil {
		writeJSON(w, 503, map[string]any{"error": "历史分页信息暂不可读"})
		return
	}
	var cursors any
	if record != nil && !record.Deleted {
		if json.Unmarshal(record.Payload, &cursors) != nil {
			writeJSON(w, 503, map[string]any{"error": "历史分页信息暂不可读"})
			return
		}
	}
	writeJSON(w, 200, map[string]any{"cursors": cursors})
}
