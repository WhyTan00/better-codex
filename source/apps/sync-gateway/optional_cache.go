package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"strconv"
	"sync/atomic"
	"syscall"

	"modernc.org/sqlite"
)

// These failures describe storage, not a rejected Native DTO, identity or
// authorization. Invalid publications must still fail without advancing ACK.
func cacheStorageFailure(err error) bool {
	var sqliteError *sqlite.Error
	if errors.As(err, &sqliteError) {
		switch sqliteError.Code() & 255 {
		case 8, 10, 11, 13, 14, 26: // READONLY, IOERR, CORRUPT, FULL, CANTOPEN, NOTADB
			return true
		}
	}
	var syntax *json.SyntaxError
	return errors.As(err, &syntax) || errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EIO) || errors.Is(err, syscall.EROFS) || errors.Is(err, syscall.ENOTDIR) || errors.Is(err, syscall.EISDIR) || errors.Is(err, os.ErrPermission)
}

func openMemoryCache() (*DurableStore, error) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if _, err = db.Exec(readModelSchema + pushSchema); err == nil {
		err = initializeNativeHistoryBudget(db)
	}
	if err != nil {
		db.Close()
		return nil, err
	}
	return &DurableStore{db: db, reader: db, memory: true, instanceID: nonce(), touches: map[recordTouchKey]recordTouch{}}, nil
}

func (g *Gateway) cacheStore() *DurableStore {
	if store := g.activeCache.Load(); store != nil {
		return store
	}
	return g.durable
}
func (g *Gateway) cachePersistence() string {
	if g.replica != nil {
		if g.replica.disabled.Load() {
			return "memory"
		}
		return "disk"
	}
	if store := g.cacheStore(); store != nil && store.memory {
		return "memory"
	}
	return "disk"
}
func (g *Gateway) cacheIdentity() (string, string) {
	if g.replica != nil && !g.replica.disabled.Load() {
		return g.storeID, "disk"
	}
	if store := g.cacheStore(); store != nil && store.memory {
		return store.instanceID, "memory"
	}
	return g.storeID, "disk"
}
func (g *Gateway) cacheStatus() map[string]any {
	mode := g.cachePersistence()
	return map[string]any{"mode": mode, "persistent": mode == "disk", "rebuildable": true, "commandAuthority": "mac-native", "readProjectionComplete": !g.cacheStore().catalogLimited.Load(), "replica": g.cacheAcceptance()}
}

func (g *Gateway) initializeCache() error {
	store := g.cacheStore()
	if saved := store.meta("serverEpoch"); saved != "" {
		g.epoch = saved
	} else if err := store.setMeta("serverEpoch", g.epoch); err != nil {
		return err
	}
	g.agentEpoch = store.meta("adapterEpoch")
	g.agentSeq, _ = strconv.ParseUint(store.meta("adapterSeq"), 10, 64)
	if store.meta("initialized") == "" {
		if err := store.seed(g.topics); err != nil {
			return err
		}
	} else {
		g.topics = map[string]*Topic{}
	}
	if err := store.restore(g); err != nil {
		return err
	}
	rows, err := store.reader.Query("SELECT seq,hash FROM received WHERE epoch=? ORDER BY seq DESC LIMIT 4096", g.agentEpoch)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var seq uint64
		var hash string
		if err := rows.Scan(&seq, &hash); err != nil {
			return err
		}
		g.frameProofs[seq] = hash
	}
	return rows.Err()
}

// Called under topic ownership (and persistMu for source batches). Retired
// disk readers remain open for requests already using them; no pointer race or
// forced close can invalidate an in-flight foreground read.
func (g *Gateway) useMemoryCacheLocked(cause error) error {
	if g.replica != nil {
		g.disableCacheReplica("storage_unavailable")
		return nil
	}
	if g.cachePersistence() == "memory" {
		return cause
	}
	store, err := openMemoryCache()
	if err != nil {
		return fmt.Errorf("memory read cache: %w", err)
	}
	if err = store.seed(nil); err == nil {
		err = store.setMeta("serverEpoch", g.epoch)
	}
	if err == nil {
		err = store.reset(g.agentEpoch, g.agentSeq)
	}
	if err == nil {
		for seq, hash := range g.frameProofs {
			if _, err = store.db.Exec("INSERT INTO received VALUES(?,?,?)", g.agentEpoch, seq, hash); err != nil {
				break
			}
		}
	}
	if err != nil {
		store.close()
		return err
	}
	g.activeCache.Store(store)
	log.Print(`{"event":"optional_cache","state":"memory","reason":"storage_unavailable","commandAuthority":"mac-native"}`)
	return nil
}

func (g *Gateway) rememberFrameProofs(frames []frame) {
	for _, f := range frames {
		g.frameProofs[f.Seq] = frameHash(f)
	}
	for seq := range g.frameProofs {
		if g.agentSeq > 4096 && seq < g.agentSeq-4096 {
			delete(g.frameProofs, seq)
		}
	}
}

func pruneMemoryRecords(tx *sql.Tx, protected map[recordTouchKey]bool, limited *atomic.Bool) error {
	var bytes int64
	if err := tx.QueryRow("SELECT COALESCE(SUM(length(payload)),0) FROM native_records").Scan(&bytes); err != nil {
		return err
	}
	const budget = int64(64 << 20)
	if bytes <= budget {
		return nil
	}
	rows, err := tx.Query("SELECT scope,key,kind,length(payload) FROM native_records ORDER BY accessed_at")
	if err != nil {
		return err
	}
	type candidate struct {
		key      recordTouchKey
		size     int64
		metadata bool
	}
	var candidates, retained []candidate
	for rows.Next() {
		var scope, key, kind string
		var size int64
		if err = rows.Scan(&scope, &key, &kind, &size); err != nil {
			break
		}
		identity := recordTouchKey{scope, key}
		value := candidate{identity, size, kind != "history" && kind != "turn" && kind != "item"}
		if protected[identity] || value.metadata {
			retained = append(retained, value)
		} else {
			candidates = append(candidates, value)
		}
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return err
	}
	// Recent and bootstrap rows have preference, not authority. Even a single
	// oversized batch may be evicted: online consumers read the scoped Mac
	// source instead, so optional caching never forces unbounded memory.
	for _, value := range append(candidates, retained...) {
		if bytes <= budget*3/4 {
			break
		}
		if _, err = tx.Exec("DELETE FROM native_records WHERE scope=? AND key=?", value.key.scope, value.key.key); err != nil {
			return err
		}
		bytes -= value.size
		if value.metadata {
			// Once version witnesses or catalog entries have been evicted, this
			// RAM projection cannot attest freshness/completeness. Online readers
			// use scoped Native until a new complete projection is built.
			limited.Store(true)
		}
	}
	return nil
}

func (g *Gateway) optionalHistorySave(scope string, page Snapshot, head, complete bool) error {
	if g.replica != nil {
		return nil
	}
	if g.cachePersistence() == "memory" {
		return nil
	}
	if err := g.history.save(scope, page, head, complete); err != nil {
		if !cacheStorageFailure(err) {
			return err
		}
		return g.useMemoryCacheLocked(err)
	}
	return nil
}

func (g *Gateway) closeCaches() {
	if !g.stopCacheReplica() {
		return
	}
	if g.push != nil && g.push.isolated {
		_ = g.push.store.close()
	}
	if store := g.activeCache.Load(); store != nil && store != g.durable {
		_ = store.close()
	}
	if g.durable != nil {
		_ = g.durable.close()
	}
}
