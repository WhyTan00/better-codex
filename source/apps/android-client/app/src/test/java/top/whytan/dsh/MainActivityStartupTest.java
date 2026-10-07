package top.whytan.dsh;

import static org.junit.Assert.*;
import java.lang.reflect.Field;
import java.util.concurrent.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.Shadows;
import android.os.Looper;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class MainActivityStartupTest {
    @Test public void ordinaryResumeAndStaleUpdateIntentCannotReplaceTheDocument() throws Exception {
        MainActivity activity=Robolectric.buildActivity(MainActivity.class).get();
        android.webkit.WebView surface=new android.webkit.WebView(org.robolectric.RuntimeEnvironment.getApplication());
        Field web=MainActivity.class.getDeclaredField("webView");web.setAccessible(true);web.set(activity,surface);
        Field resumed=MainActivity.class.getDeclaredField("activityResumed");resumed.setAccessible(true);resumed.setBoolean(activity,true);
        java.lang.reflect.Method apply=MainActivity.class.getDeclaredMethod("tryApplyDownloadedUi");apply.setAccessible(true);
        // No store is installed: an unsolicited application must return before
        // consulting a newer release, JS, or loadUrl (the old path dereferenced it).
        apply.invoke(activity);
        Field intent=MainActivity.class.getDeclaredField("uiApplyPageId");intent.setAccessible(true);intent.set(activity,"previous-document");
        apply.invoke(activity);assertNull(surface.getUrl());surface.destroy();
    }
    @Test public void blockedFileVerificationDoesNotBlockActivityAndDestroyedOwnerCannotLoad() throws Exception {
        Field lockField = UiReleaseStore.class.getDeclaredField("lock");
        lockField.setAccessible(true);
        Object lock = lockField.get(null);
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        ExecutorService holder = Executors.newSingleThreadExecutor();
        Future<?> held = holder.submit(() -> { synchronized(lock) {
            entered.countDown();
            try { release.await(10, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }});
        assertTrue(entered.await(3, TimeUnit.SECONDS));
        try {
            ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class).create();
            MainActivity activity = controller.get();
            Field web = MainActivity.class.getDeclaredField("webView");web.setAccessible(true);
            assertNull("unverified release cannot reach the WebView", web.get(activity));
            Field pending = MainActivity.class.getDeclaredField("startingWebView");pending.setAccessible(true);
            assertNull("Chromium initialization follows the first native frame", pending.get(activity));
            Field cover = MainActivity.class.getDeclaredField("startupCover");cover.setAccessible(true);
            assertNotNull("cache verification and Chromium cannot leave a blank first frame", cover.get(activity));
            Field root = MainActivity.class.getDeclaredField("nativeRoot");root.setAccessible(true);
            ((android.view.View) root.get(activity)).getViewTreeObserver().dispatchOnDraw();
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            android.webkit.WebView surface = (android.webkit.WebView)pending.get(activity);
            assertNotNull("local surface prewarms while verification is blocked", surface);
            assertNull("prewarming cannot load an unverified document", surface.getUrl());
            final boolean[] tick = {false};new android.os.Handler(Looper.getMainLooper()).post(() -> tick[0] = true);
            Shadows.shadowOf(Looper.getMainLooper()).idle();assertTrue(tick[0]);
            controller.destroy();release.countDown();held.get(3, TimeUnit.SECONDS);
            assertNull("destroy closes the prewarmed surface", pending.get(activity));
            assertNull("destroy removes the startup cover", cover.get(activity));
            Field executor = MainActivity.class.getDeclaredField("background");executor.setAccessible(true);
            assertTrue(((ExecutorService)executor.get(activity)).awaitTermination(5, TimeUnit.SECONDS));
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            assertNull("closed Activity must not receive the delayed page", web.get(activity));
        } finally {release.countDown();holder.shutdownNow();}
    }    @Test public void missingOptionalProxyCallbackCanRecoverAndLateCallbacksDoNotReplay() throws Exception {
        DshNetwork network=DshNetwork.get(org.robolectric.RuntimeEnvironment.getApplication());
        Field applying=DshNetwork.class.getDeclaredField("applying");applying.setAccessible(true);applying.setBoolean(network,true);
        Field applied=DshNetwork.class.getDeclaredField("applied");applied.setAccessible(true);applied.setBoolean(network,false);
        int[] ready={0};java.util.concurrent.atomic.AtomicBoolean loaded=new java.util.concurrent.atomic.AtomicBoolean();
        Runnable page=()->{if(loaded.compareAndSet(false,true))ready[0]++;};
        network.prepareWebView(Runnable::run,page);assertEquals(0,ready[0]);
        network.retryWebViewPreparation(Runnable::run,page);
        java.lang.reflect.Method finish=DshNetwork.class.getDeclaredMethod("finish",boolean.class);finish.setAccessible(true);finish.invoke(network,true);finish.invoke(network,true);
        assertEquals(1,ready[0]);
    }

}
