package top.whytan.dsh;

import static org.junit.Assert.*;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteOpenHelper;
import java.io.*;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import okhttp3.*;
import okio.*;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;

/** Actual refresh -> OkHttp response body -> digest/storage -> actual durable diagnostic sanitizer. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=28, manifest=Config.NONE)
public final class UiReleaseAssetDiagnosticTest {
    static final String OLD="1111111111111111", NEXT="2222222222222222";
    static final byte[] BODY="<html>controlled asset bytes</html>".getBytes(StandardCharsets.UTF_8);
    Context context; NativeDiagnostics log; UiReleaseStore store; File root;
    Thread.UncaughtExceptionHandler previousHandler;
    Object field(Object target,String name)throws Exception {Field f=target.getClass().getDeclaredField(name);f.setAccessible(true);return f.get(target);}
    String hash(byte[] body)throws Exception {StringBuilder out=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(body))out.append(String.format("%02x",b&255));return out.toString();}
    String shell(String version){return "/dsh-native-assets/"+version+"/shell.html";}
    JSONObject manifest(String version,byte[] body)throws Exception {String p=shell(version);return new JSONObject().put("schemaVersion",1).put("version",version).put("shell",p).put("minAppVersionCode",1).put("files",new JSONArray().put(new JSONObject().put("path",p).put("url","/android/ui/"+version+"/files"+p).put("bytes",body.length).put("sha256",hash(body)).put("mime","text/html")));}
    void drain()throws Exception {((ExecutorService)field(log,"writer")).submit(()->{}).get(5,TimeUnit.SECONDS);}
    List<JSONObject> events()throws Exception {drain();List<JSONObject> out=new ArrayList<>();try(Cursor c=((SQLiteOpenHelper)field(log,"db")).getWritableDatabase().rawQuery("SELECT payload FROM outbox WHERE scope='ai' ORDER BY rowid",null)){while(c.moveToNext())out.add(new JSONObject(c.getString(0)));}return out;}
    JSONObject assetFailure()throws Exception {return events().stream().filter(e->e.has("contentHash")&&("failed".equals(e.optString("stage"))||"cancelled".equals(e.optString("stage")))).findFirst().orElseThrow(()->new AssertionError("asset diagnostic absent"));}
    void assertCleanup() {assertEquals(OLD,store.activeVersion());File[] remaining=root.listFiles(f->f.getName().startsWith(".staging-"));assertNotNull(remaining);assertEquals("failed staging must be deleted",0,remaining.length);assertFalse(new File(root,NEXT).exists());}
    @Before public void setup()throws Exception {
        previousHandler=Thread.getDefaultUncaughtExceptionHandler();context=RuntimeEnvironment.getApplication();
        context.deleteDatabase("native-diagnostics-v1.db");Constructor<NativeDiagnostics> ctor=NativeDiagnostics.class.getDeclaredConstructor(Context.class);ctor.setAccessible(true);log=ctor.newInstance(context);
        Field singleton=NativeDiagnostics.class.getDeclaredField("instance");singleton.setAccessible(true);singleton.set(null,log);
        root=new File(context.getFilesDir(),"ui-releases");File old=new File(root,OLD);File file=new File(old,"files"+shell(OLD));assertTrue(file.getParentFile().mkdirs());Files.write(file.toPath(),BODY);
        Files.write(new File(old,"ui-release.json").toPath(),manifest(OLD,BODY).toString().getBytes(StandardCharsets.UTF_8));Files.write(new File(root,"active.json").toPath(),new JSONObject().put("version",OLD).toString().getBytes(StandardCharsets.UTF_8));
        context.getSharedPreferences("ui-install",Context.MODE_PRIVATE).edit().putInt("appVersion",BuildConfig.VERSION_CODE).commit();store=new UiReleaseStore(context,"ai");drain();
    }
    @After public void cleanup()throws Exception {
        store.close();for(String name:new String[]{"writer","network"}){ExecutorService e=(ExecutorService)field(log,name);e.shutdownNow();assertTrue(e.awaitTermination(5,TimeUnit.SECONDS));}
        ((SQLiteOpenHelper)field(log,"db")).close();Field singleton=NativeDiagnostics.class.getDeclaredField("instance");singleton.setAccessible(true);singleton.set(null,null);Thread.setDefaultUncaughtExceptionHandler(previousHandler);
    }
    interface AssetProvider {ResponseBody get()throws Exception;}
    OkHttpClient client(JSONObject manifest,AssetProvider provider)throws Exception {
        return new OkHttpClient.Builder().addInterceptor(chain->{ResponseBody body;
            if(chain.request().url().encodedPath().equals("/android/ui-release.json"))body=ResponseBody.create(manifest.toString(),MediaType.get("application/json"));
            else try{body=provider.get();}catch(IOException e){throw e;}catch(Exception e){throw new IOException("controlled provider failure",e);}
            return new Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK").header("Content-Type",chain.request().url().encodedPath().equals("/android/ui-release.json")?"application/json":"text/html").body(body).build();
        }).build();
    }
    ResponseBody body(byte[] bytes){return ResponseBody.create(bytes,MediaType.get("text/html"));}
    ResponseBody failingBody(boolean cancel){return new ResponseBody(){
        final BufferedSource source=Okio.buffer(new Source(){boolean supplied;
            @Override public long read(Buffer sink,long requested)throws IOException {if(!supplied){supplied=true;sink.write(BODY,0,4);return 4;}if(cancel){store.cancelRefresh();throw new IOException("controlled cancellation");}throw new java.net.SocketTimeoutException("controlled timeout without cancellation");}
            @Override public Timeout timeout(){return Timeout.NONE;}@Override public void close(){}
        });
        @Override public MediaType contentType(){return MediaType.get("text/html");}@Override public long contentLength(){return BODY.length;}@Override public BufferedSource source(){return source;}
    };}
    @Test public void normalRefreshLogsActualBytesDigestAndOriginalTraceThenCommits()throws Exception {
        UiReleaseStore.UpdateResult r=store.refresh(client(manifest(NEXT,BODY),()->body(BODY)));assertTrue(r.success);assertTrue(r.changed);assertEquals(NEXT,store.activeVersion());
        List<JSONObject> all=events(),asset=new ArrayList<>();String trace=null;for(JSONObject e:all){if("attempt".equals(e.optString("stage"))&&"check_start".equals(e.optString("reason")))trace=e.getString("traceId");if(e.has("contentHash"))asset.add(e);}
        assertEquals(5,asset.size());assertNotNull(trace);assertEquals(List.of("download_start","request_received","body_ready","verify_ok","download_complete"),asset.stream().map(e->e.optString("reason")).collect(java.util.stream.Collectors.toList()));
        for(JSONObject e:asset){assertEquals(trace,e.getString("traceId"));assertEquals(NEXT,e.getString("uiVersion"));assertEquals(hash(BODY).substring(0,16),e.getString("contentHash"));assertFalse(e.has("url"));assertFalse(e.has("message"));assertFalse(e.has("cookie"));}
        assertEquals(BODY.length,asset.get(4).getLong("count"));assertEquals(200,asset.get(4).getInt("statusCode"));
        try(UiReleaseStore.LocalResource resource=store.localResource(shell(NEXT))){assertNotNull(resource);assertArrayEquals(BODY,resource.stream.readAllBytes());}
    }
    @Test public void partialBodyTimeoutPreservesFailureAndReportsExactReadBytes()throws Exception {
        UiReleaseStore.UpdateResult r=store.refresh(client(manifest(NEXT,BODY),()->failingBody(false)));assertFalse(r.success);assertEquals("release_rejected",r.reason);assertCleanup();JSONObject e=assetFailure();assertEquals("body_partial",e.getString("reason"));assertEquals("timeout",e.getString("failureClass"));assertEquals("failed",e.getString("stage"));assertEquals(4,e.getLong("count"));
        assertFalse(events().stream().anyMatch(x->x.has("contentHash")&&"verify_ok".equals(x.optString("reason"))));
    }
    @Test public void fullBodyWrongShaReportsVerifyFailureWithoutCommit()throws Exception {
        byte[] wrong=BODY.clone();wrong[7]^=1;UiReleaseStore.UpdateResult r=store.refresh(client(manifest(NEXT,BODY),()->body(wrong)));assertFalse(r.success);assertEquals("release_rejected",r.reason);assertCleanup();JSONObject e=assetFailure();assertEquals("verify_failed",e.getString("reason"));assertEquals("rpc_contract",e.getString("failureClass"));assertEquals(BODY.length,e.getLong("count"));assertTrue(events().stream().anyMatch(x->x.has("contentHash")&&"body_ready".equals(x.optString("reason"))));
    }
    @Test public void storageCreationErrorStaysStorageAndDeletesStaging()throws Exception {
        UiReleaseStore.UpdateResult r=store.refresh(client(manifest(NEXT,BODY),()->{File[] stages=root.listFiles(f->f.getName().startsWith(".staging-"));assertNotNull(stages);assertEquals(1,stages.length);File part=new File(stages[0],"files"+shell(NEXT)+".part");assertTrue(part.mkdirs());return body(BODY);}));assertFalse(r.success);assertEquals("release_rejected",r.reason);assertCleanup();JSONObject e=assetFailure();assertEquals("store_failed",e.getString("reason"));assertEquals("storage",e.getString("failureClass"));assertEquals(0,e.getLong("count"));
    }
    @Test public void explicitCancelIsAbortedWithPartialBytesAndOriginalCleanup()throws Exception {
        UiReleaseStore.UpdateResult r=store.refresh(client(manifest(NEXT,BODY),()->failingBody(true)));assertFalse(r.success);assertEquals("release_rejected",r.reason);assertCleanup();JSONObject e=assetFailure();assertEquals("cancelled",e.getString("stage"));assertEquals("cancelled",e.getString("reason"));assertEquals("aborted",e.getString("failureClass"));assertEquals(4,e.getLong("count"));
    }
    @Test public void storageMoveAfterGoodDigestHasStorageFailureAndNoDownloadComplete()throws Exception {
        UiReleaseStore.UpdateResult r=store.refresh(client(manifest(NEXT,BODY),()->{
            File[] stages=root.listFiles(f->f.getName().startsWith(".staging-"));assertNotNull(stages);assertEquals(1,stages.length);
            File target=new File(stages[0],"files"+shell(NEXT));assertTrue(target.mkdirs());Files.write(new File(target,"blocks-replacement").toPath(),"controlled".getBytes(StandardCharsets.UTF_8));return body(BODY);
        }));assertFalse(r.success);assertEquals("release_rejected",r.reason);assertCleanup();JSONObject e=assetFailure();assertEquals("store_failed",e.getString("reason"));assertEquals("storage",e.getString("failureClass"));assertEquals(BODY.length,e.getLong("count"));
        assertTrue(events().stream().anyMatch(x->x.has("contentHash")&&"verify_ok".equals(x.optString("reason"))));assertFalse(events().stream().anyMatch(x->x.has("contentHash")&&"download_complete".equals(x.optString("reason"))));
    }
    @Test public void throwingDiagnosticWriterCannotChangeSuccessfulRefresh()throws Exception {
        ((ExecutorService)field(log,"writer")).shutdownNow();UiReleaseStore.UpdateResult r=store.refresh(client(manifest(NEXT,BODY),()->body(BODY)));assertTrue(r.success);assertEquals(NEXT,store.activeVersion());assertFalse(new File(root,".staging-"+NEXT).exists());
    }
    @Test public void throwingDiagnosticWriterCannotHideOriginalBodyFailure()throws Exception {
        ((ExecutorService)field(log,"writer")).shutdownNow();UiReleaseStore.UpdateResult r=store.refresh(client(manifest(NEXT,BODY),()->failingBody(false)));assertFalse(r.success);assertEquals("release_rejected",r.reason);assertCleanup();
    }
    @Test public void sameVersionFastPathAddsNoAssetReadsOrNewAssetDiagnostics()throws Exception {
        final int[] reads={0};UiReleaseStore.UpdateResult r=store.refresh(client(manifest(OLD,BODY),()->{reads[0]++;return body(BODY);}));assertTrue(r.success);assertFalse(r.changed);assertEquals(0,reads[0]);assertFalse(events().stream().anyMatch(e->e.has("contentHash")));assertEquals(OLD,store.activeVersion());
    }
}
