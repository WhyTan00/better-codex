package top.whytan.dsh;
import static org.junit.Assert.*;
import org.junit.Test;
import java.net.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import okhttp3.Dns;

public class OriginDnsTest {
 static final String HOST="origin.example";
 static final class Memory implements OriginDns.Store { final Map<String,String> values=new ConcurrentHashMap<>();public String read(String h){return values.get(h);}public void write(String h,String v){values.put(h,v);} }
 OriginDns dns(Dns source,Memory store,AtomicLong clock,long expires,long budget)throws Exception{return new OriginDns(Collections.singleton(HOST),Collections.singletonList(OriginDns.ipv4("47.250.133.129")),expires,source,store,clock::get,budget);}
 Dns broken=h->{throw new UnknownHostException("fixture unavailable");};
 @Test public void connectionReuseDoesNotWritePreferencesForEveryRequest()throws Exception{
  AtomicLong clock=new AtomicLong(100);Memory store=new Memory();OriginDns d=dns(broken,store,clock,0,50);InetAddress ip=OriginDns.ipv4("47.250.133.129");
  d.verified(HOST,ip);String first=store.read(HOST);clock.addAndGet(1000);for(int i=0;i<100;i++)d.verified(HOST,ip);assertEquals(first,store.read(HOST));
  clock.addAndGet(TimeUnit.HOURS.toMillis(1));d.verified(HOST,ip);assertNotEquals(first,store.read(HOST));
 }
 @Test public void dnsFailureUsesOnlyOwnedUnexpiredBootstrap()throws Exception{
  AtomicLong clock=new AtomicLong(100);OriginDns d=dns(broken,new Memory(),clock,200,50);assertEquals("47.250.133.129",d.lookup(HOST).get(0).getHostAddress());
  try{d.lookup("unrelated.example");fail();}catch(UnknownHostException expected){}
  clock.set(200);try{d.lookup(HOST);fail();}catch(UnknownHostException expected){}
 }
 @Test public void onlyTlsVerifiedPublicAddressSurvivesAcrossNetworkChanges()throws Exception{
  AtomicLong clock=new AtomicLong(100);Memory store=new Memory();OriginDns d=dns(broken,store,clock,0,50);
  for(String ip:new String[]{"127.0.0.1","192.168.1.2","198.18.0.2","100.64.0.1"})d.verified(HOST,OriginDns.ipv4(ip));assertNull(store.read(HOST));
  d.verified(HOST,OriginDns.ipv4("47.250.133.130"));d.networkChanged();assertEquals("47.250.133.130",d.lookup(HOST).get(0).getHostAddress());
  clock.addAndGet(TimeUnit.DAYS.toMillis(8));try{d.lookup(HOST);fail();}catch(UnknownHostException expected){}
 }
 @Test public void unexpiredFixedOriginPrecedesDnsAndDnsOnlyBlocksWhenNoApprovedAddress()throws Exception{
  AtomicInteger calls=new AtomicInteger();OriginDns d=dns(h->{calls.incrementAndGet();return Collections.singletonList(OriginDns.ipv4("1.1.1.1"));},new Memory(),new AtomicLong(100),200,50);
  assertEquals("47.250.133.129",d.lookup(HOST).get(0).getHostAddress());
  OriginDns withoutFixed=dns(h->{calls.incrementAndGet();return Collections.singletonList(OriginDns.ipv4("1.1.1.1"));},new Memory(),new AtomicLong(100),0,50);
  assertEquals("1.1.1.1",withoutFixed.lookup(HOST).get(0).getHostAddress());int before=calls.get();withoutFixed.lookup(HOST);assertEquals(before,calls.get());withoutFixed.networkChanged();withoutFixed.lookup(HOST);assertEquals(before+1,calls.get());
 }
 @Test public void stalledLookupIsBoundedAndDoesNotCreateAThreadPerCaller()throws Exception{
  CountDownLatch gate=new CountDownLatch(1);AtomicInteger calls=new AtomicInteger();OriginDns d=dns(h->{calls.incrementAndGet();try{gate.await();}catch(InterruptedException e){Thread.currentThread().interrupt();}return Collections.singletonList(OriginDns.ipv4("1.1.1.1"));},new Memory(),new AtomicLong(100),200,30);
  try{long at=System.nanoTime();for(int i=0;i<5;i++)assertEquals("47.250.133.129",d.lookup(HOST).get(0).getHostAddress());assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-at)<100);for(int i=0;i<100&&calls.get()==0;i++)Thread.sleep(1);assertEquals(1,calls.get());}finally{gate.countDown();}
 }
 @Test public void oldNetworkLookupCannotBecomeNewNetworkCache()throws Exception{
  CountDownLatch entered=new CountDownLatch(1),gate=new CountDownLatch(1);AtomicInteger calls=new AtomicInteger();OriginDns d=dns(h->{int n=calls.incrementAndGet();if(n==1){entered.countDown();try{gate.await();}catch(InterruptedException e){throw new UnknownHostException();}}return Collections.singletonList(OriginDns.ipv4(n==1?"1.1.1.1":"8.8.8.8"));},new Memory(),new AtomicLong(100),0,500);
  ExecutorService worker=Executors.newSingleThreadExecutor();try{Future<List<InetAddress>> old=worker.submit(()->d.lookup(HOST));assertTrue(entered.await(1,TimeUnit.SECONDS));d.networkChanged();gate.countDown();try{old.get();fail();}catch(ExecutionException expected){assertTrue(expected.getCause() instanceof UnknownHostException);}assertEquals("8.8.8.8",d.lookup(HOST).get(0).getHostAddress());}finally{gate.countDown();worker.shutdownNow();}
 }
}
