package top.whytan.dsh;

import static org.junit.Assert.*;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Exercises the actual native entry, timeout, and stale completion paths. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=28)
public final class NotificationVisibilityTest {
    private static Field field(String name) throws Exception {
        Field f=MainActivity.class.getDeclaredField(name);f.setAccessible(true);return f;
    }
    private static Object invoke(MainActivity activity,String name,Object... args) throws Exception {
        for(Method m:MainActivity.class.getDeclaredMethods())if(m.getName().equals(name)&&m.getParameterCount()==args.length){m.setAccessible(true);return m.invoke(activity,args);}
        throw new NoSuchMethodException(name);
    }
    private static Object request(long sequence) throws Exception {
        Class<?> type=Class.forName("top.whytan.dsh.MainActivity$LaunchRequest");
        Constructor<?> c=type.getDeclaredConstructor(long.class,String.class,String.class);c.setAccessible(true);
        return c.newInstance(sequence,"ai","https://workbench.example.test/local/11111111-1111-4111-a111-111111111111?workspace=ai");
    }
    @Test public void cancellingPendingNotificationReusesWarmDocumentAndRejectsStaleCompletion() throws Exception {
        MainActivity activity=Robolectric.buildActivity(MainActivity.class).get();
        class RetainedWeb extends WebView {
            android.webkit.ValueCallback<String> callback;String script;int loads;
            RetainedWeb(){super(activity);}
            @Override public void evaluateJavascript(String value,android.webkit.ValueCallback<String> done){script=value;callback=done;}
            @Override public void loadUrl(String url){loads++;}
        }
        RetainedWeb web=new RetainedWeb();field("webView").set(activity,web);invoke(activity,"buildNativeLayout",web);
        android.webkit.CookieManager.getInstance().setCookie(DshConfig.ORIGIN,"fixture=authenticated");
        Object first=request(1);field("launchRequest").set(activity,first);field("navigationSequence").setLong(activity,1);invoke(activity,"beginNotificationNavigation",first);
        assertEquals(true,invoke(activity,"cancelNotificationNavigationToList"));assertNotNull(web.callback);assertTrue(web.script.contains("backToList"));assertEquals(0,web.loads);
        web.callback.onReceiveValue("true");assertEquals(0,web.loads);assertEquals(-1L,field("pendingListSequence").getLong(activity));assertNull(field("pendingNotificationRequest").get(activity));
        Object next=request(3);field("launchRequest").set(activity,next);field("navigationSequence").setLong(activity,3);invoke(activity,"beginNotificationNavigation",next);
        web.callback.onReceiveValue("false");assertEquals(0,web.loads);assertSame(next,field("pendingNotificationRequest").get(activity));web.destroy();
    }
    @Test public void notificationEntryAndTimeoutNeverHideTheWebView() throws Exception {
        MainActivity activity=Robolectric.buildActivity(MainActivity.class).get();
        WebView web=new WebView(activity);field("webView").set(activity,web);
        invoke(activity,"buildNativeLayout",web);
        Object first=request(1);field("launchRequest").set(activity,first);field("navigationSequence").setLong(activity,1);
        invoke(activity,"beginNotificationNavigation",first);
        FrameLayout banner=(FrameLayout)field("notificationOverlay").get(activity);
        assertEquals(View.VISIBLE,web.getVisibility());assertEquals(View.GONE,banner.getVisibility());
        invoke(activity,"onNotificationWaitTimeout");
        assertEquals(View.VISIBLE,web.getVisibility());assertEquals(View.VISIBLE,banner.getVisibility());
        assertEquals(ViewGroup.LayoutParams.WRAP_CONTENT,banner.getLayoutParams().height);
        Object second=request(2);field("launchRequest").set(activity,second);field("navigationSequence").setLong(activity,2);
        invoke(activity,"beginNotificationNavigation",second);invoke(activity,"revealNotification",first);
        assertSame(second,field("pendingNotificationRequest").get(activity));
        invoke(activity,"revealNotification",second);
        assertNull(field("pendingNotificationRequest").get(activity));assertEquals(View.VISIBLE,web.getVisibility());assertEquals(View.GONE,banner.getVisibility());
        web.destroy();
    }
}
