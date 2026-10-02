package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type Status struct {
	Type string `json:"type"`
}
type Thread struct {
	ID              string  `json:"id"`
	Pinned          bool    `json:"pinned"`
	PinOrder        int     `json:"pinOrder"`
	Name            string  `json:"name"`
	Preview         string  `json:"preview"`
	Status          Status  `json:"status"`
	CreatedAt       float64 `json:"createdAt"`
	UpdatedAt       float64 `json:"updatedAt"`
	Model           *string `json:"model,omitempty"`
	ReasoningEffort *string `json:"reasoningEffort,omitempty"`
}
type Item struct {
	ID              string              `json:"id"`
	TurnID          string              `json:"turnId"`
	Type            string              `json:"type"`
	Text            string              `json:"text,omitempty"`
	Phase           string              `json:"phase,omitempty"`
	Status          string              `json:"status,omitempty"`
	Attachments     []map[string]string `json:"attachments,omitempty"`
	DetailAvailable bool                `json:"detailAvailable,omitempty"`
}
type Turn struct {
	ID               string   `json:"id"`
	Status           string   `json:"status"`
	StartedAt        *float64 `json:"startedAt"`
	CompletedAt      *float64 `json:"completedAt"`
	Items            []Item   `json:"items"`
	DetailsAvailable bool     `json:"detailsAvailable"`
}
type Snapshot struct {
	Thread      Thread  `json:"thread"`
	Turns       []Turn  `json:"turns"`
	NextCursor  *string `json:"nextCursor"`
	ConfirmedAt string  `json:"confirmedAt"`
}
type Event struct {
	CacheKey   string            `json:"cacheKey,omitempty"`
	Revision   uint64            `json:"revision,omitempty"`
	Generation string            `json:"generation,omitempty"`
	Type       string            `json:"type"`
	Snapshot   *Snapshot         `json:"snapshot,omitempty"`
	Thread     *Thread           `json:"thread,omitempty"`
	ThreadID   string            `json:"threadId,omitempty"`
	TurnID     string            `json:"turnId,omitempty"`
	ItemID     string            `json:"itemId,omitempty"`
	Turn       *Turn             `json:"turn,omitempty"`
	Item       *Item             `json:"item,omitempty"`
	Delta      string            `json:"delta,omitempty"`
	Status     *Status           `json:"status,omitempty"`
	Name       string            `json:"name,omitempty"`
	Online     *bool             `json:"online,omitempty"`
	Request    json.RawMessage   `json:"request,omitempty"`
	RequestID  json.RawMessage   `json:"requestId,omitempty"`
	Approvals  []json.RawMessage `json:"approvals,omitempty"`
}
type Stored struct {
	Scope    string   `json:"scope"`
	Snapshot Snapshot `json:"snapshot"`
	SavedAt  string   `json:"savedAt"`
}

func applyEvent(s *Snapshot, e Event) {
	if e.Type == "snapshot" && e.Snapshot != nil {
		*s = *e.Snapshot
		return
	}
	if e.Type == "status" && e.Status != nil {
		s.Thread.Status = *e.Status
		return
	}
	id := e.TurnID
	if e.Turn != nil {
		id = e.Turn.ID
	}
	if id == "" {
		return
	}
	index := -1
	for i := range s.Turns {
		if s.Turns[i].ID == id {
			index = i
			break
		}
	}
	if index < 0 {
		s.Turns = append(s.Turns, Turn{ID: id, Status: "inProgress", Items: []Item{}})
		index = len(s.Turns) - 1
	}
	t := &s.Turns[index]
	if e.Type == "turn" && e.Turn != nil {
		items := t.Items
		*t = *e.Turn
		if len(t.Items) == 0 {
			t.Items = items
		}
		if t.Status == "inProgress" {
			s.Thread.Status.Type = "active"
		} else {
			s.Thread.Status.Type = "idle"
		}
		return
	}
	if e.Type == "item" && e.Item != nil {
		for i := range t.Items {
			if t.Items[i].ID == e.Item.ID {
				t.Items[i] = *e.Item
				return
			}
		}
		t.Items = append(t.Items, *e.Item)
	}
	if e.Type == "delta" {
		for i := range t.Items {
			if t.Items[i].ID == e.ItemID {
				t.Items[i].Text += e.Delta
				return
			}
		}
		t.Items = append(t.Items, Item{ID: e.ItemID, TurnID: id, Type: "agentMessage", Phase: "commentary", Text: e.Delta})
	}
	if len(s.Turns) > 12 {
		s.Turns = s.Turns[len(s.Turns)-12:]
	}
}
func snapshotFile(dir, scope, id string) string {
	h := sha256.Sum256([]byte(scope + ":" + id))
	return filepath.Join(dir, hex.EncodeToString(h[:])+".json")
}
func saveSnapshot(dir, scope string, s Snapshot) error {
	if s.Thread.ID == "" {
		return nil
	}
	data, err := json.Marshal(Stored{Scope: scope, Snapshot: s, SavedAt: time.Now().UTC().Format(time.RFC3339Nano)})
	if err != nil {
		return err
	}
	if len(data) > 4<<20 {
		return nil
	}
	name := snapshotFile(dir, scope, s.Thread.ID)
	tmp := name + ".next"
	if err = os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, name)
}
func readSnapshots(dir string) []Stored {
	entries, _ := os.ReadDir(dir)
	result := []Stored{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		info, err := entry.Info()
		if err != nil || info.Size() > 4<<20 {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			continue
		}
		var value Stored
		if json.Unmarshal(data, &value) == nil && validScope(value.Scope) && validID(value.Snapshot.Thread.ID) {
			result = append(result, value)
		}
	}
	return result
}
func pruneStore(dir string, budget int64) {
	entries, _ := os.ReadDir(dir)
	type file struct {
		name string
		size int64
		at   time.Time
	}
	files := []file{}
	var total int64
	for _, entry := range entries {
		// Only snapshotFile's hash names belong to this disposable cache budget.
		// Diagnostic journals and other durable state have their own retention.
		name := strings.TrimSuffix(entry.Name(), ".json")
		decoded, decodeErr := hex.DecodeString(name)
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") || len(decoded) != sha256.Size || decodeErr != nil {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		files = append(files, file{entry.Name(), info.Size(), info.ModTime()})
		total += info.Size()
	}
	sort.Slice(files, func(i, j int) bool { return files[i].at.Before(files[j].at) })
	for _, f := range files {
		if total <= budget {
			break
		}
		if os.Remove(filepath.Join(dir, f.name)) == nil {
			total -= f.size
		}
	}
}
