package top.whytan.dsh;
import static org.junit.Assert.*;
import org.junit.Test;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

public class OriginTunnelTest {
 private String header(InputStream in)throws Exception{ByteArrayOutputStream b=new ByteArrayOutputStream();while(b.size()<8192){int n=in.read();if(n<0)break;b.write(n);if(b.toString("US-ASCII").endsWith("\r\n\r\n"))break;}return b.toString("US-ASCII");}
 private Socket connect(OriginTunnel proxy,String authority)throws Exception{Socket s=new Socket("127.0.0.1",proxy.port());s.setSoTimeout(2000);s.getOutputStream().write(("CONNECT "+authority+" HTTP/1.1\r\nHost: "+authority+"\r\n\r\n").getBytes(StandardCharsets.US_ASCII));return s;}
 @Test public void unknownOriginAndPortNeverReachResolver()throws Exception{
  try(OriginTunnel tunnel=new OriginTunnel(h->{fail("unauthorized resolution");return null;},Collections.singleton("owned.example:443"))){for(String target:new String[]{"evil.example:443","owned.example:80","owned.example:443@evil.example:443"})try(Socket s=connect(tunnel,target)){assertTrue(header(s.getInputStream()).startsWith("HTTP/1.1 403"));}}
 }
 @Test public void opaqueBytesFlowOnceAndStalledPeerDoesNotBlockAnotherConnection()throws Exception{
  ExecutorService workers=Executors.newCachedThreadPool();ServerSocket origin=new ServerSocket(0,8,InetAddress.getByName("127.0.0.1"));String target="owned.example:"+origin.getLocalPort();
  try(OriginTunnel tunnel=new OriginTunnel(h->Collections.singletonList(InetAddress.getByName("127.0.0.1")),Collections.singleton(target))){
   Future<Socket> first=workers.submit(origin::accept);try(Socket waiting=connect(tunnel,target);Socket peer1=first.get(2,TimeUnit.SECONDS)){
    assertTrue(header(waiting.getInputStream()).startsWith("HTTP/1.1 200"));Future<byte[]> accepted=workers.submit(()->{try(Socket peer=origin.accept()){byte[] b=new byte[32768];new DataInputStream(peer.getInputStream()).readFully(b);peer.getOutputStream().write(b);return b;}});
    byte[] payload=new byte[32768];new Random(7).nextBytes(payload);try(Socket active=connect(tunnel,target)){assertTrue(header(active.getInputStream()).startsWith("HTTP/1.1 200"));active.getOutputStream().write(payload);byte[] returned=new byte[payload.length];new DataInputStream(active.getInputStream()).readFully(returned);assertArrayEquals(payload,returned);assertArrayEquals(payload,accepted.get(2,TimeUnit.SECONDS));}
    tunnel.networkChanged();assertEquals(-1,waiting.getInputStream().read());
   }
  }finally{origin.close();workers.shutdownNow();}
 }
}
