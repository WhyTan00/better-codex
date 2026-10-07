package top.whytan.dsh;

import static org.junit.Assert.*;
import android.content.Context;
import android.os.SystemClock;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import java.lang.reflect.*;
import java.util.concurrent.atomic.AtomicInteger;
import okhttp3.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=28,manifest=Config.NONE)
public class BackgroundSyncPolicyTest {
    SyncStore store; SyncClient client; AtomicInteger published = new AtomicInteger();
    Thread.UncaughtExceptionHandler handler;
    static Field field(String name) throws Exception { Field f=SyncClient.class.getDeclaredField(name);f.setAccessible(true);return f; }
    @Before public void setup() {
        handler=Thread.getDefaultUncaughtExceptionHandler();
        Context context=RuntimeEnvironment.getApplication();context.deleteDatabase("native-sync-v1.sqlite");store=new SyncStore(context);
        client=new SyncClient(context,"ai",store,new SyncClient.Listener(){
            public void onState(String scope,JSONObject state){published.incrementAndGet();}
            public void onCompletion(String scope,String thread,String turn,boolean ready){}
        });
    }
    @After public void close(){client.close();store.close();Thread.setDefaultUncaughtExceptionHandler(handler);}
    @Test public void onlyConfirmedQuietBackgroundCanIdle() {
        assertEquals("idle",BackgroundSyncPolicy.decide(false,true,true,10,0,0,60_000,60_000).mode);
        assertEquals("foreground",BackgroundSyncPolicy.decide(true,true,true,10,0,0,60_000,60_000).mode);
        assertEquals("active",BackgroundSyncPolicy.decide(false,true,true,10,1,0,60_000,60_000).mode);
        assertEquals("active",BackgroundSyncPolicy.decide(false,true,true,10,0,0,10,60_000).mode);
        assertEquals("settling",BackgroundSyncPolicy.decide(false,true,true,10,0,1,60_000,60_000).mode);
        assertEquals("checking",BackgroundSyncPolicy.decide(false,true,false,10,0,0,60_000,60_000).mode);
        assertEquals("checking",BackgroundSyncPolicy.decide(false,true,true,700_000,0,0,60_000,60_000).mode);
        assertFalse(BackgroundSyncPolicy.decide(false,false,true,10,1,0,60_000,60_000).keepAwake);
        assertFalse(BackgroundSyncPolicy.decide(false,true,true,10,0,1,200_000,200_000).keepAwake);
    }
    @Test public void foregroundIdleNeedsVerifiedQuietStateAndKeepsEventDelivery() throws Exception {
        BackgroundSyncPolicy.Decision quiet=BackgroundSyncPolicy.decide(true,true,true,10,0,0,60_000,0);
        assertEquals(120_000L,quiet.catalogIntervalMs);assertTrue(quiet.idle());assertFalse(quiet.keepAwake);
        for(BackgroundSyncPolicy.Decision busy:new BackgroundSyncPolicy.Decision[]{
            BackgroundSyncPolicy.decide(true,true,true,10,1,0,60_000,0),
            BackgroundSyncPolicy.decide(true,true,true,10,0,1,60_000,0),
            BackgroundSyncPolicy.decide(true,true,false,10,0,0,60_000,0),
            BackgroundSyncPolicy.decide(true,false,true,10,0,0,60_000,0),
            BackgroundSyncPolicy.decide(true,true,true,10,0,0,10,0)}){
            assertFalse(busy.idle());assertEquals(30_000L,busy.catalogIntervalMs);
        }
    }
    @Test public void periodicRefreshRetainsCommittedFreshnessUntilFailure() throws Exception {
        store.saveCatalogCursor("ai","g1",0);
        field("catalogComplete").setBoolean(client,true);
        java.util.concurrent.atomic.AtomicBoolean wasComplete = new java.util.concurrent.atomic.AtomicBoolean();
        OkHttpClient mock=new OkHttpClient.Builder().addInterceptor(chain->{
            try { wasComplete.set(field("catalogComplete").getBoolean(client)); }
            catch(Exception e) { throw new java.io.IOException(e); }
            throw new java.io.IOException("fixture offline");
        }).build();field("http").set(client,mock);
        Method sync=SyncClient.class.getDeclaredMethod("syncCatalogInternal",boolean.class);sync.setAccessible(true);
        try { sync.invoke(client,false);fail("failed refresh accepted"); }
        catch(InvocationTargetException expected){assertTrue(expected.getCause() instanceof java.io.IOException);}
        assertTrue("starting a refresh must preserve the previously committed catalog",wasComplete.get());
        assertFalse("failed refresh must revoke freshness",field("catalogComplete").getBoolean(client));
    }
    @Test public void incompleteCatalogCheckpointsButCannotClaimFullSyncOrIdle() throws Exception {
        AtomicInteger reads=new AtomicInteger();
        OkHttpClient mock=new OkHttpClient.Builder().addInterceptor(chain->{
            boolean catalog=chain.request().url().encodedPath().endsWith("/native-catalog");
            int page=catalog?reads.incrementAndGet():999;
            String body="{\"generation\":\"g1\",\"records\":[],\"cursor\":"+page+",\"hasMore\":"+(page<=128)+"}";
            return new Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("fixture")
                    .body(ResponseBody.create(body,MediaType.get("application/json"))).build();
        }).build();field("http").set(client,mock);
        Method sync=SyncClient.class.getDeclaredMethod("syncCatalogInternal",boolean.class);sync.setAccessible(true);
        field("catalogComplete").setBoolean(client,true); // a previous successful pass is not this pass
        try { sync.invoke(client,false);fail("partial catalog accepted"); }
        catch(InvocationTargetException expected){assertEquals("catalog pass incomplete",expected.getCause().getMessage());}
        assertEquals(128,store.catalogCursor("ai").cursor);
        assertFalse(store.isBootstrapComplete("ai"));assertFalse(field("catalogComplete").getBoolean(client));
        sync.invoke(client,false);assertTrue(store.isBootstrapComplete("ai"));assertTrue(field("catalogComplete").getBoolean(client));
    }
    @Test public void statusBurstCoalescesButConnectionFailurePublishesImmediately() throws Exception {
        Method state=SyncClient.class.getDeclaredMethod("emitState",String.class,String.class);state.setAccessible(true);
        for(int i=0;i<100;i++)state.invoke(client,"running",null);
        assertEquals(1,published.get());
        state.invoke(client,"error","DISCONNECTED");assertEquals(2,published.get());
        assertEquals("DISCONNECTED",store.getState("ai").optString("error"));
    }
    @Test public void optionalFilesDoNotHoldWakeButPendingFinalDoes() throws Exception {
        String thread="11111111-1111-4111-8111-111111111111",turn="22222222-2222-4222-8222-222222222222";
        store.requestPreparation("ai","artifacts",thread,turn,1,false,"v1");assertEquals(0,store.criticalPreparations("ai"));
        SyncStore.Preparation job=store.requestPreparation("ai","completion",thread,turn,1,false,"v1");assertEquals(1,store.criticalPreparations("ai"));
        assertEquals(0,store.criticalPreparations("zyy"));store.finishPreparation("ai",job);assertEquals(0,store.criticalPreparations("ai"));
    }
    @Test public void enhancedModeReleasesWakeWhenWorkEndsEvenWithScreenOff() throws Exception {
        Context context=RuntimeEnvironment.getApplication();
        android.os.PowerManager power=context.getSystemService(android.os.PowerManager.class);
        Shadows.shadowOf(power).setIsInteractive(false);
        BackgroundConnection connection=new BackgroundConnection(context,new BackgroundConnection.Listener(){
            public void onRecovery(String reason){} public void onConditionsChanged(){}
        });
        try {
            for(String name:new String[]{"started","enhanced","workPending","networkAvailable","networkValidated"}) {
                Field f=BackgroundConnection.class.getDeclaredField(name);f.setAccessible(true);f.setBoolean(connection,true);
            }
            Method update=BackgroundConnection.class.getDeclaredMethod("updateWakeLease");update.setAccessible(true);
            Field lock=BackgroundConnection.class.getDeclaredField("wakeLock");lock.setAccessible(true);
            update.invoke(connection);assertTrue(((android.os.PowerManager.WakeLock)lock.get(connection)).isHeld());
            Field work=BackgroundConnection.class.getDeclaredField("workPending");work.setAccessible(true);work.setBoolean(connection,false);
            update.invoke(connection);assertFalse(((android.os.PowerManager.WakeLock)lock.get(connection)).isHeld());
        } finally { connection.close(); }
    }
    @Test public void powerDiagnosticsRetainOnlyKnownModesAndNumericCadence() throws Exception {
        JSONObject fields=NativeDiagnostics.safeFields(new JSONObject().put("reason","sync_policy").put("syncMode","idle")
                .put("heartbeatMs",120000).put("catalogIntervalMs",300000).put("text","PRIVATE"));
        assertEquals("sync_policy",fields.getString("reason"));assertEquals("idle",fields.getString("syncMode"));
        assertEquals(120000,fields.getInt("heartbeatMs"));assertFalse(fields.has("text"));
        assertFalse(NativeDiagnostics.safeFields(new JSONObject().put("syncMode","PRIVATE")).has("syncMode"));
    }
    @Test public void negotiatedHeartbeatRepliesWithoutPublishingOrPersistence() throws Exception {
        AtomicInteger pings=new AtomicInteger();
        WebSocket socket=new WebSocket(){
            public Request request(){return new Request.Builder().url("https://example.invalid").build();}
            public long queueSize(){return 0;}
            public boolean send(String text){assertEquals("{\"type\":\"ping\"}",text);pings.incrementAndGet();return true;}
            public boolean send(okio.ByteString bytes){return false;}
            public boolean close(int code,String reason){return true;}
            public void cancel(){}
        };
        field("socket").set(client,socket);field("adaptiveHeartbeat").setBoolean(client,true);
        Method reply=SyncClient.class.getDeclaredMethod("replyHeartbeat",WebSocket.class,String.class);reply.setAccessible(true);
        assertTrue((Boolean)reply.invoke(client,socket,"{\"type\":\"heartbeat\"}"));
        assertEquals(1,pings.get());assertEquals(0,published.get());
        field("adaptiveHeartbeat").setBoolean(client,false);
        assertFalse((Boolean)reply.invoke(client,socket,"{\"type\":\"heartbeat\"}"));assertEquals(1,pings.get());
    }

    @Test public void httpAuthRecoveryDoesNotLoseHealthyNativeAuthority() throws Exception {
        authRecoveryKeepsAuthority(true);
    }
    @Test public void httpAuthRecoveryCannotInventNativeOnline() throws Exception {
        authRecoveryKeepsAuthority(false);
    }
    private void authRecoveryKeepsAuthority(boolean hostOnline) throws Exception {
        field("nativeOnline").setBoolean(client,hostOnline);
        field("socketConnected").setBoolean(client,true);
        android.webkit.CookieManager cookies=android.webkit.CookieManager.getInstance();
        cookies.setCookie(DshConfig.ORIGIN,"lab-session=old");
        java.util.concurrent.atomic.AtomicBoolean reject=new java.util.concurrent.atomic.AtomicBoolean(true);
        field("http").set(client,new OkHttpClient.Builder().addInterceptor(chain->new Response.Builder()
            .request(chain.request()).protocol(Protocol.HTTP_1_1).code(reject.get()?401:200).message("fixture")
            .body(ResponseBody.create("{\"generation\":\"g1\",\"records\":[],\"cursor\":0,\"hasMore\":false}",MediaType.get("application/json"))).build()).build());
        // No transport creation: the original healthy socket remains owned.
        field("socket").set(client,new WebSocket(){
            public Request request(){return new Request.Builder().url("https://example.invalid").build();}
            public long queueSize(){return 0;} public boolean send(String text){return true;}
            public boolean send(okio.ByteString bytes){return true;}public boolean close(int c,String r){return true;}public void cancel(){}
        });
        Method refresh=SyncClient.class.getDeclaredMethod("syncCatalogSafe",boolean.class);refresh.setAccessible(true);
        refresh.invoke(client,true);
        assertEquals("auth_required",store.getState("ai").optString("state"));
        assertFalse(store.getState("ai").optBoolean("online"));
        assertEquals("HTTP auth cannot rewrite Native hello/host authority",hostOnline,field("nativeOnline").getBoolean(client));
        Method pendingPublish=SyncClient.class.getDeclaredMethod("publishState",String.class,String.class);pendingPublish.setAccessible(true);
        pendingPublish.invoke(client,"running",null);
        assertEquals("late ordinary status cannot hide an outstanding authentication failure","auth_required",store.getState("ai").optString("state"));
        assertEquals("AUTH_REQUIRED",store.getState("ai").optString("error"));
        reject.set(false);cookies.setCookie(DshConfig.ORIGIN,"lab-session=new");
        Method pause=SyncClient.class.getDeclaredMethod("authenticationPaused");pause.setAccessible(true);
        assertFalse((Boolean)pause.invoke(client));refresh.invoke(client,true);
        Method publish=SyncClient.class.getDeclaredMethod("publishState",String.class,String.class);publish.setAccessible(true);publish.invoke(client,"running",null);
        assertEquals(hostOnline,store.getState("ai").optBoolean("online"));
        assertEquals(hostOnline,store.getState("ai").optBoolean("hostOnline"));
    }
}
