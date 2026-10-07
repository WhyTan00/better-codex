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
    private JSONObject webEvent()throws Exception{return new JSONObject().put("kind","send_flow").put("stage","accepted").put("eventId",java.util.UUID.randomUUID().toString()).put("clientAt",System.currentTimeMillis()).put("pageId","12345678");}
    private org.json.JSONArray handoff(String scope,org.json.JSONArray events)throws Exception{
        java.util.concurrent.CompletableFuture<org.json.JSONArray> result=new java.util.concurrent.CompletableFuture<>();log.acceptWebEvents(scope,events,result::complete);return result.get(5,TimeUnit.SECONDS);
    }
    @Test public void webHandoffFiltersSecretsAndAcknowledgesOnlyAfterDurableScopedCommit()throws Exception{
        JSONObject event=webEvent().put("text","PRIVATE").put("url","https://private/").put("errorFrames",new org.json.JSONArray().put("turn.js:12:3").put("PRIVATE")).put("rpcCode",-32603);
        String id=event.getString("eventId");org.json.JSONArray batch=new org.json.JSONArray().put(event);
        assertEquals(id,handoff("ai",batch).getString(0));assertTrue(exists(id));
        try(Cursor rows=database().rawQuery("SELECT payload,priority FROM outbox WHERE scope='ai' AND id=?",new String[]{id})){assertTrue(rows.moveToFirst());String raw=rows.getString(0);assertFalse(raw.contains("PRIVATE"));assertFalse(raw.contains("https://"));JSONObject saved=new JSONObject(raw);assertEquals("turn.js:12:3",saved.getJSONArray("errorFrames").getString(0));assertEquals(-32603,saved.getInt("rpcCode"));assertEquals(2,rows.getInt(1));}
        assertEquals(id,handoff("ai",batch).getString(0));assertNull(handoff("zyy",batch));assertNull(handoff("foreign",batch));
        stop();log=create();drain();assertTrue(exists(id));
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

}
