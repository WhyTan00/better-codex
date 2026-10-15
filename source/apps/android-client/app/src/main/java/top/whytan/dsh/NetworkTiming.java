package top.whytan.dsh;

import java.io.IOException;
import java.net.*;
import java.util.List;
import java.util.concurrent.TimeUnit;
import okhttp3.*;
import org.json.JSONObject;

/** One bounded in-memory summary per opted-in call; no I/O in network callbacks. */
final class NetworkTiming extends EventListener {
    private final long start = System.nanoTime();
    private final long[] marks = new long[10];
    private static final String[] KEYS = {"dnsStartMs","dnsEndMs","connectStartMs","connectEndMs","tlsStartMs","tlsEndMs","requestHeadersMs","responseHeadersMs","responseBodyStartMs","responseBodyEndMs"};
    private EventListener delegate = EventListener.NONE;
    private String phase = "queued";
    private long bytes;
    private boolean reused;
    NetworkTiming(){ java.util.Arrays.fill(marks,-1); }
    static OkHttpClient.Builder install(OkHttpClient.Builder builder) {
        EventListener.Factory existing=builder.build().eventListenerFactory();
        return builder.eventListenerFactory(call->{
            EventListener previous=existing.create(call);
            NetworkTiming timing=call.request().tag(NetworkTiming.class);
            if(timing==null)return previous;
            timing.delegate=previous;return timing;
        });
    }
    private synchronized void mark(int index,String next){if(marks[index]<0)marks[index]=elapsed();phase=next;}
    long elapsed(){return TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-start);}
    synchronized JSONObject summary(String id,Throwable failure,int status){
        long duration=elapsed();
        if(failure==null&&status<400&&duration<1000&&(id.hashCode()&15)!=0)return null;
        JSONObject out=new JSONObject();
        try{
            out.put("networkFailed",failure!=null||status>=400).put("statusCode",status).put("durationMs",duration).put("networkPhase",phase).put("connectionReused",reused).put("responseBytes",bytes);
            for(int i=0;i<marks.length;i++)if(marks[i]>=0)out.put(KEYS[i],marks[i]);
            if(failure!=null)out.put("errorName",errorName(failure));
        }catch(Exception ignored){}return out;
    }
    static String errorName(Throwable e){
        if(e instanceof javax.net.ssl.SSLHandshakeException)return "SSLHandshakeException";
        if(e instanceof javax.net.ssl.SSLException)return "SSLException";
        if(e instanceof SocketTimeoutException)return "SocketTimeoutException";
        if(e instanceof UnknownHostException)return "UnknownHostException";
        if(e instanceof java.io.InterruptedIOException)return "InterruptedIOException";
        if(e instanceof IOException)return "IOException";
        if(e instanceof org.json.JSONException)return "JSONException";
        return "unknown";
    }
    @Override public void callStart(Call c){delegate.callStart(c);}
    @Override public void dnsStart(Call c,String h){mark(0,"dns");delegate.dnsStart(c,h);}
    @Override public void dnsEnd(Call c,String h,List<InetAddress>a){mark(1,"connect");delegate.dnsEnd(c,h,a);}
    @Override public void connectStart(Call c,InetSocketAddress a,Proxy p){mark(2,"connect");delegate.connectStart(c,a,p);}
    @Override public void secureConnectStart(Call c){mark(4,"tls");delegate.secureConnectStart(c);}
    @Override public void secureConnectEnd(Call c,Handshake h){mark(5,"connect");delegate.secureConnectEnd(c,h);}
    @Override public void connectEnd(Call c,InetSocketAddress a,Proxy p,Protocol v){mark(3,"request_headers");delegate.connectEnd(c,a,p,v);}
    @Override public void connectFailed(Call c,InetSocketAddress a,Proxy p,Protocol v,IOException e){delegate.connectFailed(c,a,p,v,e);}
    @Override public synchronized void connectionAcquired(Call c,Connection x){reused=marks[2]<0;phase="request_headers";delegate.connectionAcquired(c,x);}
    @Override public void connectionReleased(Call c,Connection x){delegate.connectionReleased(c,x);}
    @Override public void requestHeadersStart(Call c){delegate.requestHeadersStart(c);}
    @Override public void requestHeadersEnd(Call c,Request r){mark(6,"response_headers");delegate.requestHeadersEnd(c,r);}
    @Override public void requestBodyStart(Call c){delegate.requestBodyStart(c);}
    @Override public void requestBodyEnd(Call c,long n){delegate.requestBodyEnd(c,n);}
    @Override public void requestFailed(Call c,IOException e){delegate.requestFailed(c,e);}
    @Override public void responseHeadersStart(Call c){delegate.responseHeadersStart(c);}
    @Override public void responseHeadersEnd(Call c,Response r){mark(7,"response_body");delegate.responseHeadersEnd(c,r);}
    @Override public void responseBodyStart(Call c){mark(8,"response_body");delegate.responseBodyStart(c);}
    @Override public synchronized void responseBodyEnd(Call c,long n){bytes=n;mark(9,"complete");delegate.responseBodyEnd(c,n);}
    @Override public void responseFailed(Call c,IOException e){delegate.responseFailed(c,e);}
    @Override public void callEnd(Call c){delegate.callEnd(c);}
    @Override public void callFailed(Call c,IOException e){delegate.callFailed(c,e);}
}
