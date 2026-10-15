package top.whytan.dsh;
import static org.junit.Assert.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import java.io.*;
import java.net.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import okhttp3.*;
import org.json.JSONObject;

@RunWith(RobolectricTestRunner.class) @Config(sdk=34)
public class NetworkTimingTest {
 @Test public void successfulSamplingAndFailureAlwaysRetained()throws Exception{
  int kept=0;for(int i=0;i<256;i++){NetworkTiming t=new NetworkTiming();if(t.summary("sample-"+i,null,200)!=null)kept++;}
  assertTrue(kept>0&&kept<32);
  NetworkTiming t=new NetworkTiming();t.secureConnectStart(new OkHttpClient().newCall(new Request.Builder().url("https://fixture.invalid").build()));
  JSONObject v=NativeDiagnostics.safeFields(t.summary("x",new javax.net.ssl.SSLHandshakeException("secret-cookie"),0));
  assertEquals("tls",v.getString("networkPhase"));assertEquals("SSLHandshakeException",v.getString("errorName"));assertTrue(v.has("tlsStartMs"));assertTrue(v.getBoolean("networkFailed"));assertFalse(v.toString().contains("secret"));
 }
 @Test public void realHttpRetainsExistingListenerAndActualSummaryContract()throws Exception{
  AtomicInteger acquired=new AtomicInteger();
  try(ScopeSessionClientTest.Fixture f=new ScopeSessionClientTest.Fixture()){
   f.respond(200,"{\"id\":\"ai\",\"token\":\"private-token\"}");
   OkHttpClient c=NetworkTiming.install(new OkHttpClient.Builder().eventListener(new okhttp3.EventListener(){@Override public void connectionAcquired(Call call,Connection connection){acquired.incrementAndGet();}})).build();
   NetworkTiming t=new NetworkTiming();
   try(Response r=c.newCall(new Request.Builder().url(f.url()).tag(NetworkTiming.class,t).build()).execute()){assertTrue(r.body().string().contains("private-token"));}
   JSONObject v=NativeDiagnostics.safeFields(t.summary("p",null,200));
   assertEquals(1,acquired.get());assertTrue(v.has("connectStartMs"));assertTrue(v.has("responseHeadersMs"));assertTrue(v.has("responseBodyEndMs"));assertFalse(v.has("tlsStartMs"));assertFalse(v.getBoolean("connectionReused"));
   v.put("phase","client_diagnostic").put("component","android-network").put("reason","network_summary").put("traceId","11111111-1111-4111-a111-111111111111");
   java.nio.file.Files.write(java.nio.file.Paths.get("/tmp/dsh-network-timing-producer.json"),v.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
   assertFalse(v.toString().contains("private"));c.connectionPool().evictAll();c.dispatcher().executorService().shutdownNow();
  }
 }
 @Test public void bodyReadTimeoutReportsBodyStageWithoutFakeTls()throws Exception{
  try(ScopeSessionClientTest.Fixture f=new ScopeSessionClientTest.Fixture()){
   Future<?> server=f.worker.submit(()->{try(Socket s=f.server.accept()){s.setSoTimeout(2000);BufferedReader reader=new BufferedReader(new InputStreamReader(s.getInputStream()));while(!reader.readLine().isEmpty()){}s.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nx".getBytes());s.getOutputStream().flush();Thread.sleep(500);}catch(Exception ignored){}});
   OkHttpClient c=NetworkTiming.install(new OkHttpClient.Builder().readTimeout(100,TimeUnit.MILLISECONDS)).build();NetworkTiming t=new NetworkTiming();
   try(Response r=c.newCall(new Request.Builder().url(f.url()).tag(NetworkTiming.class,t).build()).execute()){r.body().string();fail("must time out");}catch(IOException e){JSONObject v=t.summary("x",e,200);assertEquals("response_body",v.getString("networkPhase"));assertEquals("SocketTimeoutException",v.getString("errorName"));assertFalse(v.has("tlsStartMs"));java.nio.file.Files.write(java.nio.file.Paths.get("/tmp/dsh-network-timing-failure.json"),NativeDiagnostics.safeFields(v).toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));}
   server.get(2,TimeUnit.SECONDS);c.connectionPool().evictAll();c.dispatcher().executorService().shutdownNow();
  }
 }
}
