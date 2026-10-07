package top.whytan.dsh;

import static org.junit.Assert.*;
import android.content.Context;
import java.lang.reflect.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.io.IOException;
import okhttp3.*;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;

/** Synthetic Native-shaped receiver DTO -> transactional Store -> cold reader; no Native commands. */
@RunWith(RobolectricTestRunner.class) @Config(sdk=28,manifest=Config.NONE)
public class NativeBodyArchiveIsolationTest {
 static final String THREAD="11111111-1111-4111-8111-111111111111",TURN="22222222-2222-4222-8222-222222222222";
 Context context; SyncStore store; SyncClient client;
 static Field field(String name)throws Exception{Field f=SyncClient.class.getDeclaredField(name);f.setAccessible(true);return f;}
 Object call(String name,Class<?>[]types,Object...args)throws Exception{Method m=SyncClient.class.getDeclaredMethod(name,types);m.setAccessible(true);return m.invoke(client,args);}
 static String hash(byte[] bytes)throws Exception{StringBuilder out=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(bytes))out.append(String.format("%02x",b));return out.toString();}
 static JSONObject fixtureDto(String name,String expectedHash)throws Exception{
  String path=System.getProperty("dsh.native69."+name,PublicNativeFixtures.file(name));assertNotNull("explicit synthetic producer fixture required",path);
  byte[] bytes=Files.readAllBytes(Paths.get(path));assertEquals("synthetic producer SHA",expectedHash,hash(bytes));return new JSONObject(new String(bytes,StandardCharsets.UTF_8));
 }
 JSONObject receiver()throws Exception{return fixtureDto("receiver","2696112c2a4d86d16dcadd006a03d7f27624a64346d3c2f850020f540532b905");}
 JSONObject actualHead()throws Exception{return fixtureDto("head","dfe0dc6f74a793a690827e3c13eb0aeed72909705ce19fd9537cd0a711eef0a0");}
 JSONObject actualProgress()throws Exception{return fixtureDto("progress","f80e51684c002b94147621e20ff4ef3302f649958ce0fabb10e8648087d9d712");}
 JSONObject record(String kind,String key,JSONObject payload,int revision)throws Exception{return new JSONObject().put("scope","ai").put("threadId",THREAD).put("key",key.replace("\\/","/")).put("kind",kind).put("sourceGeneration","g1").put("generation","g1").put("revision",revision).put("deleted",false).put("payload",payload);}
 JSONObject body(int bytes,String kind,int revision)throws Exception{JSONObject params=new JSONObject().put("threadId",THREAD).put("turnId",TURN);String key="read:"+new JSONArray().put("thread/items/list").put(params);return record(kind,key,new JSONObject().put("method","thread/items/list").put("params",params).put("result",new JSONObject().put("data",new JSONArray().put(new JSONObject().put("type","commandExecution").put("id","owned-test").put("aggregatedOutput",repeat(bytes)))).put("nextCursor",JSONObject.NULL)),revision);}
 static String repeat(int count){char[] value=new char[count];Arrays.fill(value,'x');return new String(value);}
 @Before public void setup(){context=RuntimeEnvironment.getApplication();context.deleteDatabase("native-sync-v1.sqlite");store=new SyncStore(context);store.saveCatalogCursor("ai","g1",0);}
 @After public void close(){if(client!=null)client.close();store.close();}
 void reopen(){store.close();store=new SyncStore(context);}
 void newClient()throws Exception{client=new SyncClient(context,"ai",store,new SyncClient.Listener(){public void onState(String s,JSONObject v){}public void onCompletion(String s,String t,String u,boolean ready){}});}
 void stopExecutors()throws Exception{((ExecutorService)field("prefetchWorkers").get(client)).shutdownNow();((ExecutorService)field("focusWorkers").get(client)).shutdownNow();}
 void source(JSONObject dto){store.saveCatalogCursor("ai",dto.optString("sourceGeneration"),0);}
 void assertPayload(JSONObject expected,JSONObject actual){assertEquals("complete Native payload digest",SyncStore.readPayloadDigest(expected.opt("payload")),SyncStore.readPayloadDigest(actual.opt("payload")));assertEquals(expected.optString("sourceGeneration"),actual.optString("sourceGeneration"));assertEquals(expected.optString("generation"),actual.optString("generation"));assertEquals(expected.optString("key"),actual.optString("key"));}
 @Test public void actualLargeNativePageCommitsAndRemainsReachableAfterReopen()throws Exception{
  JSONObject dto=receiver();source(dto);assertTrue(dto.toString().getBytes(StandardCharsets.UTF_8).length>1024*1024);
  String expected=dto.getString("sourceGeneration");assertTrue(store.applyReadRecord(dto,null,expected));reopen();
  JSONObject saved=store.readSavedRecord("ai",dto.getString("key"),expected,dto.getString("generation")).getJSONObject("record");assertPayload(dto,saved);
  JSONArray items=saved.getJSONObject("payload").getJSONObject("result").getJSONArray("data");assertEquals(28,items.length());assertTrue(saved.getJSONObject("payload").getJSONObject("result").isNull("nextCursor"));
  JSONObject page=store.readRecords("ai",0,20);assertFalse(page.getBoolean("resetRequired"));assertEquals(1,page.getJSONArray("records").length());assertPayload(dto,page.getJSONArray("records").getJSONObject(0));assertTrue(page.getLong("cursor")>0);
  assertTrue(store.readSavedRecord("zyy",dto.getString("key")).isNull("record"));assertTrue(store.readSavedRecord("ai",dto.getString("key"),"other",dto.getString("generation")).isNull("record"));
  assertFalse(store.applyReadRecord(dto,null,"retired"));assertPayload(dto,store.readSavedRecord("ai",dto.getString("key")).getJSONObject("record"));
  String export=System.getProperty("dsh.native69.export");if(export!=null){Files.write(Paths.get(export),new JSONObject().put("deltaPage",page).put("saved",store.readSavedRecord("ai",dto.getString("key"))).toString().getBytes(StandardCharsets.UTF_8));Files.setPosixFilePermissions(Paths.get(export),java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"));}
 }
 @Test public void singleBodyLargerThanDefaultSqliteWindowExportsWithoutResetOrClip()throws Exception{
  JSONObject dto=body(3*1024*1024,"history",1);assertTrue(store.applyReadRecord(dto,null,"g1"));reopen();
  assertPayload(dto,store.readSavedRecord("ai",dto.getString("key")).getJSONObject("record"));JSONObject page=store.readRecords("ai",0,20);assertFalse(page.getBoolean("resetRequired"));assertPayload(dto,page.getJSONArray("records").getJSONObject(0));assertEquals(3*1024*1024,page.getJSONArray("records").getJSONObject(0).getJSONObject("payload").getJSONObject("result").getJSONArray("data").getJSONObject(0).getString("aggregatedOutput").length());
 }
 @Test public void selectedLargeSummaryAndSmallHeadRemainColdReadableWithoutLoadingDeepItems()throws Exception{
  JSONObject p=new JSONObject().put("threadId",THREAD).put("itemsView","summary").put("sortDirection","desc");JSONObject summary=record("history","read:"+new JSONArray().put("thread/turns/list").put(p),new JSONObject().put("method","thread/turns/list").put("params",p).put("result",new JSONObject().put("data",new JSONArray().put(new JSONObject().put("id",TURN).put("items",new JSONArray().put(new JSONObject().put("id","final").put("text",repeat(3*1024*1024))))))),1);
  JSONObject hp=new JSONObject().put("threadId",THREAD).put("includeTurns",false);JSONObject head=record("history","read:"+new JSONArray().put("thread/read").put(hp),new JSONObject().put("method","thread/read").put("params",hp).put("result",new JSONObject().put("thread",new JSONObject().put("id",THREAD))),2);
  store.applyReadRecord(summary,null,"g1");store.applyReadRecord(head,null,"g1");store.applyReadRecord(body(20,"history",3),null,"g1");reopen();
  assertEquals(2,store.readThreadRecords("ai",THREAD).getJSONArray("records").length());assertEquals(2,store.readSavedThreadRecords("ai",THREAD).getJSONArray("records").length());
 }
 @Test public void onlyKnownBodyKindsHaveEightMiBLimitAndOversizeNeverCommits()throws Exception{
  for(String kind:new String[]{"history","turn","item"}){JSONObject dto=body(1100000,kind,1);store.applyNativeRecord(dto);assertNotNull(store.readRecords("ai",0,20));}
  for(String kind:new String[]{"catalog","readAlias","historyCursor","unknown"}){try{store.applyNativeRecord(body(1100000,kind,2));fail("metadata/unknown must remain rejected");}catch(JSONException expected){}}
  try{store.applyReadRecord(body(8*1024*1024,"history",9),null,"g1");fail("whole body record above8MiB");}catch(JSONException expected){}
  assertFalse(store.archiveProgress("ai",THREAD).optBoolean("complete"));
 }
 @Test public void bootstrapAndSmallControlStayAtOneMiB()throws Exception{
  store.saveBootstrap("ai",new JSONObject().put("value","accepted"));store.saveBootstrap("ai",new JSONObject().put("value",repeat(1100000)));assertEquals("accepted",store.getBootstrap("ai").getString("value"));
  try{store.receiveEvent("ai","e",1,new JSONObject().put("event",new JSONObject().put("type","runtime").put("value",repeat(1100000))));fail("oversize control");}catch(JSONException expected){}assertNull(store.nextEvent("ai"));assertEquals(0,store.eventCursor("ai").seq);
 }
 JSONObject itemEvent(String text)throws Exception{return new JSONObject().put("type","item").put("threadId",THREAD).put("turnId",TURN).put("item",new JSONObject().put("type","agentMessage").put("id","agent").put("text",text));}
 @Test public void bodyInboxAndDerivedStreamSurviveColdWithoutClippingOrDuplicateReplay()throws Exception{
  JSONObject event=itemEvent(repeat(3*1024*1024));store.receiveEvent("ai","e",1,new JSONObject().put("event",event));reopen();assertEquals(SyncStore.readPayloadDigest(event),SyncStore.readPayloadDigest(store.nextEvent("ai").payload.getJSONObject("event")));
  store.commitStreamEvent("ai",store.nextEvent("ai"),event);reopen();assertEquals(3*1024*1024,store.readStream("ai",THREAD).getJSONArray("turns").getJSONObject(0).getJSONArray("items").getJSONObject(0).getString("text").length());assertNull(store.nextEvent("ai"));assertFalse(store.receiveEvent("ai","e",1,new JSONObject().put("event",event)));
 }
 @Test public void bodyAndAggregateInboxLimitsRejectBeforeAckAndDerivedOverflowKeepsRecovery()throws Exception{
  try{store.receiveEvent("ai","e",1,new JSONObject().put("event",itemEvent(repeat(8*1024*1024))));fail("oversize DTO");}catch(JSONException expected){}assertEquals(0,store.eventCursor("ai").seq);
  JSONObject big=new JSONObject().put("id",TURN).put("items",new JSONArray().put(new JSONObject().put("id","a").put("type","agentMessage").put("text",repeat(7*1024*1024))));JSONObject snap=new JSONObject().put("type","snapshot").put("threadId",THREAD).put("snapshot",new JSONObject().put("turns",new JSONArray().put(big).put(new JSONObject(big.toString()).put("id",THREAD))));
  try{store.receiveEvent("ai","e",1,new JSONObject().put("event",snap));fail("oversize aggregate");}catch(JSONException expected){}assertNull(store.nextEvent("ai"));
  JSONObject first=itemEvent(repeat(7*1024*1024));store.receiveEvent("ai","e",1,new JSONObject().put("event",first));store.commitStreamEvent("ai",store.nextEvent("ai"),first);
  JSONObject delta=new JSONObject().put("type","delta").put("threadId",THREAD).put("turnId",TURN).put("itemId","agent").put("delta",repeat(6*1024*1024));store.receiveEvent("ai","e",2,new JSONObject().put("event",delta));store.commitStreamEvent("ai",store.nextEvent("ai"),delta);assertFalse(store.readStream("ai",THREAD).optBoolean("available"));assertTrue(store.duePreparations("ai",Long.MAX_VALUE,20).stream().anyMatch(x->x.priority==0&&x.kind.equals("history")));assertNull(store.nextEvent("ai"));
 }
 @Test public void native68FocusFlagsMigrateArchiveToFourWithoutErasingProgressOrControls()throws Exception{
  SyncStore.Preparation archive=store.requestPreparation("ai","archive",THREAD,"",4,true,"d");store.getWritableDatabase().execSQL("CREATE TABLE IF NOT EXISTS sync_preparation_focus(scope TEXT,key TEXT,priority INTEGER,PRIMARY KEY(scope,key))");store.getWritableDatabase().execSQL("UPDATE sync_preparations SET priority=0 WHERE key=?",new Object[]{archive.key});store.getWritableDatabase().execSQL("INSERT INTO sync_preparation_focus VALUES(?,?,4)",new Object[]{"ai",archive.key});
  store.requestPreparation("ai","history",THREAD,"",0,false,"stream-gap");store.requestPreparation("ai","completion",THREAD,TURN,1,false,"completion");store.requestPreparation("ai","artifacts",THREAD,TURN,0,false,"files");store.saveArchiveProgress("ai",THREAD,new JSONObject().put("sourceGeneration","g1").put("turnIndex",2).put("complete",false));newClient();
  List<SyncStore.Preparation> jobs=store.duePreparations("ai",Long.MAX_VALUE,20);assertEquals(4,jobs.stream().filter(x->x.kind.equals("archive")).findFirst().get().priority);assertEquals(4,jobs.stream().filter(x->x.kind.equals("artifacts")).findFirst().get().priority);assertEquals(0,jobs.stream().filter(x->x.kind.equals("history")).findFirst().get().priority);assertEquals(1,jobs.stream().filter(x->x.kind.equals("completion")).findFirst().get().priority);assertEquals(2,store.archiveProgress("ai",THREAD).getInt("turnIndex"));
 }
 Response response(Interceptor.Chain chain,JSONObject dto)throws Exception{return new Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("fixture").body(ResponseBody.create(dto.toString(),MediaType.get("application/json"))).build();}
 @Test public void actualNativeEofPageAdvancesExactArchiveCursorAndColdPreservesOriginal()throws Exception{
  JSONObject dto=receiver(),head=actualHead(),progress=actualProgress();source(dto);String id=dto.getString("threadId");assertEquals(2,progress.getInt("turnIndex"));assertFalse(progress.getBoolean("complete"));store.applyReadRecord(head,null,dto.getString("sourceGeneration"));JSONObject firstSummary=fixtureDto("firstSummary","abb0e5589f5c7c9e168509bca39f752bc230213dd1303a8de18514d5b9d29ae5");store.applyReadRecord(firstSummary,null,dto.getString("sourceGeneration"));store.noteVerifiedBodySummaryRead(firstSummary,0);store.applyReadRecord(dto,null,dto.getString("sourceGeneration"));store.saveArchiveProgress("ai",id,progress);String desired=store.archiveBodyVersion("ai",id);assertTrue(desired.startsWith("body-v1:"));newClient();stopExecutors();int[] calls={0};
  field("http").set(client,new OkHttpClient.Builder().addInterceptor(chain->{try{okio.Buffer b=new okio.Buffer();chain.request().body().writeTo(b);JSONObject req=new JSONObject(b.readUtf8());calls[0]++;assertFalse(req.getBoolean("fresh"));assertEquals(id,req.getJSONObject("params").getString("threadId"));if("thread/read".equals(req.getString("method")))return response(chain,head);assertEquals("thread/items/list",req.getString("method"));assertEquals(12,req.getJSONObject("params").getInt("limit"));assertNotEquals(dto.getJSONObject("payload").getJSONObject("params").getString("turnId"),req.getJSONObject("params").getString("turnId"));throw new IOException("next turn read deliberately withheld");}catch(Exception e){throw new IOException(e);}}).build());
  try{call("archiveHistoryBatch",new Class[]{String.class,String.class,String.class},id,UUID.randomUUID().toString(),desired);fail("next turn fixture withheld");}catch(InvocationTargetException expected){assertTrue(expected.getCause() instanceof IOException);}
  client.close();client=null;reopen();JSONObject after=store.archiveProgress("ai",id);assertEquals(3,after.getInt("turnIndex"));assertFalse(after.has("itemCursor"));assertFalse(after.getBoolean("complete"));assertPayload(dto,store.readSavedRecord("ai",dto.getString("key")).getJSONObject("record"));assertEquals(2,calls[0]);
 }
 @Test public void startedArchiveDoesNotHoldSameThreadForegroundHistory()throws Exception{heldArchiveAllows("history",0);}
 @Test public void startedArchiveDoesNotHoldSameThreadActiveHistory()throws Exception{heldArchiveAllows("history",1);}
 @Test public void startedArchiveDoesNotHoldSameThreadCompletion()throws Exception{heldArchiveAllows("completion",1);}
 void heldArchiveAllows(String kind,int priority)throws Exception{
  newClient();CountDownLatch archiveStarted=new CountDownLatch(1),releaseArchive=new CountDownLatch(1),shortStarted=new CountDownLatch(1);List<Boolean> fresh=Collections.synchronizedList(new ArrayList<>());
  field("http").set(client,new OkHttpClient.Builder().addInterceptor(chain->{try{okio.Buffer b=new okio.Buffer();chain.request().body().writeTo(b);JSONObject req=new JSONObject(b.readUtf8());fresh.add(req.getBoolean("fresh"));if(!req.getBoolean("fresh")){archiveStarted.countDown();assertTrue(releaseArchive.await(5,TimeUnit.SECONDS));}else shortStarted.countDown();throw new IOException("owned held read boundary");}catch(Exception e){throw new IOException(e);}}).build());
  SyncStore.Preparation archive=store.requestPreparation("ai","archive",THREAD,"",4,true,"archive");call("queuePreparation",new Class[]{SyncStore.Preparation.class},archive);assertTrue(archiveStarted.await(5,TimeUnit.SECONDS));
  try{assertTrue((Boolean)call("claimDirectRefresh",new Class[]{String.class},THREAD));call("releaseDirectRefresh",new Class[]{String.class},THREAD);SyncStore.Preparation history=store.requestPreparation("ai",kind,THREAD,"completion".equals(kind)?TURN:"",priority,false,"focus");call("queuePreparation",new Class[]{SyncStore.Preparation.class},history);assertTrue("actual reserved executor must begin before archive releases",shortStarted.await(5,TimeUnit.SECONDS));assertTrue(fresh.contains(true));assertTrue(((Map<?,?>)field("prefetchByThread").get(client)).containsKey("archive:"+THREAD));}finally{releaseArchive.countDown();}
 }
 @Test public void archiveFailureDoesNotEmitForegroundFailureOrResetCatalog()throws Exception{
  newClient();stopExecutors();field("currentFocusThreadId").set(client,THREAD);field("catalogComplete").setBoolean(client,true);field("http").set(client,new OkHttpClient.Builder().addInterceptor(chain->{throw new IOException("real archive outage");}).build());
  SyncStore.Preparation job=store.requestPreparation("ai","archive",THREAD,"",0,true,"archive");Class<?> type=Class.forName("top.whytan.dsh.SyncClient$PrefetchTask");Constructor<?> ctor=type.getDeclaredConstructor(SyncClient.class,SyncStore.Preparation.class,long.class,String.class);ctor.setAccessible(true);Runnable task=(Runnable)ctor.newInstance(client,job,1L,UUID.randomUUID().toString());String key="archive:"+THREAD;((Map)field("prefetchByThread").get(client)).put(key,task);task.run();
  assertTrue(field("catalogComplete").getBoolean(client));SyncStore.Preparation retry=store.duePreparations("ai",Long.MAX_VALUE,20).get(0);assertEquals(4,retry.priority);assertEquals(1,retry.attempts);
 }
 @Test public void unchangedUnstartedNotLoadedDoesNotWarmButRealNativeBodyStillDoes()throws Exception{
  JSONObject empty=new JSONObject().put("id",THREAD).put("ephemeral",false).put("preview","").put("path","owned-assigned-path").put("createdAt",1).put("updatedAt",1).put("turns",new JSONArray()).put("status",new JSONObject().put("type","notLoaded"));
  store.applyNativeRecord(record("catalog","thread:"+THREAD,new JSONObject().put("nativeThread",empty),1));assertTrue(store.isUnstartedHistory("ai",THREAD));assertTrue(store.historyWarmCandidates("ai",8).isEmpty());
  store.close();context.deleteDatabase("native-sync-v1.sqlite");store=new SyncStore(context);JSONObject real=receiver();source(real);JSONObject thread=actualHead().getJSONObject("payload").getJSONObject("result").getJSONObject("thread");JSONObject catalog=new JSONObject(real.toString()).put("key","thread:"+real.getString("threadId")).put("kind","catalog").put("revision",1).put("payload",new JSONObject().put("nativeThread",new JSONObject(thread.toString()).put("status",new JSONObject().put("type","notLoaded"))));store.applyNativeRecord(catalog);assertTrue(store.applyReadRecord(real,null,real.getString("sourceGeneration")));reopen();assertFalse(store.isUnstartedHistory("ai",real.getString("threadId")));assertEquals(1,store.historyWarmCandidates("ai",8).size());assertPayload(real,store.readSavedRecord("ai",real.getString("key")).getJSONObject("record"));
 }
 @Test public void normalArchiveContinuationDefersWithoutCountingAReadFailure()throws Exception{
  newClient();stopExecutors();JSONObject params=new JSONObject().put("threadId",THREAD).put("includeTurns",false);JSONObject head=record("history","read:"+new JSONArray().put("thread/read").put(params),new JSONObject().put("method","thread/read").put("params",params).put("result",new JSONObject().put("thread",new JSONObject().put("id",THREAD).put("status",new JSONObject().put("type","active")))),1);
  field("http").set(client,new OkHttpClient.Builder().addInterceptor(chain->{try{return response(chain,head);}catch(Exception e){throw new IOException(e);}}).build());SyncStore.Preparation job=store.requestPreparation("ai","archive",THREAD,"",4,true,"archive");Class<?> type=Class.forName("top.whytan.dsh.SyncClient$PrefetchTask");Constructor<?> ctor=type.getDeclaredConstructor(SyncClient.class,SyncStore.Preparation.class,long.class,String.class);ctor.setAccessible(true);Runnable task=(Runnable)ctor.newInstance(client,job,1L,UUID.randomUUID().toString());((Map)field("prefetchByThread").get(client)).put("archive:"+THREAD,task);long start=System.currentTimeMillis();task.run();SyncStore.Preparation next=store.duePreparations("ai",Long.MAX_VALUE,20).get(0);assertEquals(0,next.attempts);assertEquals(4,next.priority);assertTrue(next.dueAt>=start+60000);assertFalse(store.archiveProgress("ai",THREAD).optBoolean("complete"));
 }

}
