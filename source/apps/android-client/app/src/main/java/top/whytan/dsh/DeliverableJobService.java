package top.whytan.dsh;

import android.app.job.*;
import android.content.*;
import android.os.*;
import android.webkit.CookieManager;
import org.json.*;
import java.io.IOException;
import java.util.*;
import java.util.concurrent.*;
import okhttp3.*;

/** OS-controlled file transfers; the SyncStore is the only durable work queue. */
public final class DeliverableJobService extends JobService {
    private static final int JOB_AI=48101,JOB_ZYY=48102;
    private static final Map<String,String> rejectedCookies=new ConcurrentHashMap<>();
    private final Map<Integer,Run> runs=new HashMap<>();
    private final Handler main=new Handler(Looper.getMainLooper());
    private static int jobId(String scope){return "ai".equals(scope)?JOB_AI:JOB_ZYY;}
    private static String cookie(){try{return Objects.toString(CookieManager.getInstance().getCookie(DshConfig.ORIGIN),"");}catch(RuntimeException e){return "";}}
    static synchronized void schedule(Context context,String scope){
        if(!SyncForegroundService.syncEnabled(context,scope)||DeliverableCache.digest(cookie()).equals(rejectedCookies.get(scope)))return;
        JobScheduler scheduler=context.getSystemService(JobScheduler.class);if(scheduler==null||scheduler.getPendingJob(jobId(scope))!=null)return;
        rejectedCookies.remove(scope);
        PersistableBundle extras=new PersistableBundle();extras.putString("scope",scope);
        scheduler.schedule(new JobInfo.Builder(jobId(scope),new ComponentName(context,DeliverableJobService.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPersisted(true).setExtras(extras).build());
    }
    static void cancel(Context context,String scope){JobScheduler scheduler=context.getSystemService(JobScheduler.class);if(scheduler!=null)scheduler.cancel(jobId(scope));}
    @Override public boolean onStartJob(JobParameters params){
        String scope=params.getExtras().getString("scope","");if(!SyncForegroundService.syncEnabled(this,scope))return false;
        Run run=new Run(params,scope);runs.put(params.getJobId(),run);run.thread.start();return true;
    }
    @Override public boolean onStopJob(JobParameters params){Run run=runs.remove(params.getJobId());if(run!=null)run.stop();return SyncForegroundService.syncEnabled(this,params.getExtras().getString("scope",""));}
    @Override public void onDestroy(){for(Run run:runs.values())run.stop();runs.clear();super.onDestroy();}
    private final class Run implements Runnable {
        final JobParameters params;final String scope;final Thread thread;
        final OkHttpClient http=DshNetwork.builder(DeliverableJobService.this).connectTimeout(15,TimeUnit.SECONDS).readTimeout(35,TimeUnit.SECONDS).writeTimeout(35,TimeUnit.SECONDS).callTimeout(45,TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build();
        volatile boolean stopped;boolean retry;
        Run(JobParameters p,String s){params=p;scope=s;thread=new Thread(this,"deliverable-transfer-"+s);}
        void stop(){stopped=true;http.dispatcher().cancelAll();thread.interrupt();}
        void check()throws IOException{if(stopped||!SyncForegroundService.syncEnabled(DeliverableJobService.this,scope))throw new IOException("transfer stopped");}
        JSONObject json(Request request)throws Exception{
            check();try(Response response=http.newCall(request).execute()){
                if(response.code()==401||response.code()==302||response.code()==303)throw new AuthRequired();
                if(!response.isSuccessful()||response.body()==null)throw new IOException("deliverable manifest unavailable");
                return new JSONObject(response.body().string());
            }
        }
        Request.Builder request(String url){Request.Builder b=new Request.Builder().url(url).header("Origin",DshConfig.ORIGIN);String value=cookie();if(!value.isEmpty())b.header("Cookie",value);return b;}
        @Override public void run(){
            try(SyncStore store=new SyncStore(DeliverableJobService.this)){
                for(SyncStore.Preparation job:store.duePreparations(scope,System.currentTimeMillis(),128)){
                    if(!"artifacts".equals(job.kind))continue;check();
                    try{
                        JSONObject session=json(request(DshConfig.ORIGIN+"/dsh-scope-session?workspace="+scope).build());
                        if(!scope.equals(session.optString("id"))||session.optString("token").isEmpty())throw new IOException("scope session unavailable");
                        JSONObject manifest=json(request(DshConfig.ORIGIN+"/w/"+scope+"/api/deliverables/prepare").header("X-DSH-Scope",session.getString("token"))
                            .post(RequestBody.create(new JSONObject().put("threadId",job.threadId).put("turnId",job.turnId).toString(),MediaType.parse("application/json; charset=utf-8"))).build());
                        if(!scope.equals(manifest.optString("scope"))||!job.threadId.equals(manifest.optString("threadId"))||!job.turnId.equals(manifest.optString("turnId")))throw new IOException("deliverable scope mismatch");
                        JSONArray entries=manifest.getJSONArray("entries");List<JSONObject> ordered=new ArrayList<>();boolean complete=true;
                        for(int i=0;i<entries.length();i++){JSONObject e=entries.getJSONObject(i);if("available".equals(e.optString("state")))ordered.add(e);else if(!Arrays.asList(400,403,404,413).contains(e.optInt("status")))complete=false;}
                        ordered.sort(Comparator.comparingLong(e->e.optLong("size",Long.MAX_VALUE)));
                        for(JSONObject entry:ordered){check();try{DeliverableCache.get(DeliverableJobService.this).download(scope,entry,http,cookie());}catch(Exception unavailable){complete=false;}}
                        check();if(!complete)throw new IOException("deliverables pending");
                        DeliverableCache.get(DeliverableJobService.this).markPrepared(scope,job.threadId,job.turnId,job.desired);store.finishPreparation(scope,job);
                        NativeDiagnostics.get(DeliverableJobService.this).event(scope,"android-store","committed",new JSONObject().put("reason","download_complete").put("threadId",job.threadId).put("turnId",job.turnId).put("itemCount",ordered.size()).put("localStored",true));
                    }catch(AuthRequired auth){rejectedCookies.put(scope,DeliverableCache.digest(cookie()));store.deferPreparation(scope,job,System.currentTimeMillis()+30_000L);retry=false;break;
                    }catch(Exception unavailable){store.deferPreparation(scope,job,System.currentTimeMillis()+30_000L);try{NativeDiagnostics.get(DeliverableJobService.this).event(scope,"android-store","failed",new JSONObject().put("reason","download_failed").put("threadId",job.threadId).put("turnId",job.turnId));}catch(JSONException ignored){}retry=true;if(stopped)break;}
                }
                // A newer desired version may have arrived during the file copy.
                if(!stopped&&!rejectedCookies.containsKey(scope))for(SyncStore.Preparation p:store.duePreparations(scope,Long.MAX_VALUE,128))if("artifacts".equals(p.kind)){retry=true;break;}
            }catch(Exception unavailable){retry=true;}
            finally{http.dispatcher().cancelAll();http.connectionPool().evictAll();http.dispatcher().executorService().shutdown();
                main.post(()->{if(!stopped&&runs.get(params.getJobId())==this){runs.remove(params.getJobId());jobFinished(params,retry&&SyncForegroundService.syncEnabled(DeliverableJobService.this,scope));}});}
        }
    }
    private static final class AuthRequired extends IOException {}
}
