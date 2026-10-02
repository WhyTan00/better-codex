package main

import (
	"testing"
)

func TestHistoryBudgetMigratesAndTracksRollbackCompatibleWrites(t *testing.T) {
	g := testGateway(t)
	db := g.durable.db
	// Recreate an old installation with data but no accounting migration.
	if _, err := db.Exec(`DROP TRIGGER native_history_usage_insert;
DROP TRIGGER native_history_usage_update; DROP TRIGGER native_history_usage_delete;
DELETE FROM sync_meta WHERE key='nativeHistoryBytes';
INSERT INTO native_records VALUES('ai','old','history','id','gen',1,X'01020304',0,1);`); err != nil {
		t.Fatal(err)
	}
	if err := initializeNativeHistoryBudget(db); err != nil {
		t.Fatal(err)
	}
	check := func(want int64) {
		t.Helper()
		var counter, actual int64
		if err := db.QueryRow("SELECT CAST(value AS INTEGER),(SELECT COALESCE(SUM(length(payload)),0) FROM native_records WHERE kind IN ('history','turn','item') AND deleted=0) FROM sync_meta WHERE key='nativeHistoryBytes'").Scan(&counter, &actual); err != nil {
			t.Fatal(err)
		}
		if counter != actual || counter != want {
			t.Fatalf("derived budget drifted: counter=%d actual=%d want=%d", counter, actual, want)
		}
	}
	check(4)
	// These are the unchanged nine-column writes used by the prior binary.
	for _, step := range []struct {
		sql  string
		want int64
	}{
		{"INSERT INTO native_records VALUES('ai','new','item','id','gen',2,X'050607',0,2)", 7},
		{"UPDATE native_records SET payload=X'0102030405' WHERE key='old'", 8},
		{"UPDATE native_records SET kind='catalog' WHERE key='new'", 5},
		{"UPDATE native_records SET kind='turn' WHERE key='new'", 8},
		{"UPDATE native_records SET deleted=1 WHERE key='old'", 3},
		{"UPDATE native_records SET deleted=0 WHERE key='old'", 8},
	} {
		if _, err := db.Exec(step.sql); err != nil {
			t.Fatal(err)
		}
		check(step.want)
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec("DELETE FROM native_records"); err != nil {
		tx.Rollback()
		t.Fatal(err)
	}
	tx.Rollback()
	check(8)
	if _, err = db.Exec("DELETE FROM native_records"); err != nil {
		t.Fatal(err)
	}
	check(0)
	if err = initializeNativeHistoryBudget(db); err != nil {
		t.Fatal(err)
	}
	check(0)
}
