package com.bettercodex.app;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.Closeable;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * A small transactional read replica. It stores only server supplied DTOs and
 * cursors; it has no command, approval, credential, or execution tables.
 */
public final class SyncStore extends SQLiteOpenHelper implements Closeable {
    private static final String DATABASE_NAME = "native-sync-v1.sqlite";
    private static final int DATABASE_VERSION = 2;
    private static final String META_STATE = "state";
    private static final String META_GENERATION = "generation";
    private static final String META_BOOTSTRAP = "bootstrap";
    private static final String META_BOOTSTRAP_CONFIG = "bootstrap-config";
    private static final String META_CATALOG_STATUS = "catalog-status";

    /** The bridge accepts a stricter bound than the Web gateway's transport cap. */
    static final int MAX_RECORD_BYTES = 1 * 1024 * 1024;
    static final int MAX_PAGE_BYTES = 2 * 1024 * 1024;
    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;
    private static final long MAX_DECLARED_BYTES = 64L * 1024L * 1024L;
    private static final int MAX_KEY_LENGTH = 512;
    private static final int MAX_SOURCE_GENERATION_LENGTH = 160;
    private static final int MAX_THREAD_ID_LENGTH = 200;
    private static final int MAX_HISTORY_CURSOR_BYTES = 64 * 1024;
    private static final int MAX_HISTORY_CURSOR_ENTRIES = 256;

    private static final Set<String> RECORD_KINDS = new HashSet<>();

    static {
        RECORD_KINDS.add("catalog");
        RECORD_KINDS.add("history");
        RECORD_KINDS.add("turn");
        RECORD_KINDS.add("item");
        RECORD_KINDS.add("readAlias");
        // This is an internal source record. It is projected into the
        // historyCursors page metadata and never exposed as a Web record.
        RECORD_KINDS.add("historyCursor");
    }

    public SyncStore(Context context) {
        super(context.getApplicationContext(), DATABASE_NAME, null, DATABASE_VERSION);
        setWriteAheadLoggingEnabled(true);
    }

    @Override
    public void onConfigure(SQLiteDatabase db) {
        super.onConfigure(db);
        // SQLiteOpenHelper invokes this before the schema transaction. SQLite
        // rejects changes to synchronous from onCreate/onUpgrade transactions.
        db.execSQL("PRAGMA synchronous=FULL");
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        createSchema(db);
    }

    private static void createSchema(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS meta (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope,key))");
        db.execSQL("CREATE TABLE IF NOT EXISTS cursors (scope TEXT PRIMARY KEY, event_epoch TEXT NOT NULL DEFAULT '', event_seq INTEGER NOT NULL DEFAULT 0, catalog_generation TEXT NOT NULL DEFAULT '', catalog_cursor INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("CREATE TABLE IF NOT EXISTS local_sequences (scope TEXT PRIMARY KEY, next_seq INTEGER NOT NULL DEFAULT 1)");
        db.execSQL("CREATE TABLE IF NOT EXISTS records (scope TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, thread_id TEXT NOT NULL DEFAULT '', generation TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL, payload TEXT, confirmed_at TEXT NOT NULL DEFAULT '', bytes INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, source_generation TEXT NOT NULL DEFAULT '', change_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,key))");
        db.execSQL("CREATE INDEX IF NOT EXISTS records_revision ON records(scope,revision)");
        db.execSQL("CREATE INDEX IF NOT EXISTS records_kind ON records(scope,kind,deleted)");
        db.execSQL("CREATE TABLE IF NOT EXISTS record_changes (scope TEXT NOT NULL, seq INTEGER NOT NULL, source_generation TEXT NOT NULL DEFAULT '', record_json TEXT NOT NULL, PRIMARY KEY(scope,seq))");
        db.execSQL("CREATE INDEX IF NOT EXISTS record_changes_scope_seq ON record_changes(scope,seq)");
        db.execSQL("CREATE INDEX IF NOT EXISTS record_changes_scope_generation_seq ON record_changes(scope,source_generation,seq)");
        db.execSQL("CREATE TABLE IF NOT EXISTS history_cursors (scope TEXT NOT NULL, thread_id TEXT NOT NULL, source_generation TEXT NOT NULL DEFAULT '', value TEXT, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,thread_id))");
        db.execSQL("CREATE TABLE IF NOT EXISTS turn_observations (scope TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, state TEXT NOT NULL, observed_at INTEGER NOT NULL, notified_at INTEGER NOT NULL DEFAULT 0, baseline INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,thread_id,turn_id))");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        // v1 was never released. Recreate the change table so old rows without
        // a source generation cannot be mixed into a v2 page.
        if (oldVersion < 2) {
            db.execSQL("DROP TABLE IF EXISTS record_changes");
            createSchema(db);
        } else {
            createSchema(db);
        }
    }

    public synchronized CursorState eventCursor(String scope) {
        return readCursor(scope);
    }

    public synchronized CatalogCursor catalogCursor(String scope) {
        CursorState state = readCursor(scope);
        return new CatalogCursor(state.catalogGeneration, state.catalogCursor);
    }

    @Nullable
    private CursorState readCursor(String scope) {
        SQLiteDatabase db = getReadableDatabase();
        return readCursorLocked(db, scope);
    }

    public synchronized void saveEventCursor(String scope, String epoch, long seq) {
        if (!BetterCodexConfig.isScope(scope)) return;
        SQLiteDatabase db = getWritableDatabase();
        CursorState old = readCursorLocked(db, scope);
        String nextEpoch = safe(epoch, MAX_SOURCE_GENERATION_LENGTH);
        long nextSeq = boundedCursor(seq);
        if (nextEpoch.equals(old.epoch) && nextSeq < old.seq) return;
        ContentValues values = new ContentValues();
        values.put("scope", scope);
        values.put("event_epoch", nextEpoch);
        values.put("event_seq", nextSeq);
        values.put("catalog_generation", old.catalogGeneration);
        values.put("catalog_cursor", old.catalogCursor);
        db.insertWithOnConflict("cursors", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    public synchronized void saveCatalogCursor(String scope, String generation, long cursor) {
        if (!BetterCodexConfig.isScope(scope) || generation == null || generation.isEmpty()) return;
        SQLiteDatabase db = getWritableDatabase();
        CursorState old = readCursorLocked(db, scope);
        String nextGeneration = safe(generation, MAX_SOURCE_GENERATION_LENGTH);
        long nextCursor = boundedCursor(cursor);
        if (nextGeneration.equals(old.catalogGeneration) && nextCursor < old.catalogCursor) return;
        ContentValues values = new ContentValues();
        values.put("scope", scope);
        values.put("event_epoch", old.epoch);
        values.put("event_seq", old.seq);
        values.put("catalog_generation", nextGeneration);
        values.put("catalog_cursor", nextCursor);
        db.insertWithOnConflict("cursors", null, values, SQLiteDatabase.CONFLICT_REPLACE);
        putMeta(scope, META_GENERATION, nextGeneration);
    }

    public synchronized boolean generationChanged(String scope, @Nullable String generation) {
        if (generation == null || generation.isEmpty()) return false;
        String current = sourceGeneration(scope);
        return !current.isEmpty() && !"uninitialized".equals(current) && !generation.equals(current);
    }

    /** Reset source projections while retaining the monotonic local change log. */
    public synchronized void resetGeneration(String scope, String generation) {
        if (!BetterCodexConfig.isScope(scope) || generation == null || generation.isEmpty()) return;
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            resetGenerationLocked(db, scope, safe(generation, MAX_SOURCE_GENERATION_LENGTH));
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    private static void resetGenerationLocked(SQLiteDatabase db, String scope, String generation) {
        db.delete("records", "scope=?", new String[]{scope});
        db.delete("history_cursors", "scope=?", new String[]{scope});
        db.delete("turn_observations", "scope=?", new String[]{scope});
        db.delete("meta", "scope=? AND key IN (?,?)", new String[]{scope, META_CATALOG_STATUS, META_BOOTSTRAP_CONFIG});

        CursorState old = readCursorLocked(db, scope);
        ContentValues cursor = new ContentValues();
        cursor.put("scope", scope);
        cursor.put("event_epoch", old.epoch);
        cursor.put("event_seq", old.seq);
        cursor.put("catalog_generation", generation);
        cursor.put("catalog_cursor", 0L);
        db.insertWithOnConflict("cursors", null, cursor, SQLiteDatabase.CONFLICT_REPLACE);
        putMetaLocked(db, scope, META_GENERATION, generation);
        putMetaLocked(db, scope, META_BOOTSTRAP, "false");
    }

    public synchronized void markBootstrapComplete(String scope, boolean complete) {
        putMeta(scope, META_BOOTSTRAP, Boolean.toString(complete));
    }

    public synchronized boolean isBootstrapComplete(String scope) {
        return "true".equals(getMeta(scope, META_BOOTSTRAP));
    }

    public synchronized void setState(String scope, JSONObject state) {
        putMeta(scope, META_STATE, state == null ? "{}" : state.toString());
    }

    public synchronized JSONObject getState(String scope) {
        String value = getMeta(scope, META_STATE);
        if (value == null) return new JSONObject();
        try {
            return new JSONObject(value);
        } catch (JSONException ignored) {
            return new JSONObject();
        }
    }

    public synchronized void saveCatalogStatus(String scope, @Nullable JSONObject status) {
        if (!BetterCodexConfig.isScope(scope) || status == null) return;
        String raw = status.toString();
        if (utf8Bytes(raw) > MAX_RECORD_BYTES) return;
        putMeta(scope, META_CATALOG_STATUS, raw);
    }

    @Nullable
    public synchronized JSONObject getCatalogStatus(String scope) {
        String value = getMeta(scope, META_CATALOG_STATUS);
        if (value == null || value.isEmpty()) return null;
        try {
            return new JSONObject(value);
        } catch (JSONException ignored) {
            return null;
        }
    }

    /**
     * Apply one server DTO and its local change-log entry in one transaction.
     * Source generation changes clear old projections before accepting the new
     * record, while the local sequence remains monotonic across generations.
     */
    public synchronized void applyNativeRecord(JSONObject record) throws JSONException {
        validateRecord(record, true);
        String scope = record.optString("scope", "");
        String sourceGeneration = record.optString("sourceGeneration", "");
        String key = record.optString("key", "");
        String kind = record.optString("kind", "");
        String generation = record.optString("generation", "");
        long revision = exactLong(record, "revision", 1L, MAX_SAFE_INTEGER);
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            String current = sourceGeneration(scope);
            if (!current.isEmpty() && !"uninitialized".equals(current) && !current.equals(sourceGeneration)) {
                resetGenerationLocked(db, scope, sourceGeneration);
            } else if (current.isEmpty() || "uninitialized".equals(current)) {
                putMetaLocked(db, scope, META_GENERATION, sourceGeneration);
                ContentValues historyGeneration = new ContentValues();
                historyGeneration.put("source_generation", sourceGeneration);
                db.update("history_cursors", historyGeneration,
                        "scope=? AND (source_generation='' OR source_generation='uninitialized')",
                        new String[]{scope});
                CursorState old = readCursorLocked(db, scope);
                ContentValues cursor = new ContentValues();
                cursor.put("scope", scope);
                cursor.put("event_epoch", old.epoch);
                cursor.put("event_seq", old.seq);
                cursor.put("catalog_generation", sourceGeneration);
                cursor.put("catalog_cursor", old.catalogCursor);
                db.insertWithOnConflict("cursors", null, cursor, SQLiteDatabase.CONFLICT_REPLACE);
            }

            if ("historyCursor".equals(kind)) {
                JSONObject value = record.optJSONObject("payload");
                if (value == null && !record.optBoolean("deleted", false)) throw new JSONException("invalid history cursor");
                saveHistoryCursorLocked(db, scope, record.optString("threadId", ""), sourceGeneration, value,
                        record.optBoolean("deleted", false));
                db.setTransactionSuccessful();
                return;
            }

            String oldGeneration = null;
            long oldRevision = 0L;
            try (Cursor old = db.query("records", new String[]{"generation", "revision"}, "scope=? AND key=?", new String[]{scope, key}, null, null, null)) {
                if (old.moveToFirst()) {
                    oldGeneration = old.getString(0);
                    oldRevision = old.getLong(1);
                }
            }
            if (oldGeneration != null && oldGeneration.equals(generation) && oldRevision >= revision) {
                db.setTransactionSuccessful();
                return;
            }

            long changeSeq = nextSequenceLocked(db, scope);
            String raw = record.toString();
            ContentValues values = new ContentValues();
            values.put("scope", scope);
            values.put("key", key);
            values.put("kind", kind);
            values.put("thread_id", record.optString("threadId", ""));
            values.put("generation", generation);
            values.put("revision", revision);
            Object payload = record.has("payload") ? record.opt("payload") : JSONObject.NULL;
            values.put("payload", payload == JSONObject.NULL ? "null" : payload.toString());
            values.put("confirmed_at", record.optString("confirmedAt", ""));
            values.put("bytes", record.has("bytes") ? exactLong(record, "bytes", 0L, MAX_DECLARED_BYTES) : 0L);
            values.put("deleted", record.optBoolean("deleted", false) ? 1 : 0);
            values.put("source_generation", sourceGeneration);
            values.put("change_seq", changeSeq);
            db.insertWithOnConflict("records", null, values, SQLiteDatabase.CONFLICT_REPLACE);

            ContentValues change = new ContentValues();
            change.put("scope", scope);
            change.put("seq", changeSeq);
            change.put("source_generation", sourceGeneration);
            change.put("record_json", raw);
            db.insertOrThrow("record_changes", null, change);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    /** Save the cursor metadata returned alongside a native history read. */
    public synchronized void saveHistoryCursor(String scope, String threadId, JSONObject cursors) {
        if (!BetterCodexConfig.isScope(scope) || !isUuid(threadId) || cursors == null) return;
        if (utf8Bytes(cursors.toString()) > MAX_HISTORY_CURSOR_BYTES) return;
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            String generation = sourceGeneration(scope);
            try {
                saveHistoryCursorLocked(db, scope, threadId, generation, cursors, false);
            } catch (JSONException ignored) {
                // The public guard above establishes the same invariants as
                // the locked writer; keep malformed input out of the store.
                return;
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    private static void saveHistoryCursorLocked(SQLiteDatabase db, String scope, String threadId,
                                                String sourceGeneration, @Nullable JSONObject value,
                                                boolean deleted) throws JSONException {
        if (!isUuid(threadId) || (!deleted && value == null) || value != null && utf8Bytes(value.toString()) > MAX_HISTORY_CURSOR_BYTES) {
            throw new JSONException("invalid history cursor");
        }
        ContentValues values = new ContentValues();
        values.put("scope", scope);
        values.put("thread_id", threadId);
        values.put("source_generation", sourceGeneration == null ? "" : safe(sourceGeneration, MAX_SOURCE_GENERATION_LENGTH));
        if (value == null) values.putNull("value"); else values.put("value", value.toString());
        values.put("deleted", deleted ? 1 : 0);
        db.insertWithOnConflict("history_cursors", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    /**
     * Return records after the local scope cursor. Source revision is never
     * used as this cursor; each included DTO advances the local sequence only.
     */
    public synchronized JSONObject readRecords(String scope, long after, int limit) {
        int bounded = Math.max(1, Math.min(200, limit));
        long requestedAfter = boundedCursor(after);
        long cursorValue = requestedAfter;
        JSONArray records = new JSONArray();
        boolean hasMore = false;
        boolean resetRequired = false;
        int pageBytes = 0;
        String generation = sourceGeneration(scope);
        if (generation.isEmpty()) generation = "uninitialized";
        SQLiteDatabase db = getReadableDatabase();

        // A missing prefix is a reset only when no retained change-log entry
        // proves that the caller's cursor is an older generation boundary.
        String firstSeq = null;
        try (Cursor first = db.rawQuery("SELECT MIN(seq) FROM record_changes WHERE scope=? AND source_generation=?", new String[]{scope, generation})) {
            if (first.moveToFirst() && !first.isNull(0)) firstSeq = first.getString(0);
        }
        if (firstSeq != null && requestedAfter > 0L && requestedAfter < boundedCursor(Long.parseLong(firstSeq) - 1L)) {
            try (Cursor prior = db.rawQuery("SELECT 1 FROM record_changes WHERE scope=? AND seq<=? LIMIT 1", new String[]{scope, Long.toString(requestedAfter)})) {
                resetRequired = !prior.moveToFirst();
            }
        }

        if (!resetRequired && !"uninitialized".equals(generation)) {
            String selection = "scope=? AND source_generation=? AND seq>?";
            String[] args = new String[]{scope, generation, Long.toString(requestedAfter)};
            try (Cursor rows = db.query("record_changes", new String[]{"seq", "record_json"}, selection, args,
                    null, null, "seq ASC", Integer.toString(bounded + 1))) {
                while (rows.moveToNext()) {
                    long seq = rows.getLong(0);
                    String raw = rows.getString(1);
                    JSONObject record;
                    try {
                        record = new JSONObject(raw);
                        validateRecord(record, false);
                    } catch (JSONException invalid) {
                        resetRequired = true;
                        break;
                    }
                    int bytes = utf8Bytes(raw);
                    if (records.length() >= bounded || pageBytes > 0 && pageBytes + bytes > MAX_PAGE_BYTES) {
                        hasMore = true;
                        break;
                    }
                    if (bytes > MAX_RECORD_BYTES || pageBytes + bytes > MAX_PAGE_BYTES) {
                        // There is no valid way to advance over an omitted
                        // committed record. Force a fresh source generation.
                        resetRequired = true;
                        break;
                    }
                    records.put(record);
                    pageBytes += bytes;
                    cursorValue = seq;
                }
            }
        }

        JSONObject result = new JSONObject();
        try {
            result.put("version", 1);
            result.put("scope", scope);
            result.put("generation", generation);
            result.put("records", records);
            result.put("cursor", cursorValue);
            result.put("hasMore", hasMore);
            JSONObject status = getCatalogStatus(scope);
            if (status == null) status = new JSONObject();
            result.put("status", status);
            CatalogCursor catalog = catalogCursor(scope);
            boolean catalogPage = containsKind(records, "catalog");
            if (catalogPage || status.length() > 0) result.put("catalogCursor", catalog.cursor);
            appendHistoryCursors(result, scope, pageBytes);
            JSONObject bootstrap = getBootstrap(scope);
            if (bootstrap != null) result.put("bootstrap", bootstrap);
            result.put("resetRequired", resetRequired);
        } catch (JSONException ignored) {
            // All keys and values above are primitive or JSONObject instances.
        }
        return result;
    }

    private static boolean containsKind(JSONArray records, String kind) {
        for (int index = 0; index < records.length(); index++) {
            JSONObject record = records.optJSONObject(index);
            if (record != null && kind.equals(record.optString("kind", ""))) return true;
        }
        return false;
    }

    private void appendHistoryCursors(JSONObject result, String scope, int pageBytes) throws JSONException {
        JSONArray values = new JSONArray();
        SQLiteDatabase db = getReadableDatabase();
        int count = 0;
        int bytes = pageBytes;
        String generation = sourceGeneration(scope);
        try (Cursor rows = db.query("history_cursors", new String[]{"thread_id", "value"},
                "scope=? AND source_generation=? AND deleted=0", new String[]{scope, generation}, null, null, "thread_id ASC")) {
            while (rows.moveToNext() && count < MAX_HISTORY_CURSOR_ENTRIES) {
                JSONObject value = parseObject(rows.getString(1));
                if (value == null) continue;
                JSONObject entry = new JSONObject();
                entry.put("threadId", rows.getString(0));
                entry.put("value", value);
                int entryBytes = utf8Bytes(entry.toString());
                if (bytes + entryBytes > MAX_PAGE_BYTES) break;
                values.put(entry);
                bytes += entryBytes;
                count++;
            }
        }
        if (values.length() > 0) result.put("historyCursors", values);
    }

    public synchronized long localRecordCursor(String scope) {
        SQLiteDatabase db = getReadableDatabase();
        try (Cursor rows = db.rawQuery("SELECT COALESCE(MAX(seq),0) FROM record_changes WHERE scope=?", new String[]{scope})) {
            return rows.moveToFirst() ? boundedCursor(rows.getLong(0)) : 0L;
        }
    }

    public synchronized void saveBootstrap(String scope, JSONObject bootstrap) {
        if (!BetterCodexConfig.isScope(scope) || bootstrap == null) return;
        if (utf8Bytes(bootstrap.toString()) > MAX_RECORD_BYTES) return;
        putMeta(scope, META_BOOTSTRAP_CONFIG, bootstrap.toString());
    }

    @Nullable
    public synchronized JSONObject getBootstrap(String scope) {
        String value = getMeta(scope, META_BOOTSTRAP_CONFIG);
        if (value == null || value.isEmpty() || utf8Bytes(value) > MAX_RECORD_BYTES) return null;
        try {
            return new JSONObject(value);
        } catch (JSONException ignored) {
            return null;
        }
    }

    @Nullable
    public synchronized JSONObject catalogRecord(String scope, String threadId) {
        String key = "thread:" + threadId;
        SQLiteDatabase db = getReadableDatabase();
        try (Cursor rows = db.query("records", new String[]{"scope", "key", "kind", "thread_id", "generation", "revision", "payload", "confirmed_at", "bytes", "deleted", "source_generation"}, "scope=? AND key=?", new String[]{scope, key}, null, null, null)) {
            if (!rows.moveToFirst()) return null;
            return rowToRecord(rows);
        }
    }

    /** Derived from this scope's Native catalog; never a second execution state. */
    public synchronized JSONObject runningSessions(String scope) {
        JSONObject result = new JSONObject();
        int count = 0;
        String firstId = "";
        try (Cursor rows = getReadableDatabase().query("records", new String[]{"thread_id", "payload"},
                "scope=? AND kind='catalog' AND deleted=0", new String[]{scope}, null, null, null)) {
            while (rows.moveToNext()) {
                try {
                    JSONObject thread = new JSONObject(rows.getString(1)).optJSONObject("nativeThread");
                    JSONObject status = thread == null ? null : thread.optJSONObject("status");
                    if (thread == null || thread.optBoolean("archived", false) || status == null
                            || !"active".equals(status.optString("type"))) continue;
                    count++;
                    if (firstId.isEmpty()) firstId = rows.getString(0);
                } catch (JSONException ignored) { }
            }
        }
        try { result.put("count", count); result.put("threadId", count == 1 ? firstId : ""); }
        catch (JSONException ignored) { }
        return result;
    }

    /** Pinned and recent heads, independent of UI asset versions. */
    public synchronized List<JSONObject> historyWarmCandidates(String scope, int limit) {
        List<JSONObject> candidates = new ArrayList<>();
        SQLiteDatabase db = getReadableDatabase();
        try (Cursor rows = db.query("records", new String[]{"thread_id", "payload", "source_generation", "generation"},
                "scope=? AND kind='catalog' AND deleted=0", new String[]{scope}, null, null, "revision DESC", "512")) {
            while (rows.moveToNext()) {
                try {
                    JSONObject payload = new JSONObject(rows.getString(1));
                    JSONObject thread = payload.optJSONObject("nativeThread");
                    if (thread == null || thread.optBoolean("archived", false)) continue;
                    JSONObject status = thread.optJSONObject("status");
                    if (status != null && "active".equals(status.optString("type"))) continue;
                    String id = rows.getString(0);
                    if (id == null || id.isEmpty()) continue;
                    String version = rows.getString(2) + ":" + rows.getString(3) + ":" + thread.optLong("updatedAt", 0L);
                    String saved = getMeta(scope, "history-warm:" + id);
                    if (saved != null) {
                        JSONObject prior = new JSONObject(saved);
                        if (version.equals(prior.optString("version"))) {
                            try (Cursor head = db.rawQuery("SELECT 1 FROM records WHERE scope=? AND key=? AND kind='history' AND deleted=0 LIMIT 1",
                                    new String[]{scope, prior.optString("key")})) {
                                if (head.moveToFirst()) continue;
                            }
                        }
                    }
                    JSONObject section = thread.optJSONObject("section");
                    boolean pinned = thread.optBoolean("isPinned", false) || section != null && "Pinned".equalsIgnoreCase(section.optString("name"));
                    candidates.add(new JSONObject().put("threadId", id).put("version", version)
                            .put("pinned", pinned).put("updatedAt", thread.optLong("updatedAt", 0L)));
                } catch (JSONException ignored) { }
            }
        }
        candidates.sort((a, b) -> {
            int priority = Boolean.compare(b.optBoolean("pinned"), a.optBoolean("pinned"));
            return priority != 0 ? priority : Long.compare(b.optLong("updatedAt"), a.optLong("updatedAt"));
        });
        return new ArrayList<>(candidates.subList(0, Math.min(Math.max(0, limit), candidates.size())));
    }

    public synchronized void markHistoryWarm(String scope, JSONObject candidate, String key) throws JSONException {
        putMeta(scope, "history-warm:" + candidate.getString("threadId"),
                new JSONObject().put("version", candidate.getString("version")).put("key", key).toString());
    }

    /**
     * Record a raw turn state. Only a fresh, non-baseline transition from a
     * previously observed inProgress turn can return true.
     */
    public synchronized boolean observeTurn(String scope, String threadId, String turnId, String status, boolean fresh, boolean baseline, long now) {
        if (!fresh || status == null || status.isEmpty() || threadId.isEmpty() || turnId.isEmpty()) return false;
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            String priorState = null;
            long notifiedAt = 0L;
            try (Cursor rows = db.query("turn_observations", new String[]{"state", "notified_at"}, "scope=? AND thread_id=? AND turn_id=?", new String[]{scope, threadId, turnId}, null, null, null)) {
                if (rows.moveToFirst()) {
                    priorState = rows.getString(0);
                    notifiedAt = rows.getLong(1);
                }
            }
            boolean shouldNotify = false;
            String nextState = status;
            long nextNotified = notifiedAt;
            boolean nextBaseline = baseline;
            if ("inProgress".equals(status)) {
                // The first observed inProgress state is the service baseline;
                // it must be seen before a later completion can notify.
                nextBaseline = false;
            } else if ("completed".equals(status)) {
                shouldNotify = !baseline && "inProgress".equals(priorState) && notifiedAt == 0L;
                if (shouldNotify) nextNotified = Math.max(now, 1L);
                nextBaseline = baseline || !shouldNotify;
            } else if ("failed".equals(status) || "interrupted".equals(status) || "cancelled".equals(status)) {
                nextBaseline = true;
            } else {
                nextBaseline = baseline;
            }
            ContentValues values = new ContentValues();
            values.put("scope", scope);
            values.put("thread_id", threadId);
            values.put("turn_id", turnId);
            values.put("state", nextState);
            values.put("observed_at", Math.max(now, 1L));
            values.put("notified_at", nextNotified);
            values.put("baseline", nextBaseline ? 1 : 0);
            db.insertWithOnConflict("turn_observations", null, values, SQLiteDatabase.CONFLICT_REPLACE);
            db.setTransactionSuccessful();
            return shouldNotify;
        } finally {
            db.endTransaction();
        }
    }

    @Nullable
    public synchronized String getMeta(String scope, String key) {
        SQLiteDatabase db = getReadableDatabase();
        try (Cursor rows = db.query("meta", new String[]{"value"}, "scope=? AND key=?", new String[]{scope, key}, null, null, null)) {
            return rows.moveToFirst() ? rows.getString(0) : null;
        }
    }

    private String sourceGeneration(String scope) {
        String value = getMeta(scope, META_GENERATION);
        if (value != null && !value.isEmpty()) return value;
        CursorState cursor = readCursor(scope);
        return cursor.catalogGeneration == null ? "" : cursor.catalogGeneration;
    }

    private synchronized void putMeta(String scope, String key, String value) {
        putMetaLocked(getWritableDatabase(), scope, key, value);
    }

    private static void putMetaLocked(SQLiteDatabase db, String scope, String key, String value) {
        ContentValues values = new ContentValues();
        values.put("scope", scope);
        values.put("key", key);
        values.put("value", value == null ? "" : value);
        db.insertWithOnConflict("meta", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    private static CursorState readCursorLocked(SQLiteDatabase db, String scope) {
        try (Cursor cursor = db.query("cursors", new String[]{"event_epoch", "event_seq", "catalog_generation", "catalog_cursor"}, "scope=?", new String[]{scope}, null, null, null)) {
            if (!cursor.moveToFirst()) return new CursorState("", 0L, "", 0L);
            return new CursorState(cursor.getString(0), cursor.getLong(1), cursor.getString(2), cursor.getLong(3));
        }
    }

    private static long nextSequenceLocked(SQLiteDatabase db, String scope) {
        long next = 1L;
        try (Cursor rows = db.query("local_sequences", new String[]{"next_seq"}, "scope=?", new String[]{scope}, null, null, null)) {
            if (rows.moveToFirst()) next = Math.max(1L, rows.getLong(0));
            else {
                try (Cursor max = db.rawQuery("SELECT COALESCE(MAX(seq),0)+1 FROM record_changes WHERE scope=?", new String[]{scope})) {
                    if (max.moveToFirst()) next = Math.max(1L, max.getLong(0));
                }
            }
        }
        ContentValues values = new ContentValues();
        values.put("scope", scope);
        values.put("next_seq", next == Long.MAX_VALUE ? Long.MAX_VALUE : next + 1L);
        db.insertWithOnConflict("local_sequences", null, values, SQLiteDatabase.CONFLICT_REPLACE);
        return next;
    }

    private static void validateRecord(@Nullable JSONObject record, boolean allowInternalOnly) throws JSONException {
        if (record == null) throw new JSONException("record missing");
        String scope = record.optString("scope", "");
        String key = record.optString("key", "");
        String kind = record.optString("kind", "");
        String sourceGeneration = record.optString("sourceGeneration", "");
        String generation = record.optString("generation", "");
        if (!BetterCodexConfig.isScope(scope) || !validText(key, MAX_KEY_LENGTH, false) || !RECORD_KINDS.contains(kind)
                || "historyCursor".equals(kind) && !allowInternalOnly
                || !validText(sourceGeneration, MAX_SOURCE_GENERATION_LENGTH, false)
                || !validText(generation, MAX_SOURCE_GENERATION_LENGTH, false)) {
            throw new JSONException("invalid native record");
        }
        exactLong(record, "revision", 1L, MAX_SAFE_INTEGER);
        if (record.has("bytes")) exactLong(record, "bytes", 0L, MAX_DECLARED_BYTES);
        Object deleted = record.opt("deleted");
        if (!(deleted instanceof Boolean)) throw new JSONException("invalid deleted flag");
        Object payload = record.has("payload") ? record.opt("payload") : JSONObject.NULL;
        if (payload != JSONObject.NULL && payload == null) throw new JSONException("invalid payload");
        if (record.has("threadId") && !validText(record.optString("threadId", ""), MAX_THREAD_ID_LENGTH, true)) {
            throw new JSONException("invalid thread id");
        }
        if (record.has("confirmedAt") && !validText(record.optString("confirmedAt", ""), 200, true)) {
            throw new JSONException("invalid confirmation time");
        }
        if ("readAlias".equals(kind) && !key.startsWith("stable-item-head:")) throw new JSONException("invalid alias");
        if (utf8Bytes(record.toString()) > MAX_RECORD_BYTES) throw new JSONException("record too large");
    }

    private static long exactLong(JSONObject value, String key, long minimum, long maximum) throws JSONException {
        if (!value.has(key)) return minimum == 0L ? 0L : failLong(key);
        Object raw = value.opt(key);
        if (!(raw instanceof Number)) throw new JSONException("invalid " + key);
        double number = ((Number) raw).doubleValue();
        if (!Double.isFinite(number) || number != Math.rint(number) || number < minimum || number > maximum) {
            throw new JSONException("invalid " + key);
        }
        long result = ((Number) raw).longValue();
        if (result < minimum || result > maximum) throw new JSONException("invalid " + key);
        return result;
    }

    private static long failLong(String key) throws JSONException {
        throw new JSONException("missing " + key);
    }

    private static boolean validText(@Nullable String value, int maximum, boolean allowEmpty) {
        if (value == null || (!allowEmpty && value.isEmpty()) || value.length() > maximum) return false;
        for (int index = 0; index < value.length(); index++) if (value.charAt(index) < 0x20) return false;
        return true;
    }

    private static boolean isUuid(@Nullable String value) {
        if (value == null || value.length() > MAX_THREAD_ID_LENGTH) return false;
        try {
            UUID.fromString(value);
            return value.length() == 36;
        } catch (IllegalArgumentException ignored) {
            return false;
        }
    }

    private static long boundedCursor(long value) {
        if (value < 0L) return 0L;
        return Math.min(value, MAX_SAFE_INTEGER);
    }

    private static int utf8Bytes(String value) {
        return value == null ? 0 : value.getBytes(StandardCharsets.UTF_8).length;
    }

    @Nullable
    private static JSONObject parseObject(@Nullable String value) {
        if (value == null) return null;
        try {
            Object parsed = new JSONTokener(value).nextValue();
            return parsed instanceof JSONObject ? (JSONObject) parsed : null;
        } catch (JSONException ignored) {
            return null;
        }
    }

    private static JSONObject rowToRecord(Cursor rows) {
        JSONObject result = new JSONObject();
        try {
            result.put("scope", rows.getString(0));
            result.put("key", rows.getString(1));
            result.put("kind", rows.getString(2));
            result.put("threadId", rows.getString(3));
            result.put("generation", rows.getString(4));
            result.put("revision", rows.getLong(5));
            result.put("payload", parseJsonValue(rows.getString(6)));
            result.put("confirmedAt", rows.getString(7));
            result.put("bytes", rows.getLong(8));
            result.put("deleted", rows.getInt(9) != 0);
            result.put("sourceGeneration", rows.getString(10));
        } catch (JSONException ignored) {
            // A row made by this class has no invalid key/value combination.
        }
        return result;
    }

    private static Object parseJsonValue(@Nullable String value) {
        if (value == null) return JSONObject.NULL;
        try {
            return new JSONTokener(value).nextValue();
        } catch (JSONException ignored) {
            return JSONObject.NULL;
        }
    }

    private static String safe(@Nullable String value, int max) {
        if (value == null) return "";
        return value.length() > max ? value.substring(0, max) : value;
    }

    @Override
    public synchronized void close() {
        super.close();
    }

    public static final class CursorState {
        public final String epoch;
        public final long seq;
        public final String catalogGeneration;
        public final long catalogCursor;

        CursorState(String epoch, long seq, String catalogGeneration, long catalogCursor) {
            this.epoch = epoch == null ? "" : epoch;
            this.seq = boundedCursor(seq);
            this.catalogGeneration = catalogGeneration == null ? "" : catalogGeneration;
            this.catalogCursor = boundedCursor(catalogCursor);
        }
    }

    public static final class CatalogCursor {
        public final String generation;
        public final long cursor;

        CatalogCursor(String generation, long cursor) {
            this.generation = generation == null ? "" : generation;
            this.cursor = boundedCursor(cursor);
        }
    }
}
