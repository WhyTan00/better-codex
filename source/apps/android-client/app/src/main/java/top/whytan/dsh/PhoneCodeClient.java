package top.whytan.dsh;

import android.content.Context;
import android.os.Build;
import android.os.SystemClock;
import android.webkit.CookieManager;
import org.json.JSONObject;
import java.io.Closeable;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/** Separate from conversation sync: no inbox reads without a short-lived paired Mac request. */
public final class PhoneCodeClient implements Closeable {
    private static final MediaType JSON=MediaType.get("application/json; charset=utf-8");
    private final Context context;
    private final OkHttpClient http;
    private final String origin;
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private volatile Call active;
    private volatile boolean closed;
    private String scopeToken="";
    private JSONObject pairing;
    public PhoneCodeClient(Context context){this(context,DshNetwork.builder(context),DshConfig.ORIGIN);}
    PhoneCodeClient(Context context,OkHttpClient.Builder builder,String origin){
        this.context=context.getApplicationContext();this.origin=origin;
        http=builder.connectTimeout(10,TimeUnit.SECONDS).readTimeout(30,TimeUnit.SECONDS).callTimeout(35,TimeUnit.SECONDS)
                .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build();
    }
    private static final class AccessFailure extends IOException {final int status;AccessFailure(int status){super("Phone code access failed");this.status=status;}}
    private JSONObject call(String endpoint,JSONObject body,boolean scoped) throws Exception {
        if(closed)throw new IOException("Phone code client stopped");
        Request.Builder request=new Request.Builder().url(origin+endpoint).header("Accept","application/json").header("Origin",origin);
        String cookie=CookieManager.getInstance().getCookie(origin);if(cookie!=null&&!cookie.isEmpty())request.header("Cookie",cookie);
        if(scoped)request.header("X-Dsh-Scope",scopeToken);
        if(pairing!=null)request.header("X-Phone-Code-Device",pairing.getString("token"));
        if(body!=null)request.post(RequestBody.create(body.toString(),JSON));
        Call pending=http.newCall(request.build());active=pending;
        try(Response response=pending.execute()){
            if(response.code()!=200)throw new AccessFailure(response.code());
            if(response.body()==null||response.body().contentLength()>16384)throw new IOException("Invalid phone code response");
            response.body().source().request(16385);byte[] bytes=response.body().source().buffer().readByteArray();
            if(bytes.length>16384)throw new IOException("Invalid phone code response");return new JSONObject(new String(bytes,java.nio.charset.StandardCharsets.UTF_8));
        }finally{if(active==pending)active=null;}
    }
    private void authorize() throws Exception {JSONObject value=call("/dsh-scope-session?workspace=ai",null,false);if(!"ai".equals(value.optString("id"))||value.optString("token").isEmpty()||value.optString("token").length()>8192)throw new IOException("Invalid workspace identity");scopeToken=value.getString("token");}
    private JSONObject post(String operation,JSONObject value) throws Exception {
        if(scopeToken.isEmpty())authorize();
        try{return call("/w/ai/api/phone-code/"+operation,value,true);}
        catch(AccessFailure failure){if(failure.status!=401)throw failure;scopeToken="";authorize();return call("/w/ai/api/phone-code/"+operation,value,true);}
    }
    public static void pair(Context context,String code) throws Exception {
        try(PhoneCodeClient client=new PhoneCodeClient(context)){client.pair(code);}
    }
    public static void bind(Context context) throws Exception {
        try(PhoneCodeClient client=new PhoneCodeClient(context)){client.bind();}
    }
    void bind() throws Exception {
        if(!"ai".equals(SyncForegroundService.deviceOwner(context)))throw new IllegalStateException("Choose AI owner first");
        pairing=PhoneCodeSettings.load(context);
        String name=(Build.MANUFACTURER+" "+Build.MODEL).trim();if(name.length()>60)name=name.substring(0,60);
        JSONObject bound=post("bind",new JSONObject().put("name",name).put("installationSecret",PhoneCodeSettings.installationSecret(context)));
        if(!"ai".equals(SyncForegroundService.deviceOwner(context))||closed)throw new IllegalStateException("Device owner changed");
        PhoneCodeSettings.save(context,bound);
    }
    void pair(String code) throws Exception {
        if(!"ai".equals(SyncForegroundService.deviceOwner(context)))throw new IllegalStateException("Choose AI owner first");
        if(!code.matches("[0-9]{8}"))throw new IllegalArgumentException("Use the eight digit pairing code");
        String name=(Build.MANUFACTURER+" "+Build.MODEL).trim();if(name.length()>60)name=name.substring(0,60);
        JSONObject paired=post("pair",new JSONObject().put("code",code).put("name",name));
        if(!"ai".equals(SyncForegroundService.deviceOwner(context)))throw new IllegalStateException("Device owner changed");
        PhoneCodeSettings.save(context,paired);
    }
    public void start(){worker.execute(this::run);}
    private boolean enabled(){return !closed&&PhoneCodeSettings.enabled(context);}
    private void run(){
        int failures=0;
        try{pairing=PhoneCodeSettings.load(context);if(pairing==null)throw new IOException("Pair first");}
        catch(Exception unavailable){PhoneCodeSettings.state(context,"pairing_required");return;}
        while(enabled()){
            try{
                JSONObject response=post("poll",new JSONObject());failures=0;
                JSONObject request=response.optJSONObject("request");
                if(request==null){PhoneCodeSettings.state(context,"connected");continue;}
                serve(request,response.getLong("serverTime"));
            }catch(InterruptedException stopped){Thread.currentThread().interrupt();return;}
            catch(Exception failure){
                if(!enabled())return;
                PhoneCodeSettings.state(context,failure instanceof AccessFailure&&((AccessFailure)failure).status==401?"pairing_required":failure instanceof AccessFailure&&(((AccessFailure)failure).status==302||((AccessFailure)failure).status==303)?"auth_required":"reconnecting");
                try{Thread.sleep(Math.min(60000,5000L<<Math.min(failures++,4)));}catch(InterruptedException stopped){Thread.currentThread().interrupt();return;}
            }
        }
    }
    private void serve(JSONObject request,long serverTime) throws Exception {
        long remaining=request.getLong("expiresAt")-serverTime;
        if(remaining<=0||remaining>120000||!request.getString("id").matches("[a-f0-9-]{36}")||request.getLong("after")<serverTime-300000||request.getLong("after")>serverTime+5000||request.getString("service").length()>80)return;
        long start=SystemClock.elapsedRealtime(),deadline=start+remaining-2000;
        JSONObject result=null;PhoneCodeSettings.state(context,"reading");
        while(enabled()){
            if(!post("state",new JSONObject().put("id",request.getString("id"))).optBoolean("active"))return;
            long elapsed=SystemClock.elapsedRealtime()-start;
            result=PhoneCodeReader.read(context,request,serverTime+elapsed);
            if(!"no_match".equals(result.optString("status"))||SystemClock.elapsedRealtime()>=deadline)break;
            Thread.sleep(Math.min(1500,Math.max(1,deadline-SystemClock.elapsedRealtime())));
        }
        if(!enabled()||result==null)return;
        JSONObject sealed=PhoneCodeCrypto.seal(pairing.getString("encryptionKey"),result);
        // Re-check the explicit switch immediately before the only upload of a result.
        if(!enabled())return;
        post("respond",sealed);PhoneCodeSettings.state(context,result.getString("status"));
    }
    @Override public void close(){closed=true;Call call=active;if(call!=null)call.cancel();worker.shutdownNow();http.dispatcher().cancelAll();http.connectionPool().evictAll();http.dispatcher().executorService().shutdown();}
}
