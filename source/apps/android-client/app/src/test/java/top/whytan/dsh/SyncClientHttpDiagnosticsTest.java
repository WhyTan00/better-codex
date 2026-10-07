package top.whytan.dsh;

import static org.junit.Assert.*;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteOpenHelper;
import java.io.*;
import java.lang.reflect.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import okhttp3.*;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;

/** Real HTTP headers arrive before a gated body; receipts use the real durable outbox. */
@RunWith(RobolectricTestRunner.class) @Config(sdk=28,manifest=Config.NONE)
public class SyncClientHttpDiagnosticsTest {
    Context context; SyncClient client; SyncStore store; NativeDiagnostics log;
    Object previousLog; Thread.UncaughtExceptionHandler previousHandler;
    ExecutorService requests=Executors.newSingleThreadExecutor();
    static final String PARENT="11111111-1111-4111-8111-111111111111";
    static Field field(Class<?> type,String name)throws Exception {Field f=type.getDeclaredField(name);f.setAccessible(true);return f;}
    @Before public void setup()throws Exception {
        previousHandler=Thread.getDefaultUncaughtExceptionHandler();context=RuntimeEnvironment.getApplication();
        android.webkit.CookieManager.getInstance();context.deleteDatabase("native-diagnostics-v1.db");context.deleteDatabase("native-sync-v1.sqlite");
        previousLog=field(NativeDiagnostics.class,"instance").get(null);
        Constructor<NativeDiagnostics> ctor=NativeDiagnostics.class.getDeclaredConstructor(Context.class);ctor.setAccessible(true);log=ctor.newInstance(context);
        field(NativeDiagnostics.class,"instance").set(null,log);
        store=new SyncStore(context);client=new SyncClient(context,"ai",store,new SyncClient.Listener(){public void onState(String s,JSONObject v){}public void onCompletion(String s,String t,String u,boolean r){}});
        field(SyncClient.class,"http").set(client,new OkHttpClient.Builder().followRedirects(false).build());
    }
    @After public void teardown()throws Exception {
        client.close();store.close();requests.shutdownNow();
        for(String name:new String[]{"writer","network"}){ExecutorService e=(ExecutorService)field(NativeDiagnostics.class,name).get(log);e.shutdownNow();e.awaitTermination(5,TimeUnit.SECONDS);}
        ((SQLiteOpenHelper)field(NativeDiagnostics.class,"db").get(log)).close();field(NativeDiagnostics.class,"instance").set(null,previousLog);
        Thread.setDefaultUncaughtExceptionHandler(previousHandler);
    }
    List<JSONObject> rows()throws Exception {
        ((ExecutorService)field(NativeDiagnostics.class,"writer").get(log)).submit(()->{}).get(5,TimeUnit.SECONDS);
        List<JSONObject> rows=new ArrayList<>();
        try(Cursor c=((SQLiteOpenHelper)field(NativeDiagnostics.class,"db").get(log)).getWritableDatabase().rawQuery("SELECT payload FROM outbox WHERE scope='ai' ORDER BY rowid",null)){while(c.moveToNext()){JSONObject v=new JSONObject(c.getString(0));if("android-sync".equals(v.optString("component")))rows.add(v);}}
        return rows;
    }
    Object call(String method,String url,JSONObject body)throws Exception {
        Method m=body==null?SyncClient.class.getDeclaredMethod(method,String.class,String.class):SyncClient.class.getDeclaredMethod(method,String.class,JSONObject.class,String.class);m.setAccessible(true);
        try{return body==null?m.invoke(client,url,PARENT):m.invoke(client,url,body,PARENT);}catch(InvocationTargetException e){throw (Exception)e.getCause();}
    }
    @Test public void headersAreDurableWhileActualNetworkBodyIsStillPending()throws Exception {
        CountDownLatch headers=new CountDownLatch(1),body=new CountDownLatch(1);
        try(ServerSocket server=new ServerSocket(0,1,InetAddress.getLoopbackAddress())) {
            CompletableFuture<Void> serving=CompletableFuture.runAsync(()->{try(Socket peer=server.accept()){
                BufferedReader reader=new BufferedReader(new InputStreamReader(peer.getInputStream(),StandardCharsets.US_ASCII));String line;while((line=reader.readLine())!=null&&!line.isEmpty()){}
                byte[] data="{\"privateBody\":\"never-log-this\"}".getBytes(StandardCharsets.UTF_8);
                OutputStream out=peer.getOutputStream();out.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "+data.length+"\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));out.flush();headers.countDown();
                if(!body.await(5,TimeUnit.SECONDS))throw new IOException("body gate not released");out.write(data);out.flush();
            }catch(Exception e){throw new CompletionException(e);}});
            Future<Object> result=requests.submit(()->call("getJson","http://127.0.0.1:"+server.getLocalPort()+"/sync/v1/w/ai/native/read?private=do-not-log",null));
            try {
                assertTrue(headers.await(5,TimeUnit.SECONDS));List<JSONObject> pending=rows();long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(3);
                while(pending.size()<2&&System.nanoTime()<until){Thread.sleep(10);pending=rows();}
                assertEquals(2,pending.size());assertEquals("attempt",pending.get(0).getString("stage"));assertEquals("dispatch",pending.get(1).getString("stage"));assertEquals("request_received",pending.get(1).getString("reason"));assertFalse(result.isDone());
            } finally {body.countDown();}
            assertEquals("never-log-this",((JSONObject)result.get(5,TimeUnit.SECONDS)).getString("privateBody"));serving.get(5,TimeUnit.SECONDS);
            List<JSONObject> complete=rows();assertEquals(4,complete.size());assertEquals("body_ready",complete.get(2).getString("reason"));assertEquals("received",complete.get(2).getString("stage"));assertEquals("request_received",complete.get(3).getString("reason"));assertEquals("received",complete.get(3).getString("stage"));
            String trace=complete.get(0).getString("traceId");long previous=0;
            for(JSONObject row:complete){assertEquals(trace,row.getString("traceId"));assertEquals(PARENT,row.getString("parentTraceId"));assertFalse(row.toString().contains("never-log-this"));assertFalse(row.toString().contains("do-not-log"));assertFalse(row.has("url"));if(row.has("durationMs")){assertTrue(row.getLong("durationMs")>=previous);previous=row.getLong("durationMs");assertEquals(200,row.getInt("statusCode"));}}
        }
    }
    void fixture(int status,String body)throws Exception {
        field(SyncClient.class,"http").set(client,new OkHttpClient.Builder().addInterceptor(chain->new Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(status).message("fixture").body(ResponseBody.create(body,MediaType.get("application/json"))).build()).build());
    }
    @Test public void malformedPostBodyHasBodyReceiptButNeverAParsedSuccess()throws Exception {
        fixture(200,"private-invalid-json");try{call("postJson","https://workbench.example.test/sync/v1/w/ai/native/read",new JSONObject().put("method","thread/read").put("params",new JSONObject().put("threadId",PARENT)));fail();}catch(JSONException expected){}
        List<JSONObject> v=rows();assertEquals(4,v.size());assertEquals("body_ready",v.get(2).getString("reason"));assertEquals("failed",v.get(3).getString("stage"));assertEquals("parse",v.get(3).getString("failureClass"));assertTrue(v.get(3).has("durationMs"));assertFalse(v.toString().contains("private-invalid-json"));
    }
    @Test public void authenticationFailureKeepsItsOriginalTypedFailureWithoutBodyRead()throws Exception {
        fixture(401,"private-auth-body");try{call("getJson","https://workbench.example.test/sync/v1/w/ai/native/read",null);fail();}catch(IOException expected){assertEquals("AuthException",expected.getClass().getSimpleName());}
        List<JSONObject> v=rows();assertEquals(3,v.size());assertEquals("dispatch",v.get(1).getString("stage"));assertEquals(401,v.get(2).getInt("statusCode"));assertEquals("auth_required",v.get(2).getString("reason"));assertTrue(v.get(2).has("durationMs"));assertFalse(v.toString().contains("private-auth-body"));
    }
}
