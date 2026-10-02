package main

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

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
