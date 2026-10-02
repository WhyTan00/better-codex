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
	g.controlMu.Lock()
	defer g.controlMu.Unlock()
	return g.bridge != nil && g.nativeOnline
}
func (g *Gateway) refreshNativeCatalog(scope string) {
	key := "native-catalog:" + scope
	g.mu.Lock()
	if g.refreshing[key] || !g.hasBridge() {
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
	store := g.cacheStore()
	requestedAfter := after
	generation := store.meta("nativeGeneration")
	if supplied := r.URL.Query().Get("generation"); supplied != "" && supplied != generation {
		after = 0
	}
	records, e := store.nativeChanges(scope, "catalog", after, 200)
	if e != nil {
		if g.nativeOnlineNow() {
			g.serveSourceCatalog(w, r, scope, requestedAfter)
			return
		}
		writeJSON(w, 503, map[string]any{"error": "缓存暂不可读"})
		return
	}
	status, e := store.nativeRecord(scope, "catalog-status")
	if e != nil {
		if g.nativeOnlineNow() {
			g.serveSourceCatalog(w, r, scope, requestedAfter)
			return
		}
		writeJSON(w, 503, map[string]any{"error": "目录状态暂不可读"})
		return
	}
	if (g.cachePersistence() == "memory" || store.catalogLimited.Load() || status == nil) && g.nativeOnlineNow() {
		g.serveSourceCatalog(w, r, scope, requestedAfter)
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
	seed, e := g.cacheStore().nativeRecord(scope, "history-cursors:"+id)
	if e != nil || seed == nil || seed.Deleted {
		return nil, e
	}
	var cursors struct {
		ItemsBackwardsCursor string `json:"itemsBackwardsCursor"`
	}
	if json.Unmarshal(seed.Payload, &cursors) != nil || cursors.ItemsBackwardsCursor != cursor {
		return nil, nil
	}
	turn, e := g.cacheStore().nativeRecord(scope, "turn:"+id+":"+turnID)
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
	alias, e := g.cacheStore().nativeRecord(scope, "stable-item-head:"+string(encoded))
	if e != nil || alias == nil || alias.Deleted {
		return nil, e
	}
	var link struct {
		TargetKey string `json:"targetKey"`
	}
	if json.Unmarshal(alias.Payload, &link) != nil {
		return nil, nil
	}
	cached, e := g.cacheStore().nativeRecord(scope, link.TargetKey)
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

type nativeReadVersion struct {
	SourceGeneration string `json:"sourceGeneration"`
	Generation       string `json:"generation"`
	Revision         uint64 `json:"revision"`
}

func (g *Gateway) serveNativeRead(w http.ResponseWriter, r *http.Request, scope string) {
	var request struct {
		Method            string             `json:"method"`
		Params            map[string]any     `json:"params"`
		Fresh             bool               `json:"fresh"`
		KnownRecord       *nativeReadVersion `json:"knownRecord,omitempty"`
		SourceReadVersion int                `json:"sourceReadVersion,omitempty"`
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	if e != nil || json.Unmarshal(raw, &request) != nil {
		writeJSON(w, 400, map[string]any{"error": "读取参数无效"})
		return
	}
	// Only our committed scoped row may attest a known version. Never accept
	// this hint from an HTTP client, even an authenticated one.
	request.KnownRecord = nil
	request.SourceReadVersion = 0
	if request.Method != "thread/read" && request.Method != "thread/turns/list" && request.Method != "thread/items/list" {
		writeJSON(w, 403, map[string]any{"error": "缓存只提供原生历史读取"})
		return
	}
	request.Params = normalizeNativeParams(request.Method, request.Params)
	if sourceReadEligible(request.Method, request.Params) {
		request.SourceReadVersion = g.liveReadVersion()
	}
	threadID, _ := request.Params["threadId"].(string)
	if !validID(threadID) {
		writeJSON(w, 400, map[string]any{"error": "会话标识无效"})
		return
	}
	encoded, _ := json.Marshal([]any{request.Method, request.Params})
	key := "read:" + string(encoded)
	trace := newNativeReadTrace(scope, r.Header.Get("X-DSH-Diagnostic-Trace"), request.Method, threadID)
	store := g.cacheStore()
	if (g.cachePersistence() == "memory" || store.catalogLimited.Load()) && g.nativeOnlineNow() {
		request.Fresh = true
	}
	var cached, invalidation *NativeRecord
	cacheContext, cacheCancel := context.WithTimeout(r.Context(), optionalCacheReadBudget)
	defer cacheCancel()
	if !store.catalogLimited.Load() && !(request.Fresh && request.SourceReadVersion == 3) {
		cached, e = store.nativeRecordContext(cacheContext, scope, key, trace, "cloud_lookup")
		if e == nil && cached == nil && request.Method == "thread/items/list" && (!request.Fresh || !g.nativeOnlineNow()) {
			cached, e = g.stableNativeItemHead(scope, key, request.Params)
		}
		if e != nil && (!knownSourceReadVersion(request.SourceReadVersion) || !g.nativeOnlineNow()) {
			writeJSON(w, 503, map[string]any{"error": "缓存暂不可读"})
			return
		}
		invalidation, e = store.nativeRecordContext(cacheContext, scope, "invalidate:"+threadID, trace, "invalidation_lookup")
		if e != nil && (!knownSourceReadVersion(request.SourceReadVersion) || !g.nativeOnlineNow()) {
			writeJSON(w, 503, map[string]any{"error": "缓存版本暂不可读"})
			return
		}
	}
	stale := cached != nil && invalidation != nil && cached.Revision < invalidation.Revision
	if e == nil && cached != nil && !cached.Deleted && (!request.Fresh || !g.nativeOnlineNow()) && !(stale && knownSourceReadVersion(request.SourceReadVersion) && g.nativeOnlineNow()) {
		// Keep immutable Native payload bytes and uint64 revisions intact. A map
		// round-trip reordered every object and converted integers to float64.
		online := g.nativeOnlineNow()
		writeJSON(w, 200, struct {
			*NativeRecord
			Source       string `json:"source"`
			NativeOnline bool   `json:"nativeOnline"`
			Stale        bool   `json:"stale"`
		}{cached, "cloud-cache", online, stale || !online})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	if cached != nil && !cached.Deleted && !store.memory {
		request.KnownRecord = &nativeReadVersion{SourceGeneration: cached.SourceGeneration, Generation: cached.Generation, Revision: cached.Revision}
	}
	ctx = context.WithValue(ctx, nativeReadTraceKey{}, trace)
	result, e := g.call(ctx, scope, "native-read", request)
	if e != nil {
		writeJSON(w, 503, map[string]any{"error": "Mac 暂不可读；已缓存内容仍可阅读"})
		return
	}
	// Negotiated source reads bypass projection ACKs. Legacy adapters still
	// return an exact durable receipt, validated by the unchanged readback below.
	var record NativeRecord
	if json.Unmarshal(result, &record) != nil || record.Scope != scope || record.Key != key {
		trace.event("failed", "receipt_validate", map[string]any{"failureClass": "mismatch"})
		writeJSON(w, 502, map[string]any{"error": "原生缓存读取结果不匹配"})
		return
	}
	var delivery struct {
		ReadDelivery *struct {
			Version             int  `json:"version"`
			SourceVerified      bool `json:"sourceVerified"`
			ProjectionCommitted bool `json:"projectionCommitted"`
			SourceOnly          bool `json:"sourceOnly,omitempty"`
		} `json:"readDelivery"`
	}
	_ = json.Unmarshal(result, &delivery)
	if delivery.ReadDelivery != nil {
		d := delivery.ReadDelivery
		if !knownSourceReadVersion(request.SourceReadVersion) || !knownSourceReadVersion(d.Version) || d.Version > request.SourceReadVersion || d.SourceOnly && d.Version != 3 || !d.SourceVerified || d.ProjectionCommitted || !validSourceRead(record, scope, key, threadID, request.Method, request.Params, len(result)) {
			trace.event("failed", "source_validate", map[string]any{"failureClass": "mismatch"})
			writeJSON(w, 502, map[string]any{"error": "原生历史身份或容量不匹配"})
			return
		}
		// Source revisions are independent of the cloud stream cursor. A delayed
		// response may never regress a newer row or a known invalidation.
		if !d.SourceOnly && invalidation != nil && invalidation.SourceGeneration == record.SourceGeneration && invalidation.Revision > record.Revision {
			writeJSON(w, 409, map[string]any{"error": "历史版本已更新，请重新读取"})
			return
		}
		if !d.SourceOnly && cached != nil && cached.SourceGeneration == record.SourceGeneration && cached.Revision > record.Revision {
			writeJSON(w, 409, map[string]any{"error": "历史版本已更新，请重新读取"})
			return
		}
		trace.event("received", "source_validate", map[string]any{"recordRevision": record.Revision, "responseBytes": len(result), "sourceVerified": true, "projectionCommitted": false})
		source := "native"
		var origin struct {
			Source string `json:"source"`
		}
		_ = json.Unmarshal(result, &origin)
		if d.Version == 3 && origin.Source == "mac-cache" {
			source = "mac-cache"
		}
		writeJSON(w, 200, map[string]any{"scope": record.Scope, "key": record.Key, "kind": record.Kind, "threadId": record.ThreadID, "sourceGeneration": record.SourceGeneration, "generation": record.Generation, "revision": record.Revision, "payload": record.Payload, "bytes": record.Bytes, "confirmedAt": record.ConfirmedAt, "deleted": false, "source": source, "readDelivery": d})
		return
	}
	committed, e := g.cacheStore().nativeRecordContext(ctx, scope, key, trace, "cloud_readback_query")
	if e != nil || committed == nil || committed.Revision < record.Revision ||
		(record.SourceGeneration != "" && committed.SourceGeneration != record.SourceGeneration) ||
		(record.Generation != "" && committed.Generation != record.Generation) {
		trace.event("failed", "cloud_readback", map[string]any{"failureClass": "storage", "recordRevision": record.Revision})
		writeJSON(w, 503, map[string]any{"error": "读取结果尚未提交，请稍后核对"})
		return
	}
	trace.event("committed", "cloud_readback", map[string]any{"recordRevision": committed.Revision})
	// Only the exact version attested by this fresh Native read is authoritative.
	// A newer projection remains useful, but it was not validated by this reply.
	// Do not lose provenance on the durable-ACK path (in particular item pages).
	source := "cloud-cache"
	if request.Fresh && !committed.Deleted && committed.Kind == "history" && committed.ThreadID == threadID &&
		record.SourceGeneration != "" && record.Generation != "" && committed.Revision == record.Revision &&
		committed.SourceGeneration == record.SourceGeneration && committed.Generation == record.Generation {
		source = "native"
	}
	writeJSON(w, 200, struct {
		*NativeRecord
		Source string `json:"source"`
	}{committed, source})
}
