package top.whytan.dsh;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;
import androidx.webkit.WebViewFeature;
import java.net.*;
import java.util.*;
import java.util.concurrent.Executor;
import okhttp3.*;

/** Common origin/address policy; consumers retain independent dispatchers and queues. */
final class DshNetwork {
    private static volatile DshNetwork instance;
    final OriginDns dns;
    private OriginTunnel tunnel;
    private final Set<String> authorities;
    private boolean applying, applied;
    private final List<Runnable> ready=new ArrayList<>();
    static DshNetwork get(Context context) {
        if(instance==null)synchronized(DshNetwork.class){if(instance==null)instance=new DshNetwork(context.getApplicationContext());}
        return instance;
    }
    DshNetwork(OriginDns dns,Set<String> authorities){this.dns=dns;this.authorities=new HashSet<>(authorities);}
    private DshNetwork(Context context) {
        authorities=new HashSet<>(Arrays.asList(DshConfig.HOST+":443",DshConfig.SSO_HOST+":443"));
        SharedPreferences prefs=context.getSharedPreferences("verified-origin-addresses",Context.MODE_PRIVATE);
        OriginDns.Store store=new OriginDns.Store(){public String read(String host){return prefs.getString(host,"");}public void write(String host,String value){prefs.edit().putString(host,value).apply();}};
        try {
            dns=new OriginDns(new HashSet<>(Arrays.asList(DshConfig.HOST,DshConfig.SSO_HOST)),
                    Collections.singletonList(OriginDns.ipv4("47.250.133.129")),1793318400000L,
                    Dns.SYSTEM,store,System::currentTimeMillis,1500);
        }catch(UnknownHostException invalid){throw new IllegalStateException(invalid);}
    }
    static OkHttpClient.Builder builder(Context context) {
        OriginDns policy=get(context).dns;
        return new OkHttpClient.Builder().dns(policy).eventListener(new okhttp3.EventListener(){
            @Override public void connectionAcquired(Call call,Connection connection) {
                if(connection.handshake()!=null)policy.verified(connection.route().address().url().host(),connection.route().socketAddress().getAddress());
            }
        });
    }
    static void networkChanged(Context context) {
        DshNetwork shared=get(context);shared.dns.networkChanged();
        synchronized(shared){if(shared.tunnel!=null)shared.tunnel.networkChanged();}
    }
    // All callers run on the UI thread. Wait for the official WebView callback
    // before loading remote resources; local shell verification stays independent.
    void prepareWebView(Executor ui,Runnable callback) {
        if(applied){callback.run();return;}ready.add(callback);if(applying)return;
        applying=true;
        if(!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)
                ||!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE_REVERSE_BYPASS)) {finish(false);return;}
        try {
            if(tunnel==null)tunnel=new OriginTunnel(dns,authorities);
            ProxyConfig.Builder rules=new ProxyConfig.Builder().addProxyRule("http://127.0.0.1:"+tunnel.port());
            for(String authority:authorities)rules.addBypassRule(authority);
            ProxyConfig config=rules.setReverseBypassEnabled(true).build();
            ProxyController.getInstance().setProxyOverride(config,ui,()->finish(true));
        } catch(Exception unavailable){if(tunnel!=null){tunnel.close();tunnel=null;}finish(false);}
    }
    // Explicit recovery of a missing optional Chromium proxy callback. Both
    // generations apply the same rules; late callbacks cannot load a page twice.
    void retryWebViewPreparation(Executor ui,Runnable callback){
        if(!applied)applying=false;
        prepareWebView(ui,callback);
    }
    boolean webViewReady(){return applied;}
    void invalidate(){dns.networkChanged();synchronized(this){if(tunnel!=null)tunnel.networkChanged();}}
    private void finish(boolean ok){applied=ok;applying=false;List<Runnable> callbacks=new ArrayList<>(ready);ready.clear();for(Runnable r:callbacks)r.run();}
}
