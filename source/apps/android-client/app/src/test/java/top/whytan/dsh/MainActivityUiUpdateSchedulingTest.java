package top.whytan.dsh;

import static org.junit.Assert.*;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.os.MessageQueue;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.List;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;

/** Real native lifecycle and page callbacks, with only the network executor held. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
@LooperMode(LooperMode.Mode.PAUSED)
public final class MainActivityUiUpdateSchedulingTest {
    private static Field field(String name) throws Exception {
        Field value = MainActivity.class.getDeclaredField(name);
        value.setAccessible(true);
        return value;
    }

    private static final class HeldExecutor extends AbstractExecutorService {
        final ArrayDeque<Runnable> work = new ArrayDeque<>();
        boolean closed;
        @Override public void execute(Runnable task) { work.add(task); }
        @Override public void shutdown() { closed = true; }
        @Override public List<Runnable> shutdownNow() { closed = true; work.clear(); return List.of(); }
        @Override public boolean isShutdown() { return closed; }
        @Override public boolean isTerminated() { return closed; }
        @Override public boolean awaitTermination(long timeout, TimeUnit unit) { return closed; }
    }

    private static final class Fixture implements AutoCloseable {
        static final String DOCUMENT = DshConfig.ORIGIN + "/local/11111111-1111-4111-a111-111111111111";
        final MainActivity activity = Robolectric.buildActivity(MainActivity.class).get();
        final HeldExecutor network = new HeldExecutor();
        final WebViewClient client;
        final RecordingWebView web;
        final Handler handler;
        final Runnable automatic;

        final class RecordingWebView extends WebView {
            int loads, scripts;
            RecordingWebView() { super(activity); }
            @Override public String getUrl() { return DOCUMENT; }
            @Override public void loadUrl(String url) { loads++; }
            @Override public void evaluateJavascript(String script, ValueCallback<String> done) {
                scripts++;
                if (done != null) done.onReceiveValue("true");
            }
        }

        Fixture(boolean ready) throws Exception {
            web = new RecordingWebView();
            field("webView").set(activity, web);
            field("startupSurfaceReady").setBoolean(activity, ready);
            field("pageUrl").set(activity, DOCUMENT);
            ((ExecutorService) field("uiUpdateExecutor").get(activity)).shutdownNow();
            field("uiUpdateExecutor").set(activity, network);
            handler = (Handler) field("uiHandler").get(activity);
            automatic = (Runnable) field("automaticUpdates").get(activity);
            Constructor<?> constructor = Class.forName("top.whytan.dsh.MainActivity$DshWebViewClient")
                    .getDeclaredConstructor(MainActivity.class);
            constructor.setAccessible(true);
            client = (WebViewClient) constructor.newInstance(activity);
            CookieManager.getInstance().setCookie(DshConfig.ORIGIN, "fixture=authenticated");
        }

        void pageFinished() { client.onPageFinished(web, DOCUMENT); }
        void idle(long milliseconds) { Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(milliseconds)); }
        int scheduled() throws Exception {
            Field messages = MessageQueue.class.getDeclaredField("mMessages");
            Field next = Message.class.getDeclaredField("next");
            messages.setAccessible(true); next.setAccessible(true);
            int count = 0;
            for (Message message = (Message) messages.get(Looper.getMainLooper().getQueue());
                    message != null; message = (Message) next.get(message)) {
                if (message.getCallback() == automatic && message.getTarget() == handler) count++;
            }
            return count;
        }
        @Override public void close() throws Exception {
            handler.removeCallbacksAndMessages(null);
            for (String name : new String[]{"background", "uiUpdateExecutor", "apkUpdateExecutor"})
                ((ExecutorService) field(name).get(activity)).shutdownNow();
            web.destroy();
        }
    }

    @Test public void localFirstSurfaceDoesNotWaitForAnUpdateAndPageFinishOwnsFirstCheck() throws Exception {
        try (Fixture f = new Fixture(false)) {
            f.activity.onResume();
            final boolean[] painted = {false};
            new Handler(Looper.getMainLooper()).post(() -> painted[0] = true);
            f.idle(2_000);
            assertTrue(painted[0]); assertEquals(0, f.network.work.size()); assertEquals(0, f.scheduled());
            f.pageFinished(); assertEquals(1, f.scheduled());
            f.idle(1_999); assertEquals(0, f.network.work.size());
            f.idle(1); assertEquals(1, f.network.work.size());
        }
    }

    @Test public void returningToTheSameDocumentQueuesOneCheckAfterTwoSeconds() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.activity.onResume();
            f.activity.onPause(); f.activity.onStop();
            Object pageId = field("pageId").get(f.activity);
            f.activity.onResume();
            assertEquals(1, f.scheduled()); assertEquals(0, f.network.work.size());
            assertSame(f.web, field("webView").get(f.activity));
            assertEquals(pageId, field("pageId").get(f.activity));
            f.idle(1_999); assertEquals(0, f.network.work.size());
            f.idle(1); assertEquals(1, f.network.work.size());
            assertEquals(0, f.web.loads); assertEquals(0, f.web.scripts);
        }
    }

    @Test public void backgroundCancelsPendingCheckAndDoesNotPoll() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.activity.onResume(); f.idle(1_000);
            f.activity.onPause(); f.activity.onStop();
            assertEquals(0, f.scheduled());
            f.idle(30 * 60_000L);
            f.automatic.run(); // A late retained callback is also fenced by activityResumed.
            assertEquals(0, f.network.work.size()); assertEquals(0, f.scheduled());
        }
    }

    @Test public void recentSuccessfulCheckReusesTheFifteenMinuteWindowWithoutNetwork() throws Exception {
        try (Fixture f = new Fixture(true)) {
            long successful = System.currentTimeMillis();
            f.activity.getSharedPreferences("update-checks", Context.MODE_PRIVATE).edit()
                    .putLong("ui", successful).commit();
            f.activity.onResume(); f.idle(2_000);
            assertEquals(1, f.network.work.size());
            // No UiReleaseStore is installed: crossing the network boundary would
            // fail. Execute the actual queued refresh to prove the recent-success exit.
            f.network.work.removeFirst().run(); f.idle(0);
            assertNull(field("uiReleaseStore").get(f.activity));
            assertEquals(successful, f.activity.getSharedPreferences("update-checks", Context.MODE_PRIVATE)
                    .getLong("ui", 0));
            assertFalse(((java.util.concurrent.atomic.AtomicBoolean) field("updateStarted").get(f.activity)).get());
            assertEquals(0, f.web.loads); assertEquals(0, f.web.scripts);
        }
    }

    @Test public void pageFinishAndForegroundReturnDeduplicateTheSameRunnable() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.activity.onResume(); f.pageFinished();
            assertEquals(1, f.scheduled());
            f.activity.onPause(); f.activity.onStop(); f.activity.onResume(); f.pageFinished(); f.pageFinished();
            assertEquals(1, f.scheduled());
            f.idle(2_000); assertEquals(1, f.network.work.size()); assertEquals(0, f.scheduled());
        }
    }

    @Test public void foregroundChecksNeverReplaceADocumentWithoutTheExplicitUpdateButton() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.activity.getSharedPreferences("update-checks", Context.MODE_PRIVATE).edit()
                    .putLong("ui", System.currentTimeMillis()).commit();
            f.activity.onResume(); f.idle(2_000); f.network.work.removeFirst().run(); f.idle(0);
            assertNull(field("uiApplyPageId").get(f.activity));
            assertEquals(Fixture.DOCUMENT, f.web.getUrl());
            assertEquals(0, f.web.loads); assertEquals(0, f.web.scripts);
        }
    }
}
