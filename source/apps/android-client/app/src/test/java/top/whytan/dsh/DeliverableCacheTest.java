package top.whytan.dsh;
import static org.junit.Assert.*;
import android.content.Context;import android.net.Uri;import android.webkit.WebResourceResponse;
import org.json.*;import org.junit.*;import org.junit.runner.RunWith;import org.robolectric.*;import org.robolectric.annotation.Config;
import java.io.*;import java.security.MessageDigest;import java.util.*;import java.util.concurrent.atomic.AtomicBoolean;
import okhttp3.*;
@RunWith(RobolectricTestRunner.class) @Config(sdk=28,manifest=Config.NONE)
public class DeliverableCacheTest {
    Context context;DeliverableCache cache;
    @Before public void setup(){context=RuntimeEnvironment.getApplication();context.deleteDatabase("deliverables.db");cache=new DeliverableCache(context);}
    static String hex(byte[] data)throws Exception{StringBuilder s=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(data))s.append(String.format(Locale.ROOT,"%02x",b&255));return s.toString();}
    JSONObject descriptor(byte[] data,String name)throws Exception{String hash=hex(data);return new JSONObject().put("id",DeliverableCache.digest(name+UUID.randomUUID())).put("scope","ai").put("path","/workspace/example/"+name).put("name",name).put("size",data.length).put("sha256",hash).put("version","sha256:"+hash).put("sourceVersion","original-etag").put("mime","application/pdf").put("contentKind","pdf").put("url","/w/ai/api/local-file/test/report.pdf");}
    OkHttpClient transport(byte[] data,JSONObject d,List<Long> starts,AtomicBoolean failSecond,boolean wrongVersion){return new OkHttpClient.Builder().addInterceptor(chain->{
        String range=chain.request().header("Range");String[] r=range.substring(6).split("-");int from=Integer.parseInt(r[0]),to=Integer.parseInt(r[1]);starts.add((long)from);
        if(from>0&&failSecond.getAndSet(false))throw new IOException("network interrupted");
        return new Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(206).message("Partial Content").header("ETag",wrongVersion?"\"wrong\"":"\""+d.optString("version")+"\"").header("Content-Range","bytes "+from+"-"+to+"/"+data.length).body(ResponseBody.create(Arrays.copyOfRange(data,from,to+1),MediaType.parse("application/pdf"))).build();
    }).build();}
    @Test public void interruptedTransferReopensFromCommittedRangeThenServesOfflineWithScopeGuard()throws Exception{
        byte[] data=new byte[8*1024*1024+37];new Random(1).nextBytes(data);JSONObject d=descriptor(data,"resume.pdf");List<Long> starts=new ArrayList<>();AtomicBoolean fail=new AtomicBoolean(true);
        try{cache.download("ai",d,transport(data,d,starts,fail,false),"");fail("must interrupt");}catch(IOException expected){}
        assertFalse(cache.resolve("ai",d.getString("path")).getBoolean("available"));
        DeliverableCache reopened=new DeliverableCache(context);assertTrue(reopened.download("ai",d,transport(data,d,starts,fail,false),""));assertEquals(Arrays.asList(0L,8L*1024*1024,8L*1024*1024),starts);
        JSONObject local=reopened.resolve("ai",d.getString("path"));assertTrue(local.getBoolean("available"));Uri uri=Uri.parse(local.getString("url"));
        WebResourceResponse response=reopened.intercept(uri,"ai","bytes=7-15",true);assertEquals(206,response.getStatusCode());assertArrayEquals(Arrays.copyOfRange(data,7,16),response.getData().readAllBytes());response.getData().close();
        assertEquals(403,reopened.intercept(uri,"zyy",null,true).getStatusCode());assertEquals(403,reopened.intercept(uri,"ai",null,false).getStatusCode());
    }
    @Test public void wrongVersionAndWrongDigestNeverBecomeReadable()throws Exception{
        byte[] data="bytes".getBytes();JSONObject d=descriptor(data,"invalid.pdf");
        try{cache.download("ai",d,transport(data,d,new ArrayList<>(),new AtomicBoolean(false),true),"");fail();}catch(IOException expected){}
        assertFalse(cache.resolve("ai",d.getString("path")).getBoolean("available"));
        JSONObject wrong=descriptor("other".getBytes(),"digest.pdf");try{cache.download("ai",wrong,transport(data,wrong,new ArrayList<>(),new AtomicBoolean(false),false),"");fail();}catch(IOException expected){}
        assertFalse(cache.resolve("ai",wrong.getString("path")).getBoolean("available"));
    }
    @Test public void pendingTransferNeverSchedulesForUserDisabledScope(){
        context.getSharedPreferences("sync-control",Context.MODE_PRIVATE).edit().putBoolean("enabled:ai",false).commit();DeliverableJobService.schedule(context,"ai");
        assertNull(context.getSystemService(android.app.job.JobScheduler.class).getPendingJob(48101));
    }
}
