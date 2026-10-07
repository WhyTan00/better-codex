package top.whytan.dsh;

import android.content.Context;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;

/** Uses the JS producer's untouched output and exports the real SQLite reader envelope. */
@RunWith(RobolectricTestRunner.class) @Config(sdk=28,manifest=Config.NONE)
public class VisibleProcessContractTest {
    @Test public void exportActualSQLiteContractAfterCloseReopenAndInvalidation() throws Exception {
        String input=System.getProperty("dsh.process.input"),output=System.getProperty("dsh.process.output");
        Assume.assumeTrue(input!=null&&output!=null);
        JSONObject fixture=new JSONObject(new String(Files.readAllBytes(Paths.get(input)),StandardCharsets.UTF_8));
        JSONObject first=fixture.getJSONObject("first"),second=fixture.getJSONObject("second");
        String scope=first.getString("scope"),thread=first.getString("threadId"),turn=first.getString("turnId");
        Context context=RuntimeEnvironment.getApplication(); context.deleteDatabase("native-sync-v1.sqlite");
        SyncStore store=new SyncStore(context); JSONObject result=new JSONObject();
        try {
            store.saveVisibleProcesses(scope,first);store.close();store=new SyncStore(context);
            result.put("afterCloseReopen",store.readVisibleProcesses(scope,thread,turn));
            store.saveVisibleProcesses(scope,second);store.close();store=new SyncStore(context);
            JSONObject merged=store.readVisibleProcesses(scope,thread,turn);
            result.put("afterTwoObservations",merged);
            assertEquals(3,merged.getJSONObject("value").getJSONArray("items").length());
            assertEquals("[\"user\",\"reasoning\",\"tool\",\"next\",\"final\"]",merged.getJSONObject("value").getJSONArray("order").toString());
            try {store.saveVisibleProcesses("zyy",first);fail("foreign scope accepted");}catch(JSONException expected) {result.put("foreignScopeRejected",true);}
            result.put("foreignScopeRead",store.readVisibleProcesses("zyy",thread,turn));
            long invalidated=second.getLong("savedAt")+1;
            store.invalidateVisibleProcesses(scope,thread,invalidated);store.close();store=new SyncStore(context);
            store.saveVisibleProcesses(scope,first);
            result.put("afterInvalidationAndLateSave",store.readVisibleProcesses(scope,thread,turn));
            assertTrue(result.getJSONObject("afterInvalidationAndLateSave").isNull("value"));
            JSONObject rewritten=new JSONObject(first.toString()).put("generation","rewrite").put("savedAt",invalidated+1);
            store.saveVisibleProcesses(scope,rewritten);store.close();store=new SyncStore(context);
            result.put("afterRewrite",store.readVisibleProcesses(scope,thread,turn));
            Files.write(Paths.get(output),(result.toString(2)+"\n").getBytes(StandardCharsets.UTF_8));
        } finally {store.close();context.deleteDatabase("native-sync-v1.sqlite");}
    }
}
