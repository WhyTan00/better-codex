package main

import (
	"encoding/json"
	"github.com/gorilla/websocket"
	"strings"
	"testing"
	"time"
)

func TestConnectionLogExcludesRawErrorAndPreservesCloseCode(t *testing.T) {
	e := connectionEvent("cloud-events", "failed", "00000000-0000-4000-8000-000000000001", "ai", "read_failed", &websocket.CloseError{Code: 1006, Text: "SECRET token=PRIVATE"}, time.Now())
	raw, _ := json.Marshal(e)
	if strings.Contains(string(raw), "SECRET") || strings.Contains(string(raw), "PRIVATE") || e["closeCode"] != 1006 {
		t.Fatal(string(raw))
	}
	e = connectionEvent("cloud-bridge", "rejected", "SECRET", "outside", "authentication", nil, time.Time{})
	if e["connectionId"] != nil || e["scope"] != nil {
		t.Fatal("invalid identity retained")
	}
}
func TestClientConnectionContract(t *testing.T) {
	in := map[string]any{"kind": "transport", "component": "page-ws", "stage": "closed", "reason": "socket_closed", "connectionId": "00000000-0000-4000-8000-000000000001", "closeCode": float64(1006), "wasClean": false, "handshakeComplete": false, "routeClass": "native_ws", "url": "SECRET", "token": "SECRET"}
	out := safeClientDiagnostic(in)
	raw, _ := json.Marshal(out)
	if out["connectionId"] == nil || out["closeCode"] == nil || out["handshakeComplete"] != false || strings.Contains(string(raw), "SECRET") {
		t.Fatal(string(raw))
	}
	if diagnosticFaultPriority(out) != 2 {
		t.Fatal("connection evidence is not protected")
	}
}
