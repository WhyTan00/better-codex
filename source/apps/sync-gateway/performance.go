package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	diagnosticRetention   = 7 * 24 * time.Hour
	diagnosticLimit       = 2000
	diagnosticFaultLimit  = 500
	diagnosticMaxFileSize = 4 * 1024 * 1024
	diagnosticMaxSafeInt  = int64(9007199254740991)
)

var perfPageID = regexp.MustCompile(`^[a-f0-9-]{8,12}$`)
var diagnosticUUID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var diagnosticHex = regexp.MustCompile(`^[a-f0-9]{16}$`)
var diagnosticVersion = diagnosticHex
var diagnosticCodeFrame = regexp.MustCompile(`^(?:[a-z][a-z0-9-]{0,80}-[a-f0-9]{12,16}|scope|runtime|loader|pwa|turn)\.js:[1-9][0-9]{0,6}:[1-9][0-9]{0,8}$`)

var diagnosticEnums = map[string][]string{
	"syncMode":            {"foreground", "active", "settling", "checking", "idle", "offline"},
	"component":           {"page-ws", "cloud-events", "scope-session", "native-http", "resource", "diagnostic-upload", "android-app", "android-sync", "android-network", "android-store", "android-notification", "android-update", "android-webview", "android-bridge"},
	"routeClass":          {"native_ws", "scope_session", "native_read", "native_catalog", "native_bootstrap", "cloud_events", "performance", "asset", "local_file", "other"},
	"resourceKind":        {"script", "style", "image", "media", "frame", "other"},
	"storageFailureStage": {"journal_scan", "journal_read", "journal_write", "journal_remove", "emergency_write", "meta_read", "meta_write", "persist", "restore", "unknown"},

	"kind": {
		"history_read", "history_applied", "history_rejected", "policy_aligned", "execution_failed", "lifecycle", "sync_failed", "execution_control", "native_menu", "render_error", "submit_failed",
		"js_error", "promise_rejection", "boot_error", "resource_error", "rpc", "send_flow", "question_flow", "transport", "client_health", "android_diagnostic",
	},
	"method":       {"GET", "status", "readStream", "readRecords", "requestSync", "native-bootstrap", "focusThread", "diagnosticContext", "getTheme", "setTheme", "saveDocument", "getNotificationSettings", "setDeviceOwner", "setCompletionNotifications", "startSync", "stopSync", "openSettings", "thread/read", "thread/list", "thread/loaded/list", "thread/turns/list", "thread/items/list", "thread/start", "thread/resume", "turn/start", "turn/steer", "turn/interrupt", "thread/stop", "thread/queue/add", "thread/queue/update", "thread/queue/remove", "thread/queue/list", "thread/goal/get", "config/read", "readThreadRecords", "openDeliverable", "resolveDeliverable", "initialize", "thread/name/set", "thread/archive", "thread/unarchive", "thread/fork", "thread/section/move", "thread/settings/update", "thread/queue/delete", "thread/queue/reorder", "thread/queue/start", "thread/goal/set", "thread/goal/clear", "account/read", "account/rateLimits/read", "getAuthStatus", "permissionProfile/list", "model/list", "modelProvider/capabilities/read", "configRequirements/read", "experimentalFeature/list", "remoteControl/status/read", "collaborationMode/list", "skills/list", "app/list", "mcpServerStatus/list", "plugin/list", "plugin/installed", "thread/metadata/update", "thread/unsubscribe", "externalAgentConfig/import/readHistories", "scopeSession", "presentConversation", "readSavedThreadRecords", "readSavedRecord", "saveReadRecord", "saveVisibleProcesses", "readVisibleProcesses", "invalidateVisibleProcesses", "thread/attachment/list", "thread/backgroundTerminals/list", "thread/searchOccurrences", "thread/delete"},
	"stage":        {"attempt", "blocked", "captured", "preparing", "dispatch", "accepted", "queued", "failed", "settled", "shown", "submitting", "reconciled", "closed", "requested", "received", "local_handled", "pending", "boot", "persist_failed", "upload_failed", "uploaded", "restored", "connected", "reconnecting", "syncing", "unavailable", "offline-cache", "page_replaced", "cancelled", "committed", "skipped", "started", "stopped", "background", "foreground", "downloaded", "verified", "installed"},
	"source":       {"indexeddb", "cloud-cache", "mac-cache", "native", "network"},
	"reason":       {"menu_open", "menu_close", "menu_replaced", "menu_outside", "menu_navigation", "menu_escape", "stop_target_changed", "stop_coalesced", "no_active_turn", "newer_visible_turn", "live_event_superseded", "hydrate_not_applied", "freshness_unverified", "pageshow", "pagehide", "online", "visible", "user-stop", "system", "descendant-cleanup", "dispatch", "accepted", "failed", "document_start", "hidden", "offline", "input", "submit_disabled", "submit_busy", "upload_busy", "not_current", "empty", "loading_local_config", "preparation", "native", "outcome_unknown", "timeout", "unknown", "socket_closed", "socket_error", "heartbeat_timeout", "scope_renewal_failed", "scope_renewal_ok", "upgrade_rejected", "native_disconnected", "native_ready", "client_reconnect", "resume_unavailable", "session_replaced", "protocol_error", "resource_failure", "upstream_failure", "uncaught_exception", "memory_pressure", "activity_create", "activity_resume", "activity_pause", "activity_stop", "activity_destroy", "new_intent", "notification_open", "notification_ready", "navigation_cancelled", "navigation_timeout", "network_available", "network_lost", "network_changed", "network_unavailable", "validated_changed", "capabilities_changed", "screen_on", "screen_off", "user_present", "idle_changed", "power_save_changed", "service_create", "service_start", "service_stop", "service_destroy", "sticky_restart", "boot_restore", "package_replaced", "user_stop", "sync_start", "sync_stop", "socket_open", "send_failed", "auth_required", "request_failed", "catalog_refresh", "catalog_committed", "history_prefetch", "history_committed", "history_failed", "completion_received", "completion_posted", "completion_suppressed", "body_ready", "body_unavailable", "store_failed", "store_committed", "cache_import", "bridge_request", "bridge_reply", "bridge_failed", "main_frame", "page_started", "page_finished", "page_commit", "http_error", "ssl_error", "web_error", "renderer_gone", "check_start", "check_latest", "check_available", "check_failed", "download_start", "download_complete", "download_failed", "verify_ok", "verify_failed", "install_requested", "install_cancelled", "permission_required", "ui_embedded", "ui_cached", "ui_download", "ui_verified", "ui_failed", "cancelled", "stopped", "scope_changed", "periodic", "user_request", "diagnostic_flush", "request_start", "request_received", "focus_committed", "focus_failed", "focus_requested", "foreground", "background", "device_awake", "ack_missing", "ack_partial", "body_partial", "ui_apply", "stream_received", "stream_committed", "stream_gap", "content_prepared", "content_painted", "input_empty", "layout_repaired", "sync_policy"},
	"policy":       {"danger-full-access", "workspace-write", "read-only"},
	"failureClass": {"policy_mismatch", "host_resources", "writer_busy", "timeout", "connection", "native_rejected", "dns", "tls", "auth", "http", "parse", "storage", "react_invariant", "undefined_property", "null_property", "missing_method", "rpc_contract", "missing_item", "aborted", "resource_load", "unknown"},
	"errorName":    {"Error", "TypeError", "ReferenceError", "RangeError", "SyntaxError", "AbortError", "NullPointerException", "IllegalStateException", "IllegalArgumentException", "SecurityException", "IOException", "SQLiteException", "OutOfMemoryError", "RuntimeException", "unknown"},
	"visibility":   {"visible", "hidden", "prerender"},
	"blockReason":  {"empty-message", "loading-local-config", "file-uploads", "image-uploads", "busy", "disabled", "unknown"},
}

var diagnosticUUIDFields = []string{"eventId", "incidentId", "deviceId", "nativeDeviceId", "processIdTag", "parentTraceId", "threadId", "turnId", "generation", "traceId", "connectionId"}
var diagnosticHexFields = []string{"uiVersion", "previousUiVersion", "rpcIdHash", "questionIdHash", "selectedQuestionHash", "stackHash", "contentHash"}
var diagnosticPageFields = []string{"pageId", "previousPageId"}
var diagnosticNumericFields = []string{"clientAt", "seq", "monoMs", "revision", "turnCount", "durationMs", "inputAgeMs", "itemCount", "questionCount", "pendingCount", "droppedCount", "historyEvicted", "pendingDropped", "journalDropped", "storageFailures", "persistFailures", "uploadFailures", "nativeDropped", "apkVersion", "recordCursor", "eventCursor", "browserMajor", "statusCode", "closeCode", "attempt", "socketState", "lastMessageAgeMs", "lastPongAgeMs", "bufferedBytes", "retryDelayMs", "count", "viewportHeight", "viewportOffset", "documentOffset", "composerTop", "composerBottom", "webViewOffset", "streamCursor", "catalogIntervalMs", "heartbeatMs"}
var diagnosticBooleanFields = []string{"fresh", "trustedInput", "online", "executionConnected", "submitting", "disabled", "selected", "answered", "localStored", "uploadOk", "wasClean", "handshakeComplete", "nativeOnline", "resumed", "validated", "metered", "wifi", "cellular", "vpn", "batteryExempt", "deviceIdle", "powerSave", "backgroundRestricted", "screenInteractive", "wakeHeld", "enhanced", "networkAvailable", "networkMonitorRegistered", "transportConnected", "cacheReady", "enabled", "textAvailable"}

func (g *Gateway) servePerformance(w http.ResponseWriter, r *http.Request, scope string) {
	if r.Method == "GET" {
		if r.URL.Query().Get("diagnostics") == "1" {
			events, err := g.readClientDiagnostics(scope)
			if err != nil {
				http.Error(w, "diagnostics unavailable", http.StatusServiceUnavailable)
				return
			}
			writeJSON(w, 200, map[string]any{"events": events, "retentionHours": 168, "limit": 2000})
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
	for _, p := range []string{"client_diagnostic", "bootstrap", "dom_ready", "page_load", "conversation_ready", "native_rpc", "list_click", "list_visible", "viewport", "lifecycle", "reload", "transport", "history_policy", "asset_summary", "cache_status", "cached_view", "prewarm", "navigation", "native_catalog_read", "native_history_read", "native_cache_boot", "native_list_ready"} {
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
		for _, key := range diagnosticPageFields {
			if page, _ := e[key].(string); perfPageID.MatchString(page) {
				v[key] = page
			}
		}
		for _, k := range []string{"mobile", "persisted", "failed", "standalone", "wasDiscarded", "userInitiated"} {
			if b, ok := e[k].(bool); ok {
				v[k] = b
			}
		}
		for _, k := range []string{"count", "elapsedMs", "durationMs", "clickToReadyMs", "clickToBootstrapMs", "longTasks", "longTaskMs", "maxLongTaskMs", "focusSuppressed", "responseChars", "width", "height", "openSockets", "initialTurnItems", "resourceCount", "networkBytes", "decodedBytes", "zeroTransferResources", "cacheHits", "cacheMisses", "metadataCount", "bodyCount", "devicePixelRatio", "browserMajor", "previousWidth", "previousHeight", "previousWidthChangeAgeMs", "widthChangeAgeMs"} {
			if n, ok := e[k].(float64); ok && diagnosticInteger(n, 0, diagnosticMaxSafeInt) {
				v[k] = n
			}
		}
		if m, _ := e["method"].(string); m == "thread/read" || m == "thread/resume" || m == "thread/turns/list" || m == "thread/items/list" {
			v["method"] = m
		}
		reason, _ := e["reason"].(string)
		for _, known := range []string{"resize", "pageshow", "pagehide", "visibility", "online", "close", "open", "transport_reconnected", "host_epoch_changed", "cached_no_socket", "connected", "reconnecting", "syncing", "unavailable", "document_start", "document_hide", "document_navigate", "document_auth_required"} {
			if reason == known {
				v["reason"] = reason
			}
		}
		entries = append(entries, v)
	}
	expectedIDs := map[string]bool{}
	for _, e := range entries {
		if e["phase"] == "client_diagnostic" {
			if id, ok := e["eventId"].(string); ok && diagnosticUUID.MatchString(id) {
				expectedIDs[strings.ToLower(id)] = true
			}
		}
	}
	if err := g.storeClientDiagnostics(scope, entries); err != nil {
		logDiagnosticReceipt(scope, r.Header.Get("X-DSH-Diagnostic-Trace"), "failed", "store_failed", 503, len(expectedIDs), 0)
		http.Error(w, "diagnostics unavailable", 503)
		return
	}
	// The durable archive accepts every sanitized row before acknowledgement.
	// The 2000-row query view is an index, not the delivery receipt: retention or
	// a concurrent upload must not strand old IDs in the client's outbox.
	acknowledged := []string{}
	seen := make(map[string]bool)
	for _, row := range entries {
		id, ok := row["eventId"].(string)
		key := strings.ToLower(id)
		if row["phase"] == "client_diagnostic" && ok && expectedIDs[key] && !seen[key] {
			seen[key] = true
			acknowledged = append(acknowledged, id)
		}
	}
	g.mu.Lock()
	g.uiEvents[scope] = append(g.uiEvents[scope], entries...)
	if len(g.uiEvents[scope]) > 500 {
		g.uiEvents[scope] = g.uiEvents[scope][len(g.uiEvents[scope])-500:]
	}
	g.mu.Unlock()
	reason := "diagnostic_flush"
	if len(acknowledged) != len(expectedIDs) {
		reason = "ack_partial"
	}
	if len(expectedIDs) > 0 {
		logDiagnosticReceipt(scope, r.Header.Get("X-DSH-Diagnostic-Trace"), "committed", reason, 200, len(expectedIDs), len(acknowledged))
	}
	writeJSON(w, 200, map[string]any{"received": true, "acknowledgedEventIds": acknowledged})
}

// Explicit metadata schema: no arbitrary client strings or raw exception messages.
func safeClientDiagnostic(e map[string]any) map[string]any {
	out := map[string]any{}
	for key, list := range diagnosticEnums {
		value, _ := e[key].(string)
		for _, known := range list {
			if value == known {
				out[key] = value
			}
		}
	}
	for _, key := range diagnosticUUIDFields {
		if value, ok := e[key].(string); ok && diagnosticUUID.MatchString(value) {
			out[key] = value
		}
	}
	for _, key := range diagnosticHexFields {
		if value, ok := e[key].(string); ok && diagnosticHex.MatchString(value) {
			out[key] = value
		}
	}
	for _, key := range diagnosticPageFields {
		if value, ok := e[key].(string); ok && perfPageID.MatchString(value) {
			out[key] = value
		}
	}
	for _, key := range diagnosticNumericFields {
		if value, ok := e[key]; ok && diagnosticInteger(value, 0, diagnosticMaxSafeInt) {
			out[key] = value
		}
	}
	for _, key := range diagnosticBooleanFields {
		if value, ok := e[key].(bool); ok {
			out[key] = value
		}
	}
	if value, ok := e["rpcCode"]; ok && diagnosticInteger(value, -32768, 99999) {
		out["rpcCode"] = value
	}
	if value, ok := e["reactErrorCode"]; ok && diagnosticInteger(value, 0, 9999) {
		out["reactErrorCode"] = value
	}
	if frames, ok := diagnosticFrames(e["errorFrames"]); ok {
		out["errorFrames"] = frames
	}
	return out
}

// Receipt metadata is independent of the client outbox, so a broken upload
// reports its HTTP/persistence outcome without requiring that upload to work.
func logDiagnosticReceipt(scope, traceID, stage, reason string, statusCode, received, acknowledged int) {
	if !validScope(scope) {
		return
	}
	row := map[string]any{"event": "request", "component": "diagnostic-upload", "routeClass": "performance", "scope": scope, "at": time.Now().UTC().Format(time.RFC3339Nano), "stage": stage, "reason": reason, "statusCode": statusCode, "itemCount": received, "count": acknowledged}
	if diagnosticUUID.MatchString(traceID) {
		row["traceId"] = traceID
	}
	raw, _ := json.Marshal(row)
	log.Print(string(raw))
}

func diagnosticInteger(value any, min, max int64) bool {
	switch v := value.(type) {
	case float64:
		return diagnosticFloatInteger(v, min, max)
	case float32:
		return diagnosticFloatInteger(float64(v), min, max)
	case json.Number:
		parsed, err := strconv.ParseFloat(v.String(), 64)
		return err == nil && diagnosticFloatInteger(parsed, min, max)
	case int:
		return int64(v) >= min && int64(v) <= max
	case int8:
		return int64(v) >= min && int64(v) <= max
	case int16:
		return int64(v) >= min && int64(v) <= max
	case int32:
		return int64(v) >= min && int64(v) <= max
	case int64:
		return v >= min && v <= max
	case uint:
		return uint64(v) <= uint64(max)
	case uint8:
		return uint64(v) <= uint64(max)
	case uint16:
		return uint64(v) <= uint64(max)
	case uint32:
		return uint64(v) <= uint64(max)
	case uint64:
		return v <= uint64(max)
	default:
		return false
	}
}

func diagnosticFloatInteger(value float64, min, max int64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value == math.Trunc(value) && value >= float64(min) && value <= float64(max) && math.Abs(value) <= float64(diagnosticMaxSafeInt)
}

func diagnosticFrames(value any) ([]string, bool) {
	var values []any
	switch frames := value.(type) {
	case []any:
		values = frames
	case []string:
		values = make([]any, len(frames))
		for i, frame := range frames {
			values[i] = frame
		}
	default:
		return nil, false
	}
	frames := make([]string, 0, minInt(len(values), 8))
	for _, value := range values {
		frame, ok := value.(string)
		if !ok || !diagnosticCodeFrame.MatchString(frame) {
			continue
		}
		frames = append(frames, frame)
		if len(frames) == 8 {
			break
		}
	}
	return frames, true
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

var clientDiagnosticsMu sync.Mutex

func (g *Gateway) readClientDiagnostics(scope string) ([]map[string]any, error) {
	clientDiagnosticsMu.Lock()
	defer clientDiagnosticsMu.Unlock()
	return g.loadClientDiagnostics(scope)
}
func (g *Gateway) loadClientDiagnostics(scope string) ([]map[string]any, error) {
	path := diagnosticPath(g, scope)
	if path == "" {
		return nil, errors.New("invalid diagnostics scope")
	}
	rows, err := readDiagnosticRows(path)
	if os.IsNotExist(err) {
		return []map[string]any{}, nil
	}
	if err != nil {
		return nil, err
	}
	return normalizeDiagnosticRows(rows, time.Now()), nil
}
func (g *Gateway) storeClientDiagnostics(scope string, entries []map[string]any) error {
	path := diagnosticPath(g, scope)
	if path == "" {
		return errors.New("invalid diagnostics scope")
	}
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
	if err := g.archiveClientDiagnostics(scope, incoming, time.Now()); err != nil {
		return err
	}
	rows, err := readDiagnosticRows(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if rows == nil {
		rows = []map[string]any{}
	}
	rows = append(rows, incoming...)
	rows = normalizeDiagnosticRows(rows, time.Now())
	data, err := json.Marshal(rows)
	if err != nil {
		return err
	}
	if len(data) > diagnosticMaxFileSize {
		return errors.New("diagnostics exceed 4 MiB")
	}
	return writeDiagnosticRows(path, data)
}

// A diagnostic receipt follows file and directory sync, not only rename.
func writeDiagnosticRows(name string, data []byte) error {
	dir := filepath.Dir(name)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, ".diagnostics-")
	if err != nil {
		return err
	}
	temp := file.Name()
	defer os.Remove(temp)
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(temp, name); err != nil {
		return err
	}
	directory, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

var errDiagnosticFileTooLarge = errors.New("diagnostics file exceeds 4 MiB")

func diagnosticPath(g *Gateway, scope string) string {
	if g == nil || !validScope(scope) {
		return ""
	}
	return filepath.Join(g.dir, "client-diagnostics-"+scope+".json")
}

func readDiagnosticRows(path string) ([]map[string]any, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.Size() > diagnosticMaxFileSize {
		return nil, errDiagnosticFileTooLarge
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, diagnosticMaxFileSize+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > diagnosticMaxFileSize {
		return nil, errDiagnosticFileTooLarge
	}
	rows := []map[string]any{}
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, fmt.Errorf("decode diagnostics: %w", err)
	}
	if rows == nil {
		rows = []map[string]any{}
	}
	return rows, nil
}

func normalizeDiagnosticRows(rows []map[string]any, now time.Time) []map[string]any {
	cutoff := now.Add(-diagnosticRetention)
	recent := make([]map[string]any, 0, len(rows))
	for _, e := range rows {
		if e == nil {
			continue
		}
		at, _ := e["at"].(string)
		t, err := time.Parse(time.RFC3339Nano, at)
		if err == nil && t.After(cutoff) {
			recent = append(recent, e)
		}
	}
	return retainDiagnosticRows(dedupeDiagnosticRows(recent))
}

func dedupeDiagnosticRows(rows []map[string]any) []map[string]any {
	seen := make(map[string]int, len(rows))
	kept := make([]map[string]any, 0, len(rows))
	for _, e := range rows {
		key := diagnosticDedupeKey(e)
		if key != "" {
			if index, ok := seen[key]; ok {
				supplementDiagnosticIncident(kept[index], e)
				continue
			}
			seen[key] = len(kept)
		}
		kept = append(kept, e)
	}
	return kept
}

func supplementDiagnosticIncident(first, replay map[string]any) {
	if first == nil || replay == nil {
		return
	}
	if incidentID, _ := first["incidentId"].(string); diagnosticUUID.MatchString(incidentID) {
		return
	}
	if incidentID, _ := replay["incidentId"].(string); diagnosticUUID.MatchString(incidentID) {
		first["incidentId"] = incidentID
	}
}

func diagnosticDedupeKey(e map[string]any) string {
	if eventID, ok := e["eventId"].(string); ok && diagnosticUUID.MatchString(eventID) {
		return "eventId\x00" + strings.ToLower(eventID)
	}
	parts := make([]string, 0, 6)
	nonEmpty := false
	for _, key := range []string{"deviceId", "pageId", "clientAt", "kind", "method", "reason"} {
		value := diagnosticDedupeValue(e[key])
		if value != "" {
			nonEmpty = true
		}
		parts = append(parts, value)
	}
	if !nonEmpty {
		return ""
	}
	return "legacy\x00" + strings.Join(parts, "\x00")
}

func diagnosticDedupeValue(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case float64:
		if diagnosticInteger(v, -diagnosticMaxSafeInt, diagnosticMaxSafeInt) {
			return strconv.FormatFloat(v, 'f', -1, 64)
		}
	case float32:
		if diagnosticInteger(v, -diagnosticMaxSafeInt, diagnosticMaxSafeInt) {
			return strconv.FormatFloat(float64(v), 'f', -1, 64)
		}
	case json.Number:
		if parsed, err := strconv.ParseFloat(v.String(), 64); err == nil && diagnosticInteger(parsed, -diagnosticMaxSafeInt, diagnosticMaxSafeInt) {
			return strconv.FormatFloat(parsed, 'f', -1, 64)
		}
	case int:
		return strconv.FormatInt(int64(v), 10)
	case int8:
		return strconv.FormatInt(int64(v), 10)
	case int16:
		return strconv.FormatInt(int64(v), 10)
	case int32:
		return strconv.FormatInt(int64(v), 10)
	case int64:
		return strconv.FormatInt(v, 10)
	case uint:
		return strconv.FormatUint(uint64(v), 10)
	case uint8:
		return strconv.FormatUint(uint64(v), 10)
	case uint16:
		return strconv.FormatUint(uint64(v), 10)
	case uint32:
		return strconv.FormatUint(uint64(v), 10)
	case uint64:
		return strconv.FormatUint(v, 10)
	}
	return ""
}

func retainDiagnosticRows(rows []map[string]any) []map[string]any {
	primary := []int{}
	context := []int{}
	normal := []int{}
	for i, e := range rows {
		switch diagnosticFaultPriority(e) {
		case 2:
			primary = append(primary, i)
		case 1:
			context = append(context, i)
		default:
			normal = append(normal, i)
		}
	}
	primaryCount := minInt(len(primary), diagnosticFaultLimit)
	contextCount := minInt(len(context), diagnosticFaultLimit-primaryCount)
	normalCount := minInt(len(normal), diagnosticLimit-primaryCount-contextCount)
	keep := make([]bool, len(rows))
	for _, i := range primary[len(primary)-primaryCount:] {
		keep[i] = true
	}
	for _, i := range context[len(context)-contextCount:] {
		keep[i] = true
	}
	for _, i := range normal[len(normal)-normalCount:] {
		keep[i] = true
	}
	result := make([]map[string]any, 0, primaryCount+contextCount+normalCount)
	for i, e := range rows {
		if keep[i] {
			result = append(result, e)
		}
	}
	return result
}

func diagnosticFaultPriority(e map[string]any) int {
	kind, _ := e["kind"].(string)
	stage, _ := e["stage"].(string)
	reason, _ := e["reason"].(string)
	if diagnosticMilestone(e) {
		return 2
	}
	if kind == "lifecycle" && (reason == "visible" || reason == "hidden" || reason == "pageshow" || reason == "pagehide" || reason == "online" || reason == "offline") || kind == "client_health" && stage == "boot" || e["component"] == "android-app" || e["component"] == "android-network" || e["component"] == "android-update" || e["component"] == "android-webview" || e["component"] == "diagnostic-upload" {
		return 2
	}
	if kind == "transport" && e["component"] != nil {
		return 2
	}
	if diagnosticErrorKind(kind) || diagnosticFailureStage(stage) || diagnosticFailureStage(reason) {
		return 2
	}
	if kind == "rpc" {
		if code, ok := e["rpcCode"]; ok && diagnosticInteger(code, -32768, 99999) {
			if diagnosticDedupeValue(code) != "" && strings.HasPrefix(diagnosticDedupeValue(code), "-") {
				return 2
			}
		}
		if failureClass, _ := e["failureClass"].(string); failureClass != "" {
			return 2
		}
	}
	component, _ := e["component"].(string)
	if component == "android-notification" && reason != "periodic" || reason == "notification_ready" || reason == "history_applied" {
		return 1
	}
	if incidentID, _ := e["incidentId"].(string); diagnosticUUID.MatchString(incidentID) {
		return 1
	}
	return 0
}

// Foreground handoff milestones are retained with the same bounded fault tier
// as errors. Background request/periodic rows remain normal and therefore
// cannot consume this tier when the 2000-row file is full.
func diagnosticMilestone(e map[string]any) bool {
	kind, _ := e["kind"].(string)
	stage, _ := e["stage"].(string)
	reason, _ := e["reason"].(string)
	if kind == "history_rejected" || reason == "notification_open" || reason == "history_rejected" {
		return true
	}
	return reason == "notification_ready" || reason == "completion_posted" || kind == "history_applied" || kind == "send_flow" && (stage == "committed" || stage == "shown")
}

func diagnosticErrorKind(kind string) bool {
	return strings.HasSuffix(kind, "_error") || strings.HasSuffix(kind, "_failed") || kind == "promise_rejection"
}

func diagnosticFailureStage(stage string) bool {
	return stage == "failed" || stage == "blocked" || stage == "pending" || strings.HasSuffix(stage, "_failed")
}
