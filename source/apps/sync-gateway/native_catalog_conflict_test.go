package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Real isolated HTTP + bridge protocol: no production bridge or Native calls.
func TestNativeCatalogConflictProtocol(t *testing.T) {
	for _, variant := range []struct {
		name, message string
		status, want  int
	}{
		{"known-offset", nativeCatalogSessionChangedMessage, 409, 409},
		{"unknown-409", "isolated unknown source failure", 409, 503},
		{"same-message-503", nativeCatalogSessionChangedMessage, 503, 503},
		{"same-message-500", nativeCatalogSessionChangedMessage, 500, 503},
		{"source-auth", "isolated source auth failure", 401, 503},
	} {
		t.Run(variant.name, func(t *testing.T) {
			_, server, bridge := readBridgeFixture(t, true)
			req, _ := http.NewRequest("GET", server.URL+"/sync/v1/w/ai/native-catalog?after=204394&generation=isolated-source", nil)
			req.Header.Set("X-DSH-Authenticated", "1")
			type response struct {
				code int
				body []byte
				err  error
			}
			done := make(chan response, 1)
			go func() {
				r, err := http.DefaultClient.Do(req)
				if err != nil {
					done <- response{err: err}
					return
				}
				defer r.Body.Close()
				body, err := io.ReadAll(r.Body)
				done <- response{r.StatusCode, body, err}
			}()
			var rpc map[string]any
			if err := bridge.ReadJSON(&rpc); err != nil {
				t.Fatal(err)
			}
			body := rpc["body"].(map[string]any)
			if rpc["op"] != "native-catalog" || rpc["scope"] != "ai" || body["after"] != float64(204394) || body["generation"] != "isolated-source" || body["fresh"] != false {
				t.Fatal("source request contract changed")
			}
			if err := bridge.WriteJSON(map[string]any{"type": "reply", "id": rpc["id"], "status": variant.status, "error": variant.message}); err != nil {
				t.Fatal(err)
			}
			got := <-done
			if got.err != nil || got.code != variant.want {
				t.Fatal("source error changed response", got.code, got.err)
			}
			var value map[string]any
			if err := json.Unmarshal(got.body, &value); err != nil {
				t.Fatal(err)
			}
			if variant.want == 409 {
				if value["code"] != catalogSessionChangedCode || value["failureClass"] != catalogSessionChangedClass || value["scope"] != "ai" || len(value) != 4 {
					t.Fatal("typed scope conflict missing")
				}
			} else if len(value) != 1 || value["code"] != nil || value["scope"] != nil {
				t.Fatal("unknown failure gained recovery authority")
			}
			if bytes.Contains(got.body, []byte("records")) || bytes.Contains(got.body, []byte("complete")) {
				t.Fatal("failed catalog fabricated success")
			}
		})
	}
}

func TestNativeCatalogSuccessAndGuardsUnchanged(t *testing.T) {
	g, server, bridge := readBridgeFixture(t, true)
	type response struct {
		code int
		body []byte
		err  error
	}
	done := make(chan response, 1)
	go func() {
		req, _ := http.NewRequest("GET", server.URL+"/sync/v1/w/ai/native-catalog?after=0&generation=isolated-source", nil)
		req.Header.Set("X-DSH-Authenticated", "1")
		r, err := http.DefaultClient.Do(req)
		if err != nil {
			done <- response{err: err}
			return
		}
		defer r.Body.Close()
		body, err := io.ReadAll(r.Body)
		done <- response{r.StatusCode, body, err}
	}()
	var rpc map[string]any
	if err := bridge.ReadJSON(&rpc); err != nil {
		t.Fatal(err)
	}
	if err := bridge.WriteJSON(map[string]any{"type": "reply", "id": rpc["id"], "result": map[string]any{"generation": "isolated-source", "records": []any{}, "cursor": 0, "hasMore": false}}); err != nil {
		t.Fatal(err)
	}
	got := <-done
	if got.err != nil || got.code != 200 {
		t.Fatal("normal source catalog rejected", got.code, got.err)
	}
	var value map[string]any
	json.Unmarshal(got.body, &value)
	if value["hasMore"] != false || value["code"] != nil || value["generation"] != "isolated-source" {
		t.Fatal("normal source DTO changed")
	}
	for _, path := range []string{"/sync/v1/w/ai/native-catalog", "/sync/v1/w/other/native-catalog"} {
		req := httptest.NewRequest("GET", path, nil)
		if path != "/sync/v1/w/ai/native-catalog" {
			req.Header.Set("X-DSH-Authenticated", "1")
		}
		w := httptest.NewRecorder()
		g.Handler().ServeHTTP(w, req)
		want := 401
		if path != "/sync/v1/w/ai/native-catalog" {
			want = 404
		}
		if w.Code != want {
			t.Fatal("auth/scope guard changed", w.Code, want)
		}
	}
	// A ZYY source record cannot be adopted by an AI catalog request.
	done = make(chan response, 1)
	go func() {
		req, _ := http.NewRequest("GET", server.URL+"/sync/v1/w/ai/native-catalog?after=0", nil)
		req.Header.Set("X-DSH-Authenticated", "1")
		r, e := http.DefaultClient.Do(req)
		if e != nil {
			done <- response{err: e}
			return
		}
		defer r.Body.Close()
		b, e := io.ReadAll(r.Body)
		done <- response{r.StatusCode, b, e}
	}()
	if err := bridge.ReadJSON(&rpc); err != nil {
		t.Fatal(err)
	}
	if err := bridge.WriteJSON(map[string]any{"type": "reply", "id": rpc["id"], "result": map[string]any{"generation": "isolated-source", "cursor": 1, "hasMore": false, "records": []any{map[string]any{"scope": "zyy", "kind": "catalog", "threadId": threadID, "key": "thread:" + threadID, "sourceGeneration": "isolated-source", "revision": 1}}}}); err != nil {
		t.Fatal(err)
	}
	if got = <-done; got.err != nil || got.code != 502 {
		t.Fatal("foreign catalog accepted", got.code, got.err)
	}
}

func TestCatalogConflictDoesNotChangeOtherRPCOrInvalidScope(t *testing.T) {
	for _, op := range []string{"native-read", "native-bootstrap", "command"} {
		t.Run(op, func(t *testing.T) {
			g, _, bridge := readBridgeFixture(t)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			done := make(chan error, 1)
			go func() { _, err := g.call(ctx, "ai", op, map[string]any{}); done <- err }()
			var rpc map[string]any
			if err := bridge.ReadJSON(&rpc); err != nil {
				t.Fatal(err)
			}
			if err := bridge.WriteJSON(map[string]any{"type": "reply", "id": rpc["id"], "status": 409, "error": nativeCatalogSessionChangedMessage}); err != nil {
				t.Fatal(err)
			}
			err := <-done
			var conflict *nativeCatalogSessionChangedError
			if err == nil || errors.As(err, &conflict) || err.Error() != nativeCatalogSessionChangedMessage {
				t.Fatal("other RPC error changed")
			}
		})
	}
	if nativeCatalogSessionConflict("other", 409, nativeCatalogSessionChangedMessage) != nil {
		t.Fatal("invalid scope gained recovery authority")
	}
}
