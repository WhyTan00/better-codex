package top.whytan.dsh;

import static org.junit.Assert.*;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.os.Looper;
import android.os.SystemClock;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.JavaScriptExecutionException;
import androidx.webkit.WebViewOutcomeReceiver;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.*;
import org.json.JSONObject;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import org.robolectric.shadows.ShadowSystemClock;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=28,manifest=Config.NONE)
@LooperMode(LooperMode.Mode.PAUSED)
public class NativeBridgeTimingTest {
    private static final String ID="11111111-1111-4111-a111-111111111111";
    private NativeBridge bridge; private NativeDiagnostics log; private Thread.UncaughtExceptionHandler oldHandler; private Object priorDiagnostics;
    private Object field(Object o,String name)throws Exception {Field f=o.getClass().getDeclaredField(name);f.setAccessible(true);return f.get(o);}
    private Object invoke(String name,Class<?>[] types,Object... args)throws Exception {Method m=NativeBridge.class.getDeclaredMethod(name,types);m.setAccessible(true);return m.invoke(bridge,args);}
    private SQLiteDatabase db()throws Exception {return ((SQLiteOpenHelper)field(log,"db")).getWritableDatabase();}
    private void drain()throws Exception {((ExecutorService)field(log,"writer")).submit(()->{}).get(3,TimeUnit.SECONDS);}
    @SuppressWarnings("unchecked") private void received(String method)throws Exception {
        ((Map<String,Long>)field(bridge,"bridgeStartedAt")).put("ai\u0000"+ID,SystemClock.elapsedRealtime());
        ((Map<String,String>)field(bridge,"bridgeMethods")).put("ai\u0000"+ID,method);
    }
    @Before public void setup()throws Exception {
        oldHandler=Thread.getDefaultUncaughtExceptionHandler();Context context=RuntimeEnvironment.getApplication();android.webkit.CookieManager.getInstance();context.deleteDatabase("native-diagnostics-v1.db");
        Field singleton=NativeDiagnostics.class.getDeclaredField("instance");singleton.setAccessible(true);priorDiagnostics=singleton.get(null);
        java.lang.reflect.Constructor<NativeDiagnostics> ctor=NativeDiagnostics.class.getDeclaredConstructor(Context.class);ctor.setAccessible(true);log=ctor.newInstance(context);singleton.set(null,log);
        bridge=new NativeBridge(context,null,null,null,()->{},()->{},null,()->{},null,null);drain();
    }
    @After public void cleanup()throws Exception {
        bridge.close();((ExecutorService)field(bridge,"projectionWorker")).awaitTermination(3,TimeUnit.SECONDS);for(String name:new String[]{"writer","network"}){ExecutorService e=(ExecutorService)field(log,name);e.shutdownNow();assertTrue(e.awaitTermination(3,TimeUnit.SECONDS));}
        ((SQLiteOpenHelper)field(log,"db")).close();Field f=NativeDiagnostics.class.getDeclaredField("instance");f.setAccessible(true);f.set(null,priorDiagnostics);Thread.setDefaultUncaughtExceptionHandler(oldHandler);
    }
    @Test public void slowWorkerQueueIsSeparateFromTheWorkAndDoesNotBlockTheUiCaller()throws Exception {
        ExecutorService worker=(ExecutorService)field(bridge,"worker");CountDownLatch began=new CountDownLatch(1),release=new CountDownLatch(1),done=new CountDownLatch(1);
        worker.execute(()->{began.countDown();try{release.await(3,TimeUnit.SECONDS);}catch(InterruptedException e){Thread.currentThread().interrupt();}});assertTrue(began.await(3,TimeUnit.SECONDS));received("readSavedThreadRecords");
        invoke("executeBridgeWork",new Class[]{String.class,String.class,Runnable.class},"ai",ID,(Runnable)done::countDown);assertEquals(1,done.getCount());ShadowSystemClock.advanceBy(Duration.ofMillis(500));release.countDown();assertTrue(done.await(3,TimeUnit.SECONDS));drain();
        try(Cursor c=db().rawQuery("SELECT payload FROM outbox",null)){assertTrue(c.moveToFirst());JSONObject row=new JSONObject(c.getString(0));assertEquals("started",row.getString("stage"));assertEquals("readSavedThreadRecords",row.getString("method"));assertEquals(ID,row.getString("traceId"));assertTrue(row.getLong("durationMs")>=500);assertFalse(c.moveToNext());}
    }
    @Test public void fastQueueDoesNotCreateMoreLogs()throws Exception {
        received("readSavedRecord");CountDownLatch done=new CountDownLatch(1);invoke("executeBridgeWork",new Class[]{String.class,String.class,Runnable.class},"ai",ID,(Runnable)done::countDown);assertTrue(done.await(3,TimeUnit.SECONDS));drain();
        try(Cursor c=db().rawQuery("SELECT COUNT(*) FROM outbox",null)){assertTrue(c.moveToFirst());assertEquals(0,c.getInt(0));}
    }
    @Test public void slowMainHandoffUsesActualDeliveryAndNeverLogsTheReplyBody()throws Exception {
        String[] delivered={null};JavaScriptReplyProxy target=new JavaScriptReplyProxy(){public void postMessage(String value){delivered[0]=value;}public void postMessage(byte[] value){}public void executeJavaScript(String code,WebViewOutcomeReceiver<String,JavaScriptExecutionException> r){}};
        invoke("post",new Class[]{JavaScriptReplyProxy.class,String.class,String.class,String.class,String.class},target,"private reply body","ai",ID,"readSavedRecord");assertNull(delivered[0]);ShadowSystemClock.advanceBy(Duration.ofMillis(500));Shadows.shadowOf(Looper.getMainLooper()).idle();assertEquals("private reply body",delivered[0]);drain();
        try(Cursor c=db().rawQuery("SELECT payload FROM outbox",null)){assertTrue(c.moveToFirst());String raw=c.getString(0);JSONObject row=new JSONObject(raw);assertEquals("received",row.getString("stage"));assertEquals("bridge_reply",row.getString("reason"));assertEquals("readSavedRecord",row.getString("method"));assertTrue(row.getLong("durationMs")>=500);assertFalse(raw.contains("private reply body"));assertFalse(c.moveToNext());}
    }
    @Test public void stateAndDiagnosticRequestsLeaveTheUiFreeAndUseTheExistingStore()throws Exception{
        Context context=RuntimeEnvironment.getApplication();context.deleteDatabase("native-sync-v1.sqlite");SyncStore store=new SyncStore(context);
        UiReleaseStore ui=new UiReleaseStore(context);bridge.close();bridge=new NativeBridge(context,null,store,ui,()->{},()->{},null,()->{},null,null);
        try{
            store.setState("ai",new JSONObject().put("state","saved-native-state"));
            ExecutorService worker=(ExecutorService)field(bridge,"worker");
            for(String method:new String[]{"status","requestSync","diagnosticContext"}){
                CountDownLatch held=new CountDownLatch(1),release=new CountDownLatch(1);String[] delivered={null};
                worker.execute(()->{held.countDown();try{release.await(3,TimeUnit.SECONDS);}catch(InterruptedException e){Thread.currentThread().interrupt();}});assertTrue(held.await(3,TimeUnit.SECONDS));received(method);
                JavaScriptReplyProxy target=new JavaScriptReplyProxy(){public void postMessage(String s){delivered[0]=s;}public void postMessage(byte[] s){}public void executeJavaScript(String s,WebViewOutcomeReceiver<String,JavaScriptExecutionException> r){}};
                invoke("dispatch",new Class[]{JSONObject.class,String.class,String.class,JavaScriptReplyProxy.class},new JSONObject().put("method",method),ID,"ai",target);
                boolean[] uiRan={false};new android.os.Handler(Looper.getMainLooper()).post(()->uiRan[0]=true);Shadows.shadowOf(Looper.getMainLooper()).idle();assertTrue(uiRan[0]);assertNull("request must wait off the UI thread",delivered[0]);
                release.countDown();worker.submit(()->{}).get(3,TimeUnit.SECONDS);Shadows.shadowOf(Looper.getMainLooper()).idle();JSONObject response=new JSONObject(delivered[0]);assertTrue(response.toString(),response.getBoolean("ok"));JSONObject result=response.getJSONObject("result");
                if(!method.equals("diagnosticContext"))assertEquals("saved-native-state",result.getString("state"));
                else assertTrue(result.has("deviceId"));
                if(method.equals("status")){JSONObject identity=result.getJSONObject("nativeDiagnostics");assertTrue(NativeDiagnostics.isUuid(identity.getString("deviceId")));assertEquals(BuildConfig.VERSION_CODE,identity.getInt("apkVersion"));String output=System.getenv("DSH_NATIVE_STATUS_FIXTURE");if(output!=null)java.nio.file.Files.write(java.nio.file.Paths.get(output),result.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));}
            }
        }finally{bridge.close();store.close();ui.close();context.deleteDatabase("native-sync-v1.sqlite");}
    }
    @Test public void sourceOnlyLocalReadUsesTheArchiveWithoutCrossingSourceVersions()throws Exception{
        String fixture=System.getenv("DSH_NATIVE_LOCAL_READ_REQUEST");
        JSONObject request=fixture==null?new JSONObject().put("method","readSavedRecord").put("preferCurrent",true).put("sourceGeneration","current-source")
            .put("key","read:[\"thread/read\",{\"threadId\":\""+ID+"\",\"includeTurns\":false}]")
            :new JSONObject(new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(fixture)),java.nio.charset.StandardCharsets.UTF_8));
        assertEquals("readSavedRecord",request.getString("method"));assertTrue(request.getBoolean("preferCurrent"));assertFalse(request.has("generation"));
        Context context=RuntimeEnvironment.getApplication();context.deleteDatabase("native-sync-v1.sqlite");SyncStore store=new SyncStore(context);UiReleaseStore ui=new UiReleaseStore(context);
        bridge.close();bridge=new NativeBridge(context,null,store,ui,()->{},()->{},null,()->{},null,null);
        try{
            String key=request.getString("key"),source=request.getString("sourceGeneration");
            JSONObject record=new JSONObject().put("scope","ai").put("key",key).put("kind","history").put("threadId",ID).put("sourceGeneration",source)
                .put("generation","body-version").put("revision",1).put("deleted",false).put("payload",new JSONObject().put("result",new JSONObject().put("thread",new JSONObject().put("id",ID))));
            store.saveReadRecord("ai",record);
            store.saveReadRecord("ai",new JSONObject(record.toString()).put("sourceGeneration","another-source").put("revision",2));
            long cursor=store.localRecordCursor("ai");String[] delivered={null};
            JavaScriptReplyProxy target=new JavaScriptReplyProxy(){public void postMessage(String s){delivered[0]=s;}public void postMessage(byte[] s){}public void executeJavaScript(String s,WebViewOutcomeReceiver<String,JavaScriptExecutionException> r){}};
            received("readSavedRecord");invoke("dispatch",new Class[]{JSONObject.class,String.class,String.class,JavaScriptReplyProxy.class},request,ID,"ai",target);
            ((ExecutorService)field(bridge,"projectionWorker")).submit(()->{}).get(3,TimeUnit.SECONDS);Shadows.shadowOf(Looper.getMainLooper()).idle();
            JSONObject response=new JSONObject(delivered[0]);assertTrue(response.toString(),response.getBoolean("ok"));
            assertEquals(source,response.getJSONObject("result").getJSONObject("record").getString("sourceGeneration"));
            assertNull(store.readLocalRecord("zyy",key,source,"").optJSONObject("record"));
            assertNull(store.readLocalRecord("ai",key,"missing-source","").optJSONObject("record"));
            assertNull(store.readLocalRecord("ai",key,source,"wrong-body-version").optJSONObject("record"));
            assertEquals(cursor,store.localRecordCursor("ai"));
            try{store.readSavedRecord("ai",key,source,"");fail("Exact archive identity must still require the version pair");}catch(IllegalArgumentException expected){}
        }finally{bridge.close();store.close();ui.close();context.deleteDatabase("native-sync-v1.sqlite");}
    }
    @Test public void selectedProjectionReadAndDurableWriteBypassHeldBulkWorkerAndStoreMonitor()throws Exception {
        Context context=RuntimeEnvironment.getApplication();context.deleteDatabase("native-sync-v1.sqlite");SyncStore store=new SyncStore(context);store.localRecordCursor("ai");bridge.close();bridge=new NativeBridge(context,null,store,null,()->{},()->{},null,()->{},null,null);
        ExecutorService worker=(ExecutorService)field(bridge,"worker");CountDownLatch held=new CountDownLatch(1),release=new CountDownLatch(1);
        worker.execute(()->{synchronized(store){held.countDown();try{release.await(3,TimeUnit.SECONDS);}catch(InterruptedException e){Thread.currentThread().interrupt();}}});assertTrue(held.await(3,TimeUnit.SECONDS));
        try{
            String turn="22222222-2222-4222-a222-222222222222";JSONObject value=new JSONObject().put("schemaVersion",1).put("scope","ai").put("threadId",ID).put("turnId",turn).put("sourceGeneration","source").put("generation","history").put("savedAt",System.currentTimeMillis()).put("turnStartedAtMs",1000).put("items",new org.json.JSONArray().put(new JSONObject().put("id","final").put("type","agentMessage").put("phase","final_answer").put("text","done"))).put("order",new org.json.JSONArray().put("final"));
            String[] delivered={null};JavaScriptReplyProxy target=new JavaScriptReplyProxy(){public void postMessage(String s){delivered[0]=s;}public void postMessage(byte[] s){}public void executeJavaScript(String s,WebViewOutcomeReceiver<String,JavaScriptExecutionException> r){}};
            received("saveVisibleProcesses");invoke("dispatch",new Class[]{JSONObject.class,String.class,String.class,JavaScriptReplyProxy.class},new JSONObject().put("method","saveVisibleProcesses").put("value",value),ID,"ai",target);
            ((ExecutorService)field(bridge,"projectionWorker")).submit(()->{}).get(2,TimeUnit.SECONDS);Shadows.shadowOf(Looper.getMainLooper()).idle();assertNotNull("projection write cannot wait for bulk work",delivered[0]);assertTrue(new JSONObject(delivered[0]).getBoolean("ok"));
            delivered[0]=null;received("readVisibleProcesses");invoke("dispatch",new Class[]{JSONObject.class,String.class,String.class,JavaScriptReplyProxy.class},new JSONObject().put("method","readVisibleProcesses").put("threadId",ID).put("turnId",turn),ID,"ai",target);
            ((ExecutorService)field(bridge,"projectionWorker")).submit(()->{}).get(2,TimeUnit.SECONDS);Shadows.shadowOf(Looper.getMainLooper()).idle();assertEquals("done",new JSONObject(delivered[0]).getJSONObject("result").getJSONObject("value").getJSONArray("items").getJSONObject(0).getString("text"));assertEquals(1,release.getCount());
        }finally{release.countDown();worker.submit(()->{}).get(3,TimeUnit.SECONDS);bridge.close();((ExecutorService)field(bridge,"projectionWorker")).awaitTermination(3,TimeUnit.SECONDS);store.close();context.deleteDatabase("native-sync-v1.sqlite");}
    }

    @Test public void slowStoreTaskAddsOneStageSummaryAndClearsItsThreadLocal()throws Exception {
        received("readRecords");ExecutorService worker=(ExecutorService)field(bridge,"worker");
        invoke("executeBridgeWork",new Class[]{String.class,String.class,Runnable.class},"ai",ID,(Runnable)()->{
            ShadowSystemClock.advanceBy(Duration.ofMillis(70));
            SyncStore.storePhase("open");ShadowSystemClock.advanceBy(Duration.ofMillis(60));
            SyncStore.storePhase("query");ShadowSystemClock.advanceBy(Duration.ofMillis(90));
            SyncStore.storePhase("decode");ShadowSystemClock.advanceBy(Duration.ofMillis(100));
            SyncStore.storePhase("metadata");ShadowSystemClock.advanceBy(Duration.ofMillis(50));SyncStore.storePhase("complete");
        });worker.submit(()->{}).get(3,TimeUnit.SECONDS);drain();
        try(Cursor rows=db().rawQuery("SELECT payload FROM outbox WHERE payload LIKE '%\"component\":\"android-store\"%'",null)){
            assertTrue(rows.moveToFirst());JSONObject value=new JSONObject(rows.getString(0));assertEquals(ID,value.getString("traceId"));assertEquals("readRecords",value.getString("method"));
            assertEquals("ai",value.getString("scope"));assertEquals(70,value.getLong("storeWaitMs"));assertEquals(60,value.getLong("storeOpenMs"));assertEquals(90,value.getLong("storeQueryMs"));assertEquals(100,value.getLong("storeDecodeMs"));assertEquals(50,value.getLong("storeMetadataMs"));assertFalse(rows.moveToNext());
        }
        int count;try(Cursor rows=db().rawQuery("SELECT COUNT(*) FROM outbox",null)){rows.moveToFirst();count=rows.getInt(0);}
        received("readRecords");invoke("executeBridgeWork",new Class[]{String.class,String.class,Runnable.class},"ai",ID,(Runnable)()->{});worker.submit(()->{}).get(3,TimeUnit.SECONDS);drain();
        try(Cursor rows=db().rawQuery("SELECT COUNT(*) FROM outbox",null)){rows.moveToFirst();assertEquals(count,rows.getInt(0));}
        // A second request cannot inherit the previous timing on the same worker.
        assertTrue(worker.submit(()->{Field f=SyncStore.class.getDeclaredField("operationTiming");f.setAccessible(true);return ((ThreadLocal<?>)f.get(null)).get()==null;}).get(3,TimeUnit.SECONDS));
    }
    @Test public void archiveFailureKeepsApiAndAddsSafeExceptionPhaseEvenWhenFast()throws Exception {
        Context context=RuntimeEnvironment.getApplication();context.deleteDatabase("native-sync-v1.sqlite");SyncStore store=new SyncStore(context);
        bridge.close();bridge=new NativeBridge(context,null,store,null,()->{},()->{},null,()->{},null,null);
        try{
            String[] delivered={null};JavaScriptReplyProxy target=new JavaScriptReplyProxy(){public void postMessage(String s){delivered[0]=s;}public void postMessage(byte[] s){}public void executeJavaScript(String s,WebViewOutcomeReceiver<String,JavaScriptExecutionException> r){}};
            received("saveReadRecord");invoke("dispatch",new Class[]{JSONObject.class,String.class,String.class,JavaScriptReplyProxy.class},new JSONObject().put("method","saveReadRecord").put("record",new JSONObject().put("message","PRIVATE_BODY")),ID,"ai",target);
            ((ExecutorService)field(bridge,"projectionWorker")).submit(()->{}).get(3,TimeUnit.SECONDS);Shadows.shadowOf(Looper.getMainLooper()).idle();drain();
            JSONObject reply=new JSONObject(delivered[0]);assertFalse(reply.getBoolean("ok"));assertEquals("ARCHIVE_FAILED",reply.getJSONObject("error").getString("code"));assertEquals("本地历史暂不可读写",reply.getJSONObject("error").getString("message"));
            try(Cursor rows=db().rawQuery("SELECT payload FROM outbox WHERE payload LIKE '%\"component\":\"android-store\"%'",null)){
                assertTrue(rows.moveToFirst());String raw=rows.getString(0);JSONObject value=new JSONObject(raw);assertEquals("failed",value.getString("stage"));assertEquals("validate",value.getString("storePhase"));assertEquals("JSONException",value.getString("errorName"));assertEquals("parse",value.getString("failureClass"));assertFalse(raw.contains("PRIVATE"));assertFalse(rows.moveToNext());
            }
        }finally{bridge.close();((ExecutorService)field(bridge,"projectionWorker")).awaitTermination(3,TimeUnit.SECONDS);store.close();context.deleteDatabase("native-sync-v1.sqlite");}
    }
}
