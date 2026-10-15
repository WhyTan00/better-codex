package top.whytan.dsh;

import static org.junit.Assert.*;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import java.lang.reflect.Field;
import java.lang.reflect.Constructor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=28,manifest=Config.NONE)
public class NativeDiagnosticsTest {
    private Context context; private NativeDiagnostics log; private Thread.UncaughtExceptionHandler previousHandler;
    private Object field(String name) throws Exception { Field f=NativeDiagnostics.class.getDeclaredField(name);f.setAccessible(true);return f.get(log); }
    private void drain() throws Exception { ((ExecutorService)field("writer")).submit(()->{}).get(5,TimeUnit.SECONDS); }
    private SQLiteDatabase database() throws Exception { return ((SQLiteOpenHelper)field("db")).getWritableDatabase(); }
    private NativeDiagnostics create() throws Exception { Constructor<NativeDiagnostics> ctor=NativeDiagnostics.class.getDeclaredConstructor(Context.class);ctor.setAccessible(true);return ctor.newInstance(context); }
    @Before public void setup() throws Exception {previousHandler=Thread.getDefaultUncaughtExceptionHandler();context=RuntimeEnvironment.getApplication();android.webkit.CookieManager.getInstance();context.deleteDatabase("native-diagnostics-v1.db");log=create();drain();}
    private void stop() throws Exception {for(String name:new String[]{"writer","network"}){ExecutorService executor=(ExecutorService)field(name);executor.shutdownNow();assertTrue(executor.awaitTermination(5,TimeUnit.SECONDS));}((SQLiteOpenHelper)field("db")).close();}
    @After public void teardown() throws Exception {stop();Thread.setDefaultUncaughtExceptionHandler(previousHandler);context.deleteDatabase("native-diagnostics-v1.db");}
    @Test public void rejectsPrivateFieldsAndInvalidScope() throws Exception {
        JSONObject input=new JSONObject().put("reason","secret-token-value").put("url","https://private/?token=secret").put("message","private body").put("cookie","private cookie").put("threadId","private string").put("statusCode",503).put("durationMs",-1);
        JSONObject value=NativeDiagnostics.safeFields(input);
        assertEquals("unknown",value.getString("reason"));assertEquals(503,value.getInt("statusCode"));assertFalse(value.has("url"));assertFalse(value.has("message"));assertFalse(value.has("cookie"));assertFalse(value.has("threadId"));assertFalse(value.has("durationMs"));
        log.event("foreign","android-sync","connected",input);drain();try(Cursor rows=database().rawQuery("SELECT COUNT(*) FROM outbox",null)){assertTrue(rows.moveToFirst());assertEquals(0,rows.getInt(0));}
    }
    @Test public void actualBridgeMethodsKeepTheirSafeIdentityWithoutAcceptingPrivateStrings() throws Exception {
        for(String method:new String[]{"scopeSession","presentConversation","readSavedThreadRecords","readBodyWitness","readSavedRecord","saveReadRecord","saveVisibleProcesses","readVisibleProcesses","invalidateVisibleProcesses"}){
            JSONObject safe=NativeDiagnostics.safeFields(new JSONObject().put("method",method).put("message","private body").put("durationMs",137));
            assertEquals(method,safe.getString("method"));assertEquals(137,safe.getInt("durationMs"));assertFalse(safe.has("message"));
        }
        assertFalse(NativeDiagnostics.safeFields(new JSONObject().put("method","PRIVATE_SECRET")).has("method"));
    }
    @Test public void survivesLoggerRecreationWithoutWebViewOrNetwork() throws Exception {
        log.event("ai","android-sync","received",new JSONObject().put("reason","socket_open"));drain();String id;
        try(Cursor rows=database().rawQuery("SELECT id,payload FROM outbox WHERE scope='ai'",null)){assertTrue(rows.moveToFirst());id=rows.getString(0);assertEquals("received",new JSONObject(rows.getString(1)).getString("stage"));}
        stop();log=create();drain();try(Cursor rows=database().rawQuery("SELECT id FROM outbox WHERE scope='ai'",null)){assertTrue(rows.moveToFirst());assertEquals(id,rows.getString(0));}
    }
    @Test public void scopeBoundAndDropAccountingUseRealTransactions() throws Exception {
        SQLiteDatabase sql=database();long now=System.currentTimeMillis();sql.beginTransaction();try{for(int i=0;i<2002;i++)sql.execSQL("INSERT INTO outbox(id,scope,at,payload) VALUES(?,?,?,?)",new Object[]{"seed-"+i,"ai",now-1,"{}"});sql.execSQL("INSERT INTO outbox(id,scope,at,payload) VALUES(?,?,?,?)",new Object[]{"other-scope","zyy",now,"{}"});sql.setTransactionSuccessful();}finally{sql.endTransaction();}
        log.event("ai","android-store","committed",new JSONObject());drain();
        try(Cursor rows=sql.rawQuery("SELECT COUNT(*) FROM outbox WHERE scope='ai'",null)){assertTrue(rows.moveToFirst());assertEquals(2000,rows.getInt(0));}
        try(Cursor rows=sql.rawQuery("SELECT COUNT(*) FROM outbox WHERE scope='zyy'",null)){assertTrue(rows.moveToFirst());assertEquals(1,rows.getInt(0));}
        try(Cursor rows=sql.rawQuery("SELECT value FROM metrics WHERE scope='ai' AND name='journalDropped'",null)){assertTrue(rows.moveToFirst());assertEquals(3,rows.getInt(0));}
        try(Cursor rows=sql.rawQuery("SELECT priority FROM outbox WHERE scope='ai' AND id NOT LIKE 'seed-%'",null)){assertTrue(rows.moveToFirst());assertEquals(0,rows.getInt(0));}
    }
    @Test public void notificationHistoryAndErrorMilestonesUseCriticalRetentionTier() throws Exception {
        assertEquals(0,NativeDiagnostics.retentionPriority("android-app","received",new JSONObject().put("reason","periodic")));
        assertEquals(2,NativeDiagnostics.retentionPriority("android-webview","received",new JSONObject().put("reason","notification_open")));
        assertEquals(2,NativeDiagnostics.retentionPriority("android-sync","received",new JSONObject().put("reason","history_rejected")));
        assertEquals(2,NativeDiagnostics.retentionPriority("android-notification","shown",new JSONObject().put("reason","completion_posted")));
        assertEquals(0,NativeDiagnostics.retentionPriority("android-notification","shown",new JSONObject().put("reason","periodic")));
        assertEquals(0,NativeDiagnostics.retentionPriority("android-sync","committed",new JSONObject().put("reason","history_committed")));
        assertEquals(2,NativeDiagnostics.retentionPriority("android-sync","failed",new JSONObject().put("reason","request_failed")));
        assertEquals(0,NativeDiagnostics.retentionPriority("android-notification","attempt",new JSONObject().put("reason","periodic")));
        assertEquals(0,NativeDiagnostics.retentionPriority("android-sync","received",new JSONObject().put("reason","request_received")));
    }
    @Test public void reservedAdmissionSlotsKeepPriorityEventsWhenWriterIsBacklogged() throws Exception {
        drain();
        ScheduledExecutorService executor=(ScheduledExecutorService)field("writer");
        CountDownLatch started=new CountDownLatch(1), release=new CountDownLatch(1);
        executor.execute(() -> { started.countDown(); try { release.await(5,TimeUnit.SECONDS); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); } });
        assertTrue(started.await(5,TimeUnit.SECONDS));
        JSONObject normal=new JSONObject().put("reason","request_received");
        for(int i=0;i<112;i++) log.event("ai","android-sync","received",normal);
        log.event("ai","android-sync","received",normal);
        log.event("ai","android-notification","shown",new JSONObject().put("reason","completion_posted"));
        assertEquals(113,((java.util.concurrent.atomic.AtomicInteger)field("queued")).get());
        assertEquals(112,((java.util.concurrent.atomic.AtomicInteger)field("queuedNormal")).get());
        assertEquals(1,((java.util.concurrent.atomic.AtomicLong)field("rejected")).get());
        release.countDown();
        drain();
        try(Cursor rows=database().rawQuery("SELECT COUNT(*) FROM outbox WHERE scope='ai'",null)){assertTrue(rows.moveToFirst());assertEquals(113,rows.getInt(0));}
        try(Cursor rows=database().rawQuery("SELECT COUNT(*) FROM outbox WHERE scope='ai' AND priority=2",null)){assertTrue(rows.moveToFirst());assertEquals(1,rows.getInt(0));}
    }
    private void answer(String body) throws Exception {
        okhttp3.OkHttpClient client=new okhttp3.OkHttpClient.Builder().addInterceptor(chain->new okhttp3.Response.Builder()
            .request(chain.request()).protocol(okhttp3.Protocol.HTTP_1_1).code(200).message("OK")
            .body(okhttp3.ResponseBody.create(body,okhttp3.MediaType.parse("application/json"))).build()).build();
        Field http=NativeDiagnostics.class.getDeclaredField("http");http.setAccessible(true);http.set(log,client);
    }
    private void upload(String body,java.util.Set<String> sent) throws Exception {
        answer(body);java.lang.reflect.Method method=NativeDiagnostics.class.getDeclaredMethod("upload",String.class,String.class,String.class,String.class,java.util.Set.class);method.setAccessible(true);
        method.invoke(log,"ai","https://workbench.example.test/sync/v1/w/ai/performance","test_cookie","{}",sent);drain();
    }
    private String seed(String scope) throws Exception {log.event(scope,"android-sync","received",new JSONObject());drain();try(Cursor rows=database().rawQuery("SELECT id FROM outbox WHERE scope=? ORDER BY rowid DESC LIMIT 1",new String[]{scope})){assertTrue(rows.moveToFirst());return rows.getString(0);}}
    private boolean exists(String id) throws Exception {try(Cursor rows=database().rawQuery("SELECT id FROM outbox WHERE id=?",new String[]{id})){return rows.moveToFirst();}}
    @Test public void newWebEventsCannotBypassFailedUploadCooldown() throws Exception {
        String id=seed("ai");upload("{}",java.util.Collections.singleton(id));
        android.webkit.CookieManager.getInstance().setCookie("https://workbench.example.test","qa=test");
        java.util.concurrent.atomic.AtomicInteger requests=new java.util.concurrent.atomic.AtomicInteger();
        okhttp3.OkHttpClient http=new okhttp3.OkHttpClient.Builder().addInterceptor(chain->{requests.incrementAndGet();throw new java.io.IOException("offline fixture");}).build();
        Field client=NativeDiagnostics.class.getDeclaredField("http");client.setAccessible(true);client.set(log,http);
        for(int i=0;i<10;i++){JSONObject event=webEvent();assertNotNull(handoff("ai",new org.json.JSONArray().put(event)));assertTrue(exists(event.getString("eventId")));log.flush("ai");}
        drain();((ExecutorService)field("network")).submit(()->{}).get(5,TimeUnit.SECONDS);drain();
        assertEquals(0,requests.get());assertTrue(exists(id));
        org.robolectric.shadows.ShadowSystemClock.advanceBy(java.time.Duration.ofSeconds(31));
        log.flush("ai");drain();((ExecutorService)field("network")).submit(()->{}).get(5,TimeUnit.SECONDS);drain();
        assertEquals(1,requests.get());assertTrue(exists(id));
        android.webkit.CookieManager.getInstance().removeAllCookies(null);
    }
    private JSONObject webEvent()throws Exception{return new JSONObject().put("kind","send_flow").put("stage","accepted").put("eventId",java.util.UUID.randomUUID().toString()).put("clientAt",System.currentTimeMillis()).put("pageId","12345678");}
    private org.json.JSONArray handoff(String scope,org.json.JSONArray events)throws Exception{
        java.util.concurrent.CompletableFuture<org.json.JSONArray> result=new java.util.concurrent.CompletableFuture<>();log.acceptWebEvents(scope,events,result::complete);return result.get(5,TimeUnit.SECONDS);
    }
    @Test public void fullProtectedOutboxCommitsNewFaultAndReportsOrdinaryRetentionDropSeparately()throws Exception{
        long now=System.currentTimeMillis();SQLiteDatabase sql=database();sql.beginTransaction();try{
            for(int i=0;i<2000;i++){JSONObject event=webEvent().put("clientAt",now-10000+i);android.content.ContentValues row=new android.content.ContentValues();row.put("id",event.getString("eventId"));row.put("scope","ai");row.put("at",event.getLong("clientAt"));row.put("priority",2);row.put("payload",event.toString());sql.insertOrThrow("outbox",null,row);}sql.setTransactionSuccessful();
        }finally{sql.endTransaction();}
        JSONObject ordinary=webEvent().put("kind","client_health").put("stage","received").put("component","page-ws"),fault=webEvent().put("kind","history_applied");
        java.util.concurrent.CompletableFuture<JSONObject> result=new java.util.concurrent.CompletableFuture<>();log.acceptWebEventsReceipt("ai",new org.json.JSONArray().put(ordinary).put(fault),result::complete);JSONObject receipt=result.get(5,TimeUnit.SECONDS);
        assertNotNull(receipt);assertTrue(receipt.getBoolean("received"));assertEquals(fault.getString("eventId"),receipt.getJSONArray("acknowledgedEventIds").getString(0));assertEquals(ordinary.getString("eventId"),receipt.getJSONArray("discardedEventIds").getString(0));assertTrue(exists(fault.getString("eventId")));assertFalse(exists(ordinary.getString("eventId")));
        try(Cursor count=sql.rawQuery("SELECT COUNT(*) FROM outbox WHERE scope='ai'",null)){assertTrue(count.moveToFirst());assertEquals(2000,count.getInt(0));}
    }
    @Test public void webHandoffFiltersSecretsAndAcknowledgesOnlyAfterDurableScopedCommit()throws Exception{
        JSONObject event=webEvent().put("text","PRIVATE").put("url","https://private/").put("errorFrames",new org.json.JSONArray().put("turn.js:12:3").put("PRIVATE")).put("rpcCode",-32603);
        String id=event.getString("eventId");org.json.JSONArray batch=new org.json.JSONArray().put(event);
        assertEquals(id,handoff("ai",batch).getString(0));assertTrue(exists(id));
        try(Cursor rows=database().rawQuery("SELECT payload,priority FROM outbox WHERE scope='ai' AND id=?",new String[]{id})){assertTrue(rows.moveToFirst());String raw=rows.getString(0);assertFalse(raw.contains("PRIVATE"));assertFalse(raw.contains("https://"));JSONObject saved=new JSONObject(raw);assertEquals("turn.js:12:3",saved.getJSONArray("errorFrames").getString(0));assertEquals(-32603,saved.getInt("rpcCode"));assertEquals(2,rows.getInt(1));}
        assertEquals(id,handoff("ai",batch).getString(0));assertNull(handoff("zyy",batch));assertNull(handoff("foreign",batch));
        stop();log=create();drain();assertTrue(exists(id));
    }
    @Test public void webLayoutNotificationKeepsItsClassificationAcrossDurableHandoff()throws Exception{
        JSONObject event=webEvent().put("kind","render_error").put("reason","resize_observer")
            .put("failureClass","layout_observer").put("text","PRIVATE_LAYOUT_TEXT");
        String id=event.getString("eventId");assertEquals(id,handoff("ai",new org.json.JSONArray().put(event)).getString(0));
        try(Cursor rows=database().rawQuery("SELECT payload FROM outbox WHERE scope='ai' AND id=?",new String[]{id})){
            assertTrue(rows.moveToFirst());String raw=rows.getString(0);assertFalse(raw.contains("PRIVATE_LAYOUT_TEXT"));
            JSONObject saved=new JSONObject(raw);assertEquals("resize_observer",saved.getString("reason"));assertEquals("layout_observer",saved.getString("failureClass"));
        }
    }
    @Test public void nativeStoreSeparatesMonitorWaitFromCommitAndRetainsItsReason()throws Exception{
        Field singleton=NativeDiagnostics.class.getDeclaredField("instance");singleton.setAccessible(true);Object prior=singleton.get(null);singleton.set(null,log);
        context.deleteDatabase("native-sync-v1.sqlite");SyncStore store=new SyncStore(context);ExecutorService work=java.util.concurrent.Executors.newSingleThreadExecutor();
        String trace=java.util.UUID.randomUUID().toString();java.util.concurrent.atomic.AtomicReference<Thread> worker=new java.util.concurrent.atomic.AtomicReference<>();
        JSONObject record=new JSONObject().put("scope","ai").put("key","thread:11111111-1111-4111-a111-111111111111").put("kind","catalog")
            .put("threadId","11111111-1111-4111-a111-111111111111").put("generation","test-source").put("sourceGeneration","test-source")
            .put("revision",1).put("deleted",false).put("payload",new JSONObject());
        try{
            java.util.concurrent.Future<?> pending;
            synchronized(store){
                pending=work.submit(()->{worker.set(Thread.currentThread());try{store.applyNativeRecord(record,trace);}catch(Exception e){throw new RuntimeException(e);}});
                long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(2);
                while((worker.get()==null||worker.get().getState()!=Thread.State.BLOCKED)&&System.nanoTime()<deadline)Thread.yield();
                assertNotNull(worker.get());assertEquals(Thread.State.BLOCKED,worker.get().getState());
                org.robolectric.shadows.ShadowSystemClock.advanceBy(java.time.Duration.ofMillis(301));
            }
            pending.get(5,TimeUnit.SECONDS);drain();int stages=0;
            try(Cursor rows=database().rawQuery("SELECT payload FROM outbox WHERE scope='ai' ORDER BY rowid",null)){
                while(rows.moveToNext()){
                    JSONObject saved=new JSONObject(rows.getString(0));if(!trace.equals(saved.optString("traceId")))continue;
                    assertEquals("store_committed",saved.getString("reason"));
                    if("started".equals(saved.getString("stage")))assertEquals(301,saved.getLong("durationMs"));
                    if("committed".equals(saved.getString("stage")))assertEquals(0,saved.getLong("durationMs"));
                    stages++;
                }
            }assertEquals(3,stages);
        }finally{work.shutdownNow();store.close();context.deleteDatabase("native-sync-v1.sqlite");singleton.set(null,prior);}
    }
    @Test public void failedWebCommitCannotAcknowledgeOrPartiallyRemoveClientEvidence()throws Exception{
        JSONObject first=webEvent(),second=webEvent();database().execSQL("CREATE TRIGGER reject_web BEFORE INSERT ON outbox WHEN NEW.id='"+second.getString("eventId")+"' BEGIN SELECT RAISE(ABORT,'disk failure'); END");
        assertNull(handoff("ai",new org.json.JSONArray().put(first).put(second)));assertFalse(exists(first.getString("eventId")));assertFalse(exists(second.getString("eventId")));
        database().execSQL("DROP TRIGGER reject_web");assertEquals(2,handoff("ai",new org.json.JSONArray().put(first).put(second)).length());
    }
    @Test public void genericOrForgedAcknowledgementCannotErasePendingLogs() throws Exception {
        String a=seed("ai"),b=seed("ai"),other=seed("zyy");
        upload("{\"received\":true}",java.util.Set.of(a,b));assertTrue(exists(a));assertTrue(exists(b));
        upload(new JSONObject().put("received",true).put("acknowledgedEventIds",new org.json.JSONArray().put(a).put(other)).toString(),java.util.Set.of(a,b));
        assertFalse(exists(a));assertTrue(exists(b));assertTrue(exists(other));
    }
    @Test public void failedAckTransactionRetainsWholeBatch() throws Exception {
        String a=seed("ai"),b=seed("ai");database().execSQL("CREATE TRIGGER reject_ack BEFORE DELETE ON outbox BEGIN SELECT RAISE(ABORT,'disk failure'); END");
        upload(new JSONObject().put("received",true).put("acknowledgedEventIds",new org.json.JSONArray().put(a).put(b)).toString(),java.util.Set.of(a,b));
        assertTrue(exists(a));assertTrue(exists(b));database().execSQL("DROP TRIGGER reject_ack");
    }

    @Test public void crashMarkerIsPrivateAndImportedOnceOnNextStartup() throws Exception {
        java.lang.reflect.Method method=NativeDiagnostics.class.getDeclaredMethod("crashMarker",String.class,Throwable.class);method.setAccessible(true);
        method.invoke(log,"ai",new IllegalStateException("PRIVATE RAW ERROR WITH CREDENTIAL"));
        java.io.File file=new java.io.File(context.getFilesDir(),"native-crash-ai.json");assertTrue(file.exists());
        String raw=new String(java.nio.file.Files.readAllBytes(file.toPath()),java.nio.charset.StandardCharsets.UTF_8);assertFalse(raw.contains("PRIVATE"));
        String id=new JSONObject(raw).getString("eventId");stop();log=create();drain();assertTrue(exists(id));assertFalse(file.exists());
        try(Cursor rows=database().rawQuery("SELECT payload FROM outbox WHERE id=?",new String[]{id})){assertTrue(rows.moveToFirst());JSONObject event=new JSONObject(rows.getString(0));assertEquals("uncaught_exception",event.getString("reason"));assertEquals("IllegalStateException",event.getString("errorName"));}
    }

    @Test public void slowBridgeAndHistoryRejectionsStayAboveRoutinePolling()throws Exception {
        assertEquals(2,NativeDiagnostics.retentionPriority("android-bridge","committed",new JSONObject().put("durationMs",8000).put("method","readRecords")));
        assertEquals(2,NativeDiagnostics.retentionPriority("android-webview","received",new JSONObject().put("kind","history_rejected")));
        assertEquals(0,NativeDiagnostics.retentionPriority("android-bridge","received",new JSONObject().put("durationMs",10)));
    }

    @Test public void storeSummaryWhitelistRetainsOnlyFixedPhasesNumbersAndExceptionClasses() throws Exception {
        JSONObject input=new JSONObject().put("scope","ai").put("storePhase","insert").put("storeWaitMs",11).put("storeOpenMs",12).put("storeQueryMs",13).put("storeDecodeMs",14)
                .put("storeMetadataMs",15).put("storeValidateMs",16).put("storeSerializeMs",17).put("storeWriteMs",18)
                .put("errorName","SQLiteFullException").put("failureClass","storage").put("message","PRIVATE_BODY")
                .put("sql","PRIVATE_SQL").put("path","PRIVATE_PATH").put("token","PRIVATE_TOKEN").put("cookie","PRIVATE_COOKIE");
        JSONObject safe=NativeDiagnostics.safeFields(input);assertEquals("ai",safe.getString("scope"));assertEquals(11,safe.getLong("storeWaitMs"));assertEquals("insert",safe.getString("storePhase"));assertEquals("SQLiteFullException",safe.getString("errorName"));
        assertEquals(18,safe.getInt("storeWriteMs"));assertFalse(safe.toString().contains("PRIVATE"));
        assertFalse(NativeDiagnostics.safeFields(input.put("scope","PRIVATE_SCOPE")).has("scope"));
        assertFalse(NativeDiagnostics.safeFields(input.put("storePhase","PRIVATE_PHASE")).has("storePhase"));
        assertFalse(NativeDiagnostics.safeFields(input.put("storeOpenMs",-1)).has("storeOpenMs"));
        assertEquals("JSONException",NativeDiagnostics.storeErrorName(new org.json.JSONException("PRIVATE_JSON")));
        assertEquals("SQLiteFullException",NativeDiagnostics.storeErrorName(new android.database.sqlite.SQLiteFullException("PRIVATE_DISK")));
    }
}
