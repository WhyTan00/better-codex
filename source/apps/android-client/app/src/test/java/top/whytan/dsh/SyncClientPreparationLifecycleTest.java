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

/** Actual preparation worker and SQLite; no Native writes or external HTTP. */
@RunWith(RobolectricTestRunner.class) @Config(sdk=28,manifest=Config.NONE)
public class SyncClientPreparationLifecycleTest {
    static final String THREAD="11111111-1111-4111-8111-111111111111",TURN="22222222-2222-4222-8222-222222222222",NEWER="33333333-3333-4333-8333-333333333333";
    SyncStore store; SyncClient client; Thread.UncaughtExceptionHandler handler;
    String status="completed",generation="g1",sourceGeneration="g1",source="native"; boolean legacy,olderPage,missingTarget,hasFinal,stale,bodyFailure,itemsHaveMore,missingCursor,bodyTwoPages,bodyFinalOnSecondPage,bodyHasFinal;
    int bodyReads,turnPages,notifications,targetPage=2; boolean notifiedReady;
    int nextRevision=1; Map<String,String> payloadVersions=new HashMap<>();Map<String,Integer> revisions=new HashMap<>();
    interface ResponseHook {void run(JSONObject response)throws Exception;}
    ResponseHook beforeResponse=response->{};
    boolean requestFresh,headFailure; int headReads;
    java.util.function.Consumer<JSONObject> onState=state->{};
    static Field field(Class<?> type,String name)throws Exception {Field f=type.getDeclaredField(name);f.setAccessible(true);return f;}
    JSONObject dto(String key,String kind,JSONObject payload)throws Exception {
        String fingerprint=generation+payload.toString();
        if(!fingerprint.equals(payloadVersions.get(key))) {payloadVersions.put(key,fingerprint);revisions.put(key,nextRevision++);}
        return new JSONObject().put("scope","ai").put("threadId",THREAD).put("key",key).put("kind",kind)
                .put("generation",generation).put("sourceGeneration",sourceGeneration).put("revision",revisions.get(key)).put("deleted",false)
                .put("source",source).put("stale",stale).put("payload",payload);
    }
    @Before public void setup()throws Exception {
        handler=Thread.getDefaultUncaughtExceptionHandler();Context context=RuntimeEnvironment.getApplication();context.deleteDatabase("native-sync-v1.sqlite");store=new SyncStore(context);
        store.applyNativeRecord(dto("thread:"+THREAD,"catalog",new JSONObject().put("nativeThread",new JSONObject().put("id",THREAD).put("status",new JSONObject().put("type","idle")))));
        store.observeTurn("ai",THREAD,TURN,"inProgress",true,false,10);
        client=new SyncClient(context,"ai",store,new SyncClient.Listener(){public void onState(String scope,JSONObject state){onState.accept(state);}public void onCompletion(String scope,String thread,String turn,boolean ready){notifications++;notifiedReady=ready;}});
        field(SyncClient.class,"nativeOnline").setBoolean(client,true);
        // The test drives the real worker explicitly; events still persist their jobs.
        ((ExecutorService)field(SyncClient.class,"prefetchWorkers").get(client)).shutdownNow();
        ((ExecutorService)field(SyncClient.class,"focusWorkers").get(client)).shutdownNow();
        OkHttpClient mock=new OkHttpClient.Builder().addInterceptor(chain->{try{
            okio.Buffer buffer=new okio.Buffer();chain.request().body().writeTo(buffer);JSONObject request=new JSONObject(buffer.readUtf8()),params=request.getJSONObject("params"),result=new JSONObject();
            String method=request.getString("method");int code=200;
            requestFresh=request.optBoolean("fresh");
            if("thread/read".equals(method)){headReads++;if(headFailure)code=503;}
            if("thread/read".equals(method))result.put("thread",new JSONObject().put("id",THREAD).put("historyMode",legacy?"legacy":"paginated"));
            else if("thread/turns/list".equals(method)) {
                turnPages++;boolean target=!missingTarget&&(!olderPage||"target-page".equals(params.optString("cursor")));
                JSONObject turn=new JSONObject().put("id",target?TURN:NEWER).put("status",target?status:"inProgress")
                        .put("itemsView","summary").put("items",target&&hasFinal?finalItems():new JSONArray());
                Object next=olderPage&&!params.has("cursor")?(targetPage==3?"middle-page":"target-page"):"middle-page".equals(params.optString("cursor"))?"target-page":JSONObject.NULL;
                result.put("data",new JSONArray().put(turn)).put("nextCursor",next);
            } else {
                assertEquals("thread/items/list",method);assertEquals(TURN,params.getString("turnId"));bodyReads++;
                result.put("data",hasFinal||bodyHasFinal||bodyFinalOnSecondPage&&params.has("cursor")?finalItems():new JSONArray());
                if(!missingCursor)result.put("nextCursor",itemsHaveMore?"unresolved-items":bodyTwoPages&&!params.has("cursor")?"body-page":JSONObject.NULL);
                if(bodyFailure)code=503;
            }
            String key="read:"+new JSONArray().put(method).put(params).toString().replace("\\/","/");
            JSONObject response=dto(key,"history",new JSONObject().put("method",method).put("params",params).put("result",result));
            beforeResponse.run(response);
            return new Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(code).message("fixture").body(ResponseBody.create(response.toString(),MediaType.get("application/json"))).build();
        }catch(Exception error){throw new java.io.IOException(error);}}).build();field(SyncClient.class,"http").set(client,mock);
    }
    JSONArray finalItems()throws Exception {return new JSONArray().put(new JSONObject().put("id","final").put("type","agentMessage").put("phase","final_answer").put("text","fixture final"));}
    void runPreparation()throws Exception {
        SyncStore.Preparation job=store.requestPreparation("ai","completion",THREAD,TURN,1,false,"fixture");
        Class<?> type=Class.forName("top.whytan.dsh.SyncClient$PrefetchTask");Constructor<?> ctor=type.getDeclaredConstructor(SyncClient.class,SyncStore.Preparation.class,long.class,String.class);ctor.setAccessible(true);
        Runnable task=(Runnable)ctor.newInstance(client,job,1L,UUID.randomUUID().toString());
        ((Map)field(SyncClient.class,"prefetchByThread").get(client)).put(THREAD,task);task.run();
    }
    void refresh()throws Exception {refresh(true);}
    void refresh(boolean baseline)throws Exception {Method m=SyncClient.class.getDeclaredMethod("fetchThreadTurnsInternal",String.class,boolean.class,String.class);m.setAccessible(true);m.invoke(client,THREAD,baseline,UUID.randomUUID().toString());}
    void event(JSONObject event)throws Exception {Method m=SyncClient.class.getDeclaredMethod("processEvent",JSONObject.class,boolean.class);m.setAccessible(true);m.invoke(client,event,false);}
    void warm(JSONObject candidate)throws Exception {Method m=SyncClient.class.getDeclaredMethod("runHistoryWarm",JSONObject.class);m.setAccessible(true);m.invoke(client,candidate);}
    @Test public void failedOptionalHistoryIsNotSelectedOnEveryCatalogAndSurvivesRestart()throws Exception {
        JSONObject candidate=store.historyWarmCandidates("ai",4).get(0);headFailure=true;
        warm(candidate);assertEquals(1,headReads);
        assertTrue("unchanged failed target must yield to other history",store.historyWarmCandidates("ai",4).isEmpty());
        String pending=store.getMeta("ai","history-warm-failure:"+THREAD);assertNotNull(pending);
        reopenClientAndStore();assertTrue(store.historyWarmCandidates("ai",4).isEmpty());
        assertEquals(pending,store.getMeta("ai","history-warm-failure:"+THREAD));
        generation="g2";
        store.applyNativeRecord(dto("thread:"+THREAD,"catalog",new JSONObject().put("nativeThread",new JSONObject().put("id",THREAD).put("status",new JSONObject().put("type","idle")))));
        assertEquals("new source version wakes optional preparation",1,store.historyWarmCandidates("ai",4).size());
    }
    @Test public void historyDebtBackoffDoesNotClaimBodyReadyAndFocusOverridesIt()throws Exception {
        JSONObject candidate=store.historyWarmCandidates("ai",4).get(0);long now=System.currentTimeMillis();
        for(int i=0;i<10;i++)store.deferHistoryWarm("ai",candidate,now);
        JSONObject debt=new JSONObject(store.getMeta("ai","history-warm-failure:"+THREAD));
        assertEquals(30*60_000L,debt.getLong("dueAt")-now);
        assertNull(store.getMeta("ai","history-warm:"+THREAD));
        assertFalse(store.historyWarmDue("ai",THREAD,candidate.getString("version"),now+1));
        assertTrue(store.historyWarmDue("ai",THREAD,candidate.getString("version"),now+30*60_000L));
        Method schedule=SyncClient.class.getDeclaredMethod("scheduleThreadPrefetch",String.class,boolean.class,int.class);schedule.setAccessible(true);schedule.invoke(client,THREAD,false,0);
        assertNull("explicit focus bypasses the optional retry debt",store.getMeta("ai","history-warm-failure:"+THREAD));
        assertEquals(1,store.historyWarmCandidates("ai",4).size());
    }
    @Test public void supersededCachedHeadRevalidatesOnceAndInterruptedHistoryStopsWarming()throws Exception {
        status="interrupted";
        JSONObject params=new JSONObject().put("threadId",THREAD).put("includeTurns",false);
        String key="read:"+new JSONArray().put("thread/read").put(params).toString().replace("\\/","/");
        JSONObject payload=new JSONObject().put("method","thread/read").put("params",params)
                .put("result",new JSONObject().put("thread",new JSONObject().put("id",THREAD).put("historyMode","paginated")));
        store.applyNativeRecord(dto(key,"history",payload).put("revision",100));
        int[] freshReads={0};
        beforeResponse=response->{if("thread/read".equals(response.getJSONObject("payload").getString("method"))) {
            response.put("source",requestFresh?"native":"cloud-cache");
            if(requestFresh){freshReads[0]++;response.put("revision",101);}
        }};
        JSONObject candidate=store.historyWarmCandidates("ai",4).get(0);
        warm(candidate);
        assertEquals("one source validation repairs an obsolete cloud head",1,freshReads[0]);
        assertTrue("an interrupted summary does not owe a final answer",store.historyWarmCandidates("ai",4).isEmpty());
        assertEquals(0,bodyReads);assertEquals(0,notifications);
    }
    @Test public void interruptedHistoryWithoutFinalIsWarmWithoutBodyPreparation()throws Exception {
        status="interrupted";warm(store.historyWarmCandidates("ai",4).get(0));
        assertTrue("complete interrupted history must not be selected on every catalog",store.historyWarmCandidates("ai",4).isEmpty());
        assertEquals(0,bodyReads);assertEquals(0,notifications);
    }
    @Test public void verifiedEmptyReceiptCanWarmTheSameCachedSummaryWithoutReopeningDebt()throws Exception {
        runPreparation();assertEquals(0,store.criticalPreparations("ai"));assertEquals(1,bodyReads);
        source="cloud-cache";warm(store.historyWarmCandidates("ai",4).get(0));
        assertTrue("cached DTO identities can reuse an existing Native empty proof",store.historyWarmCandidates("ai",4).isEmpty());
        assertEquals("do not reread the same exhausted body as optional warmup",1,bodyReads);
        assertEquals(0,store.criticalPreparations("ai"));assertEquals(0,notifications);
    }
    @Test public void reorderedCachedSummaryReusesTheExactSameSemanticReceipt()throws Exception {
        runPreparation();assertEquals(0,store.criticalPreparations("ai"));assertEquals(1,bodyReads);
        source="cloud-cache";
        beforeResponse=response->{
            JSONObject payload=response.getJSONObject("payload"),result=payload.getJSONObject("result");
            JSONArray data=result.optJSONArray("data");
            if(data!=null)for(int i=0;i<data.length();i++) {
                JSONObject value=data.getJSONObject(i),reordered=new JSONObject();
                java.util.List<String> keys=new java.util.ArrayList<>();value.keys().forEachRemaining(keys::add);java.util.Collections.sort(keys);
                for(String key:keys)reordered.put(key,value.get(key));data.put(i,reordered);
            }
            JSONObject reordered=new JSONObject();reordered.put("result",result).put("params",payload.getJSONObject("params")).put("method",payload.getString("method"));
            response.put("payload",reordered);
        };
        warm(store.historyWarmCandidates("ai",4).get(0));
        assertTrue("JSON object key order is not a newer/different DTO",store.historyWarmCandidates("ai",4).isEmpty());
        assertEquals(1,bodyReads);assertEquals(0,notifications);
    }
    @Test public void apk34ByteDigestReceiptStillWorksAfterProcessAndStoreReopen()throws Exception {
        runPreparation();JSONObject saved=store.emptyCompletionRead("ai",THREAD,TURN);
        JSONArray identities=saved.getJSONArray("identities");
        for(int i=0;i<identities.length();i++) {
            JSONObject read=identities.getJSONObject(i);
            try(android.database.Cursor row=store.getReadableDatabase().query("records",new String[]{"payload"},"scope=? AND key=?",new String[]{"ai",read.getString("key")},null,null,null)) {
                assertTrue(row.moveToFirst());String raw=row.getString(0);JSONObject payload=new JSONObject(raw);
                read.remove("digestVersion");read.put("payloadDigest",DeliverableCache.digest(raw));
                if("thread/turns/list".equals(payload.optString("method"))) {
                    JSONObject turn=payload.getJSONObject("result").getJSONArray("data").getJSONObject(0);
                    saved.put("version","g1:g1:"+DeliverableCache.digest(turn.toString()));
                }
            }
        }
        android.content.ContentValues old=new android.content.ContentValues();old.put("value",saved.toString());
        assertEquals(1,store.getWritableDatabase().update("meta",old,"scope=? AND key=?",new String[]{"ai","completion-empty:"+THREAD+":"+TURN}));
        reopenClientAndStore();source="cloud-cache";warm(store.historyWarmCandidates("ai",4).get(0));
        assertTrue(store.historyWarmCandidates("ai",4).isEmpty());assertEquals(1,bodyReads);
        assertEquals(0,store.criticalPreparations("ai"));assertEquals(0,notifications);
    }
    @Test public void missingSourceFromDurableGatewayResponseKeepsEmptyPreparationPending()throws Exception {
        beforeResponse=response->{if("thread/items/list".equals(response.getJSONObject("payload").getString("method")))response.remove("source");};
        runPreparation();assertEquals("HTTP 200 and nextCursor null alone are not Native proof",1,store.criticalPreparations("ai"));
        assertNull(store.emptyCompletionRead("ai",THREAD,TURN));assertEquals(0,notifications);
    }
    @Test public void freshRevalidationConflictRemainsRejectedWithoutLoopOrCacheRegression()throws Exception {
        status="interrupted";
        JSONObject params=new JSONObject().put("threadId",THREAD).put("includeTurns",false);
        String key="read:"+new JSONArray().put("thread/read").put(params).toString().replace("\\/","/");
        JSONObject payload=new JSONObject().put("method","thread/read").put("params",params)
                .put("result",new JSONObject().put("thread",new JSONObject().put("id",THREAD).put("historyMode","paginated")));
        store.applyNativeRecord(dto(key,"history",payload).put("revision",100));
        int[] reads={0};
        beforeResponse=response->{if("thread/read".equals(response.getJSONObject("payload").getString("method"))) {
            reads[0]++;response.put("source",requestFresh?"native":"cloud-cache");
            if(requestFresh)response.put("revision",99);
        }};
        warm(store.historyWarmCandidates("ai",4).get(0));
        assertEquals("unknown body identity goes directly to one fresh source validation",1,reads[0]);
        assertTrue("failed revalidation retains a debt instead of immediate reselection",store.historyWarmCandidates("ai",4).isEmpty());
        assertNotNull(store.getMeta("ai","history-warm-failure:"+THREAD));
        assertEquals(0,turnPages);assertEquals(0,notifications);
        JSONArray rows=store.readRecords("ai",0,20).getJSONArray("records");
        for(int i=0;i<rows.length();i++)if(key.equals(rows.getJSONObject(i).optString("key")))assertEquals(100,rows.getJSONObject(i).getInt("revision"));
    }
    @Test public void actualGatewayDurableItemsEnvelopeSettlesAnEmptyPreparation()throws Exception {
        // Generated by the real Go serveNativeRead handler; do not add source
        // metadata in this Java fixture or the cross-language defect is hidden.
        final JSONObject envelope;
        try(java.io.InputStream input=getClass().getResourceAsStream("/gateway-items-envelope.json")) {
            assertNotNull("generate the envelope with TestNativeItemReadProvenance",input);
            envelope=new JSONObject(new String(input.readAllBytes(),java.nio.charset.StandardCharsets.UTF_8));
        }
        beforeResponse=response->{if("thread/items/list".equals(response.getJSONObject("payload").getString("method"))) {
            java.util.List<String> keys=new java.util.ArrayList<>();response.keys().forEachRemaining(keys::add);
            for(String key:keys)response.remove(key);
            java.util.Iterator<String> generated=envelope.keys();while(generated.hasNext()){String key=generated.next();response.put(key,envelope.get(key));}
        }};
        runPreparation();assertEquals("actual HTTP envelope must establish authoritative exhaustion",0,store.criticalPreparations("ai"));
        assertNotNull(store.emptyCompletionRead("ai",THREAD,TURN));assertEquals(1,bodyReads);assertEquals(0,notifications);
    }
    JSONObject gatewayFixture(String name)throws Exception {
        try(java.io.InputStream input=getClass().getResourceAsStream("/"+name)) {
            assertNotNull("fixture exported by the real Go handler",input);
            return new JSONObject(new String(input.readAllBytes(),java.nio.charset.StandardCharsets.UTF_8));
        }
    }
    JSONObject identity(JSONObject record)throws Exception {
        Method method=SyncClient.class.getDeclaredMethod("readIdentity",JSONObject.class);method.setAccessible(true);
        return (JSONObject)method.invoke(null,record);
    }
    @Test public void actualGoCachedHeadKeyOrderKeepsIdentityButValueOrArrayChangesDoNot()throws Exception {
        JSONObject nativeRecord=gatewayFixture("gateway-head-native-record.json");
        JSONObject cached=gatewayFixture("gateway-head-cache-envelope.json");
        assertEquals(nativeRecord.getLong("revision"),cached.getLong("revision"));
        assertNotEquals("fixture must retain the original producer difference",nativeRecord.getJSONObject("payload").toString(),cached.getJSONObject("payload").toString());
        store.applyNativeRecord(nativeRecord);assertTrue(store.applyReadRecord(cached,null,"g1"));
        assertTrue("same revision and semantic JSON must remain readable",store.currentReadIdentities(Collections.singletonList(identity(cached))));
        JSONObject changed=new JSONObject(cached.toString());
        changed.getJSONObject("payload").getJSONObject("result").getJSONObject("thread").put("historyMode","legacy");
        assertFalse("real field changes remain rejected",store.currentReadIdentities(Collections.singletonList(identity(changed))));
        JSONObject ordered=new JSONObject(nativeRecord.toString()).put("revision",43);
        ordered.getJSONObject("payload").getJSONObject("result").getJSONObject("thread").put("turns",new JSONArray().put("first").put("second"));
        store.applyNativeRecord(ordered);
        JSONObject reversed=new JSONObject(ordered.toString());
        reversed.getJSONObject("payload").getJSONObject("result").getJSONObject("thread").put("turns",new JSONArray().put("second").put("first"));
        assertFalse("array order is part of the Native content",store.currentReadIdentities(Collections.singletonList(identity(reversed))));
    }
    @Test public void authoritativeEmptyTerminalSettlesWithoutInventingFinalOrRequeue()throws Exception {
        runPreparation();assertEquals("fully read empty terminal is not missing sync work",0,store.criticalPreparations("ai"));assertEquals(0,notifications);assertEquals(1,bodyReads);
        refresh();assertEquals(0,store.criticalPreparations("ai"));assertEquals("same read version should reuse the verified absence",1,bodyReads);assertEquals(0,notifications);
    }
    @Test public void interruptedAndFailedTargetsReleaseOldCompletionWithoutFinal()throws Exception {
        for(String terminal:new String[]{"interrupted","failed","cancelled"}) {status=terminal;runPreparation();assertEquals(terminal,0,store.criticalPreparations("ai"));}
        assertEquals(0,bodyReads);assertEquals(0,notifications);
    }
    @Test public void currentLegacyActiveOrInterruptedDoesNotCreateCompletionDebt()throws Exception {
        legacy=true;status="inProgress";refresh();assertEquals(0,store.criticalPreparations("ai"));status="interrupted";refresh();assertEquals(0,store.criticalPreparations("ai"));assertEquals(0,bodyReads);
    }
    @Test public void targetOutsideLatestPageIsLocatedThroughItsNativeCursor()throws Exception {
        legacy=true;olderPage=true;hasFinal=true;runPreparation();assertEquals(0,store.criticalPreparations("ai"));assertEquals(2,turnPages);assertEquals(0,bodyReads);assertEquals(1,notifications);assertTrue(notifiedReady);
    }
    @Test public void missingTargetStaleNetworkAndIncompleteItemsRemainPending()throws Exception {
        missingTarget=true;runPreparation();assertEquals(1,store.criticalPreparations("ai"));assertEquals(0,bodyReads);
        missingTarget=false;stale=true;runPreparation();assertEquals(1,store.criticalPreparations("ai"));
        stale=false;bodyFailure=true;runPreparation();assertEquals(1,store.criticalPreparations("ai"));
        bodyFailure=false;itemsHaveMore=true;runPreparation();assertEquals(1,store.criticalPreparations("ai"));
        itemsHaveMore=false;missingCursor=true;runPreparation();assertEquals(1,store.criticalPreparations("ai"));assertEquals(0,notifications);
    }
    @Test public void lateItemInvalidatesAbsenceAndCanStillDeliverRealFinal()throws Exception {
        runPreparation();assertEquals(0,store.criticalPreparations("ai"));assertEquals(0,notifications);
        hasFinal=true;event(new JSONObject().put("type","item").put("threadId",THREAD).put("turnId",TURN).put("item",finalItems().getJSONObject(0)));
        assertEquals("late item schedules exact target recheck",1,store.criticalPreparations("ai"));runPreparation();assertEquals(0,store.criticalPreparations("ai"));assertEquals(1,notifications);assertTrue(notifiedReady);
    }
    @Test public void rewrittenReadVersionMustNotReusePriorEmptyProof()throws Exception {
        runPreparation();assertEquals(0,store.criticalPreparations("ai"));generation="g2";bodyFailure=true;runPreparation();assertEquals(1,store.criticalPreparations("ai"));assertEquals(2,bodyReads);
    }
    @Test public void eventDuringFirstSummaryReadCannotBecomeAnEmptyReceipt()throws Exception {
        java.util.concurrent.atomic.AtomicBoolean once=new java.util.concurrent.atomic.AtomicBoolean(true);
        beforeResponse=response->{if("thread/turns/list".equals(response.getJSONObject("payload").getString("method"))&&once.getAndSet(false))
            event(new JSONObject().put("type","item").put("threadId",THREAD).put("turnId",TURN).put("item",finalItems().getJSONObject(0)));};
        runPreparation();assertEquals(1,store.criticalPreparations("ai"));assertEquals(0,notifications);
        hasFinal=true;beforeResponse=response->{};runPreparation();assertEquals(0,store.criticalPreparations("ai"));assertEquals(1,notifications);assertTrue(notifiedReady);
    }
    @Test public void unadoptedLowerOrConflictingEqualRevisionEmptyReadCannotReplaceStoredFinal()throws Exception {
        for(int increment:new int[]{10,0}) {
            beforeResponse=response->{if("thread/items/list".equals(response.getJSONObject("payload").getString("method"))) {
                JSONObject stored=new JSONObject(response.toString()).put("revision",response.getLong("revision")+increment);
                stored.getJSONObject("payload").getJSONObject("result").put("data",finalItems());
                store.applyReadRecord(stored,null,"g1");
            }};
            runPreparation();assertEquals(1,store.criticalPreparations("ai"));assertEquals(0,notifications);
            boolean retained=false;JSONArray rows=store.readRecords("ai",0,50).getJSONArray("records");
            for(int i=0;i<rows.length();i++){JSONObject payload=rows.getJSONObject(i).optJSONObject("payload");if(payload!=null&&"thread/items/list".equals(payload.optString("method")))retained=SyncClient.hasFinalAnswer(payload.getJSONObject("result").getJSONArray("data"));}
            assertTrue("known final remains in SQLite",retained);
            // Separate same-revision case must not inherit the higher row.
            store.getWritableDatabase().delete("records","scope=? AND thread_id=? AND key LIKE ?",new String[]{"ai",THREAD,"read:[\"thread/items/list\",%"});
        }
    }
    @Test public void nativeChangedItemReopensAnExactTargetOutsideRecentPage()throws Exception {
        runPreparation();assertEquals(0,store.criticalPreparations("ai"));olderPage=true;hasFinal=true;
        event(new JSONObject().put("type","nativeChanged").put("threadId",THREAD).put("cacheKey","item:"+THREAD+":"+TURN+":final"));
        assertEquals(1,store.criticalPreparations("ai"));int before=turnPages;runPreparation();assertEquals(2,turnPages-before);assertEquals(0,store.criticalPreparations("ai"));assertEquals(1,notifications);assertTrue(notifiedReady);
    }
    @Test public void incompleteThenCompleteItemPagesSettleOnlyAfterLastNativePage()throws Exception {
        bodyTwoPages=true;runPreparation();assertEquals(2,bodyReads);assertEquals(0,store.criticalPreparations("ai"));assertEquals(0,notifications);
    }
    @Test public void finalOnSecondItemPageStillNotifiesWithCommittedBody()throws Exception {
        bodyTwoPages=true;bodyFinalOnSecondPage=true;runPreparation();assertEquals(2,bodyReads);assertEquals(0,store.criticalPreparations("ai"));assertEquals(1,notifications);assertTrue(notifiedReady);
    }
    @Test public void unknownMissingAndCacheSourcesCannotProveEmptyTerminal()throws Exception {
        for(String candidate:new String[]{"unexpected",null,"mac-cache","cloud-cache"}) {source=candidate;runPreparation();assertEquals(1,store.criticalPreparations("ai"));assertEquals(0,notifications);}
    }
    @Test public void staleSummaryInNormalNonbaselineRefreshCannotObserveOldCompletion()throws Exception {
        beforeResponse=response->{if("thread/turns/list".equals(response.getJSONObject("payload").getString("method"))) {
            JSONObject newer=new JSONObject(response.toString()).put("revision",response.getLong("revision")+10);
            newer.getJSONObject("payload").getJSONObject("result").getJSONArray("data").getJSONObject(0).put("status","interrupted");
            store.applyReadRecord(newer,null,"g1");
        }};
        try {refresh(false);fail("unadopted old summary was accepted");}catch(InvocationTargetException expected){assertEquals("StaleReadException",expected.getCause().getClass().getSimpleName());}
        assertEquals(0,notifications);assertEquals(0,store.criticalPreparations("ai"));assertEquals(0,bodyReads);
    }
    @Test public void publishedCompletionStateMustFollowPersistentTaskRemoval()throws Exception {
        ((ExecutorService)field(SyncClient.class,"worker").get(client)).shutdownNow();
        field(SyncClient.class,"worker").set(client,new java.util.concurrent.AbstractExecutorService(){
            boolean closed;public void shutdown(){closed=true;}public java.util.List<Runnable> shutdownNow(){closed=true;return java.util.Collections.emptyList();}
            public boolean isShutdown(){return closed;}public boolean isTerminated(){return closed;}
            public boolean awaitTermination(long timeout,java.util.concurrent.TimeUnit unit){return closed;}
            public void execute(Runnable work){work.run();}
        });
        java.util.List<Integer> pending=new java.util.ArrayList<>(),stored=new java.util.ArrayList<>();
        onState=state->{pending.add(state.optInt("criticalPending",-1));stored.add(store.preparationStatus("ai").optInt("pendingPreparations",-1));};
        runPreparation();assertEquals(java.util.Collections.singletonList(0),pending);assertEquals(java.util.Collections.singletonList(0),stored);
    }
    @Test public void positiveBodyCannotNotifyAfterItsSummaryWasReplacedByInterrupted()throws Exception {
        bodyHasFinal=true;java.util.concurrent.atomic.AtomicReference<JSONObject> summary=new java.util.concurrent.atomic.AtomicReference<>();
        beforeResponse=response->{String method=response.getJSONObject("payload").getString("method");
            if("thread/turns/list".equals(method))summary.set(new JSONObject(response.toString()));
            if("thread/items/list".equals(method)) {
                JSONObject newer=summary.get();newer.put("revision",newer.getLong("revision")+10);
                newer.getJSONObject("payload").getJSONObject("result").getJSONArray("data").getJSONObject(0).put("status","interrupted");
                store.applyReadRecord(newer,null,"g1");
            }
        };
        runPreparation();assertEquals(1,store.criticalPreparations("ai"));assertEquals(0,notifications);assertEquals(1,bodyReads);
    }
    void reopenClientAndStore()throws Exception {
        OkHttpClient old=(OkHttpClient)field(SyncClient.class,"http").get(client);client.close();store.close();
        Context context=RuntimeEnvironment.getApplication();store=new SyncStore(context);
        client=new SyncClient(context,"ai",store,new SyncClient.Listener(){public void onState(String scope,JSONObject state){onState.accept(state);}public void onCompletion(String scope,String thread,String turn,boolean ready){notifications++;notifiedReady=ready;}});
        field(SyncClient.class,"nativeOnline").setBoolean(client,true);
        ((ExecutorService)field(SyncClient.class,"prefetchWorkers").get(client)).shutdownNow();
        ((ExecutorService)field(SyncClient.class,"focusWorkers").get(client)).shutdownNow();
        field(SyncClient.class,"http").set(client,old.newBuilder().dispatcher(new Dispatcher()).connectionPool(new ConnectionPool()).build());
    }
    @Test public void reopenedClientRestoresExactOlderTargetFromDurableEmptyReadMetadata()throws Exception {
        runPreparation();assertEquals(0,store.criticalPreparations("ai"));assertNotNull(store.emptyCompletionRead("ai",THREAD,TURN));
        reopenClientAndStore();refresh();assertEquals("restart reuses valid DTO identities",1,bodyReads);assertEquals(0,store.criticalPreparations("ai"));
        olderPage=true;hasFinal=true;targetPage=3;
        event(new JSONObject().put("type","nativeChanged").put("threadId",THREAD).put("cacheKey","item:"+THREAD+":"+TURN+":final"));
        assertEquals(1,store.criticalPreparations("ai"));assertNull(store.emptyCompletionRead("ai",THREAD,TURN));
        reopenClientAndStore();assertEquals("recovery itself survives another process death",1,store.criticalPreparations("ai"));
        int before=turnPages;runPreparation();assertEquals(3,turnPages-before);assertEquals(0,store.criticalPreparations("ai"));assertEquals(1,notifications);assertTrue(notifiedReady);
    }
    @Test public void generationResetCannotReusePersistedOrInMemoryEmptyProof()throws Exception {
        runPreparation();assertNotNull(store.emptyCompletionRead("ai",THREAD,TURN));
        sourceGeneration="g2";generation="new-thread-generation";store.resetGeneration("ai","g2");store.saveCatalogCursor("ai","g2",0);
        assertNull(store.emptyCompletionRead("ai",THREAD,TURN));bodyFailure=true;runPreparation();assertEquals(1,store.criticalPreparations("ai"));assertEquals(2,bodyReads);assertEquals(0,notifications);
    }
    @Test public void wrongScopeEmptyItemsCannotSettleOrEnterEitherScopeStore()throws Exception {
        beforeResponse=response->{if("thread/items/list".equals(response.getJSONObject("payload").getString("method")))response.put("scope","zyy");};
        runPreparation();assertEquals(1,store.criticalPreparations("ai"));assertEquals(0,notifications);assertNull(store.emptyCompletionRead("ai",THREAD,TURN));
        assertEquals(0,store.readRecords("zyy",0,50).getJSONArray("records").length());
    }
    @Test public void consumedStreamItemAndRecoveryTaskSurviveCrashBeforeProcessEvent()throws Exception {
        runPreparation();assertEquals(0,store.criticalPreparations("ai"));
        JSONObject item=new JSONObject().put("type","item").put("threadId",THREAD).put("turnId",TURN).put("item",finalItems().getJSONObject(0));
        store.receiveEvent("ai","fixture-epoch",1,new JSONObject().put("event",item));
        store.commitStreamEvent("ai",store.nextEvent("ai"),item);
        assertNull(store.nextEvent("ai"));assertNull(store.emptyCompletionRead("ai",THREAD,TURN));
        reopenClientAndStore();assertEquals(1,store.criticalPreparations("ai"));
        olderPage=true;hasFinal=true;runPreparation();assertEquals(0,store.criticalPreparations("ai"));assertEquals(1,notifications);assertTrue(notifiedReady);
    }
    @Test public void streamCommitDuringEmptyReadCannotBeLostBeforeJavaEventCallback()throws Exception {
        beforeResponse=response->{if("thread/items/list".equals(response.getJSONObject("payload").getString("method"))) {
            JSONObject item=new JSONObject().put("type","item").put("threadId",THREAD).put("turnId",TURN).put("item",finalItems().getJSONObject(0));
            store.receiveEvent("ai","fixture-epoch",1,new JSONObject().put("event",item));store.commitStreamEvent("ai",store.nextEvent("ai"),item);
        }};
        runPreparation();assertNull(store.nextEvent("ai"));assertNull(store.emptyCompletionRead("ai",THREAD,TURN));assertEquals(1,store.criticalPreparations("ai"));assertEquals(0,notifications);
        reopenClientAndStore();beforeResponse=response->{};hasFinal=true;runPreparation();assertEquals(0,store.criticalPreparations("ai"));assertEquals(1,notifications);assertTrue(notifiedReady);
    }
    @Test public void rawInterruptedCommitBeforeJavaCallbackPreventsOldPositiveReadNotification()throws Exception {
        bodyHasFinal=true;
        beforeResponse=response->{if("thread/items/list".equals(response.getJSONObject("payload").getString("method"))) {
            JSONObject event=new JSONObject().put("type","turn").put("threadId",THREAD).put("turn",new JSONObject().put("id",TURN).put("status","interrupted"));
            store.receiveEvent("ai","fixture-epoch",1,new JSONObject().put("event",event));store.commitStreamEvent("ai",store.nextEvent("ai"),event);
        }};
        runPreparation();assertEquals(1,store.criticalPreparations("ai"));assertEquals(0,notifications);assertEquals(1,bodyReads);
    }
    @Test public void fullArchiveWaitsForAllItemPagesAndResumesItsExactCursor()throws Exception {
        hasFinal=true;bodyTwoPages=true;
        Method archive=SyncClient.class.getDeclaredMethod("archiveHistoryBatch",String.class,String.class,String.class);archive.setAccessible(true);
        assertFalse((Boolean)archive.invoke(client,THREAD,"archive-fixture","catalog-v1"));
        JSONObject partial=store.archiveProgress("ai",THREAD);assertFalse(partial.optBoolean("complete"));assertEquals("body-page",partial.getString("itemCursor"));assertEquals(1,bodyReads);
        store.close();store=new SyncStore(RuntimeEnvironment.getApplication());field(SyncClient.class,"store").set(client,store);
        assertTrue((Boolean)archive.invoke(client,THREAD,"archive-fixture-2","catalog-v1"));
        assertTrue(store.archiveProgress("ai",THREAD).getBoolean("complete"));assertEquals(2,bodyReads);assertEquals(1,turnPages);assertEquals(0,notifications);
    }
    @Test public void archiveBodyFailureLeavesPartialReceiptAndCannotClaimComplete()throws Exception {
        hasFinal=true;bodyFailure=true;
        Method archive=SyncClient.class.getDeclaredMethod("archiveHistoryBatch",String.class,String.class,String.class);archive.setAccessible(true);
        try{archive.invoke(client,THREAD,"archive-fixture","catalog-v1");fail("failed body accepted");}catch(InvocationTargetException expected){assertTrue(expected.getCause() instanceof java.io.IOException);}
        assertFalse(store.archiveProgress("ai",THREAD).optBoolean("complete"));assertEquals(0,notifications);
        bodyFailure=false;assertTrue((Boolean)archive.invoke(client,THREAD,"archive-fixture-2","catalog-v1"));
        assertTrue(store.archiveProgress("ai",THREAD).getBoolean("complete"));
    }
    @After public void close()throws Exception {
        if(client!=null)client.close();if(store!=null)store.close();
        NativeDiagnostics log=(NativeDiagnostics)field(NativeDiagnostics.class,"instance").get(null);
        if(log!=null){((ExecutorService)field(NativeDiagnostics.class,"writer").get(log)).shutdownNow();((ExecutorService)field(NativeDiagnostics.class,"network").get(log)).shutdownNow();((android.database.sqlite.SQLiteOpenHelper)field(NativeDiagnostics.class,"db").get(log)).close();field(NativeDiagnostics.class,"instance").set(null,null);}
        Thread.setDefaultUncaughtExceptionHandler(handler);
    }
}
