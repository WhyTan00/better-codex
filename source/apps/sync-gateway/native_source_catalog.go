package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"
)

const catalogSessionChangedCode = "catalogue_session_changed"
const catalogSessionChangedClass = "catalog_session_offset_mismatch"
const nativeCatalogSessionChangedMessage = "目录版本已更新，请重新读取"

// This is one classified read conflict from the scoped Mac catalog source.
// Other adapter errors retain their existing fail-closed response.
type nativeCatalogSessionChangedError struct{ scope string }

func (*nativeCatalogSessionChangedError) Error() string { return nativeCatalogSessionChangedMessage }

func nativeCatalogSessionConflict(scope string, status int, message string) error {
	if (scope == "ai" || scope == "zyy") && status == http.StatusConflict && message == nativeCatalogSessionChangedMessage {
		return &nativeCatalogSessionChangedError{scope: scope}
	}
	return nil
}

// The original authenticated bridge supplies a scoped Native catalog. Its
// revisions are Mac cache revisions, never cloud ACKs or command receipts.
func (g *Gateway) serveSourceCatalog(w http.ResponseWriter, r *http.Request, scope string, after uint64) {
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	generation := r.URL.Query().Get("generation")
	result, err := g.call(ctx, scope, "native-catalog", map[string]any{"after": after, "generation": generation, "fresh": r.URL.Query().Get("refresh") == "1"})
	var page struct {
		Generation string         `json:"generation"`
		Records    []NativeRecord `json:"records"`
		Cursor     uint64         `json:"cursor"`
		HasMore    bool           `json:"hasMore"`
		Status     *NativeRecord  `json:"status"`
	}
	if err != nil {
		var changed *nativeCatalogSessionChangedError
		if errors.As(err, &changed) && changed.scope == scope {
			writeJSON(w, http.StatusConflict, map[string]any{
				"error":        "目录分页状态已更新，请重新读取",
				"code":         catalogSessionChangedCode,
				"failureClass": catalogSessionChangedClass,
				"scope":        scope,
			})
			return
		}
		writeJSON(w, 503, map[string]any{"error": "Mac 目录暂不可读"})
		return
	}
	if json.Unmarshal(result, &page) != nil || page.Generation == "" || page.Records == nil || len(page.Records) > 200 || page.Generation == generation && page.Cursor < after {
		writeJSON(w, 502, map[string]any{"error": "原生目录身份不匹配"})
		return
	}
	for _, record := range page.Records {
		if record.Scope != scope || record.Kind != "catalog" || !validID(record.ThreadID) || record.Key != "thread:"+record.ThreadID || record.SourceGeneration != page.Generation || record.Revision < 1 {
			writeJSON(w, 502, map[string]any{"error": "原生目录超出当前工作区"})
			return
		}
	}
	if page.Status != nil && (page.Status.Scope != scope || page.Status.Key != "catalog-status" || page.Status.SourceGeneration != page.Generation) {
		writeJSON(w, 502, map[string]any{"error": "原生目录状态不匹配"})
		return
	}
	source := "mac-cache"
	if r.URL.Query().Get("refresh") == "1" {
		source = "native"
	}
	writeJSON(w, 200, map[string]any{"generation": page.Generation, "records": page.Records, "cursor": page.Cursor, "hasMore": page.HasMore, "status": page.Status, "nativeOnline": true, "source": source, "cache": g.cacheStatus()})
}
