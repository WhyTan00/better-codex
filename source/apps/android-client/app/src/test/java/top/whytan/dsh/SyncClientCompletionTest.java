package top.whytan.dsh;

import static org.junit.Assert.*;
import android.content.Context;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import java.lang.reflect.*;
import java.util.concurrent.ExecutorService;
import okhttp3.*;

/** Exercises the actual completion path with in-process HTTP and real SQLite. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=28,manifest=Config.NONE)
public class SyncClientCompletionTest {
    static final String THREAD="11111111-1111-4111-8111-111111111111", TURN="22222222-2222-4222-8222-222222222222";
    SyncStore store; SyncClient client; Thread.UncaughtExceptionHandler handler;
    volatile boolean called,ready,committed,terminalCommitted; java.util.concurrent.CountDownLatch completionSeen=new java.util.concurrent.CountDownLatch(1); int responseCode=200,itemReads=0; boolean legacy,missingFinal,wrongTurn,stillRunning,summaryBody,oversizedItems;
    boolean oversizedLegacy, interrupted, silentPolicy, policyFailure; int policyReads;
    Runnable onState=()->{};
    private static Field field(Class<?> c,String name)throws Exception {Field f=c.getDeclaredField(name);f.setAccessible(true);return f;}
    JSONObject record(String key,String kind,JSONObject payload)throws Exception {
        return new JSONObject().put("scope","ai").put("key",key).put("kind",kind).put("threadId",THREAD)
            .put("generation","g1").put("sourceGeneration","g1").put("revision",2).put("deleted",false).put("payload",payload);
    }
    @Before public void setup()throws Exception {
        handler=Thread.getDefaultUncaughtExceptionHandler();Context context=RuntimeEnvironment.getApplication();context.deleteDatabase("native-sync-v1.sqlite");context.getSharedPreferences("completion-push-policy-ai",0).edit().clear().commit();store=new SyncStore(context);
        store.applyNativeRecord(record("thread:"+THREAD,"catalog",new JSONObject().put("nativeThread",new JSONObject().put("id",THREAD))),null);
        store.observeTurn("ai",THREAD,TURN,"inProgress",true,false,10);
        client=new SyncClient(context,"ai",store,new SyncClient.Listener(){
            public void onState(String s,JSONObject state){onState.run();}
            public void onCompletion(String s,String t,String u,boolean bodyReady){
                called=true;ready=bodyReady;
                JSONArray records=store.readRecords("ai",0,50).optJSONArray("records");
                for(int i=0;i<records.length();i++) {
                    JSONObject row=records.optJSONObject(i);
                    if("read:body".equals(row.optString("key")))committed=true;
                    if("read:turns".equals(row.optString("key")))terminalCommitted="completed".equals(row.optJSONObject("payload").optJSONObject("result").optJSONArray("data").optJSONObject(0).optString("status"));
                }completionSeen.countDown();
            }
        });
        field(SyncClient.class,"nativeOnline").set(client,true);
        OkHttpClient mock=new OkHttpClient.Builder().addInterceptor(chain->{
            assertTrue(NativeDiagnostics.isUuid(chain.request().header("X-DSH-Diagnostic-Trace")));
            assertTrue(!called);
            String body;
            if(chain.request().url().encodedPath().endsWith("/push-thread-policy")) {
                policyReads++;
                return new Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(policyFailure?503:200).message("policy fixture")
                    .body(ResponseBody.create("{\"threadId\":\""+THREAD+"\",\"silent\":"+silentPolicy+"}",MediaType.parse("application/json"))).build();
            }
            try {
                okio.Buffer buffer=new okio.Buffer();chain.request().body().writeTo(buffer);JSONObject request=new JSONObject(buffer.readUtf8());
                String method=request.getString("method");JSONObject params=request.getJSONObject("params"),result=new JSONObject();String key,kind;
                JSONObject finalItem=new JSONObject().put("id","final-1").put("type","agentMessage").put("phase",missingFinal?"commentary":"final_answer").put("text","final text");
                if(method.equals("thread/read")){key="read:head";kind="history";result.put("thread",new JSONObject().put("id",THREAD).put("historyMode",legacy?"legacy":"durable"));}
                else if(method.equals("thread/turns/list")){key="read:turns";kind="history";assertEquals(legacy?2:20,params.getInt("limit"));String view=params.getString("itemsView");JSONArray items=legacy||summaryBody?new JSONArray().put(finalItem):new JSONArray();if(oversizedLegacy&&"full".equals(view))items.put(new JSONObject().put("id","large-tool-output").put("type","commandExecution").put("aggregatedOutput","x".repeat(2*SyncStore.MAX_RECORD_BYTES)));result.put("data",new JSONArray().put(new JSONObject().put("id",TURN).put("status",stillRunning?"inProgress":interrupted?"interrupted":"completed").put("itemsView",view).put("items",items)));}
                else {assertEquals("thread/items/list",method);itemReads++;key="read:body";kind="item";if(wrongTurn)params.put("turnId","33333333-3333-4333-8333-333333333333");JSONArray items=new JSONArray().put(finalItem);if(oversizedItems)items.put(new JSONObject().put("type","commandExecution").put("aggregatedOutput","x".repeat(SyncStore.MAX_RECORD_BYTES+1)));result.put("data",items);}
                body=record(key,kind,new JSONObject().put("method",method).put("params",params).put("result",result)).toString();
            } catch(Exception error){throw new java.io.IOException(error);}
            return new Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(responseCode).message("fixture")
                .body(ResponseBody.create(body,MediaType.parse("application/json"))).build();
        }).build();field(SyncClient.class,"http").set(client,mock);
    }
    private void completion()throws Exception {
        Method m=SyncClient.class.getDeclaredMethod("processEvent",JSONObject.class,boolean.class);m.setAccessible(true);
        m.invoke(client,new JSONObject().put("type","turn").put("threadId",THREAD).put("turn",new JSONObject().put("id",TURN).put("status","completed")),false);
    }
    @Test public void committedStreamFinalAvoidsNetworkButGapOrRewriteCannotClaimReady()throws Exception {
        JSONObject event=new JSONObject().put("type","turn").put("threadId",THREAD).put("turn",new JSONObject().put("id",TURN).put("status","completed").put("items",new JSONArray().put(new JSONObject().put("id","body").put("type","agentMessage").put("phase","final_answer").put("text","finished"))));
        store.receiveEvent("ai","e1",1,new JSONObject().put("event",event));store.commitStreamEvent("ai",store.nextEvent("ai"),event);
        java.util.concurrent.atomic.AtomicInteger reads=new java.util.concurrent.atomic.AtomicInteger();
        OkHttpClient.Builder mock=((OkHttpClient)field(SyncClient.class,"http").get(client)).newBuilder();mock.interceptors().add(0,chain->{reads.incrementAndGet();return chain.proceed(chain.request());});field(SyncClient.class,"http").set(client,mock.build());
        Method method=SyncClient.class.getDeclaredMethod("cacheCompletion",String.class,String.class,boolean.class,String.class,String.class);method.setAccessible(true);
        assertEquals(true,method.invoke(client,THREAD,TURN,true,java.util.UUID.randomUUID().toString(),"g1"));assertEquals(0,reads.get());
        responseCode=503;
        assertEquals(false,method.invoke(client,THREAD,TURN,true,java.util.UUID.randomUUID().toString(),"g2"));assertTrue(reads.get()>0);reads.set(0);
        JSONObject gap=new JSONObject().put("type","delta").put("threadId",THREAD).put("turnId",TURN).put("itemId","missing-seed").put("delta","untrusted partial");
        store.receiveEvent("ai","e1",2,new JSONObject().put("event",gap));store.commitStreamEvent("ai",store.nextEvent("ai"),gap);
        assertEquals(false,method.invoke(client,THREAD,TURN,true,java.util.UUID.randomUUID().toString(),"g1"));assertTrue(reads.get()>0);
    }
    @Test public void silentThreadNeverReachesAndroidCompletionListener()throws Exception {silentPolicy=true;completion();assertFalse(called);assertEquals(1,policyReads);}
    @Test public void ordinaryThreadRetainsCompletionAndDedupe()throws Exception {completion();assertTrue(called);assertEquals(1,policyReads);Method m=SyncClient.class.getDeclaredMethod("processTurn",JSONObject.class,String.class,boolean.class,boolean.class,boolean.class);m.setAccessible(true);m.invoke(client,new JSONObject().put("id",TURN).put("status","completed"),THREAD,true,false,true);assertEquals(1,policyReads);}
    @Test public void knownSilentPolicySurvivesClientReopenAndPolicyReadFailure()throws Exception {silentPolicy=true;completion();assertFalse(called);store.observeTurn("ai",THREAD,TURN,"inProgress",true,false,0);store.getWritableDatabase().execSQL("UPDATE turn_observations SET notified_at=0 WHERE thread_id=?",new Object[]{THREAD});policyFailure=true;completion();assertFalse(called);assertEquals(2,policyReads);}
    @Test public void callbackSeesCommittedBodyAndReadiness()throws Exception {completion();assertTrue(called);assertTrue(ready);assertTrue(committed);assertTrue(terminalCommitted);}
    @Test public void failedBodyReadNeverClaimsReady()throws Exception {responseCode=503;completion();assertTrue(called);assertFalse(ready);assertFalse(committed);}
    @Test public void missingFinalDoesNotClaimReady()throws Exception {missingFinal=true;completion();assertTrue(called);assertFalse(ready);assertTrue(committed);}
    @Test public void wrongTurnBodyIsRejectedBeforeCommit()throws Exception {wrongTurn=true;completion();assertTrue(called);assertFalse(ready);assertFalse(committed);}
    @Test public void inProgressSnapshotCannotClaimCompletionBodyReady()throws Exception {stillRunning=true;completion();assertTrue(called);assertFalse(ready);assertEquals(0,itemReads);}
    @Test public void legacyUsesBoundedSummaryWithoutUnsupportedItemCalls()throws Exception {legacy=true;completion();assertTrue(called);assertTrue(ready);assertTrue(terminalCommitted);assertEquals(0,itemReads);}
    @Test public void legacySummaryAvoidsFullRecordSizeFailure()throws Exception {
        legacy=true;oversizedLegacy=true;
        Method read=SyncClient.class.getDeclaredMethod("readTurnProjection",String.class,boolean.class,String.class,String.class);read.setAccessible(true);
        Object projection=read.invoke(client,THREAD,true,java.util.UUID.randomUUID().toString(),"g1");
        JSONObject value=(JSONObject)field(projection.getClass(),"record").get(projection);
        assertEquals("summary",value.getJSONObject("payload").getJSONObject("params").getString("itemsView"));
        assertTrue(value.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length<SyncStore.MAX_RECORD_BYTES);
        completion();assertTrue(called);assertTrue(ready);assertTrue(terminalCommitted);assertEquals(0,itemReads);
    }
    @Test public void completedSummaryIsCommittedBeforePushWithoutOversizedProcessPage()throws Exception {
        summaryBody=true;oversizedItems=true;completion();assertTrue(called);assertTrue(ready);assertTrue(terminalCommitted);assertEquals(0,itemReads);
    }
    @Test public void summaryWithOnlyCommentaryStillCannotClaimReady()throws Exception {
        summaryBody=true;missingFinal=true;completion();assertTrue(called);assertFalse(ready);assertEquals(1,itemReads);
    }
    @Test public void backgroundRefreshUsesCompletedSummaryWithoutReadingOversizedProcessPage()throws Exception {
        summaryBody=true;oversizedItems=true;
        Method read=SyncClient.class.getDeclaredMethod("readTurnProjection",String.class,boolean.class,String.class,String.class);read.setAccessible(true);
        Object projection=read.invoke(client,THREAD,true,java.util.UUID.randomUUID().toString(),"g1");
        JSONObject record=(JSONObject)field(projection.getClass(),"record").get(projection);
        Method cache=SyncClient.class.getDeclaredMethod("cacheRecentTurnItems",String.class,JSONArray.class,boolean.class,String.class,String.class,boolean.class,JSONObject.class,long.class,String.class);cache.setAccessible(true);
        java.util.Set<?> ready=(java.util.Set<?>)cache.invoke(client,THREAD,record.getJSONObject("payload").getJSONObject("result").getJSONArray("data"),true,null,"g1",field(projection.getClass(),"itemPagingSupported").getBoolean(projection),record,field(projection.getClass(),"readChange").getLong(projection),field(projection.getClass(),"streamVersion").get(projection));
        assertTrue(ready.contains(TURN));assertEquals(0,itemReads);
    }
    private void refreshHistory()throws Exception {
        Method read=SyncClient.class.getDeclaredMethod("fetchThreadTurnsInternal",String.class,boolean.class,String.class);read.setAccessible(true);
        read.invoke(client,THREAD,true,java.util.UUID.randomUUID().toString());
    }
    @Test public void legacyRunningSummaryDoesNotRequestUnsupportedItemPages()throws Exception {
        legacy=true;stillRunning=true;missingFinal=true;
        refreshHistory();assertFalse(called);assertEquals(0,itemReads);
    }
    @Test public void legacyInterruptedSummaryDoesNotRequestUnsupportedItemPages()throws Exception {
        legacy=true;interrupted=true;missingFinal=true;
        refreshHistory();assertFalse(called);assertEquals(0,itemReads);
    }
    @Test public void legacyCompletedWithoutFinalDoesNotRequestUnsupportedItemPagesOrClaimReady()throws Exception {
        legacy=true;missingFinal=true;
        completion();assertTrue(called);assertFalse(ready);assertEquals(0,itemReads);
    }
    @Test public void durableRunningSummaryWaitsForCompletionBeforeBodyPreparation()throws Exception {
        stillRunning=true;missingFinal=true;
        refreshHistory();assertFalse(called);assertEquals(0,itemReads);
    }
    @Test public void legacyHistoryWarmCommitsSummaryWithoutUnsupportedItemPages()throws Exception {
        legacy=true;missingFinal=true;
        Method warm=SyncClient.class.getDeclaredMethod("runHistoryWarm",JSONObject.class);warm.setAccessible(true);
        warm.invoke(client,new JSONObject().put("threadId",THREAD));
        boolean summaryCommitted=false;
        JSONArray records=store.readRecords("ai",0,50).getJSONArray("records");
        for(int i=0;i<records.length();i++) {
            JSONObject row=records.getJSONObject(i);
            if("read:turns".equals(row.optString("key")))summaryCommitted="summary".equals(row.getJSONObject("payload").getJSONObject("result").getJSONArray("data").getJSONObject(0).getString("itemsView"));
        }
        assertTrue(summaryCommitted);assertFalse(called);assertEquals(0,itemReads);
    }
    @Test public void notificationUrlPreservesTurnAndRejectsInvalidTurn()throws Exception {
        MainActivity activity=Robolectric.buildActivity(MainActivity.class).get();Method m=MainActivity.class.getDeclaredMethod("notificationTargetUrl",android.content.Intent.class);m.setAccessible(true);
        android.content.Intent intent=new android.content.Intent().putExtra("notification_scope","ai").putExtra("notification_thread",THREAD).putExtra("notification_turn",TURN);
        assertEquals(TURN,android.net.Uri.parse((String)m.invoke(activity,intent)).getQueryParameter("notificationTurn"));intent.putExtra("notification_turn","bad-turn");assertNull(m.invoke(activity,intent));
    }
    @Test public void blockedBodyReadDoesNotBlockReceivingAndAckingLaterFrames()throws Exception {
        java.util.concurrent.CountDownLatch entered=new java.util.concurrent.CountDownLatch(1),release=new java.util.concurrent.CountDownLatch(1);
        OkHttpClient.Builder builder=((OkHttpClient)field(SyncClient.class,"http").get(client)).newBuilder();
        builder.interceptors().add(0,chain->{entered.countDown();try{if(!release.await(5,java.util.concurrent.TimeUnit.SECONDS))throw new java.io.IOException("fixture blocked");}catch(InterruptedException e){throw new java.io.IOException(e);}return chain.proceed(chain.request());});
        field(SyncClient.class,"http").set(client,builder.build());
        java.util.List<String> frames=new java.util.concurrent.CopyOnWriteArrayList<>();
        WebSocket socket=new WebSocket(){
            public Request request(){return new Request.Builder().url("https://workbench.example.test").build();}
            public long queueSize(){return 0;} public boolean send(String v){frames.add(v);return true;}
            public boolean send(okio.ByteString b){return true;}public boolean close(int c,String r){return true;}public void cancel(){}
        };
        field(SyncClient.class,"socket").set(client,socket);field(SyncClient.class,"started").set(client,true);
        store.saveEventCursor("ai","e1",0);
        Method handle=SyncClient.class.getDeclaredMethod("handleFrame",WebSocket.class,String.class);handle.setAccessible(true);
        JSONObject one=new JSONObject().put("scope","ai").put("epoch","e1").put("seq",1).put("threadId",THREAD)
            .put("event",new JSONObject().put("type","turn").put("turn",new JSONObject().put("id",TURN).put("status","completed")));
        try {
            handle.invoke(client,socket,one.toString());
            assertTrue(entered.await(2,java.util.concurrent.TimeUnit.SECONDS));
            JSONObject two=new JSONObject().put("scope","ai").put("epoch","e1").put("seq",2)
                .put("event",new JSONObject().put("type","host").put("online",true));
            handle.invoke(client,socket,two.toString());
            assertEquals(2,store.eventCursor("ai").seq);
            assertTrue(frames.stream().anyMatch(v->v.contains("\"seq\":2")));
            assertFalse("completion must still be waiting for body",called);
            String other="44444444-4444-4444-8444-444444444444";
            JSONObject text=new JSONObject().put("scope","ai").put("epoch","e1").put("seq",3).put("threadId",other)
                .put("event",new JSONObject().put("type","item").put("turnId",TURN).put("item",new JSONObject().put("id","body-b").put("type","agentMessage").put("phase","final_answer").put("text","other final")));
            handle.invoke(client,socket,text.toString());
            long deadline=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(2);
            while(!store.readStream("ai",other).optBoolean("available")&&System.nanoTime()<deadline)Thread.sleep(5);
            assertEquals("other final",store.readStream("ai",other).getJSONArray("turns").getJSONObject(0).getJSONArray("items").getJSONObject(0).getString("text"));
            assertFalse("other final committed while completion HTTP remains blocked",called);
        } finally {
            release.countDown();
            assertTrue(completionSeen.await(3,java.util.concurrent.TimeUnit.SECONDS));
        }
        assertTrue(called);assertTrue(ready);assertTrue(store.nextEvent("ai")==null);
    }

    @Test public void arrivalBetweenEmptyInboxAndWorkerExitCannotWaitForPeriodicSync()throws Exception {
        field(SyncClient.class,"started").set(client,true);
        JSONObject first=new JSONObject().put("type","item").put("threadId",THREAD).put("turnId",TURN).put("item",new JSONObject().put("id","a").put("type","agentMessage").put("text","first"));
        JSONObject second=new JSONObject(first.toString()).put("item",new JSONObject().put("id","b").put("type","agentMessage").put("text","second"));
        Method drain=SyncClient.class.getDeclaredMethod("drainInbox");drain.setAccessible(true);
        java.util.concurrent.atomic.AtomicBoolean inject=new java.util.concurrent.atomic.AtomicBoolean(true);
        java.util.concurrent.CountDownLatch consumed=new java.util.concurrent.CountDownLatch(1);
        onState=()->{try{
            if(inject.compareAndSet(true,false)) {
                assertFalse(store.hasPendingEvents("ai"));
                assertTrue(((java.util.concurrent.atomic.AtomicBoolean)field(SyncClient.class,"inboxQueued").get(client)).get());
                store.receiveEvent("ai","e1",2,new JSONObject().put("event",second));drain.invoke(client);
            }else if(!store.hasPendingEvents("ai"))consumed.countDown();
        }catch(Exception failure){throw new AssertionError(failure);}};
        store.receiveEvent("ai","e1",1,new JSONObject().put("event",first));drain.invoke(client);
        assertTrue("no catalog timer or later event is needed",consumed.await(2,java.util.concurrent.TimeUnit.SECONDS));
        assertEquals("second",store.readStream("ai",THREAD).getJSONArray("turns").getJSONObject(0).getJSONArray("items").getJSONObject(1).getString("text"));
    }

    @After public void cleanup()throws Exception {
        if(client!=null)client.close();if(store!=null)store.close();
        NativeDiagnostics log=(NativeDiagnostics)field(NativeDiagnostics.class,"instance").get(null);
        if(log!=null){((ExecutorService)field(NativeDiagnostics.class,"writer").get(log)).shutdownNow();((ExecutorService)field(NativeDiagnostics.class,"network").get(log)).shutdownNow();((android.database.sqlite.SQLiteOpenHelper)field(NativeDiagnostics.class,"db").get(log)).close();field(NativeDiagnostics.class,"instance").set(null,null);}
        Thread.setDefaultUncaughtExceptionHandler(handler);
    }
}
