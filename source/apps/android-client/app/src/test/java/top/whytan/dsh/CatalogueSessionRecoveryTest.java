package top.whytan.dsh;
import static org.junit.Assert.*;
import android.content.Context;
import java.lang.reflect.*;
import java.util.*;
import java.util.concurrent.ExecutorService;
import java.io.IOException;
import okhttp3.*;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;

/** Genuine typed Gateway producer contract and real Store/consumer, no external network. */
@RunWith(RobolectricTestRunner.class) @Config(sdk=28,manifest=Config.NONE)
public class CatalogueSessionRecoveryTest {
 static final String ID="11111111-1111-4111-8111-111111111111";SyncStore store;SyncClient client;Context context;List<Long> offsets=new ArrayList<>();String conflictScope="ai",code="catalogue_session_changed",failureClass="catalog_session_offset_mismatch",replyGeneration="g1";int conflicts=1,status=409;boolean throwTimeout,failAfterFirstPage;
 JSONObject record()throws Exception{return new JSONObject().put("scope","ai").put("threadId",ID).put("key","read:"+new JSONArray().put("thread/read").put(new JSONObject().put("threadId",ID).put("includeTurns",false)).toString().replace("\\/","/")).put("kind","history").put("sourceGeneration","g1").put("generation","g1").put("revision",1).put("deleted",false).put("payload",new JSONObject().put("result",new JSONObject().put("thread",new JSONObject().put("id",ID).put("preview","SYNTHETIC_CACHED_BODY"))));}
 @Before public void setup()throws Exception{context=RuntimeEnvironment.getApplication();context.deleteDatabase("native-sync-v1.sqlite");store=new SyncStore(context);store.applyNativeRecord(record());store.saveCatalogCursor("ai","g1",50);store.getWritableDatabase().execSQL("INSERT INTO meta(scope,key,value) VALUES(?,?,?)",new Object[]{"ai","unchanged-draft","SYNTHETIC_DRAFT"});store.saveArchiveProgress("ai",ID,new JSONObject().put("sourceGeneration","g1").put("generation","g1").put("complete",true));client=new SyncClient(context,"ai",store,new SyncClient.Listener(){public void onState(String s,JSONObject v){}public void onCompletion(String s,String t,String u,boolean ready){}});for(String n:new String[]{"prefetchWorkers","focusWorkers"}){Field f=SyncClient.class.getDeclaredField(n);f.setAccessible(true);((ExecutorService)f.get(client)).shutdownNow();}OkHttpClient http=new OkHttpClient.Builder().addInterceptor(chain->{try{String raw=chain.request().url().queryParameter("after");long after=raw==null?0:Long.parseLong(raw);offsets.add(after);if(throwTimeout)throw new java.net.SocketTimeoutException("owned fixture timeout");boolean error=offsets.size()<=conflicts;JSONObject body=error?new JSONObject().put("code",code).put("failureClass",failureClass).put("scope",conflictScope).put("error","目录分页状态已更新，请重新读取"):new JSONObject().put("generation",replyGeneration).put("cursor",51).put("hasMore",false).put("records",new JSONArray());if(failAfterFirstPage&&offsets.size()==1){error=false;body=new JSONObject().put("generation","g1").put("cursor",51).put("hasMore",true).put("records",new JSONArray());}if(failAfterFirstPage&&offsets.size()==2){error=true;body=new JSONObject().put("code",code).put("failureClass",failureClass).put("scope",conflictScope).put("error","目录分页状态已更新，请重新读取");}return new Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(error?status:200).message("fixture").body(ResponseBody.create(body.toString(),MediaType.get("application/json"))).build();}catch(JSONException e){throw new IOException(e);}}).build();Field f=SyncClient.class.getDeclaredField("http");f.setAccessible(true);f.set(client,http);}
 @After public void close(){client.close();store.close();}
 void sync()throws Exception{Method m=SyncClient.class.getDeclaredMethod("syncCatalogInternal",boolean.class);m.setAccessible(true);m.invoke(client,false);}
 void fails()throws Exception{try{sync();fail("must preserve real failure");}catch(InvocationTargetException e){assertTrue(e.getCause() instanceof IOException);}}
 void originals()throws Exception{assertEquals("SYNTHETIC_DRAFT",store.getMeta("ai","unchanged-draft"));assertEquals("g1",store.catalogCursor("ai").generation);assertTrue(store.archiveProgress("ai",ID).getBoolean("complete"));assertEquals(SyncStore.readPayloadDigest(record().getJSONObject("payload")),SyncStore.readPayloadDigest(store.readSavedRecord("ai",record().getString("key")).getJSONObject("record").getJSONObject("payload")));}
 @Test public void exactTypedConflictRestartsOnceAndKeepsBodyAcrossStoreReopen()throws Exception{sync();assertEquals(Arrays.asList(50L,0L),offsets);assertEquals(51,store.catalogCursor("ai").cursor);originals();store.close();store=new SyncStore(context);originals();}
 @Test public void repeatedConflictStopsAfterOneReadOnlyRestart()throws Exception{conflicts=2;fails();assertEquals(Arrays.asList(50L,0L),offsets);assertEquals(50,store.catalogCursor("ai").cursor);originals();}
 @Test public void sameTypedErrorForAnotherScopeDoesNotRestart()throws Exception{conflictScope="zyy";fails();assertEquals(Collections.singletonList(50L),offsets);originals();}
 @Test public void unknown409AndOriginal503DoNotGainRetry()throws Exception{code="other";fails();assertEquals(Collections.singletonList(50L),offsets);originals();offsets.clear();code="catalogue_session_changed";status=503;fails();assertEquals(Collections.singletonList(50L),offsets);originals();}
 @Test public void authAndInternalFailureStayErrors()throws Exception{status=401;fails();assertEquals(Collections.singletonList(50L),offsets);offsets.clear();status=500;fails();assertEquals(Collections.singletonList(50L),offsets);originals();}
 @Test public void timeoutNeverStartsNewCursorPass()throws Exception{throwTimeout=true;fails();assertEquals(Collections.singletonList(50L),offsets);originals();}
 @Test public void changedSourceOnRestartDoesNotWipePriorBodyGeneration()throws Exception{replyGeneration="different-source";fails();assertEquals(Arrays.asList(50L,0L),offsets);originals();}
 @Test public void partialProgressThenConflictRestartsWithoutResetOrFalseCompletion()throws Exception{failAfterFirstPage=true;conflicts=0;sync();assertEquals(Arrays.asList(50L,51L,0L),offsets);originals();}
}
