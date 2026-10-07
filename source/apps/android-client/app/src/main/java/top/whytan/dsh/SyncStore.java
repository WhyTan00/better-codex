package top.whytan.dsh;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.CursorWindow;
import android.database.sqlite.SQLiteCursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.os.Build;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.Closeable;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.HashMap;
import java.util.Map;
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
    private static final int DATABASE_VERSION = 5;
    private static final String META_STATE = "state";
    private static final String META_GENERATION = "generation";
    private static final String META_BOOTSTRAP = "bootstrap";
    private static final String META_BOOTSTRAP_CONFIG = "bootstrap-config";
    private static final String META_CATALOG_STATUS = "catalog-status";
    private static final String META_CHANGE_BYTES = "record-change-bytes";
    private static final String META_GENERATION_FLOOR = "record-generation-floor";

    /** The bridge accepts a stricter bound than the Web gateway's transport cap. */
    static final int MAX_METADATA_RECORD_BYTES = 1 * 1024 * 1024;
    static final int MAX_RECORD_BYTES = 8 * 1024 * 1024;
    static final int MAX_VISIBLE_PROCESS_BYTES = 8 * 1024 * 1024;
    static final int MAX_PAGE_BYTES = 2 * 1024 * 1024;
    static final int MAX_BODY_ENVELOPE_BYTES = 12 * 1024 * 1024;
    // Old versions are diagnostic history, not the source for Web import.
    // Bound that duplicate history to one existing page budget per workspace.
    static final int MAX_CHANGE_LOG_BYTES = MAX_PAGE_BYTES;
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

    private final Context appContext;

    public SyncStore(Context context) {
        super(context.getApplicationContext(), DATABASE_NAME, (db,driver,table,query)->{
            SQLiteCursor cursor=new SQLiteCursor(driver,table,query);
            // SQLite's small default window must not make a committed body
            // unreachable. The public bounded-window API starts at Android28.
            if(Build.VERSION.SDK_INT>=28)cursor.setWindow(new CursorWindow("native-read-store",MAX_BODY_ENVELOPE_BYTES));
            return cursor;
        }, DATABASE_VERSION);
        appContext = context.getApplicationContext();
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
        // Read archives survive a relay/view rebuild. Original provenance and
        // pagination remain intact; these rows never advance sync or execution.
        db.execSQL("CREATE TABLE IF NOT EXISTS saved_records (scope TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, thread_id TEXT NOT NULL DEFAULT '', generation TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL, payload TEXT, confirmed_at TEXT NOT NULL DEFAULT '', bytes INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, source_generation TEXT NOT NULL DEFAULT '', change_seq INTEGER NOT NULL DEFAULT 0, saved_at INTEGER NOT NULL, PRIMARY KEY(scope,key,source_generation,generation))");
        db.execSQL("CREATE INDEX IF NOT EXISTS saved_records_thread ON saved_records(scope,thread_id,saved_at DESC)");
        db.execSQL("CREATE TABLE IF NOT EXISTS record_changes (scope TEXT NOT NULL, seq INTEGER NOT NULL, source_generation TEXT NOT NULL DEFAULT '', record_json TEXT NOT NULL, PRIMARY KEY(scope,seq))");
        db.execSQL("CREATE INDEX IF NOT EXISTS record_changes_scope_seq ON record_changes(scope,seq)");
        db.execSQL("CREATE INDEX IF NOT EXISTS record_changes_scope_generation_seq ON record_changes(scope,source_generation,seq)");
        db.execSQL("CREATE TABLE IF NOT EXISTS history_cursors (scope TEXT NOT NULL, thread_id TEXT NOT NULL, source_generation TEXT NOT NULL DEFAULT '', value TEXT, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,thread_id))");
        db.execSQL("CREATE TABLE IF NOT EXISTS turn_observations (scope TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, state TEXT NOT NULL, observed_at INTEGER NOT NULL, notified_at INTEGER NOT NULL DEFAULT 0, baseline INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,thread_id,turn_id))");
        // Read-only inbox: acknowledging transport does not claim the body is prepared.
        db.execSQL("CREATE TABLE IF NOT EXISTS sync_inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, epoch TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, received_at INTEGER NOT NULL, UNIQUE(scope,epoch,seq))");
        db.execSQL("CREATE INDEX IF NOT EXISTS sync_inbox_scope ON sync_inbox(scope,id)");
        db.execSQL("CREATE TABLE IF NOT EXISTS sync_preparations (scope TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL, desired TEXT NOT NULL DEFAULT '', priority INTEGER NOT NULL, baseline INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, requested_at INTEGER NOT NULL, PRIMARY KEY(scope,key))");
        db.execSQL("CREATE INDEX IF NOT EXISTS sync_preparations_due ON sync_preparations(scope,due_at,priority,requested_at)");
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
        if (oldVersion < 4) {
            for (String scope : new String[]{"ai", "zyy"}) {
                long sequence = localRecordCursorLocked(db, scope);
                saveNextSequenceLocked(db, scope, sequence + 1L);
                String generation = null;
                try (Cursor row = db.query("meta", new String[]{"value"}, "scope=? AND key=?",
                        new String[]{scope, META_GENERATION}, null, null, null)) {
                    if (row.moveToFirst()) generation = row.getString(0);
                }
                if (generation == null || generation.isEmpty()) generation = readCursorLocked(db, scope).catalogGeneration;
                long floor = sequence + 1L;
                try (Cursor first = db.rawQuery("SELECT MIN(seq) FROM (SELECT seq FROM record_changes WHERE scope=? AND source_generation=? UNION ALL SELECT change_seq AS seq FROM records WHERE scope=? AND source_generation=?) WHERE seq>0",
                        new String[]{scope, generation, scope, generation})) {
                    if (first.moveToFirst() && !first.isNull(0)) floor = first.getLong(0);
                }
                putMetaLocked(db, scope, META_GENERATION_FLOOR, Long.toString(floor));
                db.delete("record_changes", "scope=? AND source_generation<>?", new String[]{scope, generation});
                pruneRecordChangesLocked(db, scope, measureRecordChangesLocked(db, scope));
            }
        }
        if (oldVersion < 5) {
            db.execSQL("INSERT OR IGNORE INTO saved_records SELECT *,? FROM records WHERE kind IN ('history','turn','item')",new Object[]{System.currentTimeMillis()});
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
        if (!DshConfig.isScope(scope)) return;
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

    /** Persist the accepted frame and receive cursor in one commit, before ACK. */
    public synchronized boolean receiveEvent(String scope, String epoch, long seq, JSONObject payload) throws JSONException {
        if (!DshConfig.isScope(scope) || !validText(epoch, MAX_SOURCE_GENERATION_LENGTH, false)
                || seq < 0L || seq > MAX_SAFE_INTEGER || payload == null
                || utf8Bytes(payload.toString()) > inboxLimit(payload)) throw new JSONException("invalid sync envelope");
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            CursorState cursor = readCursorLocked(db, scope);
            if (epoch.equals(cursor.epoch) && seq <= cursor.seq) {
                db.setTransactionSuccessful();
                return false;
            }
            try (Cursor count = db.rawQuery("SELECT COUNT(*) FROM sync_inbox WHERE scope=?", new String[]{scope})) {
                if (count.moveToFirst() && count.getLong(0) >= 2048L) throw new JSONException("sync inbox full");
            }
            ContentValues row = new ContentValues();
            row.put("scope", scope); row.put("epoch", epoch); row.put("seq", seq);
            row.put("payload", payload.toString()); row.put("received_at", System.currentTimeMillis());
            db.insertOrThrow("sync_inbox", null, row);
            saveEventCursor(scope, epoch, seq);
            db.setTransactionSuccessful();
            return true;
        } finally { db.endTransaction(); }
    }

    @Nullable
    public synchronized InboxEntry nextEvent(String scope) throws JSONException {
        try (Cursor row = getReadableDatabase().query("sync_inbox", new String[]{"id","epoch","seq","payload"},
                "scope=?", new String[]{scope}, null, null, "id ASC", "1")) {
            return row.moveToFirst() ? new InboxEntry(row.getLong(0), row.getString(1), row.getLong(2), new JSONObject(row.getString(3))) : null;
        }
    }

    public synchronized void completeEvent(String scope, long id) {
        getWritableDatabase().delete("sync_inbox", "scope=? AND id=?", new String[]{scope, Long.toString(id)});
    }

    private static int inboxLimit(JSONObject payload) throws JSONException {
        JSONObject event=payload.optJSONObject("event");if(event==null)return MAX_METADATA_RECORD_BYTES;
        String type=event.optString("type");if(!java.util.Arrays.asList("item","turn","delta","snapshot").contains(type))return MAX_METADATA_RECORD_BYTES;
        if(!isUuid(event.optString("threadId")))throw new JSONException("invalid body event thread");
        Object body="item".equals(type)?event.opt("item"):"turn".equals(type)?event.opt("turn"):"delta".equals(type)?event.opt("delta"):event.opt("snapshot");
        if(body==null||body==JSONObject.NULL||"delta".equals(type)&&!(body instanceof String)||!"delta".equals(type)&&!(body instanceof JSONObject))throw new JSONException("invalid body event");
        if(!"snapshot".equals(type)&&utf8Bytes(body.toString())>MAX_RECORD_BYTES)throw new JSONException("body event too large");
        if("snapshot".equals(type)){
            JSONObject snapshot=(JSONObject)body;JSONArray turns=snapshot.optJSONArray("turns");if(turns==null)throw new JSONException("snapshot turns missing");
            for(int i=0;i<turns.length();i++)if(!(turns.opt(i)instanceof JSONObject)||utf8Bytes(turns.opt(i).toString())>MAX_RECORD_BYTES)throw new JSONException("snapshot body too large");
            JSONObject head=snapshot.optJSONObject("thread");if(head!=null&&utf8Bytes(head.toString())>MAX_METADATA_RECORD_BYTES)throw new JSONException("snapshot metadata too large");
        }
        return MAX_BODY_ENVELOPE_BYTES;
    }
    public synchronized boolean hasPendingEvents(String scope) {
        try(Cursor rows=getReadableDatabase().rawQuery("SELECT 1 FROM sync_inbox WHERE scope=? LIMIT 1",new String[]{scope})){return rows.moveToFirst();}
    }

    /** Apply text and consume its inbox row atomically; replay cannot append twice. */
    public synchronized void commitStreamEvent(String scope, InboxEntry entry, JSONObject event) throws JSONException {
        String thread=event.optString("threadId");
        if(!isUuid(thread)){completeEvent(scope,entry.id);return;}
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {
            String key="stream:"+thread;
            JSONObject previous=parseObject(getMeta(scope,key));
            observeHistoryBodyEvent(scope,event);
            JSONObject next=StreamProjection.apply(previous,scope,thread,entry.epoch,entry.seq,event);
            next.put("sourceGeneration",sourceGeneration(scope));
            JSONObject terminal=event.optJSONObject("turn");
            if("turn".equals(event.optString("type"))&&terminal!=null&&"completed".equals(terminal.optString("status"))&&isUuid(terminal.optString("id")))
                requestPreparation(scope,"completion",thread,terminal.optString("id"),0,false,entry.epoch+":"+entry.seq);
            String type=event.optString("type"),target=event.optString("turnId");
            // Consuming the final item and reopening its former empty read are
            // one commit, so a process death cannot lose that recovery edge.
            if(("item".equals(type)||"delta".equals(type))&&isUuid(target))
                reopenEmptyCompletionReads(scope,thread,target,entry.epoch+":"+entry.seq);
            else if("snapshot".equals(type))reopenEmptyCompletionReads(scope,thread,null,entry.epoch+":"+entry.seq);
            if(next.optBoolean("gap"))requestPreparation(scope,"history",thread,"",0,false,entry.epoch+":stream-gap");
            if(utf8Bytes(next.toString())<=MAX_BODY_ENVELOPE_BYTES)putMetaLocked(db,scope,key,next.toString());
            else {db.delete("meta","scope=? AND key=?",new String[]{scope,key});requestPreparation(scope,"history",thread,"",0,false,entry.epoch+":"+entry.seq);}
            putMetaLocked(db,scope,"stream-cursor",Long.toString(entry.seq));
            db.execSQL("DELETE FROM meta WHERE scope=? AND key LIKE 'stream:%' AND key NOT IN (SELECT key FROM meta WHERE scope=? AND key LIKE 'stream:%' ORDER BY rowid DESC LIMIT 32)",new Object[]{scope,scope});
            completeEvent(scope,entry.id);db.setTransactionSuccessful();
        } finally {db.endTransaction();}
    }
    public synchronized JSONObject readStream(String scope,String thread) throws JSONException {
        JSONObject value=isUuid(thread)?parseObject(getMeta(scope,"stream:"+thread)):null;
        if(value==null||!eventCursor(scope).epoch.equals(value.optString("epoch")))return new JSONObject().put("scope",scope).put("threadId",thread).put("available",false);
        value.put("available",true);return value;
    }
    public synchronized void resetStreams(String scope) {
        getWritableDatabase().delete("meta","scope=? AND key LIKE 'stream:%'",new String[]{scope});
    }

    /** Native runtime status is independent of history/catalog preparation. */
    public synchronized void commitRuntimeStatus(String scope, InboxEntry entry, JSONObject event) throws JSONException {
        String thread = event.optString("threadId");
        JSONObject status = event.optJSONObject("status");
        if (!isUuid(thread) || status == null || status.optString("type").isEmpty()) {
            completeEvent(scope, entry.id); return;
        }
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            String key = "thread-runtime:" + thread;
            JSONObject old = parseObject(getMeta(scope, key));
            if (old == null || !entry.epoch.equals(old.optString("epoch")) || entry.seq > old.optLong("seq"))
                putMetaLocked(db, scope, key, new JSONObject().put("epoch", entry.epoch)
                        .put("seq", entry.seq).put("status", status).toString());
            completeEvent(scope, entry.id); db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }

    /** A foreground Native catalog read also repairs a missed status event. */
    public synchronized void reconcileCatalogRuntime(String scope, JSONObject record, String epoch, long beforeSeq) throws JSONException {
        if (!"catalog".equals(record.optString("kind")) || record.optBoolean("deleted")) return;
        String thread = record.optString("threadId"), key = "thread-runtime:" + thread;
        JSONObject old = parseObject(getMeta(scope, key));
        if (old == null || !epoch.equals(eventCursor(scope).epoch)
                || epoch.equals(old.optString("epoch")) && old.optLong("seq") > beforeSeq) return;
        JSONObject payload = record.optJSONObject("payload"), head = payload == null ? null : payload.optJSONObject("nativeThread");
        JSONObject status = head == null ? null : head.optJSONObject("status");
        if (status != null && head.optBoolean("statusVerified",true)) putMetaLocked(getWritableDatabase(), scope, key,
                new JSONObject().put("epoch", epoch).put("seq", beforeSeq).put("status", status).toString());
    }

    /** Upsert one read-only preparation. A newer desired version survives an older job finishing. */
    public synchronized Preparation requestPreparation(String scope, String kind, String threadId, String turnId,
                                                       int priority, boolean baseline, @Nullable String desired) {
        if("archive".equals(kind)||"artifacts".equals(kind))priority=4;
        if (!DshConfig.isScope(scope) || !isUuid(threadId)
                || !("history".equals(kind) || "archive".equals(kind) || "completion".equals(kind) || "artifacts".equals(kind))
                || (!("history".equals(kind)||"archive".equals(kind)) && !isUuid(turnId))) throw new IllegalArgumentException("invalid preparation");
        String key = kind + ":" + threadId + ":" + (turnId == null ? "" : turnId);
        String target = safe(desired, 512);
        if ("history".equals(kind) && historyPreparationReady(scope,threadId,target)) {
            getWritableDatabase().delete("sync_preparations","scope=? AND key=? AND desired=?",new String[]{scope,key,target});
            return new Preparation(key,kind,threadId,"",0L,target,priority,baseline,Long.MAX_VALUE,0,System.currentTimeMillis());
        }
        SQLiteDatabase db = getWritableDatabase();
        ensureFocusPriorities(db);
        db.beginTransaction();
        try {
            Preparation old = preparationLocked(db, scope, key);
            boolean changed = old == null || !target.isEmpty() && !target.equals(old.desired);
            ContentValues row = new ContentValues();
            row.put("scope",scope); row.put("key",key); row.put("kind",kind); row.put("thread_id",threadId);
            row.put("turn_id",turnId == null ? "" : turnId);
            row.put("version",old == null ? 1L : changed ? old.version + 1L : old.version);
            row.put("desired", target.isEmpty() && old != null ? old.desired : target);
            Integer unfocused = null;
            try(Cursor focus=db.rawQuery("SELECT priority FROM sync_preparation_focus WHERE scope=? AND key=?",new String[]{scope,key})) {if(focus.moveToFirst())unfocused=focus.getInt(0);}
            int basePriority=("archive".equals(kind)||"artifacts".equals(kind))?4:old==null?priority:Math.min(priority,unfocused==null?old.priority:unfocused);
            if(("archive".equals(kind)||"artifacts".equals(kind))&&unfocused!=null){db.delete("sync_preparation_focus","scope=? AND key=?",new String[]{scope,key});unfocused=null;}
            row.put("priority",unfocused!=null&&basePriority>0?0:basePriority);
            if(unfocused!=null){if(basePriority==0)db.delete("sync_preparation_focus","scope=? AND key=?",new String[]{scope,key});else db.execSQL("UPDATE sync_preparation_focus SET priority=? WHERE scope=? AND key=?",new Object[]{basePriority,scope,key});}
            row.put("baseline", (old == null ? baseline : old.baseline && baseline) ? 1 : 0);
            row.put("due_at", changed ? 0L : old.dueAt);
            row.put("attempts", changed ? 0 : old.attempts);
            row.put("requested_at", old == null ? System.currentTimeMillis() : old.requestedAt);
            db.insertWithOnConflict("sync_preparations",null,row,SQLiteDatabase.CONFLICT_REPLACE);
            Preparation result = preparationLocked(db,scope,key);
            db.setTransactionSuccessful();
            return result;
        } finally { db.endTransaction(); }
    }

    public synchronized List<Preparation> duePreparations(String scope, long now, int limit) {
        List<Preparation> result = new ArrayList<>();
        try (Cursor rows = getReadableDatabase().query("sync_preparations", null,
                "scope=? AND due_at<=?",new String[]{scope,Long.toString(now)},null,null,
                "priority ASC,requested_at ASC,key ASC",Integer.toString(Math.max(1,Math.min(limit,128))))) {
            while(rows.moveToNext()) result.add(preparationRow(rows));
        }
        return result;
    }

    public synchronized void finishPreparation(String scope, Preparation job) {
        getWritableDatabase().delete("sync_preparations", "scope=? AND key=? AND version=?",
                new String[]{scope,job.key,Long.toString(job.version)});
    }

    private static void ensureFocusPriorities(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS sync_preparation_focus (scope TEXT NOT NULL,key TEXT NOT NULL,priority INTEGER NOT NULL,PRIMARY KEY(scope,key))");
    }

    /** Focus is a temporary read priority, not permanent execution state. */
    public synchronized void clearPreparationFocus(String scope) {
        if(!DshConfig.isScope(scope))return;SQLiteDatabase db=getWritableDatabase();ensureFocusPriorities(db);db.beginTransaction();try{
            db.execSQL("UPDATE sync_preparations SET priority=(SELECT priority FROM sync_preparation_focus WHERE scope=sync_preparations.scope AND key=sync_preparations.key) WHERE scope=? AND priority=0 AND EXISTS(SELECT 1 FROM sync_preparation_focus WHERE scope=sync_preparations.scope AND key=sync_preparations.key)",new Object[]{scope});
            db.execSQL("UPDATE sync_preparations SET priority=4 WHERE scope=? AND kind IN ('archive','artifacts')",new Object[]{scope});
            db.delete("sync_preparation_focus","scope=?",new String[]{scope});db.setTransactionSuccessful();
        }finally{db.endTransaction();}
    }

    public synchronized void promotePreparationFocus(String scope,String thread,boolean immediate) {
        if(!DshConfig.isScope(scope)||!isUuid(thread)||isUnstartedHistory(scope,thread))return;SQLiteDatabase db=getWritableDatabase();ensureFocusPriorities(db);db.beginTransaction();try{
            db.execSQL("INSERT OR REPLACE INTO sync_preparation_focus SELECT scope,key,priority FROM sync_preparations WHERE scope=? AND thread_id=? AND kind='history' AND priority>0",new Object[]{scope,thread});
            db.execSQL("UPDATE sync_preparations SET priority=0"+(immediate?",due_at=0":"")+" WHERE scope=? AND thread_id=? AND kind='history' AND priority>0",new Object[]{scope,thread});db.setTransactionSuccessful();
        }finally{db.endTransaction();}
    }

    /** Native's unchanged pre-user metadata is not a history body or a 503 proof. */
    public synchronized boolean isUnstartedHistory(String scope,String thread) {
        if(!DshConfig.isScope(scope)||!isUuid(thread))return false;String source=sourceGeneration(scope);if(source.isEmpty()||"uninitialized".equals(source))return false;
        JSONObject runtime=parseObject(getMeta(scope,"thread-runtime:"+thread)),rs=runtime==null?null:runtime.optJSONObject("status");if(rs!=null&&!quiescentStatus(rs))return false;
        JSONObject catalog=catalogRecord(scope,thread),head=null;
        if(catalog!=null&&!catalog.optBoolean("deleted")){
            if(!source.equals(catalog.optString("sourceGeneration")))return false;
            JSONObject payload=catalog.optJSONObject("payload");head=payload==null?null:payload.optJSONObject("nativeThread");
            if(!unstartedHead(head,thread))return false;
        }else{
            for(String table:new String[]{"records","saved_records"}){
                try(Cursor rows=getReadableDatabase().query(table,new String[]{"payload"},"scope=? AND thread_id=? AND source_generation=? AND kind='history' AND deleted=0",new String[]{scope,thread,source},null,null,table.equals("records")?"revision DESC":"saved_at DESC")){
                    while(rows.moveToNext()){JSONObject payload=parseObject(rows.getString(0));if(payload==null||!"thread/read".equals(payload.optString("method")))continue;JSONObject result=payload.optJSONObject("result");head=result==null?null:result.optJSONObject("thread");break;}
                }if(head!=null)break;
            }if(!unstartedHead(head,thread))return false;
        }
        try(Cursor turns=getReadableDatabase().rawQuery("SELECT 1 FROM turn_observations WHERE scope=? AND thread_id=? LIMIT 1",new String[]{scope,thread})){if(turns.moveToFirst())return false;}
        try(Cursor processes=getReadableDatabase().rawQuery("SELECT 1 FROM meta WHERE scope=? AND key LIKE ? LIMIT 1",new String[]{scope,"visible-process-v1:"+thread+":%"})){if(processes.moveToFirst())return false;}
        JSONObject stream=parseObject(getMeta(scope,"stream:"+thread));if(stream!=null&&stream.optBoolean("gap")||hasHistoryContent(stream))return false;
        for(String table:new String[]{"records","saved_records"}){
            try(Cursor normalized=getReadableDatabase().rawQuery("SELECT 1 FROM "+table+" WHERE scope=? AND thread_id=? AND kind IN ('turn','item') AND deleted=0 LIMIT 1",new String[]{scope,thread})){if(normalized.moveToFirst())return false;}
            try(Cursor rows=getReadableDatabase().query(table,new String[]{"payload"},"scope=? AND thread_id=? AND kind='history' AND deleted=0",new String[]{scope,thread},null,null,null)){
                while(rows.moveToNext()){JSONObject payload=parseObject(rows.getString(0));if(payload==null)continue;JSONObject result=payload.optJSONObject("result");if(hasHistoryContent(result))return false;JSONObject newer=result==null?null:result.optJSONObject("thread");if(newer!=null&&(!unstartedHead(newer,thread)||newer.optLong("updatedAt")>head.optLong("updatedAt")))return false;}
            }
        }
        return true;
    }

    private static boolean unstartedHead(@Nullable JSONObject head,String thread) {
        if(head==null||!thread.equals(head.optString("id"))||!head.has("ephemeral")||head.optBoolean("ephemeral",true)||!head.has("path")||!(head.opt("preview") instanceof String)||!head.optString("preview").trim().isEmpty())return false;
        if(!(head.opt("createdAt") instanceof Number)||!(head.opt("updatedAt") instanceof Number)||head.optLong("createdAt")<=0||head.optLong("createdAt")!=head.optLong("updatedAt"))return false;
        JSONObject status=head.optJSONObject("status");if(status==null||!quiescentStatus(status))return false;
        JSONArray turns=head.optJSONArray("turns");return turns!=null&&turns.length()==0;
    }

    private static boolean quiescentStatus(JSONObject status) {
        if(!("idle".equals(status.optString("type"))||"notLoaded".equals(status.optString("type"))))return false;
        if(status.has("activeFlags")){JSONArray flags=status.optJSONArray("activeFlags");if(flags==null||flags.length()!=0)return false;}return true;
    }

    private static boolean hasHistoryContent(@Nullable JSONObject result) {
        if(result==null)return false;for(String key:new String[]{"data","items","turns"}){JSONArray values=result.optJSONArray(key);JSONObject map=result.optJSONObject(key);if(values!=null&&values.length()>0||map!=null&&map.length()>0)return true;}
        JSONObject thread=result.optJSONObject("thread");return thread!=null&&((thread.optJSONArray("turns")!=null&&thread.optJSONArray("turns").length()>0)||!thread.optString("preview").trim().isEmpty());
    }

    public synchronized void retireUnstartedPreparations(String scope,String thread) {
        if(!isUnstartedHistory(scope,thread))return;ensureFocusPriorities(getWritableDatabase());
        getWritableDatabase().delete("sync_preparations","scope=? AND thread_id=? AND (kind='archive' OR(kind='history' AND(priority>=2 OR(priority=0 AND(desired='' OR EXISTS(SELECT 1 FROM sync_preparation_focus WHERE scope=sync_preparations.scope AND key=sync_preparations.key))))))",new String[]{scope,thread});
    }

    public synchronized boolean optionalHistoryPreparation(String scope,Preparation job) {
        if("archive".equals(job.kind))return true;if(!"history".equals(job.kind))return false;
        if(job.priority>=2||job.priority==0&&job.desired.isEmpty())return true;ensureFocusPriorities(getWritableDatabase());
        try(Cursor owned=getReadableDatabase().rawQuery("SELECT 1 FROM sync_preparation_focus WHERE scope=? AND key=? LIMIT 1",new String[]{scope,job.key})){return owned.moveToFirst();}
    }

    /** A view timestamp is only a freshness hint, never a body revision. */
    public synchronized String historyPreparationVersion(String scope,String thread) {
        if(!DshConfig.isScope(scope)||!isUuid(thread))return "";
        String known=archiveBodyVersion(scope,thread);if(!known.isEmpty())return known;
        JSONObject catalog=catalogRecord(scope,thread),payload=catalog==null?null:catalog.optJSONObject("payload"),head=payload==null?null:payload.optJSONObject("nativeThread");
        if(catalog==null||catalog.optBoolean("deleted"))return "";
        return "verify-body-v1:"+catalog.optString("sourceGeneration")+":"+catalog.optString("generation")+":"+(head==null?0:head.optLong("updatedAt"))+":"+bodyChangeCounter(scope,thread);
    }

    private long bodyChangeCounter(String scope,String thread){JSONObject value=parseObject(getMeta(scope,"history-body-change-v1:"+thread));return value==null?0:value.optLong("counter");}
    private static JSONObject stableTurn(JSONObject turn)throws JSONException{
        if(turn==null||!isUuid(turn.optString("id"))||turn.optJSONArray("items")==null)return null;
        JSONObject value=new JSONObject();for(String key:new String[]{"id","status","startedAt","completedAt","durationMs","error"})if(turn.has(key))value.put(key,turn.get(key));
        JSONArray items=new JSONArray();for(int i=0;i<turn.getJSONArray("items").length();i++){JSONObject item=turn.getJSONArray("items").optJSONObject(i);if(item==null)return null;if("userMessage".equals(item.optString("type"))||"agentMessage".equals(item.optString("type"))&&"final_answer".equals(item.optString("phase")))items.put(item);}
        if(items.length()==0)return null;return value.put("items",items);
    }
    private static JSONObject displayAnchors(JSONObject turn)throws JSONException{
        JSONObject value=new JSONObject();for(String k:new String[]{"id","status","startedAt","completedAt"})if(turn.has(k))value.put(k,turn.get(k));JSONArray items=new JSONArray(),raw=turn.optJSONArray("items");
        if(raw!=null)for(int i=0;i<raw.length();i++){JSONObject item=raw.optJSONObject(i);if(item==null)continue;String type=item.optString("type");if(!"userMessage".equals(type)&&!("agentMessage".equals(type)&&"final_answer".equals(item.optString("phase"))))continue;JSONObject part=new JSONObject().put("id",item.optString("id")).put("type",type);
            if("agentMessage".equals(type))part.put("text",item.optString("text")).put("phase",item.optString("phase"));else {JSONArray content=item.optJSONArray("content"),attachments=new JSONArray();StringBuilder text=new StringBuilder();if(content!=null){for(int j=0;j<content.length();j++){JSONObject c=content.optJSONObject(j);if(c==null)continue;if("text".equals(c.optString("type"))){if(text.length()>0)text.append('\n');text.append(c.optString("text"));}else attachments.put(new JSONObject().put("type",c.optString("type")));}}else{text.append(item.optString("text"));attachments=item.optJSONArray("attachments");}part.put("text",text.toString()).put("attachments",attachments==null?new JSONArray():attachments);}items.put(part);}
        return value.put("items",items);
    }
    private JSONObject bodyHead(String scope,String thread,String source,String generation)throws JSONException{
        try(Cursor rows=getReadableDatabase().query("records",READ_COLUMNS,"scope=? AND thread_id=? AND source_generation=? AND generation=? AND kind='history' AND deleted=0 AND key LIKE ?",new String[]{scope,thread,source,generation,"read:[\"thread/read\",%"},null,null,"revision DESC")){
            while(rows.moveToNext()){JSONObject record=rowToRecord(rows),p=record.optJSONObject("payload"),params=p==null?null:p.optJSONObject("params"),r=p==null?null:p.optJSONObject("result"),head=r==null?null:r.optJSONObject("thread");if(params!=null&&!params.optBoolean("includeTurns")&&head!=null&&thread.equals(head.optString("id")))return record;}
        }return null;
    }
    private void rememberBodySummary(JSONObject record)throws JSONException{rememberBodySummary(record,false,0);}
    public synchronized long historyBodyFence(String scope,String thread){return bodyChangeCounter(scope,thread);}
    public synchronized void noteVerifiedBodySummaryRead(JSONObject record,long fence)throws JSONException{if(fence!=bodyChangeCounter(record.optString("scope"),record.optString("threadId")))return;String source=record.optString("source");if(!source.isEmpty()&&!"native".equals(source))return;rememberBodySummary(record,true,fence);}
    private void rememberBodySummary(JSONObject record,boolean fresh,long fence)throws JSONException{
        JSONObject p=record.optJSONObject("payload"),params=p==null?null:p.optJSONObject("params"),result=p==null?null:p.optJSONObject("result");JSONArray data=result==null?null:result.optJSONArray("data");
        if(record.optBoolean("deleted")||p==null||!"thread/turns/list".equals(p.optString("method"))||params==null||params.has("cursor")&&!params.isNull("cursor")||!"summary".equals(params.optString("itemsView"))||!"desc".equals(params.optString("sortDirection"))||data==null||data.length()==0)return;
        String scope=record.optString("scope"),thread=record.optString("threadId"),source=record.optString("sourceGeneration"),generation=record.optString("generation");JSONObject stable=stableTurn(data.optJSONObject(0));if(stable==null||!thread.equals(params.optString("threadId")))return;
        JSONObject headRecord=bodyHead(scope,thread,source,generation),headPayload=headRecord==null?null:headRecord.optJSONObject("payload"),headResult=headPayload==null?null:headPayload.optJSONObject("result"),head=headResult==null?null:headResult.optJSONObject("thread");
        if(head==null||!(head.opt("updatedAt") instanceof Number)||head.optLong("updatedAt")<=0||!fresh&&headRecord.optLong("revision")>record.optLong("revision"))return;
        JSONArray identities=new JSONArray(),items=stable.getJSONArray("items");for(int i=0;i<items.length();i++){JSONObject item=items.getJSONObject(i);if(item.optString("id").isEmpty())return;identities.put(new JSONObject().put("id",item.getString("id")).put("digest",readPayloadDigest(item)));}
        JSONObject value=new JSONObject().put("sourceGeneration",source).put("generation",generation).put("key",record.optString("key")).put("revision",record.optLong("revision")).put("headUpdatedAt",head.optLong("updatedAt")).put("bodyCounter",fresh?fence:bodyChangeCounter(scope,thread)==0?0:-1).put("turnId",stable.optString("id")).put("status",stable.optString("status")).put("digest",readPayloadDigest(stable)).put("displayDigest",readPayloadDigest(displayAnchors(stable))).put("items",identities);
        JSONObject old=parseObject(getMeta(scope,"history-body-summary-v1:"+thread));if(old!=null&&source.equals(old.optString("sourceGeneration"))&&generation.equals(old.optString("generation"))&&old.optLong("revision")>value.optLong("revision")){if(!fresh||!old.optString("digest").equals(value.optString("digest")))return;value.put("revision",old.optLong("revision")).put("key",old.optString("key"));}
        putMeta(scope,"history-body-summary-v1:"+thread,value.toString());
    }
    private JSONObject bodyCatalogue(String scope,String thread){
        JSONObject catalog=catalogRecord(scope,thread);if(catalog!=null)return catalog;
        try(Cursor rows=getReadableDatabase().query("records",READ_COLUMNS,"scope=? AND thread_id=? AND source_generation=? AND kind='history' AND deleted=0 AND key LIKE ?",new String[]{scope,thread,sourceGeneration(scope),"read:[\"thread/read\",%"},null,null,"revision DESC","1")){
            if(rows.moveToFirst()){JSONObject record=rowToRecord(rows),p=record.optJSONObject("payload"),r=p==null?null:p.optJSONObject("result"),head=r==null?null:r.optJSONObject("thread");if(head!=null&&thread.equals(head.optString("id")))return new JSONObject(record.toString()).put("payload",new JSONObject().put("nativeThread",head));}
        }catch(JSONException ignored){}return null;
    }
    private JSONObject bodySummary(String scope,String thread){
        JSONObject catalog=bodyCatalogue(scope,thread);if(catalog==null||catalog.optBoolean("deleted"))return null;String source=catalog.optString("sourceGeneration"),generation=catalog.optString("generation");if(!sourceGeneration(scope).equals(source))return null;
        JSONObject summary=parseObject(getMeta(scope,"history-body-summary-v1:"+thread));
        if(summary==null||!source.equals(summary.optString("sourceGeneration"))||!generation.equals(summary.optString("generation")))try{
            try(Cursor rows=getReadableDatabase().query("records",READ_COLUMNS,"scope=? AND thread_id=? AND source_generation=? AND generation=? AND kind='history' AND deleted=0 AND key LIKE ?",new String[]{scope,thread,source,generation,"read:[\"thread/turns/list\",%"},null,null,"revision DESC")){while(rows.moveToNext()){rememberBodySummary(rowToRecord(rows));summary=parseObject(getMeta(scope,"history-body-summary-v1:"+thread));if(summary!=null&&source.equals(summary.optString("sourceGeneration"))&&generation.equals(summary.optString("generation")))break;}}
        }catch(JSONException|RuntimeException ignored){return null;}
        JSONObject p=catalog.optJSONObject("payload"),head=p==null?null:p.optJSONObject("nativeThread"),status=head==null?null:head.optJSONObject("status");
        if(summary==null||!source.equals(summary.optString("sourceGeneration"))||!generation.equals(summary.optString("generation"))||head==null||(status==null||!quiescentStatus(status))||summary.optLong("headUpdatedAt")<head.optLong("updatedAt")||summary.optLong("bodyCounter")!=bodyChangeCounter(scope,thread))return null;
        if(!java.util.Arrays.asList("completed","interrupted","failed").contains(summary.optString("status")))return null;return summary;
    }
    public synchronized String archiveBodyVersion(String scope,String thread){
        JSONObject value=bodySummary(scope,thread);return value==null?"":"body-v1:"+value.optString("sourceGeneration")+":"+value.optString("generation")+":"+value.optString("digest")+":"+value.optLong("bodyCounter");
    }
    /** Complete legacy archives need real saved EOF pages, not a timestamp guess. */
    public synchronized boolean archivePrepared(String scope,String thread,String version)throws JSONException{
        JSONObject summary=bodySummary(scope,thread),progress=archiveProgress(scope,thread);if(summary==null||version.isEmpty()||!version.equals(archiveBodyVersion(scope,thread))||!progress.optBoolean("complete")||!summary.optString("sourceGeneration").equals(progress.optString("sourceGeneration"))||!summary.optString("generation").equals(progress.optString("generation")))return false;
        if(version.equals(progress.optString("bodyVersion")))return true;
        if(progress.has("bodyVersion")||bodyChangeCounter(scope,thread)!=0||!archiveCoversSummary(scope,thread,summary))return false;
        progress.put("bodyVersion",version).put("desired",version);saveArchiveProgress(scope,thread,progress);return true;
    }
    public synchronized boolean archiveProgressMatchesBody(String scope,String thread,JSONObject progress,String version)throws JSONException{
        JSONObject summary=bodySummary(scope,thread);if(summary==null||!version.equals(archiveBodyVersion(scope,thread))||!summary.optString("sourceGeneration").equals(progress.optString("sourceGeneration"))||!summary.optString("generation").equals(progress.optString("generation")))return false;
        if(version.equals(progress.optString("bodyVersion")))return true;JSONArray turns=progress.optJSONArray("turns");JSONObject stable=turns==null?null:stableTurn(turns.optJSONObject(0));return !progress.optBoolean("complete")&&bodyChangeCounter(scope,thread)==0&&stable!=null&&summary.optString("digest").equals(readPayloadDigest(stable));
    }
    public synchronized JSONObject legacyArchivePage(String scope,String thread,String turn,String cursor,String source,String generation)throws JSONException{
        JSONObject params=new JSONObject().put("threadId",thread).put("turnId",turn).put("limit",48).put("sortDirection","desc");if(cursor!=null&&!cursor.isEmpty())params.put("cursor",cursor);
        JSONObject sorted=new JSONObject();List<String> keys=new ArrayList<>();params.keys().forEachRemaining(keys::add);java.util.Collections.sort(keys);for(String k:keys)sorted.put(k,params.get(k));
        String key="read:"+new JSONArray().put("thread/items/list").put(sorted).toString().replace("\\/","/");JSONObject saved=readSavedRecord(scope,key,source,generation);JSONObject record=saved.optJSONObject("record"),p=record==null?null:record.optJSONObject("payload"),r=p==null?null:p.optJSONObject("result");return record!=null&&!record.optBoolean("deleted")&&r!=null&&r.optJSONArray("data")!=null&&r.has("nextCursor")?record:null;
    }
    private boolean archiveCoversSummary(String scope,String thread,JSONObject summary)throws JSONException{return archiveCoversSummary(scope,thread,summary,12)||archiveCoversSummary(scope,thread,summary,48);}
    private boolean archiveCoversSummary(String scope,String thread,JSONObject summary,int limit)throws JSONException{
        Map<String,JSONObject> pages=new HashMap<>();String source=summary.getString("sourceGeneration"),generation=summary.getString("generation"),turn=summary.getString("turnId");
        try(Cursor rows=getReadableDatabase().query("saved_records",READ_COLUMNS,"scope=? AND thread_id=? AND source_generation=? AND generation=? AND deleted=0 AND key LIKE ?",new String[]{scope,thread,source,generation,"read:[\"thread/items/list\",%"},null,null,"revision DESC")){
            while(rows.moveToNext()){JSONObject record=rowToRecord(rows),p=record.optJSONObject("payload"),params=p==null?null:p.optJSONObject("params");if(params==null||!turn.equals(params.optString("turnId"))||params.optInt("limit")!=limit||!"desc".equals(params.optString("sortDirection")))continue;String cursor=params.has("cursor")&&!params.isNull("cursor")?params.optString("cursor"):"";if(!pages.containsKey(cursor))pages.put(cursor,record);}
        }
        List<String> found=new ArrayList<>();Set<String> seen=new HashSet<>();String cursor="";JSONArray expected=summary.getJSONArray("items");Set<String> wanted=new HashSet<>();for(int i=0;i<expected.length();i++)wanted.add(expected.getJSONObject(i).getString("id"));boolean eof=false;
        for(int n=0;n<128;n++){JSONObject record=pages.get(cursor);if(record==null||!seen.add(cursor))return false;JSONObject result=record.getJSONObject("payload").optJSONObject("result");JSONArray data=result==null?null:result.optJSONArray("data");if(data==null||!result.has("nextCursor"))return false;List<String> current=new ArrayList<>();for(int i=data.length()-1;i>=0;i--){JSONObject raw=data.optJSONObject(i),item=raw==null?null:raw.optJSONObject("item");if(item==null)item=raw;if(item!=null&&wanted.contains(item.optString("id")))current.add(item.optString("id")+":"+readPayloadDigest(item));}found.addAll(0,current);if(result.isNull("nextCursor")){eof=true;break;}Object next=result.opt("nextCursor");if(!(next instanceof String)||((String)next).isEmpty())return false;cursor=(String)next;}
        if(!eof)return false;int index=0;for(String actual:found)if(index<expected.length()){JSONObject item=expected.getJSONObject(index);if(actual.equals(item.getString("id")+":"+item.getString("digest")))index++;}return index==expected.length();
    }
    /** Durable body fence ignores control frames and identical view snapshots. */
    public synchronized void observeHistoryBodyEvent(String scope,JSONObject event)throws JSONException{
        String thread=event.optString("threadId"),type=event.optString("type"),key=event.optString("cacheKey");if(!DshConfig.isScope(scope)||!isUuid(thread))return;
        if("nativeChanged".equals(type)&&!(key.startsWith("invalidate:")||key.startsWith("turn:")||key.startsWith("item:")))return;
        if(!java.util.Arrays.asList("snapshot","turn","item","delta","nativeChanged").contains(type))return;
        Object body="snapshot".equals(type)?event.optJSONObject("snapshot"):"turn".equals(type)?event.optJSONObject("turn"):"item".equals(type)?event.optJSONObject("item"):"delta".equals(type)?event.opt("delta"):key;
        if(body==null)return;
        if("snapshot".equals(type)){JSONObject snapshot=(JSONObject)body;JSONArray turns=snapshot.optJSONArray("turns");JSONObject summary=parseObject(getMeta(scope,"history-body-summary-v1:"+thread)),catalog=catalogRecord(scope,thread);if(summary!=null&&catalog!=null&&sourceGeneration(scope).equals(summary.optString("sourceGeneration"))&&catalog.optString("generation").equals(summary.optString("generation"))&&turns!=null&&turns.length()>0&&summary.optString("displayDigest").equals(readPayloadDigest(displayAnchors(turns.getJSONObject(turns.length()-1)))))return;body=turns;}
        String fingerprint=readPayloadDigest(new JSONObject().put("type",type).put("turnId",event.optString("turnId")).put("body",body).put("bodyReceipt","nativeChanged".equals(type)?event.optString("deliveryVersion"):""));JSONObject old=parseObject(getMeta(scope,"history-body-change-v1:"+thread));if(!"delta".equals(type)&&old!=null&&fingerprint.equals(old.optString("fingerprint")))return;
        putMeta(scope,"history-body-change-v1:"+thread,new JSONObject().put("counter",bodyChangeCounter(scope,thread)+1).put("fingerprint",fingerprint).toString());
    }

    public synchronized boolean historyPreparationReady(String scope,String thread,String version) {
        if(version==null||version.isEmpty())return false;
        JSONObject saved=parseObject(getMeta(scope,"history-prepared:"+thread));
        if(saved==null||!version.equals(saved.optString("version")))return false;
        try(Cursor row=getReadableDatabase().query("records",new String[]{"key"},"scope=? AND key=? AND kind='history' AND deleted=0",new String[]{scope,saved.optString("key")},null,null,null,"1")){return row.moveToFirst();}
    }

    public synchronized void markHistoryPrepared(String scope,String thread,String version,String key) throws JSONException {
        if(!version.isEmpty()&&version.equals(historyPreparationVersion(scope,thread)))
            putMeta(scope,"history-prepared:"+thread,new JSONObject().put("version",version).put("key",key).toString());
    }

    /** Observed display items are durable projections, never Native execution facts. */
    public synchronized void saveVisibleProcesses(String scope,JSONObject incoming) throws JSONException {
        String thread=incoming.optString("threadId"),turn=incoming.optString("turnId");
        if(!DshConfig.isScope(scope)||!scope.equals(incoming.optString("scope"))||!isUuid(thread)||!isUuid(turn)
                ||incoming.optInt("schemaVersion")!=1||incoming.optString("sourceGeneration").isEmpty()
                ||incoming.optString("generation").isEmpty()||incoming.optLong("savedAt")<=0||incoming.optJSONArray("items")==null||incoming.optJSONArray("order")==null
                ||utf8Bytes(incoming.toString())>MAX_VISIBLE_PROCESS_BYTES)throw new JSONException("invalid observed process projection");
        String key="visible-process-v1:"+thread+":"+turn;
        long invalidated=0L;try{invalidated=Long.parseLong(safe(getMeta(scope,"visible-process-invalid:"+thread),64));}catch(NumberFormatException ignored){}
        if(incoming.optLong("savedAt")<=invalidated)return;
        JSONObject prior=parseObject(getMeta(scope,key)),value=new JSONObject(incoming.toString());
        if(prior!=null&&prior.optString("sourceGeneration").equals(incoming.optString("sourceGeneration"))
                &&prior.optString("generation").equals(incoming.optString("generation"))
                &&prior.optLong("turnStartedAtMs")==incoming.optLong("turnStartedAtMs")&&prior.optLong("savedAt")>invalidated) {
            JSONObject newer=prior.optLong("savedAt")>incoming.optLong("savedAt")?prior:incoming,older=newer==prior?incoming:prior;
            value=new JSONObject(newer.toString());JSONArray items=value.getJSONArray("items"),order=value.getJSONArray("order");Set<String> seen=new HashSet<>(),ordered=new HashSet<>();
            for(int i=0;i<items.length();i++)seen.add(items.getJSONObject(i).optString("id"));for(int i=0;i<order.length();i++)ordered.add(order.optString(i));
            JSONArray previous=older.optJSONArray("items");for(int i=0;previous!=null&&i<previous.length();i++){JSONObject item=previous.getJSONObject(i);if(!item.optString("id").isEmpty()&&seen.add(item.optString("id")))items.put(item);}
            // Keep the older timeline's anchors; insert newly observed items
            // before their next retained neighbor, rather than appending a
            // previously visible tool after the final answer.
            JSONArray previousOrder=older.optJSONArray("order");List<String> mergedOrder=new ArrayList<>();
            if(previousOrder!=null)for(int i=0;i<previousOrder.length();i++){String id=previousOrder.optString(i);if(!mergedOrder.contains(id))mergedOrder.add(id);}
            for(int i=0;i<order.length();i++){String id=order.optString(i);if(mergedOrder.contains(id))continue;int at=mergedOrder.size();
                for(int j=i+1;j<order.length();j++){int anchor=mergedOrder.indexOf(order.optString(j));if(anchor>=0){at=anchor;break;}}
                mergedOrder.add(at,id);
            }
            value.put("order",new JSONArray(mergedOrder));
        }
        if(utf8Bytes(value.toString())>MAX_VISIBLE_PROCESS_BYTES)throw new JSONException("observed process projection exceeds budget");
        putMeta(scope,key,value.toString());
    }

    public synchronized JSONObject readVisibleProcesses(String scope,String thread,String turn) throws JSONException {
        if(!DshConfig.isScope(scope)||!isUuid(thread)||!isUuid(turn))throw new JSONException("invalid observed process target");
        JSONObject value=parseObject(getMeta(scope,"visible-process-v1:"+thread+":"+turn));
        return new JSONObject().put("scope",scope).put("threadId",thread).put("turnId",turn).put("value",value==null?JSONObject.NULL:value);
    }

    public synchronized void invalidateVisibleProcesses(String scope,String thread,long at) throws JSONException {
        if(!DshConfig.isScope(scope)||!isUuid(thread)||at<=0)throw new JSONException("invalid observed process invalidation");
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();try{
            long previous=0L;try{previous=Long.parseLong(safe(getMeta(scope,"visible-process-invalid:"+thread),64));}catch(NumberFormatException ignored){}
            if(at<=previous){db.setTransactionSuccessful();return;}
            putMetaLocked(db,scope,"visible-process-invalid:"+thread,Long.toString(at));
            db.delete("meta","scope=? AND key LIKE ?",new String[]{scope,"visible-process-v1:"+thread+":%"});
            db.setTransactionSuccessful();
        }finally{db.endTransaction();}
    }

    public synchronized void deferPreparation(String scope, Preparation job, long dueAt) {
        ContentValues value = new ContentValues(); value.put("due_at",dueAt); value.put("attempts",job.attempts+1);
        getWritableDatabase().update("sync_preparations",value,"scope=? AND key=? AND version=?",
                new String[]{scope,job.key,Long.toString(job.version)});
    }

    /** An unfinished bounded batch is not an exception or a download count. */
    public synchronized void continuePreparation(String scope,Preparation job,long dueAt) {
        ContentValues value=new ContentValues();value.put("due_at",dueAt);
        getWritableDatabase().update("sync_preparations",value,"scope=? AND key=? AND version=?",new String[]{scope,job.key,Long.toString(job.version)});
    }

    public synchronized JSONObject preparationStatus(String scope) {
        JSONObject result = new JSONObject();
        for(String table : new String[]{"sync_inbox","sync_preparations"}) {
            try(Cursor row=getReadableDatabase().rawQuery("SELECT COUNT(*) FROM "+table+" WHERE scope=?"+(table.equals("sync_preparations")?" AND kind!='archive'":""),new String[]{scope})) {
                if(row.moveToFirst()) result.put(table.equals("sync_inbox")?"pendingEvents":"pendingPreparations",row.getLong(0));
            } catch(JSONException ignored) {}
        }
        try(Cursor row=getReadableDatabase().rawQuery("SELECT COUNT(*) FROM sync_preparations WHERE scope=? AND kind='archive'",new String[]{scope})){
            if(row.moveToFirst())result.put("pendingArchives",row.getLong(0));
        }catch(JSONException ignored){}
        return result;
    }

    /** Only body/focus work gates quiet mode; optional old history/files do not. */
    public synchronized int criticalPreparations(String scope) {
        try (Cursor row = getReadableDatabase().rawQuery(
                "SELECT (EXISTS(SELECT 1 FROM sync_inbox WHERE scope=?)) + " +
                "(SELECT COUNT(*) FROM sync_preparations WHERE scope=? AND kind NOT IN ('artifacts','archive') AND priority<=1)",
                new String[]{scope, scope})) {
            return row.moveToFirst() ? row.getInt(0) : 0;
        }
    }

    @Nullable private static Preparation preparationLocked(SQLiteDatabase db,String scope,String key) {
        try(Cursor row=db.query("sync_preparations",null,"scope=? AND key=?",new String[]{scope,key},null,null,null)) {
            return row.moveToFirst()?preparationRow(row):null;
        }
    }
    private static Preparation preparationRow(Cursor row) {
        return new Preparation(row.getString(row.getColumnIndexOrThrow("key")),row.getString(row.getColumnIndexOrThrow("kind")),
                row.getString(row.getColumnIndexOrThrow("thread_id")),row.getString(row.getColumnIndexOrThrow("turn_id")),
                row.getLong(row.getColumnIndexOrThrow("version")),row.getString(row.getColumnIndexOrThrow("desired")),
                row.getInt(row.getColumnIndexOrThrow("priority")),row.getInt(row.getColumnIndexOrThrow("baseline"))!=0,
                row.getLong(row.getColumnIndexOrThrow("due_at")),row.getInt(row.getColumnIndexOrThrow("attempts")),
                row.getLong(row.getColumnIndexOrThrow("requested_at")));
    }
    public static final class InboxEntry {
        public final long id,seq; public final String epoch; public final JSONObject payload;
        InboxEntry(long id,String epoch,long seq,JSONObject payload){this.id=id;this.epoch=epoch;this.seq=seq;this.payload=payload;}
    }
    public static final class Preparation {
        public final String key,kind,threadId,turnId,desired; public final long version,dueAt,requestedAt;
        public final int priority,attempts; public final boolean baseline;
        Preparation(String key,String kind,String threadId,String turnId,long version,String desired,int priority,
                    boolean baseline,long dueAt,int attempts,long requestedAt) {
            this.key=key;this.kind=kind;this.threadId=threadId;this.turnId=turnId;this.version=version;this.desired=desired;
            this.priority=priority;this.baseline=baseline;this.dueAt=dueAt;this.attempts=attempts;this.requestedAt=requestedAt;
        }
    }

    public synchronized void saveCatalogCursor(String scope, String generation, long cursor) {
        if (!DshConfig.isScope(scope) || generation == null || generation.isEmpty()) return;
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

    /** Reset projections and old bodies while preserving the local sequence high-water mark. */
    public synchronized void resetGeneration(String scope, String generation) {
        if (!DshConfig.isScope(scope) || generation == null || generation.isEmpty()) return;
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
        long sequence = localRecordCursorLocked(db, scope);
        saveNextSequenceLocked(db, scope, sequence + 1L);
        db.delete("records", "scope=?", new String[]{scope});
        db.delete("record_changes", "scope=?", new String[]{scope});
        putMetaLocked(db, scope, META_CHANGE_BYTES, "0");
        putMetaLocked(db, scope, META_GENERATION_FLOOR, Long.toString(sequence + 1L));
        db.delete("meta","scope=? AND (key LIKE 'stream:%' OR key LIKE 'completion-empty:%')",new String[]{scope});
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
        if (!DshConfig.isScope(scope) || status == null) return;
        String raw = status.toString();
        if (utf8Bytes(raw) > MAX_METADATA_RECORD_BYTES) return;
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
    /**
     * Apply a server DTO and report the durable commit only after the SQLite
     * transaction has completed. The diagnostic payload contains identifiers
     * and counters only; it never includes the record key or payload body.
     */
    public synchronized void applyNativeRecord(JSONObject record) throws JSONException {
        applyNativeRecord(record, null);
    }

    /**
     * Apply a record while retaining the caller's bounded batch trace. The
     * trace is metadata-only and lets a history read connect its HTTP child
     * request to the SQLite commit without putting IDs in business payloads.
     */
    public synchronized void applyNativeRecord(JSONObject record, @Nullable String batchTraceId) throws JSONException {
        String scope = record == null ? "" : record.optString("scope", "");
        String traceId = NativeDiagnostics.isUuid(batchTraceId) ? batchTraceId : UUID.randomUUID().toString();
        if (DshConfig.isScope(scope)) diagnostic(scope, "attempt", "store_committed", traceId, record, null);
        try {
            applyNativeRecordLocked(record);
            if (DshConfig.isScope(scope)) diagnostic(scope, "committed", "store_committed", traceId, record, null);
        } catch (JSONException | RuntimeException failure) {
            if (DshConfig.isScope(scope)) diagnostic(scope, "failed", "store_failed", traceId, record, null);
            throw failure;
        }
    }

    /**
     * Apply a history/body response only if it belongs to the generation read
     * by the caller. Catalog writes are authoritative and may switch the
     * generation; read responses never are, so a late old-generation response
     * must be discarded without resetting the current projection.
     */
    public synchronized boolean applyReadRecord(JSONObject record, @Nullable String batchTraceId,
                                                 @Nullable String expectedGeneration) throws JSONException {
        validateRecord(record, true);
        String scope = record.optString("scope", "");
        String traceId = NativeDiagnostics.isUuid(batchTraceId) ? batchTraceId : UUID.randomUUID().toString();
        String expected = safe(expectedGeneration, MAX_SOURCE_GENERATION_LENGTH);
        String incoming = record.optString("sourceGeneration", "");
        String current = DshConfig.isScope(scope) ? sourceGeneration(scope) : "";
        boolean accepted = !expected.isEmpty() && !"uninitialized".equals(expected)
                && !current.isEmpty() && !"uninitialized".equals(current)
                && expected.equals(current) && incoming.equals(current);
        if (!accepted) {
            if (DshConfig.isScope(scope)) diagnostic(scope, "skipped", "scope_changed", traceId, record, null);
            return false;
        }
        diagnostic(scope, "attempt", "store_committed", traceId, record, null);
        try {
            applyNativeRecordLocked(record, false);
            diagnostic(scope, "committed", "store_committed", traceId, record, null);
            return true;
        } catch (JSONException | RuntimeException failure) {
            diagnostic(scope, "failed", "store_failed", traceId, record, null);
            throw failure;
        }
    }

    /** Verify the exact adopted DTOs behind a derived read receipt. No body is returned. */
    public synchronized boolean currentReadIdentities(List<JSONObject> identities) {
        if(identities==null||identities.isEmpty())return false;
        for(JSONObject identity:identities) {
            String scope=identity.optString("scope");
            if(!DshConfig.isScope(scope)||!sourceGeneration(scope).equals(identity.optString("sourceGeneration")))return false;
            try(Cursor row=getReadableDatabase().query("records",new String[]{"source_generation","generation","revision","deleted","payload"},
                    "scope=? AND key=?",new String[]{scope,identity.optString("key")},null,null,null)) {
                if(!row.moveToFirst()||row.getInt(3)!=0||!row.getString(0).equals(identity.optString("sourceGeneration"))
                        ||!row.getString(1).equals(identity.optString("generation"))||row.getLong(2)!=identity.optLong("revision"))return false;
                int version=identity.optInt("digestVersion",0);
                if(version!=0&&version!=2)return false;
                String digest=version==2?readPayloadDigest(new org.json.JSONTokener(row.getString(4)).nextValue())
                        :DeliverableCache.digest(row.getString(4));
                if(!digest.equals(identity.optString("payloadDigest")))return false;
            } catch(JSONException invalid) {return false;}
        }
        return true;
    }

    /** JSON objects are unordered; arrays and all field values remain exact. */
    static String readPayloadDigest(Object value) {
        return DeliverableCache.digest(canonicalReadJson(value));
    }
    private static String canonicalReadJson(Object value) {
        if(value instanceof JSONObject) {
            JSONObject object=(JSONObject)value;
            List<String> keys=new ArrayList<>();object.keys().forEachRemaining(keys::add);java.util.Collections.sort(keys);
            StringBuilder result=new StringBuilder("{");
            for(String key:keys){if(result.length()>1)result.append(',');result.append(JSONObject.quote(key)).append(':').append(canonicalReadJson(object.opt(key)));}
            return result.append('}').toString();
        }
        if(value instanceof JSONArray) {
            JSONArray array=(JSONArray)value;StringBuilder result=new StringBuilder("[");
            for(int i=0;i<array.length();i++){if(i>0)result.append(',');result.append(canonicalReadJson(array.opt(i)));}
            return result.append(']').toString();
        }
        String encoded=new JSONArray().put(value).toString();
        return encoded.substring(1,encoded.length()-1);
    }

    /** Bounded metadata receipts survive a restart; no message body is copied. */
    public synchronized String streamReadVersion(String scope,String thread) {
        JSONObject stream=parseObject(getMeta(scope,"stream:"+thread));
        return stream==null?"":stream.optString("epoch")+":"+stream.optLong("seq");
    }
    public synchronized boolean saveEmptyCompletionRead(String scope,String thread,String turn,String version,String streamVersion,List<JSONObject> identities) {
        if(!DshConfig.isScope(scope)||!isUuid(thread)||!isUuid(turn)||identities==null)return false;
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {
            if(!currentReadIdentities(identities)||!streamReadVersion(scope,thread).equals(streamVersion))return false;
            JSONObject stream=readStream(scope,thread);
            if(stream.optBoolean("available")&&sourceGeneration(scope).equals(stream.optString("sourceGeneration"))) {
                JSONArray turns=stream.optJSONArray("turns");
                for(int i=0;turns!=null&&i<turns.length();i++) {JSONObject known=turns.optJSONObject(i);
                    if(known!=null&&turn.equals(known.optString("id"))&&SyncClient.hasFinalAnswer(known.optJSONArray("items")))return false;
                }
            }
            JSONArray reads=new JSONArray();for(JSONObject identity:identities) {
                if(!scope.equals(identity.optString("scope")))return false;reads.put(identity);
            }
            String value=new JSONObject().put("version",version).put("streamVersion",streamVersion).put("identities",reads).toString();
            if(utf8Bytes(value)>MAX_METADATA_RECORD_BYTES)return false;
            putMetaLocked(db,scope,"completion-empty:"+thread+":"+turn,value);
            db.execSQL("DELETE FROM meta WHERE scope=? AND key LIKE 'completion-empty:%' AND key NOT IN (SELECT key FROM meta WHERE scope=? AND key LIKE 'completion-empty:%' ORDER BY rowid DESC LIMIT 256)",new Object[]{scope,scope});
            db.setTransactionSuccessful();return true;
        } catch(JSONException invalid) {return false;} finally {db.endTransaction();}
    }
    @Nullable public synchronized JSONObject emptyCompletionRead(String scope,String thread,String turn) {
        if(!DshConfig.isScope(scope)||!isUuid(thread)||!isUuid(turn))return null;
        return parseObject(getMeta(scope,"completion-empty:"+thread+":"+turn));
    }
    public synchronized List<String> consumeEmptyCompletionReads(String scope,String thread,@Nullable String turn) {
        return consumeEmptyCompletionReads(scope,thread,turn,false,"");
    }
    public synchronized List<String> reopenEmptyCompletionReads(String scope,String thread,@Nullable String turn,String desired) {
        return consumeEmptyCompletionReads(scope,thread,turn,true,desired);
    }
    private List<String> consumeEmptyCompletionReads(String scope,String thread,@Nullable String turn,boolean reopen,String desired) {
        List<String> targets=new ArrayList<>();
        if(!DshConfig.isScope(scope)||!isUuid(thread))return targets;
        String prefix="completion-empty:"+thread+":";
        String selection=isUuid(turn)?"scope=? AND key=?":"scope=? AND key LIKE ?";
        String[] args=new String[]{scope,isUuid(turn)?prefix+turn:prefix+"%"};
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {
            try(Cursor rows=db.query("meta",new String[]{"key"},selection,args,null,null,null,"256")) {
                while(rows.moveToNext()) {String id=rows.getString(0).substring(prefix.length());if(isUuid(id))targets.add(id);}
            }
            // Recovery work is durable before its receipt disappears, including
            // a process death immediately after this transaction commits.
            if(reopen)for(String target:targets)requestPreparation(scope,"completion",thread,target,1,false,desired);
            db.delete("meta",selection,args);db.setTransactionSuccessful();return targets;
        } finally {db.endTransaction();}
    }

    private void applyNativeRecordLocked(JSONObject record) throws JSONException {
        applyNativeRecordLocked(record, true);
    }

    private void applyNativeRecordLocked(JSONObject record, boolean allowGenerationSwitch) throws JSONException {
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
                if (!allowGenerationSwitch) throw new JSONException("read generation changed");
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
            // A cache eviction changes only the disposable projection. Real
            // deletion stays hidden across source resets; originals remain saved.
            JSONObject eviction=record.optJSONObject("payload");
            boolean realDelete=record.optBoolean("deleted")&&(eviction==null||!eviction.optBoolean("cacheEvicted"));
            String fence="catalog".equals(kind)?"archive-deleted-thread:"+record.optString("threadId"):isHistoryReadKey(key)?"archive-deleted:"+key:null;
            if(fence!=null){if(realDelete)putMetaLocked(db,scope,fence,"1");else if(!record.optBoolean("deleted"))db.delete("meta","scope=? AND key=?",new String[]{scope,fence});}
            if (!record.optBoolean("deleted") && ("history".equals(kind) || "turn".equals(kind) || "item".equals(kind))) {
                values.put("saved_at",System.currentTimeMillis());
                db.insertWithOnConflict("saved_records",null,values,SQLiteDatabase.CONFLICT_REPLACE);
            }

            rememberBodySummary(record);
            ContentValues change = new ContentValues();
            change.put("scope", scope);
            change.put("seq", changeSeq);
            change.put("source_generation", sourceGeneration);
            change.put("record_json", raw);
            long oldChangeBytes = longMetaLocked(db, scope, META_CHANGE_BYTES, -1L);
            if (oldChangeBytes < 0L) oldChangeBytes = measureRecordChangesLocked(db, scope);
            db.insertOrThrow("record_changes", null, change);
            pruneRecordChangesLocked(db, scope, oldChangeBytes + utf8Bytes(raw));
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    private void diagnostic(String scope, String stage, String reason, String traceId,
                            @Nullable JSONObject record, @Nullable JSONObject extra) {
        JSONObject fields = new JSONObject();
        try {
            fields.put("traceId", traceId);
            if (record != null) {
                String threadId = record.optString("threadId", "");
                if (NativeDiagnostics.isUuid(threadId)) fields.put("threadId", threadId);
                long revision = record.optLong("revision", 0L);
                if (revision > 0L) fields.put("revision", revision);
                JSONObject payload = record.optJSONObject("payload");
                JSONObject result = payload == null ? null : payload.optJSONObject("result");
                JSONArray data = result == null ? null : result.optJSONArray("data");
                if (data != null) fields.put("count", data.length());
            }
            if (extra != null) {
                Object revision = extra.opt("revision");
                if (revision instanceof Number) fields.put("revision", revision);
                Object count = extra.opt("count");
                if (count instanceof Number) fields.put("count", count);
            }
            NativeDiagnostics.get(appContext).event(scope, "android-store", stage, fields);
        } catch (Exception ignored) {
            // Diagnostics are best-effort and must never affect the store.
        }
    }

    /** Save the cursor metadata returned alongside a native history read. */
    public synchronized void saveHistoryCursor(String scope, String threadId, JSONObject cursors) {
        if (!DshConfig.isScope(scope) || !isUuid(threadId) || cursors == null) return;
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
    /** Read the selected thread directly without advancing the workspace import cursor. */
    public synchronized JSONObject readThreadRecords(String scope, String thread) throws JSONException {
        if (!DshConfig.isScope(scope) || !isUuid(thread)) throw new IllegalArgumentException("invalid thread");
        String generation=sourceGeneration(scope);
        JSONArray records=new JSONArray();int bytes=0;
        try (Cursor rows=getReadableDatabase().query("records",
                new String[]{"scope","key","kind","thread_id","generation","revision","payload","confirmed_at","bytes","deleted","source_generation","change_seq"},
                "scope=? AND thread_id=? AND source_generation=? AND (key LIKE ? OR key LIKE ?)",
                new String[]{scope,thread,generation,"read:[\"thread/read\",%","read:[\"thread/turns/list\",%"},null,null,"revision DESC","200")) {
            while(rows.moveToNext()) {
                JSONObject record=rowToRecord(rows);String key=record.optString("key");
                if(!key.startsWith("read:"))continue;
                JSONArray request;try{request=new JSONArray(key.substring(5));}catch(JSONException invalid){continue;}
                String method=request.optString(0);JSONObject params=request.optJSONObject(1);
                if(params==null||params.has("cursor")&&!params.isNull("cursor")||!("thread/read".equals(method)||"thread/turns/list".equals(method)))continue;
                if("thread/read".equals(method)&&params.optBoolean("includeTurns"))continue;
                if("thread/turns/list".equals(method)&&!"summary".equals(params.optString("itemsView")))continue;
                validateRecord(record,false);int size=utf8Bytes(record.toString());
                if(bytes+size>(size>MAX_PAGE_BYTES||bytes>MAX_PAGE_BYTES?MAX_BODY_ENVELOPE_BYTES:MAX_PAGE_BYTES))break;
                records.put(record);bytes+=size;
            }
        }
        return new JSONObject().put("scope",scope).put("threadId",thread).put("generation",generation)
                .put("records",records);
    }

    private static final String[] READ_COLUMNS={"scope","key","kind","thread_id","generation","revision","payload","confirmed_at","bytes","deleted","source_generation","change_seq"};

    /** An exact saved page, including its original cursor and source version. */
    public synchronized JSONObject readSavedRecord(String scope,String key) throws JSONException {
        return readSavedRecord(scope,key,"","");
    }
    public synchronized JSONObject readSavedRecord(String scope,String key,String source,String generation) throws JSONException {
        if (!DshConfig.isScope(scope) || !isHistoryReadKey(key) || source.length()>MAX_SOURCE_GENERATION_LENGTH || generation.length()>160 || source.isEmpty()!=generation.isEmpty()) throw new IllegalArgumentException("invalid read identity");
        String thread=new JSONArray(key.substring(5)).getJSONObject(1).getString("threadId");
        JSONObject empty=new JSONObject().put("scope",scope).put("record",JSONObject.NULL);
        if(getMeta(scope,"archive-deleted-thread:"+thread)!=null||getMeta(scope,"archive-deleted:"+key)!=null)return empty;
        String selection="scope=? AND key=?";String[] args={scope,key};
        if(!source.isEmpty()){selection+=" AND source_generation=? AND generation=?";args=new String[]{scope,key,source,generation};}
        try(Cursor rows=getReadableDatabase().query("saved_records",READ_COLUMNS,selection,args,null,null,"saved_at DESC,rowid DESC","1")) {
            if(!rows.moveToFirst())return empty;
            JSONObject record=rowToRecord(rows);validateRecord(record,false);
            return new JSONObject().put("scope",scope).put("record",record).put("saved",true);
        }
    }

    private static boolean isHistoryReadKey(String key) {
        if(key==null||key.length()>MAX_KEY_LENGTH||!key.startsWith("read:"))return false;
        try {JSONArray request=new JSONArray(key.substring(5));String method=request.optString(0);JSONObject params=request.optJSONObject(1);
            return request.length()==2&&params!=null&&isUuid(params.optString("threadId"))&&("thread/read".equals(method)||"thread/turns/list".equals(method)||"thread/items/list".equals(method));
        }catch(JSONException invalid){return false;}
    }

    /** Save a validated reader DTO without changing the projection or its ACK. */
    public synchronized void saveReadRecord(String scope,JSONObject record) throws JSONException {
        validateRecord(record,false);
        if(record.optBoolean("deleted"))return;
        String key=record.optString("key"),kind=record.optString("kind");
        if(!scope.equals(record.optString("scope"))||!isHistoryReadKey(key)||!record.optString("threadId").equals(new JSONArray(key.substring(5)).getJSONObject(1).optString("threadId"))||!("history".equals(kind)||"turn".equals(kind)||"item".equals(kind)))throw new IllegalArgumentException("invalid archive record");
        SQLiteDatabase db=getWritableDatabase();
        // A delayed write in one version must not replace a newer saved page.
        try(Cursor old=db.query("saved_records",new String[]{"revision"},"scope=? AND key=? AND source_generation=? AND generation=?",new String[]{scope,key,record.getString("sourceGeneration"),record.getString("generation")},null,null,null)){
            if(old.moveToFirst()&&old.getLong(0)>=record.getLong("revision"))return;
        }
        ContentValues values=new ContentValues();values.put("scope",scope);values.put("key",key);values.put("kind",kind);values.put("thread_id",record.optString("threadId"));values.put("generation",record.getString("generation"));values.put("source_generation",record.getString("sourceGeneration"));values.put("revision",record.getLong("revision"));values.put("payload",record.opt("payload").toString());values.put("confirmed_at",record.optString("confirmedAt"));values.put("bytes",record.optLong("bytes"));values.put("deleted",record.optBoolean("deleted")?1:0);values.put("change_seq",0);values.put("saved_at",System.currentTimeMillis());
        db.insertWithOnConflict("saved_records",null,values,SQLiteDatabase.CONFLICT_REPLACE);
    }

    public synchronized JSONObject readSavedThreadRecords(String scope,String thread) throws JSONException {
        if(!DshConfig.isScope(scope)||!isUuid(thread))throw new IllegalArgumentException("invalid thread");
        SQLiteDatabase db=getReadableDatabase();
        if(getMeta(scope,"archive-deleted-thread:"+thread)!=null)return new JSONObject().put("scope",scope).put("threadId",thread).put("records",new JSONArray());
        try(Cursor versions=db.rawQuery("SELECT source_generation,generation FROM saved_records WHERE scope=? AND thread_id=? GROUP BY source_generation,generation ORDER BY MAX(saved_at) DESC",new String[]{scope,thread})){
            while(versions.moveToNext()){
                String source=versions.getString(0),generation=versions.getString(1);JSONArray records=new JSONArray();boolean head=false,turns=false;int bytes=0;
                try(Cursor rows=db.query("saved_records",READ_COLUMNS,"scope=? AND thread_id=? AND source_generation=? AND generation=? AND (key LIKE ? OR key LIKE ?)",new String[]{scope,thread,source,generation,"read:[\"thread/read\",%","read:[\"thread/turns/list\",%"},null,null,"revision DESC",null)){
                    while(rows.moveToNext()){
                        JSONObject record=rowToRecord(rows);String key=record.optString("key");if(record.optBoolean("deleted")||!isHistoryReadKey(key)||getMeta(scope,"archive-deleted:"+key)!=null)continue;
                        JSONArray request=new JSONArray(key.substring(5));JSONObject params=request.getJSONObject(1);String method=request.getString(0);
                        if(params.has("cursor")&&!params.isNull("cursor"))continue;
                        boolean isHead="thread/read".equals(method)&&!params.optBoolean("includeTurns"),isTurns="thread/turns/list".equals(method)&&"summary".equals(params.optString("itemsView"))&&"desc".equals(params.optString("sortDirection"));
                        if(!isHead&&!isTurns)continue;int size=utf8Bytes(record.toString());if(bytes+size>(size>MAX_PAGE_BYTES||bytes>MAX_PAGE_BYTES?MAX_BODY_ENVELOPE_BYTES:MAX_PAGE_BYTES))continue;
                        if(isHead&&head||isTurns&&turns)continue;records.put(record);bytes+=size;head|=isHead;turns|=isTurns;if(head&&turns)break;
                    }
                }
                if(head&&turns)return new JSONObject().put("scope",scope).put("threadId",thread).put("generation",source).put("saved",true).put("records",records);
            }
        }
        return new JSONObject().put("scope",scope).put("threadId",thread).put("records",new JSONArray());
    }

    public synchronized JSONObject archiveProgress(String scope,String thread) throws JSONException {
        if(!DshConfig.isScope(scope)||!isUuid(thread))throw new IllegalArgumentException("invalid thread");
        String raw=getMeta(scope,"read-archive:"+thread);return raw==null?new JSONObject():new JSONObject(raw);
    }
    public synchronized void saveArchiveProgress(String scope,String thread,JSONObject progress) throws JSONException {
        if(!DshConfig.isScope(scope)||!isUuid(thread)||utf8Bytes(progress.toString())>MAX_METADATA_RECORD_BYTES)throw new IllegalArgumentException("invalid archive progress");
        // A page from a retired projection never advances the new archive.
        if(!sourceGeneration(scope).equals(progress.optString("sourceGeneration")))throw new JSONException("retired archive source");
        putMeta(scope,"read-archive:"+thread,progress.toString());
    }

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

        // Current records retain every key and tombstone, so trimming duplicate
        // audit bodies cannot invalidate an in-generation cursor. In particular,
        // a full snapshot may page through old keys below the retained log.
        // Only a different source generation or a future cursor requires reset.
        long floor = longMetaLocked(db, scope, META_GENERATION_FLOOR, 0L);
        if (requestedAfter > 0L) resetRequired = requestedAfter < floor
                || requestedAfter > localRecordCursorLocked(db, scope);

        if (!resetRequired && !"uninitialized".equals(generation)) {
            String selection = "scope=? AND source_generation=? AND change_seq>?";
            String[] args = new String[]{scope, generation, Long.toString(requestedAfter)};
            try (Cursor rows = db.query("records", new String[]{"scope", "key", "kind", "thread_id", "generation", "revision", "payload", "confirmed_at", "bytes", "deleted", "source_generation", "change_seq"}, selection, args,
                    null, null, "change_seq ASC", Integer.toString(bounded + 1))) {
                while (rows.moveToNext()) {
                    long seq = rows.getLong(11);
                    JSONObject record;
                    try {
                        record = rowToRecord(rows);
                        validateRecord(record, false);
                    } catch (JSONException invalid) {
                        resetRequired = true;
                        break;
                    }
                    String raw = record.toString();
                    int bytes = utf8Bytes(raw);
                    if (records.length() >= bounded || pageBytes > 0 && pageBytes + bytes > MAX_PAGE_BYTES) {
                        hasMore = true;
                        break;
                    }
                    if (bytes > recordLimit(record.optString("kind")) || pageBytes > 0 && pageBytes + bytes > MAX_PAGE_BYTES) {
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
        return localRecordCursorLocked(getReadableDatabase(), scope);
    }

    private static long localRecordCursorLocked(SQLiteDatabase db, String scope) {
        try (Cursor row = db.query("local_sequences", new String[]{"next_seq"}, "scope=?", new String[]{scope}, null, null, null)) {
            if (row.moveToFirst()) return boundedCursor(row.getLong(0) - 1L);
        }
        try (Cursor row = db.rawQuery("SELECT COALESCE(MAX(seq),0) FROM (SELECT seq FROM record_changes WHERE scope=? UNION ALL SELECT change_seq AS seq FROM records WHERE scope=?)", new String[]{scope, scope})) {
            return row.moveToFirst() ? boundedCursor(row.getLong(0)) : 0L;
        }
    }

    private static long longMetaLocked(SQLiteDatabase db, String scope, String key, long fallback) {
        try (Cursor row = db.query("meta", new String[]{"value"}, "scope=? AND key=?", new String[]{scope, key}, null, null, null)) {
            return row.moveToFirst() ? row.getLong(0) : fallback;
        }
    }

    private static long measureRecordChangesLocked(SQLiteDatabase db, String scope) {
        try (Cursor rows = db.rawQuery("SELECT COALESCE(SUM(length(CAST(record_json AS BLOB))),0) FROM record_changes WHERE scope=?", new String[]{scope})) {
            return rows.moveToFirst() ? rows.getLong(0) : 0L;
        }
    }

    private static void pruneRecordChangesLocked(SQLiteDatabase db, String scope, long bytes) {
        long through = 0L;
        if (bytes > MAX_CHANGE_LOG_BYTES) {
            try (Cursor rows = db.rawQuery("SELECT seq,length(CAST(record_json AS BLOB)) FROM record_changes WHERE scope=? ORDER BY seq", new String[]{scope})) {
                while (bytes > MAX_CHANGE_LOG_BYTES && rows.moveToNext()) {
                    through = rows.getLong(0);
                    bytes -= rows.getLong(1);
                }
            }
            if (through > 0L) db.delete("record_changes", "scope=? AND seq<=?", new String[]{scope, Long.toString(through)});
        }
        putMetaLocked(db, scope, META_CHANGE_BYTES, Long.toString(Math.max(0L, bytes)));
    }

    public synchronized void saveBootstrap(String scope, JSONObject bootstrap) {
        if (!DshConfig.isScope(scope) || bootstrap == null) return;
        if (utf8Bytes(bootstrap.toString()) > MAX_METADATA_RECORD_BYTES) return;
        putMeta(scope, META_BOOTSTRAP_CONFIG, bootstrap.toString());
    }

    @Nullable
    public synchronized JSONObject getBootstrap(String scope) {
        String value = getMeta(scope, META_BOOTSTRAP_CONFIG);
        if (value == null || value.isEmpty() || utf8Bytes(value) > MAX_METADATA_RECORD_BYTES) return null;
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

    /** Source classification only; retained Native bodies and parent references are untouched. */
    public synchronized boolean isInternalDirectoryThread(String scope, String threadId) {
        JSONObject catalog = catalogRecord(scope, threadId);
        JSONObject payload = catalog == null ? null : catalog.optJSONObject("payload");
        JSONObject thread = payload == null ? null : payload.optJSONObject("nativeThread");
        if (thread != null) return CompletionNotificationPolicy.isInternalDirectoryThread(thread);
        try (Cursor rows = getReadableDatabase().query("records", new String[]{"payload"},
                "scope=? AND thread_id=? AND kind='history' AND deleted=0", new String[]{scope, threadId},
                null, null, "revision DESC", "8")) {
            while (rows.moveToNext()) {
                JSONObject value = parseObject(rows.getString(0));
                JSONObject result = value == null ? null : value.optJSONObject("result");
                JSONObject head = result == null ? null : result.optJSONObject("thread");
                if (head != null && threadId.equals(head.optString("id")))
                    return CompletionNotificationPolicy.isInternalDirectoryThread(head);
            }
        }
        return false;
    }

    /** Derived from this scope's Native catalog; never a second execution state. */
    public synchronized JSONObject runningSessions(String scope) {
        JSONObject result = new JSONObject();
        int count = 0;
        String firstId = "";
        String epoch = eventCursor(scope).epoch;
        Set<String> counted = new HashSet<>();
        Map<String, JSONObject> runtimeById = new HashMap<>();
        try (Cursor rows = getReadableDatabase().query("meta", new String[]{"key", "value"},
                "scope=? AND key LIKE 'thread-runtime:%'", new String[]{scope}, null, null, null)) {
            while (rows.moveToNext()) {
                JSONObject runtime = parseObject(rows.getString(1));
                if (runtime != null && epoch.equals(runtime.optString("epoch")))
                    runtimeById.put(rows.getString(0).substring("thread-runtime:".length()), runtime);
            }
        }
        try (Cursor rows = getReadableDatabase().query("records", new String[]{"thread_id", "payload", "deleted"},
                "scope=? AND kind='catalog'", new String[]{scope}, null, null, null)) {
            while (rows.moveToNext()) {
                counted.add(rows.getString(0));
                if (rows.getInt(2) != 0) continue;
                try {
                    JSONObject thread = new JSONObject(rows.getString(1)).optJSONObject("nativeThread");
                    JSONObject status = thread == null ? null : thread.optJSONObject("status");
                    JSONObject runtime = runtimeById.get(rows.getString(0));
                    if (runtime != null && epoch.equals(runtime.optString("epoch"))) status = runtime.optJSONObject("status");
                    if (thread == null || CompletionNotificationPolicy.isInternalDirectoryThread(thread)
                            || thread.optBoolean("archived", false) || status == null
                            || !"active".equals(status.optString("type"))) continue;
                    count++;
                    if (firstId.isEmpty()) firstId = rows.getString(0);
                } catch (JSONException ignored) { }
            }
        }
        // A newly started Native thread can arrive before its catalog row.
        for (Map.Entry<String, JSONObject> entry : runtimeById.entrySet()) {
            if (counted.contains(entry.getKey()) || isInternalDirectoryThread(scope, entry.getKey())) continue;
            JSONObject status = entry.getValue().optJSONObject("status");
            if (status == null || !"active".equals(status.optString("type"))) continue;
            count++; if (firstId.isEmpty()) firstId = entry.getKey();
        }
        try { result.put("count", count); result.put("threadId", count == 1 ? firstId : ""); }
        catch (JSONException ignored) { }
        return result;
    }

    /** Pinned and recent heads, independent of UI asset versions. */
    public synchronized List<JSONObject> historyWarmCandidates(String scope, int limit) {
        if(limit<=0)return new ArrayList<>();
        List<JSONObject> candidates = new ArrayList<>();
        SQLiteDatabase db = getReadableDatabase();
        try (Cursor rows = db.query("records", new String[]{"thread_id", "payload", "source_generation", "generation"},
                "scope=? AND kind='catalog' AND deleted=0", new String[]{scope}, null, null, "revision DESC", "512")) {
            while (rows.moveToNext()) {
                try {
                    JSONObject payload = new JSONObject(rows.getString(1));
                    JSONObject thread = payload.optJSONObject("nativeThread");
                    if (thread == null || CompletionNotificationPolicy.isInternalDirectoryThread(thread)
                            || thread.optBoolean("archived", false)) continue;
                    JSONObject status = thread.optJSONObject("status");
                    if (status != null && "active".equals(status.optString("type"))) continue;
                    String id = rows.getString(0);
                    if (id == null || id.isEmpty()) continue;
                    if (isUnstartedHistory(scope,id)) continue;
                    String version = historyPreparationVersion(scope,id);
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
        // Choose the horizon BEFORE removing ready entries. Otherwise each
        // catalog pass walks farther back and eventually warms every thread.
        List<JSONObject> due = new ArrayList<>(); int recent = 0;
        for (JSONObject candidate : candidates) {
            if (!candidate.optBoolean("pinned") && recent++ >= 20) continue;
            String id=candidate.optString("threadId"),version=candidate.optString("version");
            if (!historyWarmDue(scope,id,version,System.currentTimeMillis())) continue;
            try {
                JSONObject prior=parseObject(getMeta(scope,"history-warm:"+id));
                if(prior!=null&&!version.equals(prior.optString("version"))&&version.startsWith("body-v1:")){JSONObject summary=bodySummary(scope,id);if(summary!=null&&prior.optString("version").equals(summary.optString("sourceGeneration")+":"+summary.optString("generation")+":"+summary.optLong("headUpdatedAt"))&&archivePrepared(scope,id,version)){prior.put("version",version);putMeta(scope,"history-warm:"+id,prior.toString());}}
                if (prior!=null && version.equals(prior.optString("version"))) {
                    try(Cursor head=db.rawQuery("SELECT 1 FROM records WHERE scope=? AND key=? AND kind='history' AND deleted=0 LIMIT 1",new String[]{scope,prior.optString("key")})) {
                        if(head.moveToFirst())continue;
                    }
                }
            } catch(JSONException|RuntimeException ignored) { }
            due.add(candidate);
            if(due.size()>=Math.max(0,limit))break;
        }
        return due;
    }

    public synchronized void markHistoryWarm(String scope, JSONObject candidate, String key) throws JSONException {
        clearHistoryWarmFailure(scope, candidate.getString("threadId"));
        putMeta(scope, "history-warm:" + candidate.getString("threadId"),
                new JSONObject().put("version", candidate.getString("version")).put("key", key).toString());
    }

    public synchronized boolean historyWarmDue(String scope, String id, String version, long now) {
        try {
            String raw=getMeta(scope,"history-warm-failure:"+id);
            if(raw==null)return true;
            JSONObject failure=new JSONObject(raw);
            return !version.equals(failure.optString("version")) || now>=failure.optLong("dueAt");
        } catch(JSONException ignored) { return true; }
    }

    public synchronized void deferHistoryWarm(String scope, JSONObject candidate, long now) {
        String id=candidate.optString("threadId"),version=candidate.optString("version");
        if(!DshConfig.isScope(scope)||!isUuid(id)||version.isEmpty())return;
        int attempts=0;
        try {
            String raw=getMeta(scope,"history-warm-failure:"+id);
            if(raw!=null){JSONObject prior=new JSONObject(raw);if(version.equals(prior.optString("version")))attempts=Math.min(16,prior.optInt("attempts"));}
            long delay=Math.min(30*60_000L,30_000L*(1L<<Math.max(0,attempts)));
            putMeta(scope,"history-warm-failure:"+id,new JSONObject().put("version",version).put("attempts",attempts+1).put("dueAt",now+delay).toString());
        } catch(JSONException ignored) { }
    }

    public synchronized void clearHistoryWarmFailure(String scope, String id) {
        getWritableDatabase().delete("meta","scope=? AND key=?",new String[]{scope,"history-warm-failure:"+id});
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
        saveNextSequenceLocked(db, scope, next == Long.MAX_VALUE ? Long.MAX_VALUE : next + 1L);
        return next;
    }

    private static void saveNextSequenceLocked(SQLiteDatabase db, String scope, long next) {
        ContentValues values = new ContentValues();
        values.put("scope", scope);
        values.put("next_seq", next);
        db.insertWithOnConflict("local_sequences", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    private static void validateRecord(@Nullable JSONObject record, boolean allowInternalOnly) throws JSONException {
        if (record == null) throw new JSONException("record missing");
        String scope = record.optString("scope", "");
        String key = record.optString("key", "");
        String kind = record.optString("kind", "");
        String sourceGeneration = record.optString("sourceGeneration", "");
        String generation = record.optString("generation", "");
        if (!DshConfig.isScope(scope) || !validText(key, MAX_KEY_LENGTH, false) || !RECORD_KINDS.contains(kind)
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
        if (utf8Bytes(record.toString()) > recordLimit(kind)) throw new JSONException("record too large");
    }

    private static int recordLimit(String kind) {
        return "history".equals(kind)||"turn".equals(kind)||"item".equals(kind)?MAX_RECORD_BYTES:MAX_METADATA_RECORD_BYTES;
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
