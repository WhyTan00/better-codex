package top.whytan.dsh;

import static org.junit.Assert.*;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.LinkProperties;
import android.net.NetworkCapabilities;
import org.json.JSONObject;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import org.robolectric.shadows.*;
import okhttp3.*;
import java.lang.reflect.Field;
import java.util.concurrent.ExecutorService;

/** Real registered callback and SyncClient cancellation path, with isolated OS/network state. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=28,manifest=Config.NONE,shadows=BackgroundConnectionTest.TestConnectivityManager.class)
@LooperMode(LooperMode.Mode.PAUSED)
public class BackgroundConnectionTest {
    @Implements(ConnectivityManager.class)
    public static class TestConnectivityManager extends ShadowConnectivityManager {
        static Network active;
        static boolean metered;
        @Implementation protected Network getActiveNetwork(){return active;}
        @Implementation protected boolean isActiveNetworkMetered(){return metered;}
    }
    BackgroundConnection connection;
    ConnectivityManager connectivity;
    ConnectivityManager.NetworkCallback callback;
    SyncStore store;
    SyncClient client;
    WebSocket socket;
    Thread.UncaughtExceptionHandler handler;
    int recoveries,conditions,cancellations;
    static Field field(Class<?> type,String name)throws Exception {Field value=type.getDeclaredField(name);value.setAccessible(true);return value;}
    NetworkCapabilities capabilities(boolean valid,boolean wifi,boolean cellular,boolean vpn) {
        NetworkCapabilities caps=ShadowNetworkCapabilities.newInstance();
        ShadowNetworkCapabilities shadow=Shadows.shadowOf(caps);
        shadow.addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        if(!TestConnectivityManager.metered)shadow.addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED);
        if(valid)shadow.addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
        else shadow.removeCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
        if(wifi)shadow.addTransportType(NetworkCapabilities.TRANSPORT_WIFI);
        if(cellular)shadow.addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR);
        if(vpn)shadow.addTransportType(NetworkCapabilities.TRANSPORT_VPN);
        return caps;
    }
    void active(Network network,NetworkCapabilities caps) {
        TestConnectivityManager.active=network;
        if(network!=null)Shadows.shadowOf(connectivity).setNetworkCapabilities(network,caps);
    }
    void changed(){callback.onCapabilitiesChanged(TestConnectivityManager.active,connectivity.getNetworkCapabilities(TestConnectivityManager.active));}
    JSONObject latestNetworkDiagnostic()throws Exception {
        NativeDiagnostics diagnostics=NativeDiagnostics.get(RuntimeEnvironment.getApplication());
        ((ExecutorService)field(NativeDiagnostics.class,"writer").get(diagnostics)).submit(()->{}).get(2,java.util.concurrent.TimeUnit.SECONDS);
        android.database.sqlite.SQLiteOpenHelper db=(android.database.sqlite.SQLiteOpenHelper)field(NativeDiagnostics.class,"db").get(diagnostics);
        try(android.database.Cursor rows=db.getReadableDatabase().rawQuery("SELECT payload FROM outbox ORDER BY rowid DESC",null)) {
            while(rows.moveToNext()) {JSONObject value=new JSONObject(rows.getString(0));if("android-network".equals(value.optString("component")))return value;}
        }
        throw new AssertionError("network diagnostic was not persisted");
    }
    @Before public void setup()throws Exception {
        handler=Thread.getDefaultUncaughtExceptionHandler();Context context=RuntimeEnvironment.getApplication();
        // Load Robolectric's native SQLite on its sandbox main thread before
        // NativeDiagnostics starts its asynchronous writer.
        try(android.database.sqlite.SQLiteDatabase database=android.database.sqlite.SQLiteDatabase.create(null)) {assertTrue(database.isOpen());}
        context.getSharedPreferences("sync-control",Context.MODE_PRIVATE).edit().putString("notification-owner","ai").commit();
        connectivity=context.getSystemService(ConnectivityManager.class);
        TestConnectivityManager.metered=false;active(ShadowNetwork.newInstance(101),capabilities(true,true,false,false));
        // No callback test is allowed to make an external request.
        OkHttpClient offline=new OkHttpClient.Builder().addInterceptor(chain->{throw new java.io.IOException("isolated callback test");}).build();
        NativeDiagnostics diagnostics=NativeDiagnostics.get(context);field(NativeDiagnostics.class,"http").set(diagnostics,offline);
        context.deleteDatabase("native-sync-v1.sqlite");store=new SyncStore(context);
        client=new SyncClient(context,"ai",store,new SyncClient.Listener(){public void onState(String scope,JSONObject state){}public void onCompletion(String scope,String thread,String turn,boolean ready){}});
        field(SyncClient.class,"http").set(client,offline);
        ((ExecutorService)field(SyncClient.class,"worker").get(client)).shutdownNow();
        socket=new WebSocket(){
            public Request request(){return new Request.Builder().url("https://example.invalid").build();}
            public long queueSize(){return 0;}public boolean send(String text){return true;}public boolean send(okio.ByteString data){return true;}
            public boolean close(int code,String reason){return true;}public void cancel(){cancellations++;}
        };
        field(SyncClient.class,"socket").set(client,socket);field(SyncClient.class,"socketConnected").setBoolean(client,true);
        field(SyncClient.class,"connectedAt").setLong(client,System.currentTimeMillis());
        connection=new BackgroundConnection(context,new BackgroundConnection.Listener(){
            public void onRecovery(String reason){recoveries++;assertEquals("network_changed",reason);client.recoverConnection(reason,true);}
            public void onConditionsChanged(){conditions++;}
        });
        connection.start(false);assertEquals(0,recoveries);
        assertEquals(1,Shadows.shadowOf(connectivity).getNetworkCallbacks().size());
        callback=Shadows.shadowOf(connectivity).getNetworkCallbacks().iterator().next();
        conditions=0;
    }
    @Test public void meteredOnlyChangesUpdatePolicyWithoutCancellingHealthySocket()throws Exception {
        for(boolean metered:new boolean[]{true,false}) {
            TestConnectivityManager.metered=metered;active(TestConnectivityManager.active,capabilities(true,true,false,false));changed();
            assertEquals(metered,connection.snapshot().getBoolean("metered"));
            assertEquals(0,recoveries);assertEquals(0,cancellations);
            assertSame(socket,field(SyncClient.class,"socket").get(client));
            assertTrue(connection.snapshot().getBoolean("networkAvailable"));
            JSONObject event=latestNetworkDiagnostic();
            assertEquals("capabilities_changed",event.getString("reason"));
            assertEquals(metered,event.getBoolean("metered"));
        }
        assertEquals("both billing changes still reach the conditions consumer",2,conditions);
    }
    @Test public void repeatedEquivalentSnapshotsDoNotRecoverOrRepublish() {
        Network same=ShadowNetwork.newInstance(101);
        active(same,capabilities(true,true,false,false));
        callback.onAvailable(same);changed();changed();
        assertEquals(0,recoveries);assertEquals(0,cancellations);assertEquals(0,conditions);
    }
    @Test public void defaultNetworkSwapRecoversOnceAndLateOldCallbackCannotReplaceIt()throws Exception {
        Network old=TestConnectivityManager.active,next=ShadowNetwork.newInstance(202);
        active(next,capabilities(true,true,false,false));callback.onAvailable(next);changed();
        assertEquals(1,recoveries);assertEquals(1,cancellations);
        callback.onLost(old);callback.onCapabilitiesChanged(old,capabilities(false,false,true,false));changed();
        assertEquals(1,recoveries);assertEquals(1,conditions);
        assertEquals(next,field(BackgroundConnection.class,"activeNetwork").get(connection));
        assertTrue(connection.snapshot().getBoolean("wifi"));assertFalse(connection.snapshot().getBoolean("cellular"));
    }
    @Test public void validationLossAndReturnRecoverOnceWhenUsableAgain()throws Exception {
        Network same=TestConnectivityManager.active;
        active(same,capabilities(false,true,false,false));changed();changed();
        assertEquals(0,recoveries);assertFalse(connection.snapshot().getBoolean("networkAvailable"));
        active(same,capabilities(true,true,false,false));changed();changed();
        assertEquals(1,recoveries);assertEquals(1,cancellations);assertEquals(2,conditions);
        assertTrue(connection.snapshot().getBoolean("networkAvailable"));
    }
    @Test public void actualOfflineThenAvailableRecoversOnce()throws Exception {
        Network old=TestConnectivityManager.active;
        active(null,null);callback.onLost(old);callback.onLost(old);
        assertEquals(0,recoveries);assertFalse(connection.snapshot().getBoolean("networkAvailable"));
        Network next=ShadowNetwork.newInstance(202);active(next,capabilities(true,false,true,false));
        callback.onAvailable(next);changed();callback.onLost(old);
        assertEquals(1,recoveries);assertEquals(1,cancellations);assertEquals(2,conditions);
        assertTrue(connection.snapshot().getBoolean("cellular"));
    }
    @Test public void sameVpnNetworkWithChangedUnderlyingTransportStillRecoversOnce() {
        Network vpn=ShadowNetwork.newInstance(303);active(vpn,capabilities(true,true,false,true));callback.onAvailable(vpn);changed();
        assertEquals(1,recoveries);int priorConditions=conditions;
        active(vpn,capabilities(true,false,true,true));changed();changed();
        assertEquals(2,recoveries);assertEquals(priorConditions+1,conditions);
        TestConnectivityManager.metered=true;changed();
        assertEquals("billing change after actual route change adds no recovery",2,recoveries);
    }
    @Test public void sameVpnLinkReplacementRecoversAndExportsOnlyOpaquePathIdentity()throws Exception {
        Network vpn=ShadowNetwork.newInstance(303);active(vpn,capabilities(true,true,false,true));callback.onAvailable(vpn);changed();
        LinkProperties first=new LinkProperties();first.setInterfaceName("tun0");callback.onLinkPropertiesChanged(vpn,first);
        JSONObject before=connection.snapshot();int count=recoveries;
        LinkProperties next=new LinkProperties();next.setInterfaceName("tun1");callback.onLinkPropertiesChanged(vpn,next);callback.onLinkPropertiesChanged(vpn,next);
        JSONObject after=connection.snapshot();assertEquals(count+1,recoveries);
        assertEquals(before.getLong("networkGeneration")+1,after.getLong("networkGeneration"));
        assertEquals(before.getString("networkMonitorId"),after.getString("networkMonitorId"));
        assertFalse(after.toString().contains("tun1"));
        String output=System.getProperty("dsh.network.contract");
        if(output!=null)java.nio.file.Files.write(java.nio.file.Paths.get(output),new org.json.JSONArray().put(before).put(after).toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }
    @Test public void callbackPayloadWinsWhenSynchronousSnapshotIsStale()throws Exception {
        Network next=ShadowNetwork.newInstance(404);callback.onAvailable(next);
        callback.onCapabilitiesChanged(next,capabilities(true,false,true,true));
        assertEquals(next,field(BackgroundConnection.class,"activeNetwork").get(connection));
        assertTrue(connection.snapshot().getBoolean("cellular"));assertTrue(connection.snapshot().getBoolean("vpn"));
    }
    @After public void close()throws Exception {
        if(connection!=null)connection.close();if(client!=null)client.close();if(store!=null)store.close();
        NativeDiagnostics log=(NativeDiagnostics)field(NativeDiagnostics.class,"instance").get(null);
        if(log!=null) {
            ExecutorService writer=(ExecutorService)field(NativeDiagnostics.class,"writer").get(log),network=(ExecutorService)field(NativeDiagnostics.class,"network").get(log);
            writer.shutdownNow();network.shutdownNow();writer.awaitTermination(2,java.util.concurrent.TimeUnit.SECONDS);network.awaitTermination(2,java.util.concurrent.TimeUnit.SECONDS);
            ((android.database.sqlite.SQLiteOpenHelper)field(NativeDiagnostics.class,"db").get(log)).close();field(NativeDiagnostics.class,"instance").set(null,null);
        }
        Thread.setDefaultUncaughtExceptionHandler(handler);
    }
}
