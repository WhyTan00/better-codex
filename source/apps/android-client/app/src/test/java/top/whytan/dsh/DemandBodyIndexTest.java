package top.whytan.dsh;
import android.content.Context;
import android.content.ContentValues;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import java.io.File;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=28,manifest=Config.NONE)
public class DemandBodyIndexTest {
    final String id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    SyncStore store;Context context;long revision;
    @Before public void setup() {context=RuntimeEnvironment.getApplication();context.deleteDatabase("native-sync-v1.sqlite");store=new SyncStore(context);}
    @After public void close() {store.close();}
    JSONObject record(String key,String kind,JSONObject payload)throws Exception {return new JSONObject().put("scope","ai").put("key",key).put("kind",kind).put("threadId",id).put("sourceGeneration","s").put("generation","s").put("revision",++revision).put("deleted",false).put("payload",payload);}
    String readKey(int n) {return "read:[\"thread/items/list\",{\"cursor\":\""+n+"\",\"threadId\":\""+id+"\"}]";}
    @Test public void sparsePagingAdvancesTheReaderCursorWithoutDecodingOrDeletingUnrelatedBodies()throws Exception {
        store.applyNativeRecord(record("thread:"+id,"catalog",new JSONObject().put("nativeThread",new JSONObject().put("id",id))));
        for(int i=0;i<205;i++)store.applyNativeRecord(record(readKey(i),"history",new JSONObject().put("result",new JSONObject().put("data",new JSONArray()))));
        // An unopened old body can even be damaged: index replication neither
        // reads it nor lets it prevent the valid workspace metadata opening.
        ContentValues corrupt=new ContentValues();corrupt.put("payload","old unread body");store.getWritableDatabase().update("records",corrupt,"key=?",new String[]{readKey(100)});
        long before=store.localRecordCursor("ai"),after=0;int refs=0,metadata=0,pages=0;
        while(true){JSONObject page=store.readRecords("ai",after,100,true);assertTrue(page.getBoolean("indexOnly"));assertFalse(page.getBoolean("resetRequired"));refs+=page.getJSONArray("bodyChanges").length();metadata+=page.getJSONArray("records").length();assertTrue(page.toString().getBytes(StandardCharsets.UTF_8).length<150000);after=page.getLong("cursor");pages++;if(!page.getBoolean("hasMore"))break;assertTrue(pages<10);}
        assertEquals(205,refs);assertEquals(1,metadata);assertEquals(before,after);assertEquals(before,store.localRecordCursor("ai"));
        try(android.database.Cursor row=store.getReadableDatabase().rawQuery("SELECT count(*) FROM records WHERE kind='history'",null)){assertTrue(row.moveToFirst());assertEquals(205,row.getInt(0));}
        assertEquals(0,store.readRecords("zyy",0,200,true).getJSONArray("bodyChanges").length());
    }
    @Test public void exactBodyIsReadOnlyWhenRequestedAndSavedHistorySurvivesProjectionReset()throws Exception {
        String key=readKey(1);store.applyNativeRecord(record(key,"history",new JSONObject().put("result",new JSONObject().put("data",new JSONArray().put(new JSONObject().put("text","ORIGINAL"))))));
        long cursor=store.localRecordCursor("ai");assertEquals(key,store.readLocalRecord("ai",key,"s","s").getJSONObject("record").getString("key"));assertEquals(cursor,store.localRecordCursor("ai"));
        assertTrue(store.readLocalRecord("zyy",key,"s","s").isNull("record"));store.resetGeneration("ai","new-source");assertEquals(key,store.readLocalRecord("ai",key,"s","s").getJSONObject("record").getString("key"));
    }
    @Test public void nativeSparseOutputIsExportedUnmodifiedForTheRealJsConsumer()throws Exception {
        store.applyNativeRecord(record("thread:"+id,"catalog",new JSONObject().put("nativeThread",new JSONObject().put("id",id).put("name","controlled"))));
        for(int i=0;i<3;i++)store.applyNativeRecord(record(readKey(i),"history",new JSONObject().put("result",new JSONObject().put("data",new JSONArray()))));
        JSONArray pages=new JSONArray();long after=0;while(true){JSONObject page=store.readRecords("ai",after,2,true);pages.put(page);after=page.getLong("cursor");if(!page.getBoolean("hasMore"))break;}
        String out=System.getProperty("dsh.demand.export");if(out!=null)java.nio.file.Files.write(new File(out).toPath(),pages.toString().getBytes(StandardCharsets.UTF_8));
        System.out.println("DSH_SPARSE_PRODUCER:"+pages.toString());
        assertEquals(2,pages.length());assertEquals(2,pages.getJSONObject(1).getJSONArray("bodyChanges").length());
    }
}
