package top.whytan.dsh;
import static org.junit.Assert.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import java.util.*;
import okhttp3.*;
import org.json.JSONObject;

@RunWith(RobolectricTestRunner.class) @Config(sdk=34)
public class ScopeSessionClientTest {
 @Test public void transportFailureClassificationNeverRetainsMessages(){
  assertEquals("dns",ScopeSessionClient.failureClass(new UnknownHostException("private-cookie-and-host")));
  assertEquals("tls",ScopeSessionClient.failureClass(new javax.net.ssl.SSLException("private-server")));
  assertEquals("timeout",ScopeSessionClient.failureClass(new SocketTimeoutException("private-url")));
  assertEquals("connection",ScopeSessionClient.failureClass(new IOException("private-token")));
 }
 static class Fixture implements AutoCloseable {
  final ServerSocket server=new ServerSocket(0,8,InetAddress.getByName("127.0.0.1"));
  final ExecutorService worker=Executors.newCachedThreadPool();
  Fixture()throws Exception{}
  String url(){return "http://127.0.0.1:"+server.getLocalPort();}
  Future<String> respond(int status,String body){return worker.submit(()->{try(Socket peer=server.accept()){
   peer.setSoTimeout(2000);ByteArrayOutputStream head=new ByteArrayOutputStream();
   while(!head.toString("UTF-8").endsWith("\r\n\r\n")){int b=peer.getInputStream().read();if(b<0)throw new EOFException();head.write(b);}
   byte[] bytes=body.getBytes(StandardCharsets.UTF_8);
   peer.getOutputStream().write(("HTTP/1.1 "+status+" Test\r\nContent-Type: application/json\r\nContent-Length: "+bytes.length+"\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
   peer.getOutputStream().write(bytes);return head.toString("UTF-8");
  }});}
  public void close()throws Exception{server.close();worker.shutdownNow();}
 }
 @Test public void blockedHistoryDispatcherCannotBlockScopeAndNoSecretEntersTrace()throws Exception{
  Dispatcher history=new Dispatcher();history.setMaxRequests(1);history.setMaxRequestsPerHost(1);
  List<String> traces=new CopyOnWriteArrayList<>();
  try(Fixture stalled=new Fixture();Fixture fixture=new Fixture();ScopeSessionClient client=new ScopeSessionClient(new OkHttpClient.Builder().dispatcher(history),fixture.url())){
   OkHttpClient historyClient=new OkHttpClient.Builder().dispatcher(history).build();
   Call blocked=historyClient.newCall(new Request.Builder().url(stalled.url()).build());
   Future<Socket> accepted=stalled.worker.submit(stalled.server::accept);
   blocked.enqueue(new Callback(){public void onFailure(Call c,IOException e){}public void onResponse(Call c,Response r){r.close();}});
   try(Socket ignored=accepted.get(3,TimeUnit.SECONDS)){assertEquals(1,history.runningCallsCount());
   Future<String> received=fixture.respond(200,"{\"id\":\"ai\",\"token\":\"secret-fixture\"}");
   CompletableFuture<JSONObject> done=new CompletableFuture<>();
   client.read("ai","session=fixture-cookie","11111111-1111-4111-a111-111111111111",(s,r,c,d)->traces.add(s+":"+r+":"+c),
      (result,error)->{if(error!=null)done.completeExceptionally(new Exception(error));else done.complete(result);});
   assertEquals("secret-fixture",done.get(3,TimeUnit.SECONDS).getJSONObject("data").getString("token"));
   String request=received.get(3,TimeUnit.SECONDS);assertTrue(request.startsWith("GET /dsh-scope-session?workspace=ai "));
   assertTrue(request.contains("Cookie: session=fixture-cookie"));assertFalse(traces.toString().contains("secret-fixture"));
   assertEquals(1,history.runningCallsCount());assertEquals(0,history.queuedCallsCount());
   }finally{blocked.cancel();historyClient.connectionPool().evictAll();history.executorService().shutdownNow();}
  }
 }
 @Test public void authenticationAndWrongScopeRemainFailuresInsteadOfReusableCredentials()throws Exception{
  try(Fixture fixture=new Fixture();ScopeSessionClient client=new ScopeSessionClient(new OkHttpClient.Builder(),fixture.url())){
   fixture.respond(401,"");CompletableFuture<JSONObject> auth=new CompletableFuture<>();
   client.read("ai",null,"fixture",(s,r,c,d)->{},(v,e)->auth.complete(v));
   JSONObject rejected=auth.get(3,TimeUnit.SECONDS);assertEquals(401,rejected.getInt("status"));assertFalse(rejected.has("data"));
   fixture.respond(200,"{\"id\":\"zyy\",\"token\":\"wrong-scope\"}");CompletableFuture<String> wrong=new CompletableFuture<>();
   client.read("ai",null,"fixture",(s,r,c,d)->{},(v,e)->wrong.complete(e));
   assertEquals("CONTROL_INVALID_RESPONSE",wrong.get(3,TimeUnit.SECONDS));
  }
 }
}
