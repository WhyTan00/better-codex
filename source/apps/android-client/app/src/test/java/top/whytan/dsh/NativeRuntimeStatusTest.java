package top.whytan.dsh;

import static org.junit.Assert.*;
import android.content.Context;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;

/** The actual Native SyncFeed frames pass through the ordered Android inbox. */
@RunWith(RobolectricTestRunner.class) @Config(sdk=28,manifest=Config.NONE)
public class NativeRuntimeStatusTest {
    static final String ID="11111111-1111-4111-8111-111111111111";
    SyncStore store; SyncClient client; JSONArray frames;
    static Field field(String name)throws Exception {Field f=SyncClient.class.getDeclaredField(name);f.setAccessible(true);return f;}
    JSONObject catalog(String status,long revision)throws Exception {
        return new JSONObject().put("scope","ai").put("threadId",ID).put("key","thread:"+ID).put("kind","catalog")
                .put("sourceGeneration","g1").put("generation","g1").put("revision",revision).put("deleted",false)
                .put("payload",new JSONObject().put("nativeThread",new JSONObject().put("id",ID).put("status",new JSONObject().put("type",status))));
    }
    @Before public void setup()throws Exception {
        Context context=RuntimeEnvironment.getApplication();context.deleteDatabase("native-sync-v1.sqlite");store=new SyncStore(context);store.applyNativeRecord(catalog("active",1));
        frames=new JSONArray(new String(getClass().getResourceAsStream("/native-thread-status-frames.json").readAllBytes(),StandardCharsets.UTF_8));
        client=new SyncClient(context,"ai",store,new SyncClient.Listener(){public void onState(String s,JSONObject state){}public void onCompletion(String s,String thread,String turn,boolean ready){fail("status reconciliation must never send a completion notification");}});
        field("started").setBoolean(client,true);field("catalogComplete").setBoolean(client,true);field("nativeOnline").setBoolean(client,true);
        field("catalogCompletedAt").setLong(client,android.os.SystemClock.elapsedRealtime());field("runningCount").setInt(client,1);
    }
    @After public void cleanup()throws Exception {client.close();store.close();RuntimeEnvironment.getApplication().deleteDatabase("native-sync-v1.sqlite");}
    void deliver(JSONObject frame)throws Exception {
        store.receiveEvent("ai",frame.getString("epoch"),frame.getLong("seq"),frame);
        Method drain=SyncClient.class.getDeclaredMethod("drainInbox");drain.setAccessible(true);drain.invoke(client);
        ((ExecutorService)field("streamWorker").get(client)).submit(()->{}).get(5,TimeUnit.SECONDS);
    }
    @Test public void actualTerminalEventImmediatelyClearsCatalogAndClientBusyState()throws Exception {
        for(int i=0;i<frames.length();i++){JSONObject frame=frames.getJSONObject(i);deliver(frame);
            if("idle".equals(frame.getJSONObject("event").getJSONObject("status").getString("type"))){assertEquals(0,store.runningSessions("ai").getInt("count"));assertEquals(0,field("runningCount").getInt(client));break;}}
    }
    @Test public void newerActiveEventSurvivesAnOlderCompletionAndRestart()throws Exception {
        for(int i=0;i<frames.length();i++)deliver(frames.getJSONObject(i));assertEquals(1,store.runningSessions("ai").getInt("count"));
        assertFalse(store.receiveEvent("ai",frames.getJSONObject(1).getString("epoch"),frames.getJSONObject(1).getLong("seq"),frames.getJSONObject(1)));
        store.close();store=new SyncStore(RuntimeEnvironment.getApplication());assertEquals(1,store.runningSessions("ai").getInt("count"));
    }
    @Test public void oldEpochStatusCannotOverrideTheNewCatalog()throws Exception {
        for(int i=0;i<4;i++)deliver(frames.getJSONObject(i));assertEquals(0,store.runningSessions("ai").getInt("count"));
        store.receiveEvent("ai","replacement",1,new JSONObject().put("event",new JSONObject().put("type","host").put("online",true)));
        assertEquals(1,store.runningSessions("ai").getInt("count"));
    }
    @Test public void freshCatalogRepairsMissedStatusButCannotEraseANewerEvent()throws Exception {
        deliver(frames.getJSONObject(0));deliver(frames.getJSONObject(1));long before=store.eventCursor("ai").seq;
        Method reconcile=SyncStore.class.getDeclaredMethod("reconcileCatalogRuntime",String.class,JSONObject.class,String.class,long.class);reconcile.setAccessible(true);
        reconcile.invoke(store,"ai",catalog("idle",2),"native-status-fixture",before);assertEquals(0,store.runningSessions("ai").getInt("count"));
        deliver(frames.getJSONObject(4));reconcile.invoke(store,"ai",catalog("idle",3),"native-status-fixture",before);assertEquals(1,store.runningSessions("ai").getInt("count"));
    }
}
