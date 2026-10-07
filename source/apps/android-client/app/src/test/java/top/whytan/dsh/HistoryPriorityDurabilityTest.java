package top.whytan.dsh;
import android.content.Context;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import java.util.*;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @Config(sdk=28,manifest=Config.NONE)
public class HistoryPriorityDurabilityTest {
 Context context; SyncStore store; String scope="ai"; long revision=1;
 String id(int n){return String.format("00000000-0000-4000-8000-%012d",n);}
 @Before public void setup()throws Exception {context=RuntimeEnvironment.getApplication();context.deleteDatabase("native-sync-v1.sqlite");store=new SyncStore(context);}
 @After public void cleanup(){store.close();}
 JSONObject record(int n,String kind,String key,JSONObject payload)throws Exception{return new JSONObject().put("scope",scope).put("threadId",id(n)).put("kind",kind).put("key",key).put("sourceGeneration","s").put("generation","g").put("revision",revision++).put("deleted",false).put("payload",payload);}
 void catalog(int n,long updated,boolean pinned)throws Exception {store.applyNativeRecord(record(n,"catalog","thread:"+id(n),new JSONObject().put("nativeThread",new JSONObject().put("id",id(n)).put("updatedAt",updated).put("isPinned",pinned).put("status",new JSONObject().put("type","idle")))));}
 @Test public void readyRecentHorizonCannotWalkBackIntoOlderThreadsAndPinsHaveTheirOwnQuota()throws Exception {
  for(int n=1;n<=25;n++)catalog(n,100-n,false);catalog(90,1,true);
  List<JSONObject> candidates=store.historyWarmCandidates(scope,100);assertEquals(21,candidates.size());assertEquals(id(90),candidates.get(0).getString("threadId"));
  for(JSONObject target:candidates){String key="history:"+target.getString("threadId");int n=target.optBoolean("pinned")?90:Integer.parseInt(target.getString("threadId").substring(24));store.applyNativeRecord(record(n,"history",key,new JSONObject().put("method","thread/turns/list").put("result",new JSONObject().put("data",new JSONArray()))));store.markHistoryWarm(scope,target,key);}
  assertTrue(store.historyWarmCandidates(scope,100).isEmpty());store.close();store=new SyncStore(context);assertTrue(store.historyWarmCandidates(scope,100).isEmpty());
  catalog(25,200,false);assertEquals(1,store.historyWarmCandidates(scope,100).size());assertEquals(id(25),store.historyWarmCandidates(scope,100).get(0).getString("threadId"));
 }
 @Test public void preparedReadSurvivesProcessRestartAndOnlyChangedSourceReopensIt()throws Exception {
  catalog(1,10,false);String key="history:head";store.applyNativeRecord(record(1,"history",key,new JSONObject()));String version=store.historyPreparationVersion(scope,id(1));store.markHistoryPrepared(scope,id(1),version,key);
  store.close();store=new SyncStore(context);assertTrue(store.historyPreparationReady(scope,id(1),version));SyncStore.Preparation job=store.requestPreparation(scope,"history",id(1),"",0,false,version);assertEquals(Long.MAX_VALUE,job.dueAt);assertTrue(store.duePreparations(scope,System.currentTimeMillis(),100).isEmpty());
  catalog(1,11,false);String newer=store.historyPreparationVersion(scope,id(1));assertNotEquals(version,newer);assertFalse(store.historyPreparationReady(scope,id(1),newer));assertEquals(0,store.requestPreparation(scope,"history",id(1),"",0,false,newer).dueAt);
 }
 @Test public void unloadedPersistentThreadsRemainEligibleForReadOnlyDiskWarm()throws Exception {
  JSONObject thread=new JSONObject().put("id",id(1)).put("updatedAt",100).put("status",new JSONObject().put("type","notLoaded"));
  store.applyNativeRecord(record(1,"catalog","thread:"+id(1),new JSONObject().put("nativeThread",thread)));
  assertEquals(1,store.historyWarmCandidates(scope,20).size());assertTrue(store.historyWarmCandidates(scope,0).isEmpty());
 }
 JSONObject seen(long at,String item)throws Exception {return new JSONObject().put("schemaVersion",1).put("scope",scope).put("threadId",id(1)).put("turnId",id(2)).put("sourceGeneration","s").put("generation","g").put("turnStartedAtMs",1000).put("savedAt",at).put("items",new JSONArray().put(new JSONObject().put("id",item).put("type","reasoning").put("text",item))).put("order",new JSONArray().put(item));}
 @Test public void seenProcessItemsSurviveSQLiteRestartAndMissingLaterProjection()throws Exception {store.saveVisibleProcesses(scope,seen(100,"old"));store.close();store=new SyncStore(context);store.saveVisibleProcesses(scope,seen(200,"new"));JSONObject value=store.readVisibleProcesses(scope,id(1),id(2)).getJSONObject("value");assertEquals(2,value.getJSONArray("items").length());assertEquals(200,value.getLong("savedAt"));store.saveVisibleProcesses(scope,seen(150,"late"));assertEquals(3,store.readVisibleProcesses(scope,id(1),id(2)).getJSONObject("value").getJSONArray("items").length());}
 @Test public void explicitRevertAndForeignScopeCannotResurrectSeenProcesses()throws Exception {store.saveVisibleProcesses(scope,seen(100,"old"));store.invalidateVisibleProcesses(scope,id(1),200);store.saveVisibleProcesses(scope,seen(150,"late"));assertTrue(store.readVisibleProcesses(scope,id(1),id(2)).isNull("value"));try{store.saveVisibleProcesses("zyy",seen(300,"foreign"));fail();}catch(JSONException expected){}store.saveVisibleProcesses(scope,seen(300,"fresh"));store.invalidateVisibleProcesses(scope,id(1),150);assertEquals(1,store.readVisibleProcesses(scope,id(1),id(2)).getJSONObject("value").getJSONArray("items").length());}
 @Test public void retainedProcessOrderKeepsTheOriginalPromptAndFinalAnchors()throws Exception {
  JSONObject first=seen(100,"earlier").put("order",new JSONArray().put("prompt").put("earlier").put("final"));
  JSONObject next=seen(200,"later").put("order",new JSONArray().put("prompt").put("later").put("final"));
  store.saveVisibleProcesses(scope,first);store.saveVisibleProcesses(scope,next);store.close();store=new SyncStore(context);
  assertEquals("[\"prompt\",\"earlier\",\"later\",\"final\"]",store.readVisibleProcesses(scope,id(1),id(2)).getJSONObject("value").getJSONArray("order").toString());
 }
}
