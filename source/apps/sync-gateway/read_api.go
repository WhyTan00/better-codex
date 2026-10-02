package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

func (g *Gateway) serveSnapshot(w http.ResponseWriter, r *http.Request, scope, id string) {
	cursor := r.URL.Query().Get("cursor")
	g.mu.Lock()
	t := g.topicLocked(scope, id)
	seq, epoch, online := t.Seq, g.epoch, g.nativeOnlineNow()
	var snapshot Snapshot
	cached := t.Snapshot != nil
	if cached {
		data, _ := json.Marshal(t.Snapshot)
		_ = json.Unmarshal(data, &snapshot)
	}
	g.mu.Unlock()
	if strings.HasPrefix(cursor, "cached:") && cached {
		page, err := g.boundedHistoryPage(r.Context(), scope, id, cursor, snapshot.Thread)
		if err != nil {
			writeJSON(w, 409, map[string]any{"error": err.Error()})
			return
		}
		snapshot = page
	} else if cursor != "" || !cached {
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		result, err := g.call(ctx, scope, "snapshot", map[string]any{"threadId": id, "cursor": cursor})
		if err != nil {
			writeJSON(w, 503, map[string]any{"error": err.Error()})
			return
		}
		if json.Unmarshal(result, &snapshot) != nil {
			writeJSON(w, 502, map[string]any{"error": "会话内容尚未同步"})
			return
		}
		if g.replica != nil {
			g.mirrorHistoryPage(scope, snapshot, cursor == "")
		} else {
			_ = g.history.save(scope, snapshot, cursor == "", snapshot.NextCursor == nil)
		}
		if cursor == "" {
			g.mu.Lock()
			t = g.topicLocked(scope, id)
			seq, epoch = t.Seq, g.epoch
			if t.Snapshot != nil {
				data, _ := json.Marshal(t.Snapshot)
				_ = json.Unmarshal(data, &snapshot)
			}
			g.mu.Unlock()
		}
		online = true
		cached = false
	}
	if cursor == "" {
		if g.replica == nil {
			snapshot.NextCursor = g.history.cursor(scope, id, snapshot)
		}
		g.refresh(scope, id)
	}
	g.mu.Lock()
	approvals := []json.RawMessage{}
	for _, request := range g.topicLocked(scope, id).Approvals {
		approvals = append(approvals, append(json.RawMessage{}, request...))
	}
	g.mu.Unlock()
	tag := snapshotETag(snapshot)
	w.Header().Set("ETag", tag)
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("X-Sync-Epoch", epoch)
	w.Header().Set("X-Sync-Seq", strconv.FormatUint(seq, 10))
	w.Header().Set("X-Sync-Online", strconv.FormatBool(online))
	if r.Header.Get("If-None-Match") == tag && len(approvals) == 0 {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	writeJSON(w, 200, map[string]any{"snapshot": snapshot, "seq": seq, "epoch": epoch, "online": online, "cached": cached, "approvals": approvals})
}

func (g *Gateway) serveCatalog(w http.ResponseWriter, r *http.Request, scope string) {
	search := strings.ToLower(r.URL.Query().Get("search"))
	offset, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Query().Get("cursor"), "offset:"))
	if offset < 0 {
		offset = 0
	}
	g.mu.Lock()
	t := g.topicLocked(scope, "")
	list := []Thread{}
	ranks := map[string]int{}
	for i, id := range t.PinnedIDs {
		ranks[id] = i
	}
	for _, thread := range t.List {
		rank, pinned := ranks[thread.ID]
		thread.Pinned = pinned
		thread.PinOrder = rank
		if search == "" || strings.Contains(strings.ToLower(thread.Name+" "+thread.Preview), search) {
			list = append(list, thread)
		}
	}
	seq, epoch, online := t.Seq, g.epoch, g.nativeOnlineNow()
	g.mu.Unlock()
	sort.Slice(list, func(i, j int) bool {
		if list[i].Pinned != list[j].Pinned {
			return list[i].Pinned
		}
		if list[i].Pinned && list[i].PinOrder != list[j].PinOrder {
			return list[i].PinOrder < list[j].PinOrder
		}
		if list[i].UpdatedAt == list[j].UpdatedAt {
			return list[i].ID > list[j].ID
		}
		return list[i].UpdatedAt > list[j].UpdatedAt
	})
	if offset > len(list) {
		offset = len(list)
	}
	end := offset + 40
	var next *string
	if end < len(list) {
		v := "offset:" + strconv.Itoa(end)
		next = &v
	} else {
		end = len(list)
	}
	g.refresh(scope, "")
	content, _ := json.Marshal(map[string]any{"data": list[offset:end], "nextCursor": next})
	sum := sha256.Sum256(content)
	tag := `"` + hex.EncodeToString(sum[:16]) + `"`
	w.Header().Set("ETag", tag)
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("X-Sync-Epoch", epoch)
	w.Header().Set("X-Sync-Seq", strconv.FormatUint(seq, 10))
	w.Header().Set("X-Sync-Online", strconv.FormatBool(online))
	if r.Header.Get("If-None-Match") == tag {
		w.WriteHeader(304)
		return
	}
	writeJSON(w, 200, map[string]any{"data": list[offset:end], "seq": seq, "epoch": epoch, "online": online, "nextCursor": next})
}
