package top.whytan.dsh;

import static org.junit.Assert.*;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import java.lang.reflect.Method;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.RobolectricTestRunner;

@RunWith(RobolectricTestRunner.class) @Config(sdk=28,manifest=Config.NONE)
public class ForegroundSyncNotificationTest {
    private String shown(String mode, int pending, int running, boolean fresh) throws Exception {
        SyncForegroundService service=Robolectric.buildService(SyncForegroundService.class).get();
        JSONObject state=new JSONObject().put("scope","ai").put("online",true)
                .put("transportConnected",true).put("hostOnline",true)
                .put("catalogComplete",fresh).put("lastSuccessfulSyncAt",System.currentTimeMillis())
                .put("runningSessionCount",running).put("syncMode",mode).put("criticalPending",pending);
        Method update=SyncForegroundService.class.getDeclaredMethod("updateForeground",JSONObject.class);
        update.setAccessible(true);update.invoke(service,state);
        NotificationManager manager=(NotificationManager)service.getSystemService(Context.NOTIFICATION_SERVICE);
        java.util.List<Notification> notifications=Shadows.shadowOf(manager).getAllNotifications();
        assertEquals(1,notifications.size());
        return notifications.get(0).extras.getString(Notification.EXTRA_TEXT);
    }
    @Test public void foregroundAndQuietSettlingWithoutBacklogNeverClaimBackfill() throws Exception {
        for(String mode:new String[]{"foreground","active","checking"}) {
            assertFalse(mode,shown(mode,0,0,true).contains("补齐"));
        }
    }
    @Test public void actualCriticalBacklogIsShownEvenInForeground() throws Exception {
        assertTrue(shown("foreground",2,0,true).contains("补齐"));
        assertTrue(shown("settling",1,0,true).contains("补齐"));
    }
    @Test public void completedBackfillLeavesTheNotification() throws Exception {
        assertTrue(shown("settling",1,0,true).contains("补齐"));
        assertFalse(shown("active",0,0,true).contains("补齐"));
        assertTrue(shown("idle",0,0,true).contains("省电接收"));
    }
    @Test public void runningAndUnconfirmedStatesStayDistinct() throws Exception {
        assertTrue(shown("active",2,1,true).contains("电脑端正在处理"));
        assertTrue(shown("checking",2,0,false).contains("核对会话状态"));
    }
    @Test public void changedCountRefreshesTitleEvenWhenBodyTextIsUnchanged() throws Exception {
        SyncForegroundService service=Robolectric.buildService(SyncForegroundService.class).get();
        Method update=SyncForegroundService.class.getDeclaredMethod("updateForeground",JSONObject.class);update.setAccessible(true);
        JSONObject state=new JSONObject().put("scope","ai").put("online",true).put("transportConnected",true).put("hostOnline",true)
                .put("catalogComplete",true).put("lastSuccessfulSyncAt",System.currentTimeMillis()).put("syncMode","active");
        NotificationManager manager=(NotificationManager)service.getSystemService(Context.NOTIFICATION_SERVICE);
        state.put("runningSessionCount",2);update.invoke(service,state);state.put("runningSessionCount",1);update.invoke(service,state);
        assertEquals("1 个会话运行中",Shadows.shadowOf(manager).getAllNotifications().get(0).extras.getString(Notification.EXTRA_TITLE));
        state.put("runningSessionCount",0).put("syncMode","idle");update.invoke(service,state);
        assertTrue(Shadows.shadowOf(manager).getAllNotifications().get(0).extras.getString(Notification.EXTRA_TEXT).contains("省电接收"));
    }
}
