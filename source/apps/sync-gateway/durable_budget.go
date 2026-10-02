package main

import (
	"database/sql"
	"errors"
)

// Cache accounting must not rescan every cached history blob on each incoming
// record. This derived counter is maintained in the same transaction by SQLite
// triggers, including writes from an older binary after rollback. The source
// table and its original nine-column insert contract stay unchanged.
func initializeNativeHistoryBudget(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var value string
	err = tx.QueryRow("SELECT value FROM sync_meta WHERE key='nativeHistoryBytes'").Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		_, err = tx.Exec("INSERT INTO sync_meta(key,value) SELECT 'nativeHistoryBytes',COALESCE(SUM(length(payload)),0) FROM native_records WHERE kind IN ('history','turn','item') AND deleted=0")
	}
	if err != nil {
		return err
	}
	_, err = tx.Exec(`
CREATE TRIGGER IF NOT EXISTS native_history_usage_insert AFTER INSERT ON native_records
WHEN NEW.kind IN ('history','turn','item') AND NEW.deleted=0
BEGIN UPDATE sync_meta SET value=CAST(value AS INTEGER)+length(NEW.payload) WHERE key='nativeHistoryBytes'; END;
CREATE TRIGGER IF NOT EXISTS native_history_usage_delete AFTER DELETE ON native_records
WHEN OLD.kind IN ('history','turn','item') AND OLD.deleted=0
BEGIN UPDATE sync_meta SET value=CAST(value AS INTEGER)-length(OLD.payload) WHERE key='nativeHistoryBytes'; END;
CREATE TRIGGER IF NOT EXISTS native_history_usage_update AFTER UPDATE OF payload,kind,deleted ON native_records
BEGIN UPDATE sync_meta SET value=CAST(value AS INTEGER)
 + CASE WHEN NEW.kind IN ('history','turn','item') AND NEW.deleted=0 THEN length(NEW.payload) ELSE 0 END
 - CASE WHEN OLD.kind IN ('history','turn','item') AND OLD.deleted=0 THEN length(OLD.payload) ELSE 0 END
 WHERE key='nativeHistoryBytes'; END;`)
	if err != nil {
		return err
	}
	return tx.Commit()
}
