package top.whytan.dsh;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import okhttp3.Dns;

/** Loopback CONNECT only. TLS stays end-to-end in WebView; no cookies or RPC are inspected. */
final class OriginTunnel implements AutoCloseable {
    private final Dns dns;
    private final Set<String> allowed;
    private final ServerSocket server;
    private final Set<Socket> sockets=ConcurrentHashMap.newKeySet();
    private final Semaphore slots=new Semaphore(32);
    private final ExecutorService workers=Executors.newCachedThreadPool(r->{Thread t=new Thread(r,"dsh-origin-tunnel");t.setDaemon(true);return t;});
    private volatile boolean closed;
    OriginTunnel(Dns dns,Set<String> authorities)throws IOException {
        this.dns=dns;allowed=new HashSet<>(authorities);server=new ServerSocket();
        server.bind(new InetSocketAddress(InetAddress.getByAddress(new byte[]{127,0,0,1}),0),32);
        workers.execute(()->{while(!closed)try{Socket local=server.accept();if(!slots.tryAcquire()){local.close();continue;}sockets.add(local);workers.execute(()->serve(local));}catch(IOException|RejectedExecutionException e){if(!closed)close();}});
    }
    int port(){return server.getLocalPort();}
    private void serve(Socket local) {
        Socket remote=null;
        try {
            local.setSoTimeout(15000);local.setTcpNoDelay(true);
            String header=header(local.getInputStream());String[] request=header.split("\\r\\n",2)[0].split(" ",-1);
            if(request.length!=3||!request[0].equals("CONNECT")||!request[2].equals("HTTP/1.1")||!allowed.contains(request[1])) {
                local.getOutputStream().write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".getBytes(StandardCharsets.US_ASCII));return;
            }
            String authority=request[1];int split=authority.lastIndexOf(':');String host=authority.substring(0,split);int port=Integer.parseInt(authority.substring(split+1));
            long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(15);
            for(InetAddress ip:dns.lookup(host)) {
                int remain=(int)TimeUnit.NANOSECONDS.toMillis(deadline-System.nanoTime());if(remain<=0)break;
                Socket attempt=new Socket();sockets.add(attempt);
                try{attempt.connect(new InetSocketAddress(ip,port),Math.min(remain,3000));remote=attempt;break;}
                catch(IOException unavailable){sockets.remove(attempt);quietClose(attempt);}
            }
            if(remote==null)throw new IOException("Origin unreachable");
            remote.setTcpNoDelay(true);local.setSoTimeout(0);
            local.getOutputStream().write("HTTP/1.1 200 Connection Established\r\n\r\n".getBytes(StandardCharsets.US_ASCII));local.getOutputStream().flush();
            final Socket peer=remote;
            workers.execute(()->{try{copy(peer.getInputStream(),local.getOutputStream());}catch(IOException ignored){}finally{quietClose(local);quietClose(peer);}});
            copy(local.getInputStream(),remote.getOutputStream());
        } catch(IOException|RuntimeException ignored) { /* The caller's existing connection handling owns recovery. Never replay bytes. */ }
        finally {quietClose(local);sockets.remove(local);if(remote!=null){quietClose(remote);sockets.remove(remote);}slots.release();}
    }
    private static String header(InputStream in)throws IOException {
        ByteArrayOutputStream out=new ByteArrayOutputStream();int state=0;
        while(out.size()<8192){int b=in.read();if(b<0)throw new EOFException();out.write(b);state=(state==0&&b==13)?1:(state==1&&b==10)?2:(state==2&&b==13)?3:(state==3&&b==10)?4:0;if(state==4)return out.toString("US-ASCII");}
        throw new IOException("CONNECT header too large");
    }
    private static void copy(InputStream in,OutputStream out)throws IOException {byte[] bytes=new byte[16384];int n;while((n=in.read(bytes))!=-1){out.write(bytes,0,n);out.flush();}}
    private static void quietClose(Socket socket){try{socket.close();}catch(IOException ignored){}}
    void networkChanged(){for(Socket socket:sockets)quietClose(socket);}
    @Override public void close(){closed=true;try{server.close();}catch(IOException ignored){}networkChanged();workers.shutdownNow();}
}
