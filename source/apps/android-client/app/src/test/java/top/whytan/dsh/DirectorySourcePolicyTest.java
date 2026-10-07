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

/** Existing SQLite, actual worker and source DTOs; no external or Native writes. */
@RunWith(RobolectricTestRunner.class) @Config(sdk=28,manifest=Config.NONE)
public class DirectorySourcePolicyTest {
    static final String PARENT="11111111-1111-4111-8111-111111111111",CHILD="22222222-2222-4222-8222-222222222222";
    Context context; SyncStore store; SyncClient client; int requests;
    @Before public void setUp()throws Exception {
        context=RuntimeEnvironment.getApplication();context.deleteDatabase("native-sync-v1.sqlite");store=new SyncStore(context);
        client=new SyncClient(context,"ai",store,new SyncClient.Listener(){public void onState(String scope,JSONObject value){}public void onCompletion(String s,String t,String u,boolean ready){fail("internal completion");}});
        ((ExecutorService)field("prefetchWorkers").get(client)).shutdownNow();
        field("http").set(client,new OkHttpClient.Builder().addInterceptor(chain->{requests++;throw new java.io.IOException("unexpected child read");}).build());
    }
    @After public void tearDown(){client.close();store.close();context.deleteDatabase("native-sync-v1.sqlite");}
    Field field(String name)throws Exception {Field f=SyncClient.class.getDeclaredField(name);f.setAccessible(true);return f;}
    JSONObject thread(String id,Object source,String status)throws JSONException {return new JSONObject().put("id",id).put("source",source).put("name","synthetic retained history").put("updatedAt",1).put("status",new JSONObject().put("type",status));}
    void catalog(JSONObject thread,int revision)throws Exception {String id=thread.getString("id");store.applyNativeRecord(new JSONObject().put("scope","ai").put("key","thread:"+id).put("kind","catalog").put("threadId",id).put("generation","g1").put("sourceGeneration","g1").put("revision",revision).put("confirmedAt","2026-10-04T00:00:00Z").put("deleted",false).put("payload",new JSONObject().put("nativeThread",thread)),"fixture");}
    JSONObject spawn()throws JSONException {return new JSONObject().put("subAgent",new JSONObject().put("thread_spawn",new JSONObject().put("parent_thread_id",PARENT).put("depth",1).put("agent_path","/root/reviewer")));}
    @Test public void nativeSourceUnionAndTemporaryWorkAreInternalButUserForkIsNot()throws Exception {
        for(Object source:new Object[]{"subAgent","subAgentReview","subAgentCompact","subAgentThreadSpawn","subAgentOther",new JSONObject().put("subAgent","review"),new JSONObject().put("subagent",new JSONObject().put("thread_spawn",new JSONObject().put("parent_thread_id",PARENT))),new JSONObject().put("subagent",new JSONObject()).toString(),spawn()})
            assertTrue(CompletionNotificationPolicy.isInternalDirectoryThread(thread(CHILD,source,"active")));
        assertTrue(CompletionNotificationPolicy.isInternalDirectoryThread(thread(CHILD,"vscode","active").put("ephemeral",true)));
        assertTrue(CompletionNotificationPolicy.isInternalDirectoryThread(thread(CHILD,"vscode","active").put("threadSource","thread_title")));
        for(Object source:new Object[]{"cli","vscode","exec","appServer","unknown",new JSONObject().put("custom","user")})
            assertFalse(CompletionNotificationPolicy.isInternalDirectoryThread(thread(PARENT,source,"idle").put("forkedFromId",CHILD)));
    }
    @Test public void oldMixedCatalogColdReopenKeepsParentWarmAndChildDataWithoutWarmingChild()throws Exception {
        catalog(thread(CHILD,spawn(),"idle"),1);catalog(thread(PARENT,"exec","idle"),2);
        store.close();store=new SyncStore(context);field("store").set(client,store);
        assertTrue(store.isInternalDirectoryThread("ai",CHILD));assertNotNull(store.catalogRecord("ai",CHILD));
        java.util.List<JSONObject> candidates=store.historyWarmCandidates("ai",8);assertEquals(1,candidates.size());assertEquals(PARENT,candidates.get(0).getString("threadId"));
        Method warm=SyncClient.class.getDeclaredMethod("runHistoryWarm",JSONObject.class);warm.setAccessible(true);warm.invoke(client,new JSONObject().put("threadId",CHILD));assertEquals(0,requests);
    }
    @Test public void activeChildDoesNotKeepRunningIndicatorAliveAfterParentCompletes()throws Exception {
        catalog(thread(CHILD,spawn(),"active"),1);catalog(thread(PARENT,"vscode","active"),2);
        assertEquals(1,store.runningSessions("ai").getInt("count"));assertEquals(PARENT,store.runningSessions("ai").getString("threadId"));
        catalog(thread(PARENT,"vscode","idle"),3);store.close();store=new SyncStore(context);field("store").set(client,store);assertEquals(0,store.runningSessions("ai").getInt("count"));
    }
    @Test public void existingChildPreparationRetiresWithoutAnyHttpOrDeletingHistory()throws Exception {
        catalog(thread(CHILD,spawn(),"idle"),1);SyncStore.Preparation job=store.requestPreparation("ai","archive",CHILD,"",3,true,"old-job");
        Class<?> type=Class.forName("top.whytan.dsh.SyncClient$PrefetchTask");Constructor<?> ctor=type.getDeclaredConstructor(SyncClient.class,SyncStore.Preparation.class,long.class,String.class);ctor.setAccessible(true);
        Runnable task=(Runnable)ctor.newInstance(client,job,1L,UUID.randomUUID().toString());((Map)field("prefetchByThread").get(client)).put("archive".equals(job.kind)?"archive:"+CHILD:CHILD,task);task.run();
        assertEquals(0,requests);assertTrue(store.duePreparations("ai",Long.MAX_VALUE,10).isEmpty());assertNotNull(store.catalogRecord("ai",CHILD));
    }
    @Test public void unknownOldPinAdoptsOneHeadThenRetiresBeforeAnyBodyRead()throws Exception {
        store.saveCatalogCursor("ai","g1",0);
        field("http").set(client,new OkHttpClient.Builder().addInterceptor(chain->{
            requests++;
            try {
                okio.Buffer buffer=new okio.Buffer();chain.request().body().writeTo(buffer);
                JSONObject call=new JSONObject(buffer.readUtf8());assertEquals("thread/read",call.getString("method"));
                JSONObject record=new JSONObject().put("scope","ai").put("key","read:child-head").put("kind","history").put("threadId",CHILD)
                    .put("generation","g1").put("sourceGeneration","g1").put("revision",1).put("deleted",false).put("source","native")
                    .put("payload",new JSONObject().put("method","thread/read").put("params",call.getJSONObject("params"))
                    .put("result",new JSONObject().put("thread",thread(CHILD,spawn(),"idle"))));
                return new Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                    .body(ResponseBody.create(record.toString(),MediaType.get("application/json"))).build();
            } catch(JSONException failure){throw new java.io.IOException(failure);}
        }).build());
        SyncStore.Preparation job=store.requestPreparation("ai","history",CHILD,"",2,true,"old-pin");
        Class<?> type=Class.forName("top.whytan.dsh.SyncClient$PrefetchTask");Constructor<?> ctor=type.getDeclaredConstructor(SyncClient.class,SyncStore.Preparation.class,long.class,String.class);ctor.setAccessible(true);
        Runnable task=(Runnable)ctor.newInstance(client,job,1L,UUID.randomUUID().toString());((Map)field("prefetchByThread").get(client)).put("archive".equals(job.kind)?"archive:"+CHILD:CHILD,task);task.run();
        assertEquals(1,requests);assertTrue(store.isInternalDirectoryThread("ai",CHILD));assertTrue(store.duePreparations("ai",Long.MAX_VALUE,10).isEmpty());
    }
}
