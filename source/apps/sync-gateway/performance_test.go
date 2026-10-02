package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRenderDiagnosticKeepsOnlyCodeCoordinates(t *testing.T) {
	var input map[string]any
	if err := json.Unmarshal([]byte(`{"kind":"render_error","errorName":"TypeError","message":"PRIVATE_PROMPT","errorFrames":["app-primary-6cd7b8b3f5e3.js:467:1234","https://PRIVATE_URL/secret.js:1:2","/workspace/redacted/source.js:1:2"],"reactErrorCode":185}`), &input); err != nil {
		t.Fatal(err)
	}
	result := safeClientDiagnostic(input)
	frames := result["errorFrames"].([]string)
	if result["kind"] != "render_error" || result["errorName"] != "TypeError" || len(frames) != 1 || frames[0] != "app-primary-6cd7b8b3f5e3.js:467:1234" {
		t.Fatalf("code coordinates lost: %#v", result)
	}
	data, _ := json.Marshal(result)
	if strings.Contains(string(data), "PRIVATE") {
		t.Fatal("private exception data retained")
	}
}

func TestClientDiagnosticKeepsLegacyKind(t *testing.T) {
	result := safeClientDiagnostic(map[string]any{
		"kind": "history_read", "reason": "pageshow", "method": "thread/read", "fresh": false,
	})
	if result["kind"] != "history_read" || result["reason"] != "pageshow" || result["method"] != "thread/read" || result["fresh"] != false {
		t.Fatalf("legacy diagnostic metadata was filtered: %#v", result)
	}
}

func TestClientDiagnosticSchemaKeepsBoundedMetadata(t *testing.T) {
	var input map[string]any
	if err := json.Unmarshal([]byte(`{
                "kind":"send_flow","stage":"blocked","source":"native","reason":"submit_busy",
                "policy":"workspace-write","failureClass":"rpc_contract","errorName":"AbortError",
                "eventId":"11111111-1111-4111-a111-111111111111","incidentId":"22222222-2222-4222-a222-222222222222",
                "deviceId":"33333333-3333-4333-a333-333333333333","traceId":"44444444-4444-4444-a444-444444444444",
                "uiVersion":"abcdef0123456789","rpcIdHash":"0123456789abcdef","questionIdHash":"fedcba9876543210",
                "selectedQuestionHash":"0011223344556677","stackHash":"8899aabbccddeeff",
                "pageId":"12345678","previousPageId":"abcdef12",
                "clientAt":123,"seq":4,"monoMs":5,"statusCode":500,"rpcCode":-32000,"reactErrorCode":9999,
                "fresh":true,"executionConnected":false,"answered":true,
                "errorFrames":["scope.js:1:2","runtime.js:2:3","loader.js:3:4","pwa.js:4:5","turn.js:5:6",
                  "app-primary-6cd7b8b3f5e3.js:467:1234","app-secondary-0123456789abcdef.js:7:8",
                  "app-tertiary-abcdef0123456789.js:9:10","https://private.invalid/secret.js:1:2","/workspace/redacted/source.js:1:2"],
                "message":"PRIVATE_PROMPT","token":"PRIVATE_TOKEN","rpcCodeBad":-40000
        }`), &input); err != nil {
		t.Fatal(err)
	}
	result := safeClientDiagnostic(input)
	for _, key := range []string{"kind", "stage", "source", "reason", "policy", "failureClass", "errorName", "eventId", "incidentId", "deviceId", "traceId", "uiVersion", "rpcIdHash", "questionIdHash", "selectedQuestionHash", "stackHash", "pageId", "previousPageId", "clientAt", "seq", "monoMs", "statusCode", "rpcCode", "reactErrorCode", "fresh", "executionConnected", "answered"} {
		if _, ok := result[key]; !ok {
			t.Errorf("schema field %q was filtered", key)
		}
	}
	frames, ok := result["errorFrames"].([]string)
	if !ok || len(frames) != 8 || frames[0] != "scope.js:1:2" || frames[7] != "app-tertiary-abcdef0123456789.js:9:10" {
		t.Fatalf("bounded frames were not retained: %#v", result["errorFrames"])
	}
	if _, ok := result["rpcCodeBad"]; ok {
		t.Fatal("unknown field retained")
	}
	data, _ := json.Marshal(result)
	if strings.Contains(string(data), "PRIVATE") || strings.Contains(string(data), "private.invalid") {
		t.Fatalf("private diagnostic data retained: %s", data)
	}

	input["rpcCode"] = -32769
	input["reactErrorCode"] = 10000
	input["uiVersion"] = "ABCDEF0123456789"
	input["pageId"] = "private-page"
	result = safeClientDiagnostic(input)
	for _, key := range []string{"rpcCode", "reactErrorCode", "uiVersion", "pageId"} {
		if _, ok := result[key]; ok {
			t.Errorf("invalid %s was retained", key)
		}
	}
}

func TestAndroidDiagnosticSchemaAndDurableReceipt(t *testing.T) {
	id := "11111111-1111-4111-a111-111111111111"
	result := safeClientDiagnostic(map[string]any{
		"kind": "android_diagnostic", "component": "android-sync", "stage": "committed",
		"reason": "request_received", "method": "readRecords", "routeClass": "native_bootstrap",
		"nativeDeviceId": "22222222-2222-4222-a222-222222222222", "processIdTag": "33333333-3333-4333-a333-333333333333",
		"parentTraceId": "44444444-4444-4444-a444-444444444444", "eventId": id,
		"historyEvicted": float64(2), "pendingDropped": float64(3), "journalDropped": float64(4),
		"storageFailureStage": "journal_write", "persistFailures": float64(1), "networkAvailable": true,
		"failureClass": "dns", "errorName": "IOException",
	})
	for _, key := range []string{"kind", "component", "stage", "reason", "method", "routeClass", "nativeDeviceId", "processIdTag", "parentTraceId", "eventId", "historyEvicted", "pendingDropped", "journalDropped", "storageFailureStage", "persistFailures", "networkAvailable", "failureClass", "errorName"} {
		if _, ok := result[key]; !ok {
			t.Fatalf("android schema field %q was filtered: %#v", key, result)
		}
	}

	g := testGateway(t)
	server := httptest.NewServer(g.Handler())
	defer server.Close()
	body := fmt.Sprintf(`{"events":[{"phase":"client_diagnostic","kind":"android_diagnostic","component":"android-sync","stage":"committed","eventId":"%s"}]}`, id)
	req, _ := http.NewRequest(http.MethodPost, server.URL+"/sync/v1/w/ai/performance", strings.NewReader(body))
	req.Header.Set("X-DSH-Authenticated", "1")
	req.Header.Set("Origin", g.origin)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("diagnostic POST status %d", response.StatusCode)
	}
	var receipt struct {
		Received             bool     `json:"received"`
		AcknowledgedEventIDs []string `json:"acknowledgedEventIds"`
	}
	if err := json.NewDecoder(response.Body).Decode(&receipt); err != nil {
		t.Fatal(err)
	}
	if !receipt.Received || len(receipt.AcknowledgedEventIDs) != 1 || receipt.AcknowledgedEventIDs[0] != id {
		t.Fatalf("durable receipt mismatch: %#v", receipt)
	}
}

func TestClientDiagnosticsDeduplicateReplayAndKeepFirstAt(t *testing.T) {
	g := testGateway(t)
	firstAt := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
	laterAt := time.Now().UTC().Format(time.RFC3339Nano)
	eventID := "55555555-5555-4555-a555-555555555555"
	incidentID := "77777777-7777-4777-a777-777777777777"
	first := map[string]any{
		"phase": "client_diagnostic", "at": firstAt, "eventId": eventID, "kind": "js_error",
		"deviceId": "66666666-6666-4666-a666-666666666666", "pageId": "12345678", "clientAt": float64(7),
	}
	replay := map[string]any{
		"phase": "client_diagnostic", "at": laterAt, "eventId": eventID, "kind": "js_error",
		"deviceId": first["deviceId"], "pageId": first["pageId"], "clientAt": float64(7), "incidentId": incidentID,
	}
	if err := g.storeClientDiagnostics("ai", []map[string]any{first, replay}); err != nil {
		t.Fatal(err)
	}
	rows := readDiagnosticsForTest(t, g, "ai")
	if len(rows) != 1 || rows[0]["at"] != firstAt || rows[0]["incidentId"] != incidentID {
		t.Fatalf("eventId replay changed first receipt: %#v", rows)
	}

	legacyAt := time.Now().Add(-30 * time.Minute).UTC().Format(time.RFC3339Nano)
	legacyReplayAt := time.Now().UTC().Format(time.RFC3339Nano)
	legacy := map[string]any{
		"phase": "client_diagnostic", "at": legacyAt, "deviceId": first["deviceId"], "pageId": "abcdef12",
		"clientAt": float64(8), "kind": "lifecycle", "method": "thread/read", "reason": "pageshow",
	}
	legacyReplay := map[string]any{
		"phase": "client_diagnostic", "at": legacyReplayAt, "deviceId": first["deviceId"], "pageId": "abcdef12",
		"clientAt": float64(8), "kind": "lifecycle", "method": "thread/read", "reason": "pageshow",
	}
	if err := g.storeClientDiagnostics("ai", []map[string]any{legacy, legacyReplay}); err != nil {
		t.Fatal(err)
	}
	rows = readDiagnosticsForTest(t, g, "ai")
	if len(rows) != 2 || rows[1]["at"] != legacyAt {
		t.Fatalf("legacy replay was not stable: %#v", rows)
	}
}

func TestClientDiagnosticsStayInTheirScope(t *testing.T) {
	g := testGateway(t)
	at := time.Now().UTC().Format(time.RFC3339Nano)
	if err := g.storeClientDiagnostics("ai", []map[string]any{{"phase": "client_diagnostic", "at": at, "kind": "history_read", "pageId": "12345678", "clientAt": float64(1)}}); err != nil {
		t.Fatal(err)
	}
	if err := g.storeClientDiagnostics("zyy", []map[string]any{{"phase": "client_diagnostic", "at": at, "kind": "history_applied", "pageId": "abcdef12", "clientAt": float64(2)}}); err != nil {
		t.Fatal(err)
	}
	aiRows, zyyRows := readDiagnosticsForTest(t, g, "ai"), readDiagnosticsForTest(t, g, "zyy")
	if len(aiRows) != 1 || aiRows[0]["kind"] != "history_read" || len(zyyRows) != 1 || zyyRows[0]["kind"] != "history_applied" {
		t.Fatalf("diagnostics crossed scopes: ai=%#v zyy=%#v", aiRows, zyyRows)
	}
}

func TestClientDiagnosticsFaultPrioritySurvivesHistoryFlood(t *testing.T) {
	g := testGateway(t)
	now := time.Now().UTC()
	normal := make([]map[string]any, 0, diagnosticLimit)
	for i := 0; i < diagnosticLimit; i++ {
		normal = append(normal, map[string]any{
			"phase": "client_diagnostic", "at": now.Add(time.Duration(i) * time.Millisecond).Format(time.RFC3339Nano),
			"kind": "lifecycle", "pageId": "12345678", "clientAt": float64(i),
		})
	}
	if err := g.storeClientDiagnostics("ai", normal); err != nil {
		t.Fatal(err)
	}
	context := make([]map[string]any, 0, diagnosticFaultLimit+100)
	for i := 0; i < diagnosticFaultLimit+100; i++ {
		context = append(context, map[string]any{
			"phase": "client_diagnostic", "at": now.Add(time.Duration(diagnosticLimit+i) * time.Millisecond).Format(time.RFC3339Nano),
			"kind": "send_flow", "stage": "accepted", "incidentId": diagnosticTestUUID(i), "pageId": "12345678", "clientAt": float64(3000 + i),
		})
	}
	errorEvent := map[string]any{
		"phase": "client_diagnostic", "at": now.Add(10 * time.Second).Format(time.RFC3339Nano),
		"kind": "send_flow", "stage": "blocked", "incidentId": diagnosticTestUUID(9999), "pageId": "12345678", "clientAt": float64(5000),
	}
	if err := g.storeClientDiagnostics("ai", append(context, errorEvent)); err != nil {
		t.Fatal(err)
	}
	rows := readDiagnosticsForTest(t, g, "ai")
	if len(rows) != diagnosticLimit {
		t.Fatalf("retention limit changed: got %d", len(rows))
	}
	foundError, contextCount, normalCount := false, 0, 0
	lastClientAt := -1.0
	for _, row := range rows {
		clientAt, _ := row["clientAt"].(float64)
		if clientAt < lastClientAt {
			t.Fatalf("retained rows lost source order: %.0f after %.0f", clientAt, lastClientAt)
		}
		lastClientAt = clientAt
		kind, _ := row["kind"].(string)
		stage, _ := row["stage"].(string)
		switch {
		case kind == "send_flow" && stage == "blocked":
			foundError = true
		case kind == "send_flow":
			contextCount++
		case kind == "lifecycle":
			normalCount++
		}
	}
	if !foundError || contextCount != diagnosticFaultLimit-1 || normalCount != diagnosticLimit-diagnosticFaultLimit {
		t.Fatalf("fault tiers were not prioritized: error=%v context=%d normal=%d", foundError, contextCount, normalCount)
	}
}

func TestClientDiagnosticsNotificationMilestonesSurviveBackgroundFlood(t *testing.T) {
	g := testGateway(t)
	now := time.Now().UTC()
	background := make([]map[string]any, 0, diagnosticLimit)
	for i := 0; i < diagnosticLimit; i++ {
		reason := "periodic"
		if i%2 == 0 {
			reason = "request_received"
		}
		background = append(background, map[string]any{
			"phase": "client_diagnostic", "at": now.Add(time.Duration(i) * time.Millisecond).Format(time.RFC3339Nano),
			"eventId": diagnosticTestUUID(10000 + i), "kind": "lifecycle", "stage": "received", "reason": reason,
		})
	}
	keyRows := []map[string]any{
		{"phase": "client_diagnostic", "at": now.Add(3 * time.Second).Format(time.RFC3339Nano), "eventId": diagnosticTestUUID(20001), "kind": "history_rejected"},
		{"phase": "client_diagnostic", "at": now.Add(3*time.Second + time.Millisecond).Format(time.RFC3339Nano), "eventId": diagnosticTestUUID(20002), "kind": "client_health", "stage": "received", "reason": "notification_open"},
		{"phase": "client_diagnostic", "at": now.Add(3*time.Second + 2*time.Millisecond).Format(time.RFC3339Nano), "eventId": diagnosticTestUUID(20003), "kind": "android_diagnostic", "stage": "committed", "reason": "history_committed"},
		{"phase": "client_diagnostic", "at": now.Add(3*time.Second + 3*time.Millisecond).Format(time.RFC3339Nano), "eventId": diagnosticTestUUID(20004), "kind": "android_diagnostic", "stage": "shown", "reason": "periodic"},
		{"phase": "client_diagnostic", "at": now.Add(3*time.Second + 4*time.Millisecond).Format(time.RFC3339Nano), "eventId": diagnosticTestUUID(20005), "kind": "js_error"},
	}
	if err := g.storeClientDiagnostics("ai", append(background, keyRows...)); err != nil {
		t.Fatal(err)
	}
	rows := readDiagnosticsForTest(t, g, "ai")
	if len(rows) != diagnosticLimit {
		t.Fatalf("retention limit changed: got %d", len(rows))
	}
	found := make(map[string]bool)
	for _, row := range rows {
		if id, ok := row["eventId"].(string); ok {
			found[id] = true
		}
	}
	for i := 20001; i <= 20005; i++ {
		if !found[diagnosticTestUUID(i)] {
			t.Fatalf("key diagnostic %d was crowded out", i)
		}
	}
	backgroundCount := 0
	for _, row := range rows {
		if kind, _ := row["kind"].(string); kind == "lifecycle" {
			backgroundCount++
		}
	}
	if backgroundCount != diagnosticLimit-len(keyRows) {
		t.Fatalf("background rows did not yield to key rows: got %d", backgroundCount)
	}
}

func TestClientDiagnosticsExpireAfterSevenDaysAndGETReportsContract(t *testing.T) {
	g := testGateway(t)
	now := time.Now().UTC()
	rows := []map[string]any{
		{"phase": "client_diagnostic", "at": now.Add(-diagnosticRetention - time.Minute).Format(time.RFC3339Nano), "kind": "lifecycle"},
		{"phase": "client_diagnostic", "at": now.Add(-time.Hour).Format(time.RFC3339Nano), "kind": "history_applied"},
	}
	path := filepath.Join(g.dir, "client-diagnostics-ai.json")
	if err := atomicJSON(path, rows); err != nil {
		t.Fatal(err)
	}
	loaded := readDiagnosticsForTest(t, g, "ai")
	if len(loaded) != 1 || loaded[0]["kind"] != "history_applied" {
		t.Fatalf("seven-day TTL did not remove old rows: %#v", loaded)
	}

	server := httptest.NewServer(g.Handler())
	defer server.Close()
	request, _ := http.NewRequest(http.MethodGet, server.URL+"/sync/v1/w/ai/performance?diagnostics=1", nil)
	request.Header.Set("X-DSH-Authenticated", "1")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("diagnostic GET status %d", response.StatusCode)
	}
	var payload struct {
		Events         []map[string]any `json:"events"`
		RetentionHours int              `json:"retentionHours"`
		Limit          int              `json:"limit"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.RetentionHours != 168 || payload.Limit != diagnosticLimit || len(payload.Events) != 1 {
		t.Fatalf("GET diagnostics contract mismatch: %#v", payload)
	}
}

func TestClientDiagnosticsWriteHasHardFourMiBCap(t *testing.T) {
	g := testGateway(t)
	row := map[string]any{
		"phase": "client_diagnostic", "at": time.Now().UTC().Format(time.RFC3339Nano),
		"kind": "lifecycle", "unexpected": strings.Repeat("x", diagnosticMaxFileSize),
	}
	if err := g.storeClientDiagnostics("ai", []map[string]any{row}); err == nil {
		t.Fatal("oversized diagnostic file was accepted")
	}
	if _, err := os.Stat(filepath.Join(g.dir, "client-diagnostics-ai.json")); !os.IsNotExist(err) {
		t.Fatalf("oversized write left a file: %v", err)
	}
}

func diagnosticTestUUID(n int) string {
	return fmt.Sprintf("00000000-0000-4000-8000-%012x", n)
}

func readDiagnosticsForTest(t *testing.T, g *Gateway, scope string) []map[string]any {
	t.Helper()
	rows, err := g.readClientDiagnostics(scope)
	if err != nil {
		t.Fatal(err)
	}
	return rows
}
func TestDiagnosticFilesSurviveSnapshotBudgetPruning(t *testing.T) {
	g := testGateway(t)
	path := diagnosticPath(g, "ai")
	row := map[string]any{"phase": "client_diagnostic", "kind": "client_health", "at": time.Now().UTC().Format(time.RFC3339Nano)}
	if err := g.storeClientDiagnostics("ai", []map[string]any{row}); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	cache := snapshotFile(g.dir, "ai", diagnosticTestUUID(1))
	if err := os.WriteFile(cache, []byte("disposable"), 0600); err != nil {
		t.Fatal(err)
	}
	pruneStore(g.dir, 0)
	after, err := os.ReadFile(path)
	if err != nil || string(before) != string(after) {
		t.Fatalf("diagnostics evicted by cache budget: %v", err)
	}
	if _, err := os.Stat(cache); !os.IsNotExist(err) {
		t.Fatalf("snapshot budget was not enforced: %v", err)
	}
}
func TestCorruptDiagnosticReadIsNotEmptySuccessAndPOSTPreservesIt(t *testing.T) {
	g := testGateway(t)
	name := diagnosticPath(g, "ai")
	original := []byte("{corrupt diagnostic fixture")
	if err := os.WriteFile(name, original, 0600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(g.Handler())
	defer server.Close()
	for _, method := range []string{"GET", "POST"} {
		req, _ := http.NewRequest(method, server.URL+"/sync/v1/w/ai/performance?diagnostics=1", strings.NewReader(`{"events":[{"phase":"client_diagnostic","kind":"client_health"}]}`))
		req.Header.Set("X-DSH-Authenticated", "1")
		req.Header.Set("Origin", g.origin)
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != 503 {
			t.Fatalf("%s corrupt file returned %d", method, response.StatusCode)
		}
	}
	current, err := os.ReadFile(name)
	if err != nil || string(current) != string(original) {
		t.Fatalf("corrupt evidence overwritten: %v", err)
	}
}
