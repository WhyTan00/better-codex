package main

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNativeHTTPTraceIsScopedAndSettled(t *testing.T) {
	g := testGateway(t)
	bootstrap := NativeRecord{
		SourceGeneration: "source",
		Scope:            "ai",
		Key:              "bootstrap",
		Kind:             "bootstrap",
		Generation:       "generation",
		Revision:         1,
		Payload:          json.RawMessage(`{"config":{"ready":true}}`),
	}
	raw, err := json.Marshal(bootstrap)
	if err != nil {
		t.Fatal(err)
	}
	if err = g.apply(frame{Type: "publish", Epoch: "source", Seq: 1, Scope: "ai", Event: Event{Type: "nativeRecord"}, Data: raw}); err != nil {
		t.Fatal(err)
	}
	if err = g.apply(snapshotFrame(2)); err != nil {
		t.Fatal(err)
	}
	params := map[string]any{"threadId": threadID, "includeTurns": false}
	encoded, err := json.Marshal([]any{"thread/read", params})
	if err != nil {
		t.Fatal(err)
	}
	readRecord := NativeRecord{
		SourceGeneration: "source",
		Scope:            "ai",
		Key:              "read:" + string(encoded),
		Kind:             "history",
		ThreadID:         threadID,
		Generation:       "generation",
		Revision:         2,
		Payload:          json.RawMessage(`{"method":"thread/read","params":{"threadId":"11111111-1111-4111-a111-111111111111","includeTurns":false},"result":{"thread":{"id":"11111111-1111-4111-a111-111111111111"}}}`),
	}
	raw, err = json.Marshal(readRecord)
	if err != nil {
		t.Fatal(err)
	}
	if err = g.apply(frame{Type: "publish", Epoch: "source", Seq: 3, Scope: "ai", ThreadID: threadID, Event: Event{Type: "nativeRecord"}, Data: raw}); err != nil {
		t.Fatal(err)
	}

	var logs bytes.Buffer
	previousWriter, previousFlags := log.Writer(), log.Flags()
	log.SetOutput(&logs)
	log.SetFlags(0)
	defer func() {
		log.SetOutput(previousWriter)
		log.SetFlags(previousFlags)
	}()

	request := func(path, trace string, authenticated bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		if authenticated {
			r.Header.Set("X-DSH-Authenticated", "1")
		}
		if trace != "" {
			r.Header.Set("X-DSH-Diagnostic-Trace", trace)
		}
		w := httptest.NewRecorder()
		g.Handler().ServeHTTP(w, r)
		return w
	}
	postRequest := func(path string, body any, trace string, authenticated bool) *httptest.ResponseRecorder {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
		r.Header.Set("Origin", "http://127.0.0.1")
		if authenticated {
			r.Header.Set("X-DSH-Authenticated", "1")
		}
		r.Header.Set("X-DSH-Diagnostic-Trace", trace)
		w := httptest.NewRecorder()
		g.Handler().ServeHTTP(w, r)
		return w
	}

	traces := []string{
		"11111111-1111-4111-a111-111111111111",
		"22222222-2222-4222-a222-222222222222",
		"33333333-3333-4333-a333-333333333333",
		"44444444-4444-4444-a444-444444444444",
	}
	if got := request("/sync/v1/w/ai/native-catalog?after=0", traces[0], true).Code; got != http.StatusOK {
		t.Fatal("catalog status", got)
	}
	if got := request("/sync/v1/w/ai/native-bootstrap", traces[1], true).Code; got != http.StatusOK {
		t.Fatal("bootstrap status", got)
	}
	if got := request("/sync/v1/w/ai/thread/"+threadID, traces[2], true).Code; got != http.StatusOK {
		t.Fatal("thread status", got)
	}
	if got := postRequest("/sync/v1/w/ai/native-read", map[string]any{
		"method": "thread/read", "params": map[string]any{"threadId": threadID}, "fresh": false,
	}, traces[3], true).Code; got != http.StatusOK {
		t.Fatal("native-read status", got)
	}

	// Invalid or unauthenticated requests still follow their existing guards,
	// but cannot create an unscoped trace record.
	if got := request("/sync/v1/w/ai/native-catalog", "not-a-uuid", true).Code; got != http.StatusOK {
		t.Fatal("invalid trace changed catalog status", got)
	}
	if got := request("/sync/v1/w/ai/native-bootstrap", traces[0], false).Code; got != http.StatusUnauthorized {
		t.Fatal("missing auth changed bootstrap status", got)
	}
	if got := request("/sync/v1/w/other/native-bootstrap", traces[0], true).Code; got != http.StatusNotFound {
		t.Fatal("foreign scope changed route status", got)
	}

	rows := []map[string]any{}
	readPhases := map[string]bool{}
	for _, line := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
		if line == "" {
			continue
		}
		var row map[string]any
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			t.Fatalf("non-json trace log %q: %v", line, err)
		}
		if row["event"] == "read" {
			if row["scope"] != "ai" || row["traceId"] != traces[3] {
				t.Fatal("unscoped storage stage", row)
			}
			if row["stage"] == "received" {
				for _, field := range []string{"dbWaitMs", "sqlReadMs", "decodeMs", "phaseDurationMs"} {
					if row[field] == nil {
						t.Fatal("storage timing missing", field)
					}
				}
				readPhases[row["readPhase"].(string)] = true
			}
			continue
		}
		rows = append(rows, row)
	}
	if !readPhases["cloud_lookup"] || !readPhases["invalidation_lookup"] {
		t.Fatal("early storage phases missing", readPhases)
	}
	if len(rows) != 8 {
		t.Fatalf("got %d trace rows: %s", len(rows), logs.String())
	}
	for i, trace := range traces {
		received, settled := rows[2*i], rows[2*i+1]
		for _, row := range []map[string]any{received, settled} {
			if row["event"] != "request" || row["component"] != "native-http" || row["scope"] != "ai" || row["traceId"] != trace {
				t.Fatalf("bad scoped trace row %#v", row)
			}
			if row["routeClass"] == nil || row["method"] != map[int]string{0: "GET", 1: "GET", 2: "thread/read", 3: "POST"}[i] {
				t.Fatalf("bad route/method row %#v", row)
			}
			if _, ok := row["durationMs"]; !ok {
				t.Fatalf("missing duration row %#v", row)
			}
		}
		if received["stage"] != "received" || received["reason"] != "request_received" || received["statusCode"] != float64(0) {
			t.Fatalf("bad request_received row %#v", received)
		}
		if settled["stage"] != "settled" || settled["statusCode"] != float64(200) {
			t.Fatalf("bad settled row %#v", settled)
		}
		if duration, ok := settled["durationMs"].(float64); !ok || duration < 0 {
			t.Fatalf("bad settled duration %#v", settled)
		}
	}
	if strings.Contains(logs.String(), "X-DSH-Diagnostic") || strings.Contains(logs.String(), "native-bootstrap?") {
		t.Fatal("request headers or URL leaked into trace log")
	}
}
