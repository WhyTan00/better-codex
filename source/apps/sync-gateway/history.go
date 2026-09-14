package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type HistoryIndex struct {
	Scope      string   `json:"scope"`
	ThreadID   string   `json:"threadId"`
	Turns      []string `json:"turns"`
	Complete   bool     `json:"complete"`
	NextNative *string  `json:"nextNative"`
}
type HistoryStore struct {
	mu  sync.Mutex
	dir string
}

func (h *HistoryStore) directory(scope, id string) string {
	if !validScope(scope) || !validID(id) {
		return ""
	}
	return filepath.Join(h.dir, scope, id)
}
func atomicJSON(name string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(name), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(name), ".write-")
	if err != nil {
		return err
	}
	temp := file.Name()
	defer os.Remove(temp)
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(data)
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(temp, name)
}
func (h *HistoryStore) indexLocked(scope, id string) (HistoryIndex, error) {
	dir := h.directory(scope, id)
	if dir == "" {
		return HistoryIndex{}, errors.New("invalid history scope")
	}
	data, err := os.ReadFile(filepath.Join(dir, "index.json"))
	if os.IsNotExist(err) {
		return HistoryIndex{Scope: scope, ThreadID: id, Turns: []string{}}, nil
	}
	if err != nil {
		return HistoryIndex{}, err
	}
	var index HistoryIndex
	err = json.Unmarshal(data, &index)
	if index.Scope != scope || index.ThreadID != id {
		return HistoryIndex{}, errors.New("history scope mismatch")
	}
	return index, err
}
func (h *HistoryStore) save(scope string, s Snapshot, head, complete bool) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	dir := h.directory(scope, s.Thread.ID)
	if dir == "" {
		return errors.New("invalid history identity")
	}
	index, err := h.indexLocked(scope, s.Thread.ID)
	if err != nil {
		return err
	}
	old := append([]string{}, index.Turns...)
	incoming := []string{}
	seen := map[string]bool{}
	for _, turn := range s.Turns {
		if !validID(turn.ID) {
			return errors.New("invalid turn identity")
		}
		if err = atomicJSON(filepath.Join(dir, turn.ID+".json"), turn); err != nil {
			return err
		}
		incoming = append(incoming, turn.ID)
		seen[turn.ID] = true
	}
	// Preserve the official page order; ids need not encode time.
	if len(incoming) > 0 {
		if head {
			prefix := []string{}
			for _, id := range old {
				if seen[id] {
					break
				}
				prefix = append(prefix, id)
			}
			index.Turns = append(prefix, incoming...)
		} else {
			index.Turns = incoming
			for _, id := range old {
				if !seen[id] {
					index.Turns = append(index.Turns, id)
				}
			}
		}
	}

	if !head || len(index.Turns) <= len(s.Turns) {
		index.NextNative = s.NextCursor
		if complete {
			index.Complete = true
			index.NextNative = nil
		}
	}
	return atomicJSON(filepath.Join(dir, "index.json"), index)
}
func (h *HistoryStore) cursor(scope, id string, head Snapshot) *string {
	if len(head.Turns) == 0 {
		return head.NextCursor
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	index, err := h.indexLocked(scope, id)
	if err != nil {
		return head.NextCursor
	}
	first := head.Turns[0].ID
	for i, t := range index.Turns {
		if t == first && i > 0 {
			cursor := "cached:" + first
			return &cursor
		}
	}
	if index.Complete {
		return nil
	}
	return head.NextCursor
}
func (h *HistoryStore) page(scope, id, cursor string, thread Thread) (Snapshot, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	index, err := h.indexLocked(scope, id)
	if err != nil {
		return Snapshot{}, err
	}
	boundary := strings.TrimPrefix(cursor, "cached:")
	end := -1
	for i, t := range index.Turns {
		if t == boundary {
			end = i
			break
		}
	}
	if end < 0 {
		return Snapshot{}, errors.New("cached history cursor expired")
	}
	start := end - 6
	if start < 0 {
		start = 0
	}
	result := Snapshot{Thread: thread, Turns: []Turn{}, NextCursor: index.NextNative}
	for _, turnID := range index.Turns[start:end] {
		data, err := os.ReadFile(filepath.Join(h.directory(scope, id), turnID+".json"))
		if err != nil {
			return Snapshot{}, err
		}
		var turn Turn
		if json.Unmarshal(data, &turn) != nil {
			return Snapshot{}, errors.New("cached turn unreadable")
		}
		result.Turns = append(result.Turns, turn)
	}
	if start > 0 {
		next := "cached:" + index.Turns[start]
		result.NextCursor = &next
	} else if index.Complete {
		result.NextCursor = nil
	}
	return result, nil
}
func snapshotETag(s Snapshot) string {
	s.ConfirmedAt = ""
	data, _ := json.Marshal(s)
	sum := sha256.Sum256(data)
	return `"` + hex.EncodeToString(sum[:16]) + `"`
}
