package top.whytan.dsh;
import android.view.View;import android.webkit.WebView;import androidx.core.graphics.Insets;import androidx.core.view.ViewCompat;import androidx.core.view.WindowInsetsCompat;
import org.junit.Test;import org.junit.runner.RunWith;import org.robolectric.Robolectric;import org.robolectric.RobolectricTestRunner;import org.robolectric.annotation.Config;import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @Config(sdk=34)
public class MainActivityImeViewportTest {
 @Test public void keyboardOcclusionIsReservedAndClosingRestoresTheNativeSafeArea()throws Exception {
  MainActivity activity=Robolectric.buildActivity(MainActivity.class).get();WebView web=new WebView(activity);
  java.lang.reflect.Method create=MainActivity.class.getDeclaredMethod("buildNativeLayout",WebView.class);create.setAccessible(true);View root=(View)create.invoke(activity,web);
  WindowInsetsCompat closed=new WindowInsetsCompat.Builder().setInsets(WindowInsetsCompat.Type.systemBars(),Insets.of(4,24,8,30)).setInsets(WindowInsetsCompat.Type.ime(),Insets.NONE).setVisible(WindowInsetsCompat.Type.ime(),false).build();
  WindowInsetsCompat open=new WindowInsetsCompat.Builder(closed).setInsets(WindowInsetsCompat.Type.ime(),Insets.of(0,0,0,500)).setVisible(WindowInsetsCompat.Type.ime(),true).build();
  ViewCompat.dispatchApplyWindowInsets(root,open);assertEquals(500,root.getPaddingBottom());assertEquals(24,root.getPaddingTop());
  root.measure(View.MeasureSpec.makeMeasureSpec(600,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(1000,View.MeasureSpec.EXACTLY));root.layout(0,0,600,1000);assertEquals(476,root.getMeasuredHeight()-root.getPaddingTop()-root.getPaddingBottom());assertEquals(android.view.ViewGroup.LayoutParams.MATCH_PARENT,web.getLayoutParams().height);
  ViewCompat.dispatchApplyWindowInsets(root,closed);assertEquals(30,root.getPaddingBottom());assertEquals(4,root.getPaddingLeft());assertEquals(8,root.getPaddingRight());web.destroy();
 }
}
