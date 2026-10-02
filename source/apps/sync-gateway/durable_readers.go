package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/url"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

// Readers see committed WAL snapshots without occupying the single durable
// writer. Recency is advisory cache metadata, coalesced into the next existing
// publication transaction instead of causing an fsync on every GET.
type DurableStore struct {
	db, reader            *sql.DB
	memory                bool // Rebuildable cache only; never stores command execution authority.
	instanceID            string
	touchMu               sync.Mutex
	touches               map[recordTouchKey]recordTouch
	fallback              atomic.Pointer[DurableStore]
	catalogLimited        atomic.Bool
	separateNotifications bool
}
type recordTouchKey struct{ scope, key string }
type recordTouch struct {
	scope, key, generation string
	revision               uint64
	at                     int64
}

func newDurableReaders(writer *sql.DB, dir string) (*DurableStore, error) {
	u := &url.URL{Scheme: "file", Path: filepath.Join(dir, "read-model-v1.sqlite")}
	q := url.Values{"mode": {"ro"}, "_pragma": {"query_only(1)", "busy_timeout(5000)"}}
	u.RawQuery = q.Encode()
	reader, err := sql.Open("sqlite", u.String())
	if err != nil {
		writer.Close()
		return nil, err
	}
	reader.SetMaxOpenConns(4)
	reader.SetMaxIdleConns(4)
	if err = reader.Ping(); err != nil {
		reader.Close()
		writer.Close()
		return nil, err
	}
	return &DurableStore{db: writer, reader: reader, touches: map[recordTouchKey]recordTouch{}}, nil
}

func (d *DurableStore) close() error {
	if d.reader == d.db {
		return d.db.Close()
	}
	readErr := d.reader.Close()
	writeErr := d.db.Close()
	return errors.Join(readErr, writeErr)
}

func (d *DurableStore) rememberAccess(r *NativeRecord) {
	if r.Deleted || (r.Kind != "history" && r.Kind != "turn" && r.Kind != "item") {
		return
	}
	d.touchMu.Lock()
	defer d.touchMu.Unlock()
	key := recordTouchKey{r.Scope, r.Key}
	if _, exists := d.touches[key]; exists || len(d.touches) < 4096 {
		d.touches[key] = recordTouch{r.Scope, r.Key, r.Generation, r.Revision, time.Now().UnixMilli()}
	}
}

func (d *DurableStore) takeTouches() map[recordTouchKey]recordTouch {
	d.touchMu.Lock()
	defer d.touchMu.Unlock()
	batch := d.touches
	d.touches = map[recordTouchKey]recordTouch{}
	return batch
}

func (d *DurableStore) restoreTouches(batch map[recordTouchKey]recordTouch) {
	d.touchMu.Lock()
	defer d.touchMu.Unlock()
	for key, touch := range batch {
		old, exists := d.touches[key]
		if (!exists && len(d.touches) < 4096) || (exists && old.at < touch.at) {
			d.touches[key] = touch
		}
	}
}

func (d *DurableStore) nativeRecordContext(ctx context.Context, scope, key string, trace *nativeReadTrace, phase string) (record *NativeRecord, err error) {
	started := time.Now()
	trace.event("pending", phase, nil)
	var poolMs, queryMs, decodeMs int64
	var raw []byte
	defer func() {
		stage := "received"
		if err != nil {
			stage = "failed"
		}
		trace.event(stage, phase, map[string]any{"phaseDurationMs": time.Since(started).Milliseconds(), "dbWaitMs": poolMs, "sqlReadMs": queryMs, "decodeMs": decodeMs, "responseBytes": len(raw), "cacheHit": record != nil})
	}()
	conn, err := d.reader.Conn(ctx)
	poolMs = time.Since(started).Milliseconds()
	if err != nil {
		return nil, err
	}
	queryStarted := time.Now()
	err = conn.QueryRowContext(ctx, "SELECT payload FROM native_records WHERE scope=? AND key=?", scope, key).Scan(&raw)
	queryMs = time.Since(queryStarted).Milliseconds()
	conn.Close()
	if errors.Is(err, sql.ErrNoRows) {
		return d.fallbackRecord(ctx, scope, key, trace, phase+"_disk")
	}
	if err != nil {
		return nil, err
	}
	decodeStarted := time.Now()
	var r NativeRecord
	if err = json.Unmarshal(raw, &r); err != nil {
		return nil, err
	}
	decodeMs = time.Since(decodeStarted).Milliseconds()
	d.rememberAccess(&r)
	return &r, nil
}
