package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

var perfPageID = regexp.MustCompile(`^[a-f0-9-]{8,12}$`)

func (g *Gateway) servePerformance(w http.ResponseWriter, r *http.Request, scope string) {
	if r.Method == "GET" {
		if r.URL.Query().Get("diagnostics") == "1" {
			writeJSON(w, 200, map[string]any{"events": g.readClientDiagnostics(scope), "retentionHours": 24, "limit": 1000})
			return
		}
		g.mu.Lock()
		entries := append([]map[string]any{}, g.uiEvents[scope]...)
		g.mu.Unlock()
		writeJSON(w, 200, map[string]any{"events": entries})
		return
	}
	if r.Method != "POST" || r.Header.Get("Origin") != g.origin {
		http.Error(w, "origin required", 403)
		return
	}
	var body struct {
		Events []map[string]any `json:"events"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 32768)
	if json.NewDecoder(r.Body).Decode(&body) != nil {
		http.Error(w, "invalid event", 400)
		return
	}
	allowed := map[string]bool{}
	for _, p := range []string{"client_diagnostic", "bootstrap", "dom_ready", "page_load", "conversation_ready", "native_rpc", "list_click", "list_visible", "viewport", "lifecycle", "reload", "transport", "history_policy", "asset_summary", "cache_status", "cached_view", "prewarm", "native_catalog_read", "native_history_read", "native_cache_boot", "native_list_ready"} {
		allowed[p] = true
	}
	entries := []map[string]any{}
	for i, e := range body.Events {
		if i >= 30 {
			break
		}
		phase, _ := e["phase"].(string)
		if !allowed[phase] {
			continue
		}
		v := map[string]any{"phase": phase, "at": time.Now().UTC().Format(time.RFC3339Nano)}
		if phase == "client_diagnostic" {
			for k, value := range safeClientDiagnostic(e) {
				v[k] = value
			}
		}
		if source, _ := e["source"].(string); source == "indexeddb" || source == "cloud-cache" || source == "mac-cache" || source == "native" || source == "network" {
			v["source"] = source
		}
		if page, _ := e["pageId"].(string); perfPageID.MatchString(page) {
			v["pageId"] = page
		}
		for _, k := range []string{"mobile", "persisted", "failed"} {
			if b, ok := e[k].(bool); ok {
				v[k] = b
			}
		}
		for _, k := range []string{"count", "elapsedMs", "durationMs", "clickToReadyMs", "clickToBootstrapMs", "longTasks", "longTaskMs", "maxLongTaskMs", "focusSuppressed", "responseChars", "width", "height", "openSockets", "initialTurnItems", "resourceCount", "networkBytes", "decodedBytes", "zeroTransferResources", "cacheHits", "cacheMisses", "metadataCount", "bodyCount"} {
			if n, ok := e[k].(float64); ok && n >= 0 && n <= 64<<20 {
				v[k] = n
			}
		}
		if m, _ := e["method"].(string); m == "thread/read" || m == "thread/resume" || m == "thread/turns/list" || m == "thread/items/list" {
			v["method"] = m
		}
		reason, _ := e["reason"].(string)
		for _, known := range []string{"resize", "pageshow", "pagehide", "visibility", "online", "close", "open", "transport_reconnected", "host_epoch_changed", "cached_no_socket", "connected", "reconnecting", "syncing", "unavailable"} {
			if reason == known {
				v["reason"] = reason
			}
		}
		entries = append(entries, v)
	}
	if err := g.storeClientDiagnostics(scope, entries); err != nil {
		http.Error(w, "diagnostics unavailable", 503)
		return
	}
	g.mu.Lock()
	g.uiEvents[scope] = append(g.uiEvents[scope], entries...)
	if len(g.uiEvents[scope]) > 500 {
		g.uiEvents[scope] = g.uiEvents[scope][len(g.uiEvents[scope])-500:]
	}
	g.mu.Unlock()
	writeJSON(w, 200, map[string]bool{"received": true})
}

// Explicit metadata schema: no arbitrary client strings or raw exception messages.
func safeClientDiagnostic(e map[string]any) map[string]any {
	out := map[string]any{}
	allowed := map[string][]string{
		"kind":         {"history_read", "history_applied", "history_rejected", "policy_aligned", "execution_failed", "lifecycle", "sync_failed", "execution_control", "native_menu"},
		"reason":       {"menu_open", "menu_close", "menu_replaced", "menu_outside", "menu_navigation", "menu_escape", "stop_target_changed", "stop_coalesced", "no_active_turn", "newer_visible_turn", "live_event_superseded", "hydrate_not_applied", "freshness_unverified", "pageshow", "pagehide", "online", "visible", "user-stop", "system", "descendant-cleanup", "dispatch", "accepted", "failed"},
		"policy":       {"danger-full-access", "workspace-write", "read-only"},
		"failureClass": {"policy_mismatch", "host_resources", "writer_busy", "timeout", "connection", "native_rejected"},
		"method":       {"thread/read", "thread/turns/list", "thread/items/list", "thread/start", "thread/resume", "turn/interrupt", "thread/stop"},
	}
	for key, list := range allowed {
		value, _ := e[key].(string)
		for _, known := range list {
			if value == known {
				out[key] = value
			}
		}
	}
	for _, key := range []string{"deviceId", "threadId", "turnId", "generation"} {
		if value, ok := e[key].(string); ok && diagnosticUUID.MatchString(value) {
			out[key] = value
		}
	}
	if value, ok := e["uiVersion"].(string); ok && diagnosticVersion.MatchString(value) {
		out["uiVersion"] = value
	}
	for _, key := range []string{"clientAt", "revision", "turnCount", "durationMs", "inputAgeMs"} {
		if value, ok := e[key].(float64); ok && value >= 0 && value <= 9007199254740991 {
			out[key] = value
		}
	}
	if value, ok := e["fresh"].(bool); ok {
		out["fresh"] = value
	}
	if value, ok := e["trustedInput"].(bool); ok {
		out["trustedInput"] = value
	}
	return out
}

var diagnosticUUID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var diagnosticVersion = regexp.MustCompile(`^[a-f0-9]{16}$`)

var clientDiagnosticsMu sync.Mutex

func (g *Gateway) readClientDiagnostics(scope string) []map[string]any {
	clientDiagnosticsMu.Lock()
	defer clientDiagnosticsMu.Unlock()
	return g.loadClientDiagnostics(scope)
}
func (g *Gateway) loadClientDiagnostics(scope string) []map[string]any {
	rows := []map[string]any{}
	raw, err := os.ReadFile(filepath.Join(g.dir, "client-diagnostics-"+scope+".json"))
	if err == nil && len(raw) <= 1024*1024 {
		_ = json.Unmarshal(raw, &rows)
	}
	kept := []map[string]any{}
	cutoff := time.Now().Add(-24 * time.Hour)
	for _, e := range rows {
		at, _ := e["at"].(string)
		t, err := time.Parse(time.RFC3339Nano, at)
		if err == nil && t.After(cutoff) {
			kept = append(kept, e)
		}
	}
	return kept
}
func (g *Gateway) storeClientDiagnostics(scope string, entries []map[string]any) error {
	incoming := []map[string]any{}
	for _, e := range entries {
		if e["phase"] == "client_diagnostic" {
			incoming = append(incoming, e)
		}
	}
	if len(incoming) == 0 {
		return nil
	}
	clientDiagnosticsMu.Lock()
	defer clientDiagnosticsMu.Unlock()
	rows := append(g.loadClientDiagnostics(scope), incoming...)
	if len(rows) > 1000 {
		rows = rows[len(rows)-1000:]
	}
	return atomicJSON(filepath.Join(g.dir, "client-diagnostics-"+scope+".json"), rows)
}
