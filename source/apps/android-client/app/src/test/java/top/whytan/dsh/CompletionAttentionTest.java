package top.whytan.dsh;
import static org.junit.Assert.*;
import android.app.NotificationManager;
import android.content.Context;
import java.lang.reflect.Field;
import java.util.UUID;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.RobolectricTestRunner;
@RunWith(RobolectricTestRunner.class) @Config(sdk=28,manifest=Config.NONE)
public class CompletionAttentionTest {
 private static void set(Object o,String name,Object v)throws Exception{Field f=o.getClass().getDeclaredField(name);f.setAccessible(true);f.set(o,v);}
 @Test public void completionServiceSuppressesWholeForegroundAppAndExactSeenTurn()throws Exception{
  SyncForegroundService service=Robolectric.buildService(SyncForegroundService.class).get();
  service.getSharedPreferences("sync-control",0).edit().putString("notification-owner","ai").putBoolean("completion-enabled",true).commit();
  SyncStore store=new SyncStore(service);String thread=UUID.randomUUID().toString(),turn=UUID.randomUUID().toString(),other=UUID.randomUUID().toString();
  JSONObject record=new JSONObject().put("scope","ai").put("key","thread:"+thread).put("kind","catalog").put("threadId",thread).put("generation","g1").put("sourceGeneration","g1").put("revision",2).put("deleted",false).put("payload",new JSONObject().put("nativeThread",new JSONObject().put("id",thread).put("name","fixture")));store.applyNativeRecord(record,null);
  SyncClient client=new SyncClient(service,"ai",store,new SyncClient.Listener(){public void onState(String s,JSONObject v){}public void onCompletion(String s,String t,String u,boolean r){}});
  set(service,"store",store);set(service,"client",client);set(service,"enabled",true);
  NotificationManager manager=(NotificationManager)service.getSystemService(Context.NOTIFICATION_SERVICE);Object owner=new Object();
  try{
   SyncForegroundService.setAppVisible(true);SyncForegroundService.setPresentationActive(true);SyncForegroundService.presentConversation(owner,"ai",thread,true);service.onCompletion("ai",thread,turn,false);assertEquals(0,Shadows.shadowOf(manager).getAllNotifications().size());
   SyncForegroundService.presentConversation(owner,"ai",other,true);service.onCompletion("ai",thread,turn,false);assertEquals(0,Shadows.shadowOf(manager).getAllNotifications().size());
   SyncForegroundService.presentConversation(owner,"ai","",false);SyncForegroundService.setPresentationActive(false);service.onCompletion("ai",thread,turn,false);assertEquals(0,Shadows.shadowOf(manager).getAllNotifications().size());
   SyncForegroundService.setAppVisible(false);service.onCompletion("ai",thread,turn,false);assertEquals(1,Shadows.shadowOf(manager).getAllNotifications().size());
   SyncForegroundService.setAppVisible(true);SyncForegroundService.setPresentationActive(true);
   SyncForegroundService.presentConversation(owner,"ai",thread,true);SyncForegroundService.markCompletionSeen(service,"ai",thread,turn);assertEquals(0,Shadows.shadowOf(manager).getAllNotifications().size());
   SyncForegroundService.setAppVisible(false);SyncForegroundService.setPresentationActive(false);service.onCompletion("ai",thread,turn,false);assertEquals(0,Shadows.shadowOf(manager).getAllNotifications().size());
   service.onCompletion("ai",thread,UUID.randomUUID().toString(),false);assertEquals(1,Shadows.shadowOf(manager).getAllNotifications().size());
  }finally{SyncForegroundService.clearPresentation(owner);SyncForegroundService.setAppVisible(false);SyncForegroundService.setPresentationActive(false);client.close();store.close();}
 }
 @Test public void oldBridgeCannotClearNewPresentationAndWorkspaceNeverLeaks(){CompletionAttention p=new CompletionAttention();Object old=new Object(),next=new Object();p.present(old,"ai","a",true);p.present(next,"ai","b",true);p.clear(old);assertTrue(p.suppress(true,"ai","b","t"));assertTrue(p.suppress(true,"zyy","b","t"));assertFalse(p.suppress(false,"ai","b","t"));p.present(next,"ai","",false);assertTrue(p.suppress(true,"ai","b","t"));}
 @Test public void backgroundPaintCannotAcknowledgeAnUnseenCompletion(){CompletionAttention p=new CompletionAttention();p.present(this,"ai","a",true);p.seen(false,"ai","a","t");p.clear(this);assertFalse(p.suppress(false,"ai","a","t"));}
}
