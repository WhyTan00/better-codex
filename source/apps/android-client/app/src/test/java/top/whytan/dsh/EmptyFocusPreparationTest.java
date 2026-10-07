package top.whytan.dsh;

import static org.junit.Assert.*;
import android.content.Context;
import java.lang.reflect.*;
import java.util.*;
import java.util.concurrent.ExecutorService;
import okhttp3.*;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;

/** Real SyncStore, worker and producer DTO consumption; no Native command. */
@RunWith(RobolectricTestRunner.class) @Config(sdk=28,manifest=Config.NONE)
public class EmptyFocusPreparationTest {
 static final String EMPTY="01a1124d-9d58-7523-b98c-8b0c270b2b07",MAIN="11111111-1111-4111-8111-111111111111",TURN="22222222-2222-4222-8222-222222222222";
 SyncStore store;SyncClient client;int reads,catalogReads;boolean outage;
 static Field field(String name)throws Exception{Field f=SyncClient.class.getDeclaredField(name);f.setAccessible(true);return f;}
 Object call(String name,Class<?>[]types,Object...args)throws Exception{Method m=SyncClient.class.getDeclaredMethod(name,types);m.setAccessible(true);return m.invoke(client,args);}
 JSONObject emptyHead()throws Exception{return new JSONObject().put("id",EMPTY).put("ephemeral",false).put("preview","").put("path","assigned Native rollout path (private value elided)").put("createdAt",1791308438L).put("updatedAt",1791308438L).put("status",new JSONObject().put("type","idle")).put("turns",new JSONArray());}
 JSONObject record(String scope,String id,String key,String kind,JSONObject payload,int revision)throws Exception{return new JSONObject().put("scope",scope).put("threadId",id).put("key",key).put("kind",kind).put("sourceGeneration","g1").put("generation","g1").put("revision",revision).put("deleted",false).put("payload",payload);}
 void head(String scope,JSONObject h,int revision)throws Exception{String id=h.getString("id");store.applyNativeRecord(record(scope,id,"thread:"+id,"catalog",new JSONObject().put("nativeThread",h),revision));}
 @Before public void setup()throws Exception{
  Context context=RuntimeEnvironment.getApplication();context.deleteDatabase("native-sync-v1.sqlite");store=new SyncStore(context);store.saveCatalogCursor("ai","g1",0);
  client=new SyncClient(context,"ai",store,new SyncClient.Listener(){public void onState(String s,JSONObject v){}public void onCompletion(String s,String t,String u,boolean ready){}});
  ((ExecutorService)field("prefetchWorkers").get(client)).shutdownNow();((ExecutorService)field("focusWorkers").get(client)).shutdownNow();
  OkHttpClient http=new OkHttpClient.Builder().addInterceptor(chain->{try{JSONObject response;
   if(chain.request().method().equals("GET")){catalogReads++;response=new JSONObject().put("generation","g1").put("cursor",1).put("hasMore",false).put("records",new JSONArray());}
   else{reads++;okio.Buffer b=new okio.Buffer();chain.request().body().writeTo(b);JSONObject request=new JSONObject(b.readUtf8()),p=request.getJSONObject("params");String method=request.getString("method"),id=p.getString("threadId");JSONObject result="thread/read".equals(method)?new JSONObject().put("thread",new JSONObject().put("id",id).put("historyMode","paginated")):new JSONObject().put("data",new JSONArray()).put("nextCursor",JSONObject.NULL);response=new JSONObject().put("record",record("ai",id,"read:"+new JSONArray().put(method).put(p),"history",new JSONObject().put("method",method).put("params",p).put("result",result),100));}
   return new Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(outage?503:200).message("fixture").body(ResponseBody.create(response.toString(),MediaType.get("application/json"))).build();
  }catch(Exception e){throw new java.io.IOException(e);}}).build();field("http").set(client,http);
 }
 @After public void close(){client.close();store.close();}
 @Test public void unchangedNativePreUserHeadDoesNotPrepareReadOrWarm()throws Exception{
  head("ai",emptyHead(),1);store.requestPreparation("ai","history",EMPTY,"",0,false,"");store.requestPreparation("ai","archive",EMPTY,"",4,true,"old-archive");
  assertTrue(client.focusThread(EMPTY));assertTrue(store.duePreparations("ai",Long.MAX_VALUE,20).isEmpty());assertTrue(store.historyWarmCandidates("ai",20).isEmpty());assertEquals(0,reads);assertEquals(0,catalogReads);assertNull(store.getMeta("ai","history-prepared:"+EMPTY));
 }
 @Test public void actualCommittedSavedHeadSurvivesReopenWithoutRepeatedFocusRead()throws Exception{
  JSONObject p=new JSONObject().put("threadId",EMPTY).put("includeTurns",false),payload=new JSONObject().put("method","thread/read").put("params",p).put("result",new JSONObject().put("thread",emptyHead()));
  store.applyNativeRecord(record("ai",EMPTY,"read:"+new JSONArray().put("thread/read").put(p),"history",payload,1));store.getWritableDatabase().delete("records","scope=? AND thread_id=?",new String[]{"ai",EMPTY});
  assertTrue(store.isUnstartedHistory("ai",EMPTY));assertTrue(client.focusThread(EMPTY));assertEquals(0,reads);
 }
 @Test public void realUserMetadataActiveOrOriginalBodyReopensReading()throws Exception{
  head("ai",emptyHead(),1);assertTrue(store.isUnstartedHistory("ai",EMPTY));
  JSONObject updated=emptyHead().put("preview","first real input").put("updatedAt",1791308440L);head("ai",updated,2);assertFalse(store.isUnstartedHistory("ai",EMPTY));
  head("ai",emptyHead().put("status",new JSONObject().put("type","active")),3);assertFalse(store.isUnstartedHistory("ai",EMPTY));
  head("ai",emptyHead(),4);JSONObject params=new JSONObject().put("threadId",EMPTY),result=new JSONObject().put("data",new JSONArray().put(new JSONObject().put("id",TURN).put("items",new JSONArray().put(new JSONObject().put("type","userMessage").put("content",new JSONArray())))));
  store.applyNativeRecord(record("ai",EMPTY,"read:"+new JSONArray().put("thread/turns/list").put(params),"history",new JSONObject().put("method","thread/turns/list").put("params",params).put("result",result),5));assertFalse("image-only or cached originals are still real history",store.isUnstartedHistory("ai",EMPTY));
 }
 @Test public void unknownHeadCrossScopeAndChangedSourceAreNotEmptyProof()throws Exception{
  head("zyy",emptyHead(),1);assertFalse(store.isUnstartedHistory("ai",EMPTY));head("ai",new JSONObject().put("id",EMPTY).put("status",new JSONObject().put("type","idle")),2);assertFalse(store.isUnstartedHistory("ai",EMPTY));head("ai",emptyHead(),3);store.resetGeneration("ai","g2");assertFalse(store.isUnstartedHistory("ai",EMPTY));
 }
 @Test public void normalizedCommittedItemsAndProcessesAreNeverSuppressed()throws Exception{
  head("ai",emptyHead(),1);store.applyNativeRecord(record("ai",EMPTY,"item:"+EMPTY+":"+TURN+":user","item",new JSONObject().put("turnId",TURN).put("item",new JSONObject().put("type","userMessage")),2));assertFalse(store.isUnstartedHistory("ai",EMPTY));
 }
 @Test public void omittedTurnsActiveFlagsAndRuntimeFailureAreUnknownNotEmpty()throws Exception{
  JSONObject h=emptyHead();h.remove("turns");head("ai",h,1);assertFalse(store.isUnstartedHistory("ai",EMPTY));
  head("ai",emptyHead().put("status",new JSONObject().put("type","idle").put("activeFlags",new JSONArray().put("waitingOnAgent"))),2);assertFalse(store.isUnstartedHistory("ai",EMPTY));
  head("ai",emptyHead(),3);JSONObject error=new JSONObject().put("threadId",EMPTY).put("status",new JSONObject().put("type","systemError"));store.commitRuntimeStatus("ai",new SyncStore.InboxEntry(1,"runtime",1,error),error);assertFalse(store.isUnstartedHistory("ai",EMPTY));JSONObject unknown=new JSONObject().put("threadId",EMPTY).put("status",new JSONObject().put("type","idle").put("activeFlags",JSONObject.NULL));store.commitRuntimeStatus("ai",new SyncStore.InboxEntry(2,"runtime",2,unknown),unknown);assertFalse(store.isUnstartedHistory("ai",EMPTY));
 }
 @Test public void newerChangedHeadAndExplicitReadRemainReadable()throws Exception{
  head("ai",emptyHead(),1);JSONObject p=new JSONObject().put("threadId",EMPTY).put("includeTurns",false);JSONObject newer=emptyHead().put("updatedAt",1791308440L);store.applyNativeRecord(record("ai",EMPTY,"read:"+new JSONArray().put("thread/read").put(p),"history",new JSONObject().put("method","thread/read").put("params",p).put("result",new JSONObject().put("thread",newer)),2));assertFalse(store.isUnstartedHistory("ai",EMPTY));
  store.getWritableDatabase().delete("records","scope=? AND kind='history'",new String[]{"ai"});store.getWritableDatabase().delete("saved_records","scope=? AND kind='history'",new String[]{"ai"});assertTrue(store.isUnstartedHistory("ai",EMPTY));outage=true;
  try{call("fetchThreadTurns",new Class[]{String.class,boolean.class},EMPTY,false);fail("explicit read must expose the actual 503");}catch(InvocationTargetException expected){assertTrue(expected.getCause() instanceof java.io.IOException);}assertTrue(reads>0);
 }
 @Test public void switchingFocusRestoresOldHistoryAndLeavesArchiveBackground()throws Exception{
  JSONObject normal=emptyHead().put("preview","existing input");head("ai",normal,1);head("ai",new JSONObject(normal.toString()).put("id",MAIN),2);
  store.requestPreparation("ai","archive",EMPTY,"",4,true,"a");store.requestPreparation("ai","archive",MAIN,"",4,true,"b");
  store.requestPreparation("ai","history",EMPTY,"",4,true,"a");store.requestPreparation("ai","history",MAIN,"",4,true,"b");
  client.focusThread(EMPTY);assertEquals(4,store.duePreparations("ai",Long.MAX_VALUE,20).stream().filter(x->x.key.startsWith("archive:"+EMPTY)).findFirst().get().priority);
  assertEquals(0,store.duePreparations("ai",Long.MAX_VALUE,20).stream().filter(x->x.key.startsWith("history:"+EMPTY)).findFirst().get().priority);
  client.focusThread(MAIN);List<SyncStore.Preparation> jobs=store.duePreparations("ai",Long.MAX_VALUE,20);
  assertEquals(4,jobs.stream().filter(x->x.key.startsWith("archive:"+EMPTY)).findFirst().get().priority);
  assertEquals(4,jobs.stream().filter(x->x.key.startsWith("archive:"+MAIN)).findFirst().get().priority);
  assertEquals(3,jobs.stream().filter(x->x.key.startsWith("history:"+EMPTY)).findFirst().get().priority);
  assertEquals(0,jobs.stream().filter(x->x.key.startsWith("history:"+MAIN)).findFirst().get().priority);
 }
 @Test public void transientFocusDoesNotDemoteAnIndependentCriticalGap()throws Exception{
  head("ai",emptyHead().put("preview","real history"),1);store.requestPreparation("ai","history",EMPTY,"",0,false,"stream-gap");client.focusThread(EMPTY);client.focusThread(MAIN);assertEquals(0,store.duePreparations("ai",Long.MAX_VALUE,20).stream().filter(x->x.threadId.equals(EMPTY)&&x.kind.equals("history")).findFirst().get().priority);
 }
 @Test public void emptyMetadataCannotRetireAnIndependentCriticalRecovery()throws Exception{
  head("ai",emptyHead(),1);SyncStore.Preparation gap=store.requestPreparation("ai","history",EMPTY,"",0,false,"epoch:stream-gap");client.focusThread(EMPTY);assertFalse(store.optionalHistoryPreparation("ai",gap));assertTrue(store.duePreparations("ai",Long.MAX_VALUE,20).stream().anyMatch(x->x.desired.equals("epoch:stream-gap")));
 }
 @Test public void emptySelectionCannotReplayPriorPendingCatalogFocus()throws Exception{
  head("ai",emptyHead(),1);head("ai",emptyHead().put("id",MAIN).put("preview","real history"),2);client.focusThread(MAIN);client.focusThread(EMPTY);assertNull(((java.util.concurrent.atomic.AtomicReference<?>)field("focusThreadId").get(client)).get());
 }
 @Test public void emptyFocusDoesNotInvalidateCatalogAndReal503RemainsFailure()throws Exception{
  head("ai",emptyHead(),1);client.focusThread(EMPTY);call("syncCatalogInternal",new Class[]{boolean.class},false);assertTrue(field("catalogComplete").getBoolean(client));assertEquals(0,reads);
  outage=true;try{call("syncCatalogInternal",new Class[]{boolean.class},true);fail("real catalog 503 cannot become empty success");}catch(InvocationTargetException expected){assertTrue(expected.getCause() instanceof java.io.IOException);}assertFalse(field("catalogComplete").getBoolean(client));
 }
}
