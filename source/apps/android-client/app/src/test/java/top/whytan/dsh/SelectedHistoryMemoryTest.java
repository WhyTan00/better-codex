package top.whytan.dsh;

import android.content.Context;
import android.content.ContentValues;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=28,manifest=Config.NONE)
public class SelectedHistoryMemoryTest {
    final String id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    SyncStore store; long revision;
    @Before public void setup() { Context c=RuntimeEnvironment.getApplication();c.deleteDatabase("native-sync-v1.sqlite");store=new SyncStore(c);store.resetGeneration("ai","s"); }
    @After public void close() { store.close(); }
    String key(String method,JSONObject params)throws Exception {params.put("threadId",id);return "read:[\""+method+"\","+params.toString()+"]";}
    JSONObject record(String key,JSONObject result)throws Exception {return new JSONObject().put("scope","ai").put("threadId",id).put("sourceGeneration","s").put("generation","s").put("kind","history").put("revision",++revision).put("key",key).put("deleted",false).put("payload",new JSONObject().put("result",result));}
    String[] head()throws Exception {
        String h=key("thread/read",new JSONObject().put("includeTurns",false));
        String t=key("thread/turns/list",new JSONObject().put("itemsView","summary").put("sortDirection","desc").put("limit",2));
        store.applyNativeRecord(record(h,new JSONObject().put("thread",new JSONObject().put("id",id))));
        store.applyNativeRecord(record(t,new JSONObject().put("data",new JSONArray()).put("nextCursor","older")));
        return new String[]{h,t};
    }
    @Test public void moreThan200NewerOldPagesCannotHideTheSelectedHead()throws Exception {
        String[] keys=head();
        for(int i=0;i<220;i++)store.applyNativeRecord(record(key("thread/turns/list",new JSONObject().put("itemsView","summary").put("sortDirection","desc").put("cursor","older-"+i)),new JSONObject().put("data",new JSONArray())));
        long cursor=store.localRecordCursor("ai");
        JSONArray rows=store.readThreadRecords("ai",id).getJSONArray("records");
        assertEquals(2,rows.length());assertEquals(keys[0],rows.getJSONObject(0).getString("key"));assertEquals(keys[1],rows.getJSONObject(1).getString("key"));
        assertEquals(cursor,store.localRecordCursor("ai"));assertEquals(0,store.readThreadRecords("zyy",id).getJSONArray("records").length());
    }
    @Test public void anUnreadOldPageBodyIsNeitherParsedNorDeletedDuringOpening()throws Exception {
        head();String old=key("thread/turns/list",new JSONObject().put("cursor","older").put("itemsView","full"));
        store.applyNativeRecord(record(old,new JSONObject().put("data",new JSONArray())));
        ContentValues corrupt=new ContentValues();corrupt.put("payload","unread old page fixture");
        store.getWritableDatabase().update("records",corrupt,"scope=? AND key=?",new String[]{"ai",old});
        store.getWritableDatabase().update("saved_records",corrupt,"scope=? AND key=?",new String[]{"ai",old});
        assertEquals(2,store.readThreadRecords("ai",id).getJSONArray("records").length());
        assertEquals(2,store.readSavedThreadRecords("ai",id).getJSONArray("records").length());
        try(android.database.Cursor row=store.getReadableDatabase().rawQuery("SELECT payload FROM saved_records WHERE scope=? AND key=?",new String[]{"ai",old})) {assertTrue(row.moveToFirst());assertEquals("unread old page fixture",row.getString(0));}
    }
    @Test public void openingReturnsOneNewestSummaryAndLeavesOtherVariantsOnDisk()throws Exception {
        head();String newer=key("thread/turns/list",new JSONObject().put("itemsView","summary").put("sortDirection","desc").put("limit",20));
        store.applyNativeRecord(record(newer,new JSONObject().put("data",new JSONArray()).put("nextCursor","older")));
        JSONArray rows=store.readThreadRecords("ai",id).getJSONArray("records");assertEquals(2,rows.length());assertEquals(newer,rows.getJSONObject(1).getString("key"));
        assertEquals(2,store.readSavedThreadRecords("ai",id).getJSONArray("records").length());
    }
}
