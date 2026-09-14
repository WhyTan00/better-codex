package main

import (
	"net/http/httptest"
	"testing"
)

func TestAuthenticatedPWANavigationKeepsAPIGuards(t *testing.T) {
	g := testGateway(t)
	for _, path := range []string{"/", "/app", "/app/thread/" + threadID} {
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("Origin", "null")
		r.Header.Set("Sec-Fetch-Site", "cross-site")
		r.Header.Set("Sec-Fetch-Mode", "navigate")
		r.Header.Set("Sec-Fetch-Dest", "document")
		if g.browserAllowed(r) {
			t.Fatal("navigation skipped SSO")
		}
		r.Header.Set("X-BETTER_CODEX-Authenticated", "1")
		if !g.browserAllowed(r) {
			t.Fatal("PWA/SSO document incorrectly denied", path)
		}
		r.Header.Set("Sec-Fetch-Mode", "cors")
		if g.browserAllowed(r) {
			t.Fatal("cross-origin fetch accepted", path)
		}
	}
	r := httptest.NewRequest("GET", "/sync/v1/w/ai/threads", nil)
	r.Header.Set("X-BETTER_CODEX-Authenticated", "1")
	r.Header.Set("Origin", "null")
	r.Header.Set("Sec-Fetch-Mode", "navigate")
	r.Header.Set("Sec-Fetch-Dest", "document")
	if g.browserAllowed(r) {
		t.Fatal("API was mistaken for document")
	}
}
func TestOldLightConversationLinkReturnsCompleteNativeUI(t *testing.T) {
	g := testGateway(t)
	r := httptest.NewRequest("GET", "/app/thread/"+threadID+"?workspace=secondary", nil)
	r.Header.Set("X-BETTER_CODEX-Authenticated", "1")
	w := httptest.NewRecorder()
	g.Handler().ServeHTTP(w, r)
	if w.Code != 303 || w.Header().Get("Location") != "/local/"+threadID+"?workspace=secondary" {
		t.Fatal(w.Code, w.Header())
	}
}
