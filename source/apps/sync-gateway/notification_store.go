package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

const notificationSchema = `
CREATE TABLE IF NOT EXISTS notification_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notification_threads(scope TEXT,thread_id TEXT,source_generation TEXT,revision INTEGER,title TEXT NOT NULL,known INTEGER NOT NULL,child INTEGER NOT NULL,PRIMARY KEY(scope,thread_id));`

type notificationThread struct {
	scope, id, generation, title string
	revision                     uint64
	known, child                 bool
}
type notificationCompletion struct {
	scope, thread, turn, title, summary string
	completedAt                         int64
}
type notificationProjection struct {
	threads     []notificationThread
	completions []notificationCompletion
}

// Notification subscriptions, deduplication and receipts are independent of
// the large, replaceable reading replica. Migration copies existing rows once
// and leaves the old database untouched for rollback/recovery.
func openNotificationStore(dir string) (*DurableStore, error) {
	path := filepath.Join(dir, "notifications-v1.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	failed := true
	defer func() {
		if failed {
			db.Close()
		}
	}()
	if _, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;` + pushSchema + notificationSchema); err != nil {
		return nil, err
	}
	if err = os.Chmod(path, 0600); err != nil {
		return nil, err
	}
	var migrated string
	_ = db.QueryRow("SELECT value FROM notification_meta WHERE key='legacy-migration-v1'").Scan(&migrated)
	if migrated == "" {
		legacy := filepath.Join(dir, "read-model-v1.sqlite")
		if _, statErr := os.Stat(legacy); statErr == nil {
			if _, err = db.Exec("ATTACH DATABASE ? AS legacy", legacy); err != nil {
				return nil, err
			}
			tx, e := db.Begin()
			if e != nil {
				return nil, e
			}
			for _, table := range []string{"push_device_owners", "push_devices", "push_completions", "push_completion_content", "push_jobs"} {
				if _, e = tx.Exec("INSERT OR IGNORE INTO main." + table + " SELECT * FROM legacy." + table); e != nil {
					tx.Rollback()
					return nil, e
				}
			}
			rows, e := tx.Query("SELECT payload FROM legacy.native_records WHERE kind='catalog'")
			if e != nil {
				tx.Rollback()
				return nil, e
			}
			var threads []notificationThread
			for rows.Next() {
				var raw []byte
				if e = rows.Scan(&raw); e != nil {
					break
				}
				if value, ok := notificationCatalog(raw); ok {
					threads = append(threads, value)
				}
			}
			if e == nil {
				e = rows.Err()
			}
			rows.Close()
			if e != nil {
				tx.Rollback()
				return nil, e
			}
			for _, t := range threads {
				if e = saveNotificationThread(tx, t); e != nil {
					tx.Rollback()
					return nil, e
				}
			}
			if _, e = tx.Exec("INSERT INTO notification_meta VALUES('legacy-migration-v1','1')"); e != nil {
				tx.Rollback()
				return nil, e
			}
			if e = tx.Commit(); e != nil {
				return nil, e
			}
			if _, err = db.Exec("DETACH DATABASE legacy"); err != nil {
				return nil, err
			}
		} else if !errors.Is(statErr, os.ErrNotExist) {
			return nil, statErr
		} else {
			if _, err = db.Exec("INSERT INTO notification_meta VALUES('legacy-migration-v1','1')"); err != nil {
				return nil, err
			}
		}
	}
	failed = false
	return &DurableStore{db: db, reader: db, touches: map[recordTouchKey]recordTouch{}}, nil
}
func notificationCatalog(raw []byte) (notificationThread, bool) {
	var r NativeRecord
	if json.Unmarshal(raw, &r) != nil || r.Kind != "catalog" || !validScope(r.Scope) || !validID(r.ThreadID) || r.Key != "thread:"+r.ThreadID || r.SourceGeneration == "" {
		return notificationThread{}, false
	}
	t := notificationThread{scope: r.Scope, id: r.ThreadID, generation: r.SourceGeneration, revision: r.Revision}
	var entry struct {
		DisplayTitle string         `json:"displayTitle"`
		NativeThread map[string]any `json:"nativeThread"`
	}
	if !r.Deleted && json.Unmarshal(r.Payload, &entry) == nil && entry.NativeThread["id"] == r.ThreadID {
		t.known = true
		t.child = isSubagentThread(entry.NativeThread)
		t.title = notificationExcerpt(entry.DisplayTitle, 64)
	}
	return t, true
}
func saveNotificationThread(tx *sql.Tx, t notificationThread) error {
	var generation string
	_ = tx.QueryRow("SELECT value FROM notification_meta WHERE key='nativeGeneration'").Scan(&generation)
	if generation != "" && generation != t.generation {
		if _, err := tx.Exec("DELETE FROM notification_threads"); err != nil {
			return err
		}
	}
	if _, err := tx.Exec("INSERT INTO notification_meta VALUES('nativeGeneration',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", t.generation); err != nil {
		return err
	}
	_, err := tx.Exec(`INSERT INTO notification_threads VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope,thread_id) DO UPDATE SET source_generation=excluded.source_generation,revision=excluded.revision,title=excluded.title,known=excluded.known,child=excluded.child WHERE excluded.source_generation<>notification_threads.source_generation OR excluded.revision>=notification_threads.revision`, t.scope, t.id, t.generation, t.revision, t.title, t.known, t.child)
	return err
}
func notificationPreview(t *Topic, turn string) (string, string) {
	if t == nil || t.Snapshot == nil {
		return "", ""
	}
	title := t.Snapshot.Thread.Name
	answer := ""
	for _, v := range t.Snapshot.Turns {
		if v.ID != turn || v.Status != "completed" {
			continue
		}
		for _, item := range v.Items {
			if item.Type == "agentMessage" && (item.Phase == "final_answer" || item.Phase == "") && item.Text != "" {
				answer = item.Text
			}
		}
	}
	return notificationExcerpt(title, 64), notificationExcerpt(answer, 180)
}
func (g *Gateway) mirrorPush(frames []frame, changed map[string]*Topic) error {
	p := g.push
	if p == nil || !p.isolated {
		return nil
	}
	job := notificationProjection{}
	for _, f := range frames {
		if f.Event.Type == "nativeRecord" {
			if t, ok := notificationCatalog(f.Data); ok {
				job.threads = append(job.threads, t)
			}
		}
		if f.Event.Type == "turn" && f.Event.Turn != nil && f.Event.Turn.Status == "completed" {
			t := f.Event.Turn
			completed := time.Now().UnixMilli()
			if t.CompletedAt != nil {
				completed = int64(*t.CompletedAt * 1000)
			}
			title, summary := notificationPreview(changed[topicKey(f.Scope, f.ThreadID)], t.ID)
			job.completions = append(job.completions, notificationCompletion{scope: f.Scope, thread: f.ThreadID, turn: t.ID, completedAt: completed, title: title, summary: summary})
		}
	}
	if len(job.threads) == 0 && len(job.completions) == 0 {
		return nil
	}
	// This small authoritative state commits before the source ACK. Only the
	// large reading replica is disposable/asynchronous; a completion ACK may
	// never retire its sender before deduplication and delivery intent exist.
	if err := p.saveProjection(job); err != nil {
		p.projectionFailed.Store(true)
		return err
	}
	p.projectionFailed.Store(false)
	return nil
}
func (p *PushService) saveProjection(job notificationProjection) error {
	tx, err := p.store.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, t := range job.threads {
		if err = saveNotificationThread(tx, t); err != nil {
			return err
		}
	}
	now := time.Now().UnixMilli()
	for _, c := range job.completions {
		if c.turn == "" || !validScope(c.scope) || !validID(c.thread) || c.completedAt < now-int64(15*time.Minute/time.Millisecond) || c.completedAt > now+60000 {
			continue
		}
		var silent bool
		_ = tx.QueryRow("SELECT silent FROM push_thread_policies WHERE scope=? AND thread_id=?", c.scope, c.thread).Scan(&silent)
		if silent {
			continue
		}
		var child bool
		_ = tx.QueryRow("SELECT child FROM notification_threads WHERE scope=? AND thread_id=? AND known=1", c.scope, c.thread).Scan(&child)
		if child {
			continue
		}
		result, e := tx.Exec("INSERT OR IGNORE INTO push_completions VALUES(?,?,?,?)", c.scope, c.thread, c.turn, now)
		if e != nil {
			return e
		}
		n, _ := result.RowsAffected()
		if n == 0 {
			continue
		}
		if c.title == "" {
			_ = tx.QueryRow("SELECT title FROM notification_threads WHERE scope=? AND thread_id=? AND known=1", c.scope, c.thread).Scan(&c.title)
		}
		if _, e = tx.Exec("INSERT OR IGNORE INTO push_completion_content VALUES(?,?,?,?,?)", c.scope, c.thread, c.turn, c.title, c.summary); e != nil {
			return e
		}
		rows, e := tx.Query("SELECT d.device_id FROM push_devices d JOIN push_device_owners o ON o.device_id=d.device_id AND o.recipient=d.scope WHERE d.scope=? AND d.enabled=1 AND d.enabled_at<=?", c.scope, c.completedAt)
		if e != nil {
			return e
		}
		var devices []string
		for rows.Next() {
			var id string
			if e = rows.Scan(&id); e != nil {
				break
			}
			devices = append(devices, id)
		}
		if e == nil {
			e = rows.Err()
		}
		rows.Close()
		if e != nil {
			return e
		}
		for _, id := range devices {
			if _, e = tx.Exec("INSERT OR IGNORE INTO push_jobs(id,scope,device_id,thread_id,turn_id,receipt,state,next_at,created_at) VALUES(?,?,?,?,?,?,'queued',?,?)", nonce(), c.scope, id, c.thread, c.turn, nonce(), now, now); e != nil {
				return e
			}
		}
	}
	return tx.Commit()
}
func (p *PushService) notificationAvailable() bool {
	return !p.projectionFailed.Load() && (p.isolated || p.gateway == nil || p.gateway.cachePersistence() != "memory")
}
