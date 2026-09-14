package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"time"
)

func normalizeNativeParams(method string, p map[string]any) map[string]any {
	result := map[string]any{}
	for k, v := range p {
		result[k] = v
	}
	if result["cursor"] == nil {
		delete(result, "cursor")
	}
	if method == "thread/read" {
		if _, ok := result["includeTurns"]; !ok {
			result["includeTurns"] = false
		}
	}
	if method == "thread/turns/list" || method == "thread/items/list" {
		fallback, maximum := float64(12), float64(20)
		direction := "desc"
		if method == "thread/items/list" {
			fallback, maximum, direction = 40, 100, "asc"
			if result["turnId"] == nil {
				delete(result, "turnId")
			}
		}
		limit, _ := result["limit"].(float64)
		if limit == 0 {
			limit = fallback
		}
		if limit < 1 {
			limit = 1
		}
		if limit > maximum {
			limit = maximum
		}
		result["limit"] = limit
		if result["sortDirection"] == nil {
			result["sortDirection"] = direction
		}
		if method == "thread/turns/list" && result["itemsView"] == nil {
			result["itemsView"] = "summary"
		}
	}
	return result
}

func (g *Gateway) nativeOnlineNow() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.bridge != nil && g.nativeOnline
}
func (g *Gateway) refreshNativeCatalog(scope string) {
	key := "native-catalog:" + scope
	g.mu.Lock()
	if g.refreshing[key] || g.bridge == nil {
		g.mu.Unlock()
		return
	}
	g.refreshing[key] = true
	g.mu.Unlock()
	go func() {
		defer func() { g.mu.Lock(); delete(g.refreshing, key); g.mu.Unlock() }()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_, _ = g.call(ctx, scope, "native-catalog", map[string]any{"fresh": true})
	}()
}
func (g *Gateway) serveNativeCatalog(w http.ResponseWriter, r *http.Request, scope string) {
	after, e := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)
	if e != nil && r.URL.Query().Get("after") != "" {
		writeJSON(w, 400, map[string]any{"error": "缓存游标无效"})
		return
	}
	generation := g.durable.meta("nativeGeneration")
	if supplied := r.URL.Query().Get("generation"); supplied != "" && supplied != generation {
		after = 0
	}
	records, e := g.durable.nativeChanges(scope, "catalog", after, 200)
	if e != nil {
		writeJSON(w, 503, map[string]any{"error": "缓存暂不可读"})
		return
	}
	status, e := g.durable.nativeRecord(scope, "catalog-status")
	if e != nil {
		writeJSON(w, 503, map[string]any{"error": "目录状态暂不可读"})
		return
	}
	cursor := after
	if len(records) > 0 {
		cursor = records[len(records)-1].Revision
	}
	if status == nil || r.URL.Query().Get("refresh") == "1" {
		g.refreshNativeCatalog(scope)
	}
	writeJSON(w, 200, map[string]any{"generation": generation, "records": records, "cursor": cursor, "hasMore": len(records) == 200, "status": status, "nativeOnline": g.nativeOnlineNow(), "source": "cloud-cache"})
}

// Completed turns are immutable within a history generation. Only the first
// per-turn item page can move to a new global snapshot cursor; its original
// nextCursor and all native payload fields remain unchanged.
func (g *Gateway) stableNativeItemHead(scope, key string, p map[string]any) (*NativeRecord, error) {
	id, _ := p["threadId"].(string)
	turnID, _ := p["turnId"].(string)
	cursor, _ := p["cursor"].(string)
	if turnID == "" || cursor == "" {
		return nil, nil
	}
	seed, e := g.durable.nativeRecord(scope, "history-cursors:"+id)
	if e != nil || seed == nil || seed.Deleted {
		return nil, e
	}
	var cursors struct {
		ItemsBackwardsCursor string `json:"itemsBackwardsCursor"`
	}
	if json.Unmarshal(seed.Payload, &cursors) != nil || cursors.ItemsBackwardsCursor != cursor {
		return nil, nil
	}
	turn, e := g.durable.nativeRecord(scope, "turn:"+id+":"+turnID)
	if e != nil || turn == nil || turn.Deleted {
		return nil, e
	}
	var metadata struct {
		Turn struct {
			Status string `json:"status"`
		} `json:"turn"`
	}
	if json.Unmarshal(turn.Payload, &metadata) != nil || metadata.Turn.Status != "completed" {
		return nil, nil
	}
	encoded, _ := json.Marshal([]any{id, turnID, p["limit"], p["sortDirection"]})
	alias, e := g.durable.nativeRecord(scope, "stable-item-head:"+string(encoded))
	if e != nil || alias == nil || alias.Deleted {
		return nil, e
	}
	var link struct {
		TargetKey string `json:"targetKey"`
	}
	if json.Unmarshal(alias.Payload, &link) != nil {
		return nil, nil
	}
	cached, e := g.durable.nativeRecord(scope, link.TargetKey)
	if e != nil || cached == nil || cached.Deleted {
		return nil, e
	}
	if cached.Generation != turn.Generation || cached.SourceGeneration != turn.SourceGeneration || seed.Generation != turn.Generation {
		return nil, nil
	}
	var payload map[string]json.RawMessage
	if json.Unmarshal(cached.Payload, &payload) != nil {
		return nil, nil
	}
	payload["params"], _ = json.Marshal(p)
	copy := *cached
	copy.Key = key
	copy.Payload, _ = json.Marshal(payload)
	return &copy, nil
}

func (g *Gateway) serveNativeRead(w http.ResponseWriter, r *http.Request, scope string) {
	var request struct {
		Method string         `json:"method"`
		Params map[string]any `json:"params"`
		Fresh  bool           `json:"fresh"`
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	if e != nil || json.Unmarshal(raw, &request) != nil {
		writeJSON(w, 400, map[string]any{"error": "读取参数无效"})
		return
	}
	if request.Method != "thread/read" && request.Method != "thread/turns/list" && request.Method != "thread/items/list" {
		writeJSON(w, 403, map[string]any{"error": "缓存只提供原生历史读取"})
		return
	}
	request.Params = normalizeNativeParams(request.Method, request.Params)
	threadID, _ := request.Params["threadId"].(string)
	if !validID(threadID) {
		writeJSON(w, 400, map[string]any{"error": "会话标识无效"})
		return
	}
	encoded, _ := json.Marshal([]any{request.Method, request.Params})
	key := "read:" + string(encoded)
	cached, e := g.durable.nativeRecord(scope, key)
	if e == nil && cached == nil && request.Method == "thread/items/list" && (!request.Fresh || !g.nativeOnlineNow()) {
		cached, e = g.stableNativeItemHead(scope, key, request.Params)
	}
	if e != nil {
		writeJSON(w, 503, map[string]any{"error": "缓存暂不可读"})
		return
	}
	invalidation, e := g.durable.nativeRecord(scope, "invalidate:"+threadID)
	if e != nil {
		writeJSON(w, 503, map[string]any{"error": "缓存版本暂不可读"})
		return
	}
	stale := cached != nil && invalidation != nil && cached.Revision < invalidation.Revision
	if cached != nil && !cached.Deleted && (!request.Fresh || !g.nativeOnlineNow()) {
		value := map[string]any{}
		data, _ := json.Marshal(cached)
		_ = json.Unmarshal(data, &value)
		value["source"] = "cloud-cache"
		value["nativeOnline"] = g.nativeOnlineNow()
		value["stale"] = stale || !g.nativeOnlineNow()
		writeJSON(w, 200, value)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	result, e := g.call(ctx, scope, "native-read", request)
	if e != nil {
		writeJSON(w, 503, map[string]any{"error": "Mac 暂不可读；已缓存内容仍可阅读"})
		return
	}
	// Adapter waits for the durable publication ACK before replying.
	var record NativeRecord
	if json.Unmarshal(result, &record) != nil || record.Scope != scope || record.Key != key {
		writeJSON(w, 502, map[string]any{"error": "原生缓存读取结果不匹配"})
		return
	}
	committed, e := g.durable.nativeRecord(scope, key)
	if e != nil || committed == nil || committed.Revision < record.Revision {
		writeJSON(w, 503, map[string]any{"error": "读取结果尚未提交，请稍后核对"})
		return
	}
	writeJSON(w, 200, committed)
}
