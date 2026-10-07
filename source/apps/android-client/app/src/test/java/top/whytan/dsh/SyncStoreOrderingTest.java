package top.whytan.dsh;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

import java.util.HashSet;
import java.util.Set;

/** Durable ordering and completion de-duplication contract for background reads. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, manifest = Config.NONE)
public class SyncStoreOrderingTest {
    private static final String THREAD_ID = "11111111-1111-4111-8111-111111111111";
    private static final String TURN_ID = "22222222-2222-4222-8222-222222222222";
    private Context context;
    private SyncStore store;

    @Before
    public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase("native-sync-v1.sqlite");
        store = new SyncStore(context);
    }

    @After
    public void tearDown() {
        if (store != null) store.close();
        context.deleteDatabase("native-sync-v1.sqlite");
    }

    @Test public void receivedEventAndCursorSurviveProcessReopenTogether() throws Exception {
        JSONObject frame=new JSONObject().put("event",new JSONObject().put("type","host").put("online",true));
        assertTrue(store.receiveEvent("ai","e1",1,frame));
        store.close();store=new SyncStore(context);
        assertEquals(1,store.eventCursor("ai").seq);
        assertEquals("host",store.nextEvent("ai").payload.getJSONObject("event").getString("type"));
        assertFalse(store.receiveEvent("ai","e1",1,frame));
        store.completeEvent("ai",store.nextEvent("ai").id);
        assertTrue(store.nextEvent("ai")==null);
        assertEquals(1,store.eventCursor("ai").seq);
        assertEquals(0,store.eventCursor("zyy").seq);
    }

    @Test public void invalidEventCannotAdvanceCursor() throws Exception {
        try { store.receiveEvent("ai","e1",1,null); org.junit.Assert.fail("missing frame accepted"); }
        catch(org.json.JSONException expected) {}
        assertEquals(0,store.eventCursor("ai").seq);
        assertTrue(store.nextEvent("ai")==null);
    }

    @Test public void unloadedPersistentCatalogStillPreparesReadAndRetainsSavedPages() throws Exception {
        JSONObject body=new JSONObject().put("nativeThread",new JSONObject().put("id",THREAD_ID)
                .put("status",new JSONObject().put("type","notLoaded")).put("updatedAt",10));
        store.applyNativeRecord(record("catalog","thread:"+THREAD_ID,body,1),"fixture");
        JSONObject saved=record("history","read:"+new JSONArray().put("thread/turns/list").put(new JSONObject().put("threadId",THREAD_ID)).toString(),
                new JSONObject().put("result",new JSONObject().put("data",new JSONArray())),2);
        store.applyNativeRecord(saved,"fixture");
        assertEquals(1,store.historyWarmCandidates("ai",8).size());
        store.close();store=new SyncStore(context);
        assertNotNull(store.readSavedRecord("ai",saved.getString("key")).getJSONObject("record"));
        assertEquals(1,store.historyWarmCandidates("ai",8).size());
        body.getJSONObject("nativeThread").getJSONObject("status").put("type","idle");
        store.applyNativeRecord(record("catalog","thread:"+THREAD_ID,body,3),"fixture");
        assertEquals(THREAD_ID,store.historyWarmCandidates("ai",8).get(0).getString("threadId"));
    }
    @Test public void freshCatalogRetirementsStopWarmReadsWithoutErasingSavedBodies() throws Exception {
        String fixture=System.getenv("DSH_CATALOG_FIXTURE");
        JSONArray retirements=fixture==null?new JSONArray().put(record("catalog","thread:"+THREAD_ID,new JSONObject(),10).put("payload",JSONObject.NULL).put("deleted",true))
                :new JSONArray(new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(fixture)),java.nio.charset.StandardCharsets.UTF_8));
        assertTrue(retirements.length()>0);
        java.util.List<String> bodyKeys=new java.util.ArrayList<>();
        for(int i=0;i<retirements.length();i++){
            JSONObject retired=retirements.getJSONObject(i);String id=retired.getString("threadId"),source=retired.getString("sourceGeneration");
            JSONObject live=new JSONObject(retired.toString()).put("revision",1).put("deleted",false)
                    .put("payload",new JSONObject().put("nativeThread",new JSONObject().put("id",id).put("updatedAt",10).put("status",new JSONObject().put("type","idle"))));
            store.applyNativeRecord(live);
            String key="read:"+new JSONArray().put("thread/turns/list").put(new JSONObject().put("threadId",id)).toString();bodyKeys.add(key);
            store.saveReadRecord("ai",record("history",key,new JSONObject().put("result",new JSONObject().put("data",new JSONArray().put(new JSONObject().put("id","saved-prompt")))),2,source).put("threadId",id).put("generation",retired.getString("generation")));
        }
        assertEquals(retirements.length(),store.historyWarmCandidates("ai",8).size());
        for(int i=0;i<retirements.length();i++)store.applyNativeRecord(retirements.getJSONObject(i));
        assertTrue(store.historyWarmCandidates("ai",8).isEmpty());store.close();store=new SyncStore(context);
        assertTrue(store.historyWarmCandidates("ai",8).isEmpty());
        for(String key:bodyKeys){
            // Retired rows stay out of live lookups; the durable body archive
            // itself must remain byte-complete across process restarts.
            try(android.database.Cursor rows=store.getReadableDatabase().query("saved_records",new String[]{"payload","deleted"},"scope=? AND key=?",new String[]{"ai",key},null,null,null)){
                assertTrue(rows.moveToFirst());assertEquals(0,rows.getInt(1));assertEquals("saved-prompt",new JSONObject(rows.getString(0)).getJSONObject("result").getJSONArray("data").getJSONObject(0).getString("id"));
            }
        }
    }
    @Test public void streamCompletionAndPreparationAreAtomicAndSurviveRestart()throws Exception {
        JSONObject event=new JSONObject().put("type","turn").put("threadId",THREAD_ID).put("turn",new JSONObject().put("id",TURN_ID).put("status","completed").put("items",new JSONArray()));
        store.receiveEvent("ai","e1",1,new JSONObject().put("event",event));
        store.getWritableDatabase().execSQL("CREATE TRIGGER fail_stream BEFORE INSERT ON meta WHEN NEW.key='stream:"+THREAD_ID+"' BEGIN SELECT RAISE(ABORT,'disk failure'); END");
        try{store.commitStreamEvent("ai",store.nextEvent("ai"),event);org.junit.Assert.fail("failed commit accepted");}catch(android.database.sqlite.SQLiteException expected){}
        assertNotNull(store.nextEvent("ai"));assertTrue(store.duePreparations("ai",Long.MAX_VALUE,10).isEmpty());assertFalse(store.readStream("ai",THREAD_ID).optBoolean("available"));
        store.getWritableDatabase().execSQL("DROP TRIGGER fail_stream");store.commitStreamEvent("ai",store.nextEvent("ai"),event);
        store.close();store=new SyncStore(context);
        assertTrue(store.nextEvent("ai")==null);assertEquals("completed",store.readStream("ai",THREAD_ID).getJSONArray("turns").getJSONObject(0).getString("status"));
        SyncStore.Preparation work=store.duePreparations("ai",Long.MAX_VALUE,10).get(0);assertEquals("completion",work.kind);assertEquals(TURN_ID,work.turnId);assertEquals(0,work.priority);assertFalse(work.baseline);
    }

    @Test public void olderPreparationCompletionCannotEraseNewerVersion() throws Exception {
        SyncStore.Preparation old=store.requestPreparation("ai","history",THREAD_ID,"",1,false,"r1");
        SyncStore.Preparation next=store.requestPreparation("ai","history",THREAD_ID,"",0,false,"r2");
        store.finishPreparation("ai",old);
        store.close();store=new SyncStore(context);
        java.util.List<SyncStore.Preparation> pending=store.duePreparations("ai",System.currentTimeMillis(),10);
        assertEquals(1,pending.size());assertEquals(next.version,pending.get(0).version);
        assertEquals(0,pending.get(0).priority);
        assertTrue(store.duePreparations("zyy",Long.MAX_VALUE,10).isEmpty());
        store.finishPreparation("ai",pending.get(0));
        assertTrue(store.duePreparations("ai",Long.MAX_VALUE,10).isEmpty());
    }

    @Test public void failedPreparationRetainsItsIdentityAndDueTimeAfterReopen() throws Exception {
        SyncStore.Preparation job=store.requestPreparation("ai","completion",THREAD_ID,TURN_ID,1,false,"v1");
        long due=System.currentTimeMillis()+30000;store.deferPreparation("ai",job,due);
        store.requestPreparation("ai","completion",THREAD_ID,TURN_ID,1,false,"v1");
        store.close();store=new SyncStore(context);
        assertTrue(store.duePreparations("ai",due-1,10).isEmpty());
        assertEquals(1,store.duePreparations("ai",due,10).get(0).attempts);
    }

    @Test
    public void committedBodyIsVisibleBeforeCompletionObservationAndOnlyNotifiesOnce() throws Exception {
        String batchTrace = "33333333-3333-4333-8333-333333333333";
        store.applyNativeRecord(record("catalog", "thread:" + THREAD_ID,
                new JSONObject().put("nativeThread", new JSONObject().put("id", THREAD_ID)), 1), batchTrace);

        JSONObject body = new JSONObject().put("result", new JSONObject()
                .put("data", new JSONArray().put(new JSONObject().put("id", "item-1"))));
        store.applyNativeRecord(record("item", "item:" + TURN_ID + ":item-1", body, 2), batchTrace);

        JSONObject page = store.readRecords("ai", 0, 20);
        JSONArray records = page.optJSONArray("records");
        assertNotNull(records);
        assertEquals(2, records.length());
        assertTrue(containsKey(records, "item:" + TURN_ID + ":item-1"));

        assertFalse(store.observeTurn("ai", THREAD_ID, TURN_ID, "inProgress", true, false, 10));
        assertTrue(store.observeTurn("ai", THREAD_ID, TURN_ID, "completed", true, false, 20));
        assertFalse(store.observeTurn("ai", THREAD_ID, TURN_ID, "completed", true, false, 30));
    }

    @Test
    public void baselineCompletionDoesNotNotifyAfterBodyCommit() throws Exception {
        String batchTrace = "44444444-4444-4444-8444-444444444444";
        store.applyNativeRecord(record("item", "item:" + TURN_ID + ":item-2",
                new JSONObject().put("result", new JSONObject().put("data", new JSONArray())), 1), batchTrace);
        assertFalse(store.observeTurn("ai", THREAD_ID, TURN_ID, "inProgress", true, true, 10));
        assertFalse(store.observeTurn("ai", THREAD_ID, TURN_ID, "completed", true, true, 20));
    }

    @Test
    public void lateReadFromOldGenerationIsRejectedWithoutResettingCurrentProjection() throws Exception {
        String batchTrace = "55555555-5555-4555-8555-555555555555";
        store.applyNativeRecord(record("catalog", "thread:" + THREAD_ID,
                new JSONObject().put("nativeThread", new JSONObject().put("id", THREAD_ID)),
                1, "g-1"), batchTrace);
        assertTrue(store.applyReadRecord(record("history", "history:" + TURN_ID,
                new JSONObject().put("result", new JSONObject().put("data", new JSONArray())),
                2, "g-1"), batchTrace, "g-1"));

        store.applyNativeRecord(record("catalog", "thread:" + THREAD_ID,
                new JSONObject().put("nativeThread", new JSONObject().put("id", THREAD_ID)),
                1, "g-2"), batchTrace);
        assertFalse(store.applyReadRecord(record("item", "item:" + TURN_ID + ":late",
                new JSONObject().put("result", new JSONObject().put("data", new JSONArray())),
                3, "g-1"), batchTrace, "g-1"));

        JSONObject page = store.readRecords("ai", 0, 20);
        assertEquals("g-2", page.optString("generation"));
        JSONArray records = page.optJSONArray("records");
        assertNotNull(records);
        assertEquals(1, records.length());
        assertTrue(containsKey(records, "thread:" + THREAD_ID));
        assertFalse(containsKey(records, "item:" + TURN_ID + ":late"));
    }

    @Test
    public void readRecordsReturnsOnlyTheLatestProjectionForRepeatedKeyRevisions() throws Exception {
        String key = "item:" + TURN_ID + ":same-key";
        for (int revision = 1; revision <= 401; revision++) {
            store.applyNativeRecord(record("item", key,
                    new JSONObject().put("revisionMarker", revision), revision), null);
        }

        JSONObject page = store.readRecords("ai", 0, 200);
        JSONArray records = page.optJSONArray("records");
        assertNotNull(records);
        assertEquals(1, records.length());
        assertEquals(key, records.getJSONObject(0).optString("key"));
        assertEquals(401L, records.getJSONObject(0).optLong("revision"));
        assertEquals(401L, page.optLong("cursor"));
        assertFalse(page.optBoolean("hasMore"));

        // A cursor in the middle of the retained change log still receives the
        // current row, never an intermediate revision of the same key.
        JSONObject afterOldRevision = store.readRecords("ai", 200, 200);
        assertEquals(1, afterOldRevision.optJSONArray("records").length());
        assertEquals(401L, afterOldRevision.optJSONArray("records").getJSONObject(0).optLong("revision"));
    }

    @Test
    public void readRecordsPagesCurrentRowsWithoutDuplicates() throws Exception {
        for (int index = 1; index <= 205; index++) {
            store.applyNativeRecord(record("item", "item:" + TURN_ID + ":page-" + index,
                    new JSONObject().put("index", index), index), null);
        }

        JSONObject first = store.readRecords("ai", 0, 200);
        JSONObject second = store.readRecords("ai", first.optLong("cursor"), 200);
        JSONArray firstRows = first.optJSONArray("records");
        JSONArray secondRows = second.optJSONArray("records");
        assertNotNull(firstRows);
        assertNotNull(secondRows);
        assertEquals(200, firstRows.length());
        assertEquals(5, secondRows.length());
        assertTrue(first.optBoolean("hasMore"));
        assertFalse(second.optBoolean("hasMore"));

        Set<String> keys = new HashSet<>();
        for (int index = 0; index < firstRows.length(); index++) {
            assertTrue(keys.add(firstRows.getJSONObject(index).optString("key")));
        }
        for (int index = 0; index < secondRows.length(); index++) {
            assertTrue(keys.add(secondRows.getJSONObject(index).optString("key")));
        }
        assertEquals(205, keys.size());
    }

    @Test
    public void readRecordsKeepsTheLatestTombstoneInTheProjection() throws Exception {
        String key = "item:" + TURN_ID + ":deleted";
        store.applyNativeRecord(record("item", key, new JSONObject().put("live", true), 1), null);
        store.applyNativeRecord(record("item", key, new JSONObject(), 2).put("deleted", true), null);

        JSONArray records = store.readRecords("ai", 0, 20).optJSONArray("records");
        assertNotNull(records);
        assertEquals(1, records.length());
        JSONObject tombstone = records.getJSONObject(0);
        assertEquals(key, tombstone.optString("key"));
        assertTrue(tombstone.optBoolean("deleted"));
        assertEquals(2L, tombstone.optLong("revision"));
    }

    @Test
    public void generationResetDropsOldBodiesButRetainsMonotonicLocalCursor() throws Exception {
        store.applyNativeRecord(record("catalog", "thread:" + THREAD_ID,
                new JSONObject().put("nativeThread", new JSONObject().put("id", THREAD_ID)), 1, "g-old"), null);
        store.applyNativeRecord(record("item", "item:" + TURN_ID + ":old",
                new JSONObject().put("old", true), 2, "g-old"), null);
        assertEquals(2L, store.localRecordCursor("ai"));

        store.applyNativeRecord(record("catalog", "thread:" + THREAD_ID,
                new JSONObject().put("nativeThread", new JSONObject().put("id", THREAD_ID)), 1, "g-new"), null);
        JSONObject page = store.readRecords("ai", 0, 20);
        JSONArray records = page.optJSONArray("records");
        assertNotNull(records);
        assertEquals("g-new", page.optString("generation"));
        assertEquals(1, records.length());
        assertTrue(containsKey(records, "thread:" + THREAD_ID));
        assertFalse(containsKey(records, "item:" + TURN_ID + ":old"));
        assertEquals(3L, page.optLong("cursor"));
        assertEquals(3L, store.localRecordCursor("ai"));
        assertTrue(store.readRecords("ai", 1, 20).optBoolean("resetRequired"));
        assertTrue(store.readRecords("ai", 2, 20).optBoolean("resetRequired"));
        assertFalse(store.readRecords("ai", 3, 20).optBoolean("resetRequired"));

        try (android.database.Cursor changes = store.getReadableDatabase().rawQuery(
                "SELECT COUNT(*) FROM record_changes WHERE scope=?", new String[]{"ai"})) {
            assertTrue(changes.moveToFirst());
            assertEquals(1L, changes.getLong(0));
        }
    }

    @Test
    public void duplicateBodiesStayWithinByteBudgetAndOldSameGenerationCursorStillReadsLatest() throws Exception {
        String body = "汉".repeat(22000);
        for (int revision = 1; revision <= 200; revision++) {
            store.applyNativeRecord(record("item", "item:bounded", new JSONObject()
                    .put("text", body).put("version", revision), revision), null);
            assertTrue(changeBytes("ai") <= SyncStore.MAX_CHANGE_LOG_BYTES);
        }
        try (android.database.Cursor rows = store.getReadableDatabase().rawQuery(
                "SELECT COUNT(*) FROM record_changes WHERE scope='ai'", null)) {
            assertTrue(rows.moveToFirst());assertTrue(rows.getLong(0) < 200L);
        }
        store.close();store = new SyncStore(context);
        assertEquals(200L, store.localRecordCursor("ai"));
        JSONObject page = store.readRecords("ai", 1, 200);
        assertFalse(page.optBoolean("resetRequired"));
        assertEquals(1, page.getJSONArray("records").length());
        assertEquals(200L, page.getJSONArray("records").getJSONObject(0).getLong("revision"));
        assertEquals(changeBytes("ai"), Long.parseLong(store.getMeta("ai", "record-change-bytes")));
    }

    @Test
    public void fullSnapshotCanPageBelowRetainedAuditFloorWithoutResetLoopOrLostTombstone() throws Exception {
        String body = "x".repeat(32768);
        for (int index = 1; index <= 205; index++) {
            store.applyNativeRecord(record("item", "item:page-budget-" + index,
                    new JSONObject().put("text", body), index), null);
        }
        store.applyNativeRecord(record("item", "item:page-budget-1", new JSONObject(), 206)
                .put("deleted", true), null);
        assertTrue(changeBytes("ai") <= SyncStore.MAX_CHANGE_LOG_BYTES);
        long after = 0L;int pages = 0;boolean tombstone = false;
        Set<String> keys = new HashSet<>();
        while (true) {
            JSONObject page = store.readRecords("ai", after, 200);
            assertFalse(page.optBoolean("resetRequired"));
            for (int i = 0; i < page.getJSONArray("records").length(); i++) {
                JSONObject row = page.getJSONArray("records").getJSONObject(i);
                assertTrue(keys.add(row.getString("key")));
                if (row.getString("key").equals("item:page-budget-1")) tombstone = row.getBoolean("deleted");
            }
            assertTrue(page.getLong("cursor") > after);
            after = page.getLong("cursor");
            assertTrue(++pages <= 10);
            if (!page.getBoolean("hasMore")) break;
        }
        assertEquals(205, keys.size());assertTrue(tombstone);assertTrue(pages > 1);assertEquals(206L, after);
    }

    @Test
    public void emptyGenerationResetPersistsFenceAndDoesNotClearAnotherWorkspace() throws Exception {
        store.applyNativeRecord(record("item", "item:ai-old", new JSONObject(), 1), null);
        store.applyNativeRecord(record("item", "item:zyy-kept", new JSONObject(), 1).put("scope", "zyy"), null);
        long otherBytes = changeBytes("zyy");
        store.resetGeneration("ai", "g-next");
        assertEquals(0L, changeBytes("ai"));assertEquals(otherBytes, changeBytes("zyy"));
        assertEquals(1L, store.localRecordCursor("ai"));
        store.close();store = new SyncStore(context);
        assertTrue(store.readRecords("ai", 1, 20).getBoolean("resetRequired"));
        assertEquals(0, store.readRecords("ai", 1, 20).getJSONArray("records").length());
        assertFalse(store.readRecords("ai", 0, 20).getBoolean("resetRequired"));
        store.applyNativeRecord(record("item", "item:new", new JSONObject(), 1, "g-next"), null);
        assertEquals(2L, store.localRecordCursor("ai"));
        assertTrue(store.readRecords("ai", 1, 20).getBoolean("resetRequired"));
        assertFalse(store.readRecords("ai", 2, 20).getBoolean("resetRequired"));
        assertTrue(store.readRecords("ai", 3, 20).getBoolean("resetRequired"));
        assertEquals(1, store.readRecords("zyy", 0, 20).getJSONArray("records").length());
    }

    @Test
    public void failedPruningRollsBackProjectionCursorAndByteCounterTogether() throws Exception {
        String body = "x".repeat(700000);
        for (int revision = 1; revision <= 2; revision++) store.applyNativeRecord(record("item", "item:atomic",
                new JSONObject().put("text", body), revision), null);
        long bytes = changeBytes("ai");
        store.getWritableDatabase().execSQL("CREATE TRIGGER reject_review_prune BEFORE DELETE ON record_changes BEGIN SELECT RAISE(ABORT,'fixture prune failure'); END");
        boolean failed = false;
        try { store.applyNativeRecord(record("item", "item:atomic", new JSONObject().put("text", body), 3), null); }
        catch (android.database.SQLException expected) { failed = true; }
        assertTrue(failed);assertEquals(2L, store.localRecordCursor("ai"));assertEquals(bytes, changeBytes("ai"));
        assertEquals(bytes, Long.parseLong(store.getMeta("ai", "record-change-bytes")));
        assertEquals(2L, store.readRecords("ai", 0, 20).getJSONArray("records").getJSONObject(0).getLong("revision"));
        store.getWritableDatabase().execSQL("DROP TRIGGER reject_review_prune");
        store.applyNativeRecord(record("item", "item:atomic", new JSONObject().put("text", body), 3), null);
        assertEquals(3L, store.localRecordCursor("ai"));assertTrue(changeBytes("ai") <= SyncStore.MAX_CHANGE_LOG_BYTES);
    }

    @Test
    public void v3UpgradeBoundsExistingHistoryWithoutLosingLatestProjection() throws Exception {
        JSONObject latest = record("item", "item:legacy-upgrade", new JSONObject().put("text", "x".repeat(65536)), 200);
        store.applyNativeRecord(latest, null);
        android.database.sqlite.SQLiteDatabase db = store.getWritableDatabase();
        db.delete("record_changes", "scope='ai'", null);
        for (int seq = 1; seq <= 200; seq++) legacyChange(db, "ai", seq, "g-1", latest.toString());
        db.execSQL("UPDATE records SET change_seq=200 WHERE scope='ai'");
        db.execSQL("UPDATE local_sequences SET next_seq=201 WHERE scope='ai'");
        db.delete("meta", "key IN ('record-change-bytes','record-generation-floor')", null);
        db.setVersion(3);assertTrue(changeBytes("ai") > SyncStore.MAX_CHANGE_LOG_BYTES);
        store.close();store = new SyncStore(context);
        assertTrue(changeBytes("ai") <= SyncStore.MAX_CHANGE_LOG_BYTES);
        assertEquals(200L, store.localRecordCursor("ai"));
        JSONObject page = store.readRecords("ai", 1, 20);
        assertFalse(page.getBoolean("resetRequired"));assertEquals(200L, page.getLong("cursor"));
        assertEquals(200L, page.getJSONArray("records").getJSONObject(0).getLong("revision"));
        assertEquals(changeBytes("ai"), Long.parseLong(store.getMeta("ai", "record-change-bytes")));
    }

    @Test
    public void v3UpgradeRemovesOldGenerationAndRejectsItsCursor() throws Exception {
        JSONObject current = record("item", "item:current-generation", new JSONObject(), 1, "g-current");
        store.applyNativeRecord(current, null);
        android.database.sqlite.SQLiteDatabase db = store.getWritableDatabase();
        db.delete("record_changes", "scope='ai'", null);
        legacyChange(db, "ai", 1, "g-old", record("item", "item:gone", new JSONObject(), 1, "g-old").toString());
        legacyChange(db, "ai", 2, "g-current", current.toString());
        db.execSQL("UPDATE records SET change_seq=2 WHERE scope='ai'");
        db.execSQL("UPDATE local_sequences SET next_seq=3 WHERE scope='ai'");
        db.delete("meta", "key IN ('record-change-bytes','record-generation-floor')", null);
        db.setVersion(3);store.close();store = new SyncStore(context);
        assertEquals(2L, store.localRecordCursor("ai"));
        assertTrue(store.readRecords("ai", 1, 20).getBoolean("resetRequired"));
        JSONObject fresh = store.readRecords("ai", 0, 20);
        assertFalse(fresh.getBoolean("resetRequired"));assertEquals(1, fresh.getJSONArray("records").length());
        assertEquals(2L, fresh.getLong("cursor"));
        try (android.database.Cursor rows = store.getReadableDatabase().rawQuery(
                "SELECT COUNT(*) FROM record_changes WHERE scope='ai' AND source_generation='g-old'", null)) {
            assertTrue(rows.moveToFirst());assertEquals(0L, rows.getLong(0));
        }
    }

    private long changeBytes(String scope) {
        try (android.database.Cursor rows = store.getReadableDatabase().rawQuery(
                "SELECT COALESCE(SUM(length(CAST(record_json AS BLOB))),0) FROM record_changes WHERE scope=?", new String[]{scope})) {
            assertTrue(rows.moveToFirst());return rows.getLong(0);
        }
    }

    private static void legacyChange(android.database.sqlite.SQLiteDatabase db, String scope, long seq,
                                     String generation, String raw) {
        android.content.ContentValues row = new android.content.ContentValues();
        row.put("scope", scope);row.put("seq", seq);row.put("source_generation", generation);row.put("record_json", raw);
        db.insertOrThrow("record_changes", null, row);
    }

    @Test public void selectedThreadReadBypassesOtherThreadsAndDoesNotAdvanceCursor() throws Exception {
        String head="read:[\"thread/read\",{\"threadId\":\""+THREAD_ID+"\",\"includeTurns\":false}]";
        String summary="read:[\"thread/turns/list\",{\"threadId\":\""+THREAD_ID+"\",\"itemsView\":\"summary\",\"sortDirection\":\"desc\"}]";
        store.applyNativeRecord(record("catalog","thread:"+THREAD_ID,new JSONObject(),1),null);
        store.applyReadRecord(record("history",head,new JSONObject().put("result",new JSONObject().put("thread",new JSONObject().put("id",THREAD_ID))),2),null,"g-1");
        store.applyReadRecord(record("turn",summary,new JSONObject().put("result",new JSONObject().put("data",new JSONArray())),3),null,"g-1");
        for(int i=0;i<210;i++)store.applyReadRecord(record("item","read:[\"thread/items/list\",{\"cursor\":\""+i+"\"}]",new JSONObject(),4+i),null,"g-1");
        long cursor=store.localRecordCursor("ai");
        JSONObject result=store.readThreadRecords("ai",THREAD_ID);
        assertEquals(2,result.getJSONArray("records").length());
        assertTrue(containsKey(result.getJSONArray("records"),head));assertTrue(containsKey(result.getJSONArray("records"),summary));
        assertEquals(cursor,store.localRecordCursor("ai"));
        assertEquals(0,store.readThreadRecords("zyy",THREAD_ID).getJSONArray("records").length());
        assertEquals(0,store.readThreadRecords("ai",TURN_ID).getJSONArray("records").length());
    }

    @Test public void savedPagesSurviveProjectionResetAndProcessDeathWithoutAdvancingSync() throws Exception {
        String head="read:[\"thread/read\",{\"threadId\":\""+THREAD_ID+"\",\"includeTurns\":false}]";
        String summary="read:[\"thread/turns/list\",{\"threadId\":\""+THREAD_ID+"\",\"itemsView\":\"summary\",\"sortDirection\":\"desc\"}]";
        store.applyNativeRecord(record("history",head,new JSONObject().put("result",new JSONObject().put("thread",new JSONObject().put("id",THREAD_ID))),1),null);
        store.applyReadRecord(record("turn",summary,new JSONObject().put("result",new JSONObject().put("data",new JSONArray())),2),null,"g-1");
        store.resetGeneration("ai","g-2");long cursor=store.localRecordCursor("ai");store.close();store=new SyncStore(context);
        assertEquals(0,store.readThreadRecords("ai",THREAD_ID).getJSONArray("records").length());
        JSONObject saved=store.readSavedThreadRecords("ai",THREAD_ID);assertEquals("g-1",saved.getString("generation"));assertEquals(2,saved.getJSONArray("records").length());assertTrue(saved.getBoolean("saved"));
        assertEquals("g-1",store.readSavedRecord("ai",head).getJSONObject("record").getString("sourceGeneration"));
        assertEquals(cursor,store.localRecordCursor("ai"));assertEquals(0,store.readSavedThreadRecords("zyy",THREAD_ID).getJSONArray("records").length());
    }
    @Test public void readerArchivesRetainFullPagesAndExactCursorsWithoutBecomingCurrentProjection() throws Exception {
        String key="read:[\"thread/items/list\",{\"threadId\":\""+THREAD_ID+"\",\"turnId\":\""+TURN_ID+"\",\"cursor\":\"older-exact\"}]";
        store.resetGeneration("ai","g-2");long cursor=store.localRecordCursor("ai");
        store.saveReadRecord("ai",record("item",key,new JSONObject().put("result",new JSONObject().put("data",new JSONArray().put(new JSONObject().put("text","full process body"))).put("nextCursor","oldest")),3));
        store.saveReadRecord("ai",record("item",key,new JSONObject(),2));
        JSONObject saved=store.readSavedRecord("ai",key).getJSONObject("record");assertEquals(3,saved.getLong("revision"));assertEquals("oldest",saved.getJSONObject("payload").getJSONObject("result").getString("nextCursor"));
        assertEquals(cursor,store.localRecordCursor("ai"));assertEquals("g-2",store.catalogCursor("ai").generation);
        try{store.saveReadRecord("zyy",saved);org.junit.Assert.fail("cross scope archive accepted");}catch(IllegalArgumentException expected){}
    }
    @Test public void partialArchiveProgressIsDurableAndCannotBePromotedAfterSourceReset() throws Exception {
        store.resetGeneration("ai","g-1");JSONObject progress=new JSONObject().put("sourceGeneration","g-1").put("generation","thread-version").put("turnCursor","older").put("itemCursor","item-older").put("complete",false);
        store.saveArchiveProgress("ai",THREAD_ID,progress);store.close();store=new SyncStore(context);
        assertFalse(store.archiveProgress("ai",THREAD_ID).getBoolean("complete"));assertEquals("item-older",store.archiveProgress("ai",THREAD_ID).getString("itemCursor"));
        store.resetGeneration("ai","g-2");progress.put("complete",true);
        try{store.saveArchiveProgress("ai",THREAD_ID,progress);org.junit.Assert.fail("retired EOF accepted");}catch(org.json.JSONException expected){}
        assertFalse(store.archiveProgress("ai",THREAD_ID).getBoolean("complete"));
    }
    @Test public void evictionKeepsSavedHistoryAndRealDeletionCannotResurrectAfterReset() throws Exception {
        String head="read:[\"thread/read\",{\"threadId\":\""+THREAD_ID+"\",\"includeTurns\":false}]";
        JSONObject original=record("history",head,new JSONObject().put("result",new JSONObject().put("thread",new JSONObject().put("id",THREAD_ID))),1);
        store.applyNativeRecord(original,null);
        store.applyNativeRecord(record("history",head,new JSONObject().put("cacheEvicted",true),2).put("deleted",true),null);
        assertNotNull(store.readSavedRecord("ai",head).optJSONObject("record"));
        store.applyNativeRecord(record("history",head,new JSONObject(),3).put("payload",JSONObject.NULL).put("deleted",true),null);
        store.resetGeneration("ai","g-2");org.junit.Assert.assertNull(store.readSavedRecord("ai",head).optJSONObject("record"));
        try(android.database.Cursor rows=store.getReadableDatabase().rawQuery("SELECT count(*) FROM saved_records WHERE scope='ai' AND key=?",new String[]{head})){assertTrue(rows.moveToFirst());assertEquals(1,rows.getInt(0));}
    }
    @Test public void savedInitialSnapshotIsFoundBehindThreeHundredNewerItemPages() throws Exception {
        String head="read:[\"thread/read\",{\"threadId\":\""+THREAD_ID+"\",\"includeTurns\":false}]";
        String summary="read:[\"thread/turns/list\",{\"threadId\":\""+THREAD_ID+"\",\"itemsView\":\"summary\",\"sortDirection\":\"desc\"}]";
        store.saveReadRecord("ai",record("history",head,new JSONObject().put("result",new JSONObject().put("thread",new JSONObject().put("id",THREAD_ID))),1));
        store.saveReadRecord("ai",record("turn",summary,new JSONObject().put("result",new JSONObject().put("data",new JSONArray())),2));
        for(int i=0;i<300;i++)store.saveReadRecord("ai",record("item","read:[\"thread/items/list\",{\"threadId\":\""+THREAD_ID+"\",\"turnId\":\""+TURN_ID+"\",\"cursor\":\"page-"+i+"\"}]",new JSONObject().put("result",new JSONObject().put("data",new JSONArray())),3+i));
        assertEquals(2,store.readSavedThreadRecords("ai",THREAD_ID).getJSONArray("records").length());
        JSONObject old=store.readSavedRecord("ai",head).getJSONObject("record");store.saveReadRecord("ai",new JSONObject(old.toString()).put("sourceGeneration","new-source").put("generation","new-body").put("revision",500));
        JSONObject exact=store.readSavedRecord("ai",head,old.getString("sourceGeneration"),old.getString("generation")).getJSONObject("record");assertEquals(1,exact.getLong("revision"));
    }
    private static boolean containsKey(JSONArray values, String key) {
        for (int index = 0; index < values.length(); index++) {
            JSONObject value = values.optJSONObject(index);
            if (value != null && key.equals(value.optString("key", ""))) return true;
        }
        return false;
    }

    private static JSONObject record(String kind, String key, JSONObject payload, long revision) throws Exception {
        return record(kind, key, payload, revision, "g-1");
    }

    private static JSONObject record(String kind, String key, JSONObject payload, long revision,
                                     String sourceGeneration) throws Exception {
        return new JSONObject().put("scope", "ai")
                .put("key", key)
                .put("kind", kind)
                .put("threadId", THREAD_ID)
                .put("generation", sourceGeneration)
                .put("revision", revision)
                .put("payload", payload)
                .put("deleted", false)
                .put("sourceGeneration", sourceGeneration);
    }
}
