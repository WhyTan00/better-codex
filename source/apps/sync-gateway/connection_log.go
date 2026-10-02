package main

import (
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

// Fixed connection metadata only; error strings, URLs, headers and messages are excluded.
func connectionEvent(component, stage, id, scope, reason string, err error, started time.Time) map[string]any {
	v := map[string]any{"event": "connection", "at": time.Now().UTC().Format(time.RFC3339Nano), "component": component, "stage": stage, "reason": reason}
	if diagnosticUUID.MatchString(id) {
		v["connectionId"] = id
	}
	if validScope(scope) {
		v["scope"] = scope
	}
	if !started.IsZero() {
		v["durationMs"] = time.Since(started).Milliseconds()
	}
	if err != nil {
		v["failureClass"] = "connection"
		var timeout net.Error
		if errors.As(err, &timeout) && timeout.Timeout() {
			v["failureClass"] = "timeout"
		}
		var closed *websocket.CloseError
		if errors.As(err, &closed) {
			v["closeCode"] = closed.Code
		}
	}
	return v
}
func logConnection(component, stage, id, scope, reason string, err error, started time.Time) {
	raw, _ := json.Marshal(connectionEvent(component, stage, id, scope, reason, err, started))
	log.Print(string(raw))
}

// nativeHTTPEvent records only the scoped request identity and outcome for the
// Android native HTTP reads. Request URLs, query values, headers and response
// bodies stay outside the log entirely.
func nativeHTTPEvent(stage, traceID, scope, routeClass, method string, statusCode int, started time.Time) map[string]any {
	v := map[string]any{
		"event":      "request",
		"at":         time.Now().UTC().Format(time.RFC3339Nano),
		"component":  "native-http",
		"stage":      stage,
		"routeClass": routeClass,
		"method":     method,
	}
	if validScope(scope) {
		v["scope"] = scope
	}
	if diagnosticUUID.MatchString(traceID) {
		v["traceId"] = traceID
	}
	if statusCode >= 0 {
		v["statusCode"] = statusCode
	}
	if !started.IsZero() {
		v["durationMs"] = time.Since(started).Milliseconds()
	}
	if stage == "received" {
		v["reason"] = "request_received"
	}
	return v
}

func logNativeHTTP(stage, traceID, scope, routeClass, method string, statusCode int, started time.Time) {
	raw, _ := json.Marshal(nativeHTTPEvent(stage, traceID, scope, routeClass, method, statusCode, started))
	log.Print(string(raw))
}

// nativeHTTPResponseWriter captures the final status without changing the
// JSON response or the authentication/scope checks performed by Handler.
type nativeHTTPResponseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (w *nativeHTTPResponseWriter) WriteHeader(statusCode int) {
	if w.statusCode != 0 {
		return
	}
	w.statusCode = statusCode
	w.ResponseWriter.WriteHeader(statusCode)
}

func (w *nativeHTTPResponseWriter) Write(body []byte) (int, error) {
	if w.statusCode == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(body)
}

func (w *nativeHTTPResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// traceNativeHTTP wraps an already authenticated, scope-selected native
// request. A malformed or absent trace header runs through the exact existing
// handler without emitting an unscoped record.
func traceNativeHTTP(w http.ResponseWriter, r *http.Request, scope, routeClass, method string, handler func(http.ResponseWriter)) {
	traceID := r.Header.Get("X-DSH-Diagnostic-Trace")
	if !diagnosticUUID.MatchString(traceID) {
		handler(w)
		return
	}
	started := time.Now()
	logNativeHTTP("received", traceID, scope, routeClass, method, 0, started)
	recorder := &nativeHTTPResponseWriter{ResponseWriter: w}
	handler(recorder)
	statusCode := recorder.statusCode
	if statusCode == 0 {
		statusCode = http.StatusOK
	}
	logNativeHTTP("settled", traceID, scope, routeClass, method, statusCode, started)
}
