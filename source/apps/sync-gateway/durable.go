package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	_ "modernc.org/sqlite"
	"os"
	"path/filepath"
	"time"
)

// FULL synchronous WAL is the acknowledgement boundary. Native data, topic
// projections, replay events and the consumed sender cursor commit together.
type DurableStore struct{ db *sql.DB }

// Only rebuildable history is evicted. Catalog, tombstones, approval state and
// command identities are retained. The just-committed response stays readable.
func pruneNativeHistory(tx *sql.Tx, scope, key string, budget int64) error {
	var total int64
	if e := tx.QueryRow("SELECT COALESCE(SUM(length(payload)),0) FROM native_records WHERE kind IN ('history','turn','item') AND deleted=0").Scan(&total); e != nil {
		return e
	}
	if total <= budget {
		return nil
	}
	rows, e := tx.Query("SELECT scope,key,length(payload) FROM native_records WHERE kind IN ('history','turn','item') AND deleted=0 AND NOT(scope=? AND key=?) ORDER BY accessed_at", scope, key)
	if e != nil {
		return e
	}
	type victim struct {
		scope, key string
		bytes      int64
	}
	var victims []victim
	for rows.Next() {
		var v victim
		if e = rows.Scan(&v.scope, &v.key, &v.bytes); e != nil {
			rows.Close()
			return e
		}
		victims = append(victims, v)
		total -= v.bytes
		if total <= budget*3/4 {
			break
		}
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, v := range victims {
		if _, e = tx.Exec("DELETE FROM native_records WHERE scope=? AND key=?", v.scope, v.key); e != nil {
			return e
		}
	}
	return nil
}

type durableTopic struct {
	Seq        uint64
	Events     []Envelope
	Bytes      int
	Snapshot   *Snapshot
	List       map[string]Thread
	PinnedIDs  []string
	NextCursor *string
	Approvals  map[string]json.RawMessage
}
type NativeRecord struct {
	SourceGeneration string          `json:"sourceGeneration"`
	Scope            string          `json:"scope"`
	Key              string          `json:"key"`
	Kind             string          `json:"kind"`
	ThreadID         string          `json:"threadId"`
	Generation       string          `json:"generation"`
	Revision         uint64          `json:"revision"`
	Payload          json.RawMessage `json:"payload"`
	ConfirmedAt      string          `json:"confirmedAt"`
	Bytes            int             `json:"bytes"`
	Deleted          bool            `json:"deleted"`
}

func persistable(t *Topic) durableTopic {
	return durableTopic{t.Seq, t.Events, t.Bytes, t.Snapshot, t.List, t.PinnedIDs, t.NextCursor, t.Approvals}
}
func cloneTopic(t *Topic) *Topic {
	b, _ := json.Marshal(persistable(t))
	var p durableTopic
	_ = json.Unmarshal(b, &p)
	return &Topic{Seq: p.Seq, Events: p.Events, Bytes: p.Bytes, Snapshot: p.Snapshot, List: p.List, PinnedIDs: p.PinnedIDs, NextCursor: p.NextCursor, Approvals: p.Approvals, Dirty: t.Dirty, Subscribers: t.Subscribers}
}
func openDurable(dir string) (*DurableStore, error) {
	db, err := sql.Open("sqlite", filepath.Join(dir, "read-model-v1.sqlite"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS sync_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS topics(key TEXT PRIMARY KEY,payload BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS received(epoch TEXT,seq INTEGER,hash TEXT NOT NULL,PRIMARY KEY(epoch,seq));
 CREATE TABLE IF NOT EXISTS native_records(scope TEXT,key TEXT,kind TEXT,thread_id TEXT,generation TEXT,revision INTEGER,payload BLOB,deleted INTEGER,accessed_at INTEGER,PRIMARY KEY(scope,key));
 CREATE INDEX IF NOT EXISTS native_record_change ON native_records(scope,kind,revision);
 CREATE INDEX IF NOT EXISTS native_record_lru ON native_records(kind,accessed_at);
 CREATE TABLE IF NOT EXISTS history_pages(scope TEXT,thread_id TEXT,page_hash TEXT,payload BLOB,PRIMARY KEY(scope,thread_id,page_hash));`)
	if err != nil {
		db.Close()
		return nil, err
	}
	_ = os.Chmod(filepath.Join(dir, "read-model-v1.sqlite"), 0600)
	if _, err = db.Exec(pushSchema); err != nil {
		db.Close()
		return nil, err
	}
	return &DurableStore{db}, nil
}
func (d *DurableStore) meta(key string) string {
	var v string
	_ = d.db.QueryRow("SELECT value FROM sync_meta WHERE key=?", key).Scan(&v)
	return v
}
func (d *DurableStore) setMeta(key, value string) error {
	_, e := d.db.Exec("INSERT INTO sync_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value)
	return e
}
func (d *DurableStore) reset(epoch string, seq uint64) error {
	tx, e := d.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	for k, v := range map[string]string{"adapterEpoch": epoch, "adapterSeq": fmt.Sprint(seq)} {
		if _, e = tx.Exec("INSERT INTO sync_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", k, v); e != nil {
			return e
		}
	}
	return tx.Commit()
}
func frameHash(f frame) string {
	raw, _ := json.Marshal(f)
	h := sha256.Sum256(raw)
	return hex.EncodeToString(h[:])
}
func (d *DurableStore) checkDuplicate(f frame) error {
	var got string
	e := d.db.QueryRow("SELECT hash FROM received WHERE epoch=? AND seq=?", f.Epoch, f.Seq).Scan(&got)
	if errors.Is(e, sql.ErrNoRows) {
		return errors.New("duplicate identity outside retention")
	}
	if e != nil {
		return e
	}
	if got != frameHash(f) {
		return errors.New("duplicate identity has different content")
	}
	return nil
}
func (d *DurableStore) commit(f frame, topics map[string]*Topic) error {
	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for key, t := range topics {
		raw, e := json.Marshal(persistable(t))
		if e != nil {
			return e
		}
		if _, e = tx.Exec("INSERT INTO topics VALUES(?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload", key, raw); e != nil {
			return e
		}
	}
	if f.Event.Type == "nativeRecord" {
		var r NativeRecord
		if json.Unmarshal(f.Data, &r) != nil || r.Scope != f.Scope || r.ThreadID != f.ThreadID || r.Key == "" || r.Generation == "" || r.Revision == 0 {
			return errors.New("invalid native record")
		}
		if r.SourceGeneration == "" {
			return errors.New("native source generation missing")
		}
		var generation string
		_ = tx.QueryRow("SELECT value FROM sync_meta WHERE key='nativeGeneration'").Scan(&generation)
		if generation != r.SourceGeneration {
			if _, err = tx.Exec("DELETE FROM native_records"); err != nil {
				return err
			}
			if _, err = tx.Exec("INSERT INTO sync_meta VALUES('nativeGeneration',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", r.SourceGeneration); err != nil {
				return err
			}
		}
		var old NativeRecord
		var raw []byte
		e := tx.QueryRow("SELECT payload FROM native_records WHERE scope=? AND key=?", r.Scope, r.Key).Scan(&raw)
		if e != nil && !errors.Is(e, sql.ErrNoRows) {
			return e
		}
		if len(raw) > 0 {
			if e = json.Unmarshal(raw, &old); e != nil {
				return e
			}
			if old.Generation == r.Generation && old.Revision > r.Revision {
				return errors.New("native record revision moved backwards")
			}
			if old.Generation == r.Generation && old.Revision == r.Revision && string(raw) != string(f.Data) {
				return errors.New("native record identity mismatch")
			}
		}
		if _, e = tx.Exec(`INSERT INTO native_records VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,key) DO UPDATE SET kind=excluded.kind,thread_id=excluded.thread_id,generation=excluded.generation,revision=excluded.revision,payload=excluded.payload,deleted=excluded.deleted,accessed_at=excluded.accessed_at`, r.Scope, r.Key, r.Kind, r.ThreadID, r.Generation, r.Revision, []byte(f.Data), r.Deleted, time.Now().UnixMilli()); e != nil {
			return e
		}
		if e = pruneNativeHistory(tx, r.Scope, r.Key, 512*1024*1024); e != nil {
			return e
		}
	}
	if f.Event.Type == "historyPage" {
		if _, err = tx.Exec("INSERT OR REPLACE INTO history_pages VALUES(?,?,?,?)", f.Scope, f.ThreadID, frameHash(frame{Data: f.Data}), []byte(f.Data)); err != nil {
			return err
		}
	}
	if err = enqueueCompletion(tx, f, time.Now().UnixMilli()); err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO received VALUES(?,?,?)", f.Epoch, f.Seq, frameHash(f)); err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO sync_meta VALUES('adapterSeq',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", fmt.Sprint(f.Seq)); err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO sync_meta VALUES('adapterEpoch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", f.Epoch); err != nil {
		return err
	}
	// Replays older than this acknowledged window require a snapshot reset.
	if _, err = tx.Exec("DELETE FROM received WHERE epoch<>? OR seq<?", f.Epoch, int64(f.Seq)-4096); err != nil {
		return err
	}
	return tx.Commit()
}
func (d *DurableStore) seed(topics map[string]*Topic) error {
	tx, e := d.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	for key, t := range topics {
		raw, err := json.Marshal(persistable(t))
		if err != nil {
			return err
		}
		if _, e = tx.Exec("INSERT OR IGNORE INTO topics VALUES(?,?)", key, raw); e != nil {
			return e
		}
	}
	if _, e = tx.Exec("INSERT INTO sync_meta VALUES('initialized','1')"); e != nil {
		return e
	}
	return tx.Commit()
}
func (d *DurableStore) saveTopic(key string, t *Topic) error {
	raw, e := json.Marshal(persistable(t))
	if e != nil {
		return e
	}
	_, e = d.db.Exec("INSERT INTO topics VALUES(?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload", key, raw)
	return e
}
func (d *DurableStore) restore(g *Gateway) error {
	rows, e := d.db.Query("SELECT key,payload FROM topics")
	if e != nil {
		return e
	}
	defer rows.Close()
	for rows.Next() {
		var key string
		var raw []byte
		if e = rows.Scan(&key, &raw); e != nil {
			return e
		}
		var p durableTopic
		if e = json.Unmarshal(raw, &p); e != nil {
			return e
		}
		g.topics[key] = &Topic{Seq: p.Seq, Events: p.Events, Bytes: p.Bytes, Snapshot: p.Snapshot, List: p.List, PinnedIDs: p.PinnedIDs, NextCursor: p.NextCursor, Approvals: p.Approvals, Subscribers: map[*browser]bool{}}
	}
	return rows.Err()
}
func (d *DurableStore) nativeRecord(scope, key string) (*NativeRecord, error) {
	var raw []byte
	e := d.db.QueryRow("SELECT payload FROM native_records WHERE scope=? AND key=?", scope, key).Scan(&raw)
	if errors.Is(e, sql.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var r NativeRecord
	if e = json.Unmarshal(raw, &r); e != nil {
		return nil, e
	}
	_, _ = d.db.Exec("UPDATE native_records SET accessed_at=? WHERE scope=? AND key=?", time.Now().UnixMilli(), scope, key)
	return &r, nil
}
func (d *DurableStore) nativeChanges(scope, kind string, after uint64, limit int) ([]NativeRecord, error) {
	rows, e := d.db.Query("SELECT payload FROM native_records WHERE scope=? AND kind=? AND revision>? ORDER BY revision LIMIT ?", scope, kind, after, limit)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	records := []NativeRecord{}
	for rows.Next() {
		var raw []byte
		if e = rows.Scan(&raw); e != nil {
			return nil, e
		}
		var r NativeRecord
		if e = json.Unmarshal(raw, &r); e != nil {
			return nil, e
		}
		records = append(records, r)
	}
	return records, rows.Err()
}
