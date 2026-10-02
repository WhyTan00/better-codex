package main

import (
	"bytes"
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

func TestDiagnosticReceiptSurvivesFullPriorityTier(t *testing.T) {
	g := testGateway(t)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	rows := []map[string]any{}
	for i := 0; i < diagnosticFaultLimit; i++ {
		rows = append(rows, map[string]any{"phase": "client_diagnostic", "kind": "android_diagnostic", "component": "android-update", "reason": "check_latest", "eventId": fmt.Sprintf("00000000-0000-4000-a000-%012d", i), "at": now})
	}
	if err := g.storeClientDiagnostics("ai", rows); err != nil {
		t.Fatal(err)
	}
	id := "11111111-1111-4111-a111-111111111111"
	// A real completion-preparation event is context tier. Previously, 500
	// update-check rows made it impossible to ACK this ID, even after retries.
	body := fmt.Sprintf(`{"events":[{"phase":"client_diagnostic","kind":"android_diagnostic","component":"android-notification","stage":"committed","reason":"body_ready","eventId":"%s","message":"PRIVATE_PROMPT"}]}`, id)
	for attempt := 0; attempt < 2; attempt++ {
		req := httptest.NewRequest(http.MethodPost, "/sync/v1/w/ai/performance", strings.NewReader(body))
		req.Header.Set("Origin", g.origin)
		w := httptest.NewRecorder()
		g.servePerformance(w, req, "ai")
		if w.Code != 200 || !strings.Contains(w.Body.String(), id) {
			t.Fatalf("durable event cannot drain, attempt %d: %d %s", attempt, w.Code, w.Body.String())
		}
	}
	view, err := g.readClientDiagnostics("ai")
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range view {
		if row["eventId"] == id {
			t.Fatal("fixture did not exercise query-view eviction")
		}
	}
	files, _ := filepath.Glob(filepath.Join(g.dir, "diagnostics-archive-ai", "*.jsonl"))
	if len(files) != 1 {
		t.Fatalf("archive files: %v", files)
	}
	stored, err := os.ReadFile(files[0])
	if err != nil || !bytes.Contains(stored, []byte(id)) || bytes.Contains(stored, []byte("PRIVATE_PROMPT")) {
		t.Fatalf("archive lost receipt or retained raw input: %v", err)
	}
	if info, _ := os.Stat(files[0]); info.Mode().Perm() != 0600 {
		t.Fatal("diagnostics archive is not private")
	}
	if _, err := os.Stat(filepath.Join(g.dir, "diagnostics-archive-zyy")); !os.IsNotExist(err) {
		t.Fatal("AI event crossed workspace boundary")
	}
}

func TestDiagnosticArchiveFailureCannotAcknowledge(t *testing.T) {
	g := testGateway(t)
	if err := os.WriteFile(filepath.Join(g.dir, "diagnostics-archive-ai"), []byte("blocked"), 0600); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/sync/v1/w/ai/performance", strings.NewReader(`{"events":[{"phase":"client_diagnostic","eventId":"11111111-1111-4111-a111-111111111111","kind":"history_applied"}]}`))
	req.Header.Set("Origin", g.origin)
	w := httptest.NewRecorder()
	g.servePerformance(w, req, "ai")
	if w.Code != 503 || strings.Contains(w.Body.String(), "acknowledgedEventIds") {
		t.Fatalf("failed archive acknowledged: %d %s", w.Code, w.Body.String())
	}
}

func TestDiagnosticArchiveRotatesAndPrunesOnlyOwnedFiles(t *testing.T) {
	g := testGateway(t)
	dir := filepath.Join(g.dir, "diagnostics-archive-ai")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"2026-09-01-000000.jsonl", "keep.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("keep"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	name := filepath.Join(dir, "2026-09-20-000000.jsonl")
	file, err := os.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	if err = file.Truncate(diagnosticArchiveSegment); err != nil {
		t.Fatal(err)
	}
	file.Close()
	row := map[string]any{"phase": "client_diagnostic", "kind": "history_applied"}
	if err := g.archiveClientDiagnostics("ai", []map[string]any{row}, time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "2026-09-01-000000.jsonl")); !os.IsNotExist(err) {
		t.Fatal("expired owned segment retained")
	}
	if _, err := os.Stat(filepath.Join(dir, "keep.txt")); err != nil {
		t.Fatal("unrelated file removed")
	}
	stored, err := os.ReadFile(filepath.Join(dir, "2026-09-20-000001.jsonl"))
	var result map[string]any
	if err != nil || json.Unmarshal(stored, &result) != nil || result["kind"] != "history_applied" {
		t.Fatal("rotated segment missing")
	}
}
