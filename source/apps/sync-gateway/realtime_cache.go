package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

const optionalCacheReadBudget = 50 * time.Millisecond
const replicaQueueBudget = int64(64 << 20)

type cacheReplicaJob struct {
	frames             []frame
	topics             map[string]*Topic
	epoch, serverEpoch string
	sequence           uint64
	reset              bool
	bytes              int64
	historyPage        *Snapshot
	scope              string
	head               bool
}
type replicaCursor struct {
	epoch    string
	sequence uint64
}
type cacheReplica struct {
	store               *DurableStore
	jobs                chan cacheReplicaJob
	stop, done          chan struct{}
	storageMu           sync.Mutex
	disabled            atomic.Bool
	queuedBytes         atomic.Int64
	accepted, committed atomic.Pointer[replicaCursor]
	once                sync.Once
	lookups             chan struct{}
	// Test injection affects only this optional background writer.
	beforeWrite func()
}

// EnableRealtimeCache keeps accepted source state in bounded RAM. The existing
// disk store becomes its asynchronous read replica, never a delivery barrier.
// Called once before the HTTP server and maintenance goroutines are started.
func (g *Gateway) enableRealtimeCache() error {
	if g.replica != nil {
		return nil
	}
	front, err := openMemoryCache()
	if err != nil {
		return err
	}
	if err = front.seed(nil); err == nil {
		err = front.setMeta("serverEpoch", g.epoch)
	}
	if err == nil {
		err = front.reset(g.agentEpoch, g.agentSeq)
	}
	if err != nil {
		front.close()
		return err
	}
	r := &cacheReplica{store: g.durable, jobs: make(chan cacheReplicaJob, 128), stop: make(chan struct{}), done: make(chan struct{}), lookups: make(chan struct{}, 4)}
	r.accepted.Store(&replicaCursor{g.agentEpoch, g.agentSeq})
	r.committed.Store(&replicaCursor{g.agentEpoch, g.agentSeq})
	r.store.separateNotifications = true
	if g.durable.memory {
		r.disabled.Store(true)
	} else {
		if err = warmLiveRecords(front, g.durable); err != nil {
			r.disabled.Store(true)
		} else {
			front.fallback.Store(g.durable)
		}
	}
	for seq, hash := range g.frameProofs {
		if _, err = front.db.Exec("INSERT INTO received VALUES(?,?,?)", g.agentEpoch, seq, hash); err != nil {
			front.close()
			return err
		}
	}
	g.replica = r
	g.activeCache.Store(front)
	go g.runCacheReplica(r)
	return nil
}

func warmLiveRecords(front, disk *DurableStore) error {
	generation := disk.meta("nativeGeneration")
	if generation != "" {
		if err := front.setMeta("nativeGeneration", generation); err != nil {
			return err
		}
	}
	rows, err := disk.reader.Query("SELECT scope,key,kind,thread_id,generation,revision,payload,deleted,accessed_at FROM native_records ORDER BY CASE WHEN kind IN ('history','turn','item') THEN 1 ELSE 0 END,accessed_at DESC")
	if err != nil {
		return err
	}
	defer rows.Close()
	tx, err := front.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var bytes int64
	for rows.Next() {
		var scope, key, kind, thread, generation string
		var revision uint64
		var raw []byte
		var deleted bool
		var accessed int64
		if err = rows.Scan(&scope, &key, &kind, &thread, &generation, &revision, &raw, &deleted, &accessed); err != nil {
			return err
		}
		if bytes+int64(len(raw)) > 64<<20 {
			if kind != "history" && kind != "turn" && kind != "item" {
				front.catalogLimited.Store(true)
			}
			continue
		}
		if _, err = tx.Exec("INSERT INTO native_records VALUES(?,?,?,?,?,?,?,?,?)", scope, key, kind, thread, generation, revision, raw, deleted, accessed); err != nil {
			return err
		}
		bytes += int64(len(raw))
	}
	if err = rows.Err(); err != nil {
		return err
	}
	return tx.Commit()
}

// Called with topic ownership. Values are immutable after being enqueued.
func (g *Gateway) mirrorBatch(frames []frame, changed map[string]*Topic) {
	r := g.replica
	if r == nil || r.disabled.Load() {
		return
	}
	job := cacheReplicaJob{frames: frames, topics: map[string]*Topic{}}
	for _, f := range frames {
		raw, err := json.Marshal(f)
		if err != nil {
			g.disableCacheReplica("invalid_replica")
			return
		}
		job.bytes += int64(len(raw))
	}
	for key, t := range changed {
		// Clone at source ownership: background marshaling cannot race later
		// Native mutations, subscriptions, resets, or another publication batch.
		raw, err := json.Marshal(persistable(t))
		if err != nil {
			g.disableCacheReplica("invalid_replica")
			return
		}
		job.bytes += int64(len(raw))
		if r.queuedBytes.Load()+job.bytes > replicaQueueBudget {
			g.disableCacheReplica("capacity")
			return
		}
		var p durableTopic
		if json.Unmarshal(raw, &p) != nil {
			g.disableCacheReplica("invalid_replica")
			return
		}
		job.topics[key] = &Topic{Seq: p.Seq, Events: p.Events, Bytes: p.Bytes, Snapshot: p.Snapshot, List: p.List, PinnedIDs: p.PinnedIDs, NextCursor: p.NextCursor, Approvals: p.Approvals}
	}
	if r.queuedBytes.Add(job.bytes) > replicaQueueBudget {
		r.queuedBytes.Add(-job.bytes)
		g.disableCacheReplica("capacity")
		return
	}
	select {
	case r.jobs <- job:
	default:
		r.queuedBytes.Add(-job.bytes)
		g.disableCacheReplica("capacity")
	}
}
func (g *Gateway) mirrorReset(epoch string, seq uint64, serverEpoch string) {
	r := g.replica
	if r == nil || r.disabled.Load() {
		return
	}
	select {
	case r.jobs <- cacheReplicaJob{reset: true, epoch: epoch, sequence: seq, serverEpoch: serverEpoch}:
	default:
		g.disableCacheReplica("capacity")
	}
}
func (g *Gateway) disableCacheReplica(reason string) {
	if g.replica == nil || g.replica.disabled.Swap(true) {
		return
	}
	g.cacheStore().fallback.Store(nil)
	log.Printf(`{"event":"optional_cache","state":"memory","reason":%q,"commandAuthority":"mac-native"}`, reason)
}
func (g *Gateway) runCacheReplica(r *cacheReplica) {
	defer close(r.done)
	for {
		select {
		case <-r.stop:
			return
		case job := <-r.jobs:
			if r.disabled.Load() {
				r.queuedBytes.Add(-job.bytes)
				continue
			}
			r.storageMu.Lock()
			if r.beforeWrite != nil {
				r.beforeWrite()
			}
			var err error
			if job.reset {
				err = r.store.resetProjection(job.epoch, job.sequence, job.serverEpoch)
			} else if job.historyPage != nil {
				err = g.history.save(job.scope, *job.historyPage, job.head, job.historyPage.NextCursor == nil)
			} else {
				err = r.store.commitBatch(job.frames, job.topics, &publicationMetrics{})
				if err == nil {
					err = g.mirrorLegacyFiles(job)
				}
			}
			r.storageMu.Unlock()
			r.queuedBytes.Add(-job.bytes)
			if err != nil {
				g.disableCacheReplica("storage_unavailable")
				continue
			}
			if job.reset {
				r.committed.Store(&replicaCursor{job.epoch, job.sequence})
			} else if len(job.frames) > 0 {
				last := job.frames[len(job.frames)-1]
				r.committed.Store(&replicaCursor{last.Epoch, last.Seq})
			}
		}
	}
}
func (g *Gateway) mirrorLegacyFiles(job cacheReplicaJob) error {
	for _, f := range job.frames {
		switch f.Event.Type {
		case "historyPage":
			var page Snapshot
			if json.Unmarshal(f.Data, &page) != nil {
				return errors.New("invalid history page")
			}
			if err := g.history.save(f.Scope, page, false, page.NextCursor == nil); err != nil {
				return err
			}
		case "snapshot":
			if f.Event.Snapshot != nil {
				if err := saveSnapshot(g.dir, f.Scope, *f.Event.Snapshot); err != nil {
					return err
				}
				if err := g.history.save(f.Scope, *f.Event.Snapshot, true, f.Event.Snapshot.NextCursor == nil); err != nil {
					return err
				}
			}
		case "pins":
			var value struct {
				IDs []string `json:"ids"`
			}
			if json.Unmarshal(f.Data, &value) != nil {
				return errors.New("invalid pins")
			}
			if err := atomicJSON(filepath.Join(g.dir, "pins-"+f.Scope+".json"), value.IDs); err != nil {
				return err
			}
		}
	}
	return nil
}
func (g *Gateway) mirrorHistoryPage(scope string, page Snapshot, head bool) {
	r := g.replica
	if r == nil || r.disabled.Load() {
		return
	}
	raw, err := json.Marshal(page)
	if err != nil {
		return
	}
	bytes := int64(len(raw))
	if r.queuedBytes.Add(bytes) > replicaQueueBudget {
		r.queuedBytes.Add(-bytes)
		g.disableCacheReplica("capacity")
		return
	}
	var frozen Snapshot
	_ = json.Unmarshal(raw, &frozen)
	select {
	case r.jobs <- cacheReplicaJob{historyPage: &frozen, scope: scope, head: head, bytes: bytes}:
	default:
		r.queuedBytes.Add(-bytes)
		g.disableCacheReplica("capacity")
	}
}
func (g *Gateway) boundedHistoryPage(ctx context.Context, scope, id, cursor string, thread Thread) (Snapshot, error) {
	if g.replica == nil {
		return g.history.page(scope, id, cursor, thread)
	}
	r := g.replica
	select {
	case r.lookups <- struct{}{}:
	default:
		return Snapshot{}, errors.New("历史缓存正在忙碌，请重新读取会话")
	}
	type result struct {
		page Snapshot
		err  error
	}
	done := make(chan result, 1)
	go func() {
		defer func() { <-r.lookups }()
		page, err := g.history.page(scope, id, cursor, thread)
		done <- result{page, err}
	}()
	ctx, cancel := context.WithTimeout(ctx, optionalCacheReadBudget)
	defer cancel()
	select {
	case got := <-done:
		return got.page, got.err
	case <-ctx.Done():
		return Snapshot{}, errors.New("历史缓存正在忙碌，请重新读取会话")
	}
}
func (g *Gateway) stopCacheReplica() bool {
	if g.replica == nil {
		return true
	}
	r := g.replica
	r.once.Do(func() { close(r.stop) })
	select {
	case <-r.done:
		return true
	case <-time.After(3 * time.Second):
		return false
	}
}

// Read through only after a RAM miss, under an independent optional-cache
// budget. A slow disk cannot consume the Native/HTTP operation budget.
func (d *DurableStore) fallbackRecord(ctx context.Context, scope, key string, trace *nativeReadTrace, phase string) (*NativeRecord, error) {
	disk := d.fallback.Load()
	if disk == nil || d.catalogLimited.Load() {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(ctx, optionalCacheReadBudget)
	defer cancel()
	r, err := disk.nativeRecordContext(ctx, scope, key, trace, phase)
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, nil
	}
	var generation string
	err = d.reader.QueryRowContext(ctx, "SELECT value FROM sync_meta WHERE key='nativeGeneration'").Scan(&generation)
	if errors.Is(err, sql.ErrNoRows) || generation != r.SourceGeneration {
		return nil, nil
	}
	return r, err
}
func cloneSourceEvent(e Event) Event {
	raw, _ := json.Marshal(e)
	var result Event
	_ = json.Unmarshal(raw, &result)
	return result
}

func (g *Gateway) liveReadVersion() int {
	if g.replica != nil {
		return 3
	}
	return sourceReadVersion
}
func (g *Gateway) cacheAcceptance() map[string]any {
	if g.replica == nil {
		return nil
	}
	a, p := g.replica.accepted.Load(), g.replica.committed.Load()
	return map[string]any{"acceptedEpoch": a.epoch, "acceptedSeq": a.sequence, "persistedEpoch": p.epoch, "persistedSeq": p.sequence, "caughtUp": a.epoch == p.epoch && a.sequence == p.sequence, "projectionCommitted": false, "pendingBytes": g.replica.queuedBytes.Load()}
}
