package top.whytan.dsh;

import static org.junit.Assert.*;
import android.app.Service;
import android.app.Notification;
import android.app.ForegroundServiceStartNotAllowedException;
import android.content.Context;
import android.content.Intent;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implements;
import org.robolectric.annotation.Implementation;
import org.robolectric.shadows.ShadowService;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=34, shadows=ForegroundStartRestrictionTest.DeniedPromotion.class)
public class ForegroundStartRestrictionTest {
    @Implements(Service.class)
    public static class DeniedPromotion extends ShadowService {
        @Implementation protected void startForeground(int id, Notification notification, int type) {
            throw new ForegroundServiceStartNotAllowedException("fixture denial");
        }
    }
    @Test public void deniedStickyPromotionKeepsUserIntentWithoutCrashingOrStartingClient() throws Exception {
        SyncForegroundService service=Robolectric.buildService(SyncForegroundService.class).create().get();
        service.getSharedPreferences("sync-control",Context.MODE_PRIVATE).edit()
                .putString("last-scope","ai").putBoolean("enabled:ai",true).commit();
        assertEquals(Service.START_NOT_STICKY,service.onStartCommand(null,0,1));
        assertTrue(service.getSharedPreferences("sync-control",Context.MODE_PRIVATE).getBoolean("enabled:ai",false));
        assertFalse(SyncForegroundService.statusSnapshot(service,"ai").optBoolean("running"));
        assertEquals("BACKGROUND_START_RESTRICTED",SyncForegroundService.statusSnapshot(service,"ai").optString("error"));
        service.onDestroy();
    }
}
