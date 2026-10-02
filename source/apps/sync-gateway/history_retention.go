package main

import (
	"context"
	"log"
	"time"
)

// Only the obsolete, write-only hash archive is reclaimed here. Native DTOs,
// HistoryStore pagination, topics, approvals, receipts and push state are not
// age-deleted. SQLite free pages are reused; never VACUUM a live sync writer.
func (g *Gateway) pruneUnusedHistory(ctx context.Context) (int64, error) {
	if g.cachePersistence() == "memory" {
		return 0, nil
	}
	if g.replica != nil {
		if !g.replica.storageMu.TryLock() {
			return 0, nil
		}
		defer g.replica.storageMu.Unlock()
	} else {
		if !g.persistMu.TryLock() {
			return 0, nil
		}
		defer g.persistMu.Unlock()
	}
	ctx, cancel := context.WithTimeout(ctx, 250*time.Millisecond)
	defer cancel()
	store := g.cacheStore()
	if g.replica != nil {
		store = g.replica.store
	}
	rows, err := store.reader.QueryContext(ctx, "SELECT rowid,length(payload) FROM history_pages ORDER BY rowid LIMIT 256")
	if err != nil {
		return 0, err
	}
	var ids []int64
	var bytes int64
	for rows.Next() {
		var id, size int64
		if err = rows.Scan(&id, &size); err != nil {
			rows.Close()
			return 0, err
		}
		if len(ids) > 0 && bytes+size > 4*1024*1024 {
			break
		}
		ids = append(ids, id)
		bytes += size
	}
	err = rows.Err()
	rows.Close()
	if err != nil || len(ids) == 0 {
		return 0, err
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx, "DELETE FROM history_pages WHERE rowid=?")
	if err != nil {
		return 0, err
	}
	defer stmt.Close()
	for _, id := range ids {
		if _, err = stmt.ExecContext(ctx, id); err != nil {
			return 0, err
		}
	}
	if err = tx.Commit(); err != nil {
		return 0, err
	}
	return int64(len(ids)), nil
}

func (g *Gateway) runHistoryRetention(ctx context.Context) {
	timer := time.NewTicker(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			count, err := g.pruneUnusedHistory(ctx)
			if err != nil {
				log.Print(`{"event":"history_retention","state":"deferred"}`)
			} else if count > 0 {
				log.Printf(`{"event":"history_retention","state":"committed","rows":%d}`, count)
			}
		}
	}
}
