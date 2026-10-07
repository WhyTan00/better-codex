package top.whytan.dsh;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.os.SystemClock;
import android.webkit.CookieManager;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/** Metadata-only, scoped durable outbox. Never depends on WebView/IndexedDB running. */
public final class NativeDiagnostics {
    private static volatile NativeDiagnostics instance;
    private static final long TTL = 7L * 86400000L;
    private static final Set<String> COMPONENTS = set("android-app android-sync android-network android-store android-notification android-update android-webview android-bridge diagnostic-upload");
    private static final Set<String> STAGES = set("attempt dispatch connected received committed failed closed reconnecting skipped shown started stopped background foreground downloaded verified installed cancelled pending boot");
    private static final Set<String> ERRORS = set("NullPointerException IllegalStateException IllegalArgumentException SecurityException IOException SQLiteException OutOfMemoryError RuntimeException Error unknown");
    private static final Set<String> FAILURE_CLASSES = set("dns tls timeout connection auth http parse aborted storage rpc_contract unknown");
    private static final Set<String> METHODS = set("GET thread/read thread/list thread/turns/list thread/items/list native-bootstrap status readRecords readStream readThreadRecords requestSync focusThread openDeliverable resolveDeliverable diagnosticContext getTheme setTheme saveDocument getNotificationSettings setDeviceOwner setCompletionNotifications startSync stopSync openSettings scopeSession presentConversation readSavedThreadRecords readSavedRecord saveReadRecord saveVisibleProcesses readVisibleProcesses invalidateVisibleProcesses");
    private static final Set<String> ROUTES = set("scope_session native_catalog native_read native_bootstrap cloud_events other");
    private static final Set<String> IDS = set("traceId parentTraceId connectionId threadId turnId generation");
    private static final Set<String> NUMBERS = set("durationMs revision count statusCode closeCode attempt itemCount turnCount pendingCount recordCursor eventCursor viewportHeight viewportOffset documentOffset composerTop composerBottom webViewOffset streamCursor catalogIntervalMs heartbeatMs");
    private static final Set<String> BOOLS = set("online nativeOnline fresh localStored wasClean transportConnected textAvailable cacheReady enabled validated metered wifi cellular vpn batteryExempt deviceIdle powerSave backgroundRestricted screenInteractive wakeHeld enhanced networkAvailable networkMonitorRegistered");
    // Fixed operation labels only. Expanded alongside the gateway contract, never arbitrary error text.
    private static final Set<String> REASONS = set("unknown empty focus_committed focus_failed focus_requested request_start request_received history_rejected uncaught_exception memory_pressure document_start foreground background activity_create activity_resume activity_pause activity_stop activity_destroy new_intent notification_open notification_ready navigation_cancelled navigation_timeout network_available network_lost network_changed network_unavailable validated_changed capabilities_changed screen_on screen_off user_present idle_changed power_save_changed device_awake service_create service_start service_stop service_destroy sticky_restart boot_restore package_replaced user_stop sync_start sync_stop socket_open socket_closed socket_error heartbeat_timeout send_failed auth_required request_failed catalog_refresh catalog_committed history_prefetch history_committed history_failed completion_received completion_posted completion_suppressed body_ready body_partial body_unavailable store_failed store_committed cache_import bridge_request bridge_reply bridge_failed main_frame page_started page_finished page_commit http_error ssl_error web_error renderer_gone check_start check_latest check_available check_failed download_start download_complete download_failed verify_ok verify_failed install_requested install_cancelled permission_required ui_embedded ui_cached ui_download ui_verified ui_failed cancelled stopped scope_changed periodic user_request ack_missing ack_partial ui_apply diagnostic_flush stream_received stream_committed stream_gap content_prepared content_painted input_empty layout_repaired sync_policy");
    private static Set<String> set(String value) { return new HashSet<>(Arrays.asList(value.split(" "))); }

    /** Highest tier is bounded separately by the outbox retention ordering. */
    static int retentionPriority(String component, String stage, JSONObject fields) {
        String reason = fields == null ? "" : fields.optString("reason", "");
        String kind = fields == null ? "" : fields.optString("kind", "");
        // A status broadcast is routine telemetry, not an application incident.
        if ("android-app".equals(component) && "received".equals(stage) && "periodic".equals(reason)) return 0;
        if ("send_flow".equals(kind) || "js_error".equals(kind) || "promise_rejection".equals(kind)
                || "history_applied".equals(kind) || "content_readiness".equals(kind)) return 2;
        if ("notification_open".equals(reason) || "history_rejected".equals(reason)
                || "notification_ready".equals(reason) || "completion_posted".equals(reason)
                || "failed".equals(stage) || "closed".equals(stage) || "pending".equals(stage)
                || reason.endsWith("_failed") || reason.endsWith("_error")) return 2;
        if ("android-network".equals(component) || "android-app".equals(component) || "android-update".equals(component) || "android-webview".equals(component)
                || "diagnostic-upload".equals(component) || reason.startsWith("socket_")
                || reason.startsWith("service_") || reason.startsWith("activity_")) return 2;
        if ("android-notification".equals(component) && !"periodic".equals(reason)
                || "history_applied".equals(reason)) return 1;
        return 0;
    }
    private static final int MAX_QUEUED = 128;
    private static final int RESERVED_PRIORITY_SLOTS = 16;
    private static final int NORMAL_QUEUED_LIMIT = MAX_QUEUED - RESERVED_PRIORITY_SLOTS;
    private final Context context;
    private final Db db;
    private final ScheduledExecutorService writer = Executors.newSingleThreadScheduledExecutor();
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final AtomicInteger queued = new AtomicInteger();
    private final AtomicInteger queuedNormal = new AtomicInteger();
    private final Object admissionLock = new Object();
    private final AtomicLong sequence = new AtomicLong();
    private final AtomicLong rejected = new AtomicLong();
    private final AtomicLong volatilePersistFailures = new AtomicLong();
    private final Set<String> queuedFlush = java.util.concurrent.ConcurrentHashMap.newKeySet();
    private final Set<String> uploading = new HashSet<>(); // writer confined
    private final java.util.Map<String,String> uploadOutcomes = new java.util.HashMap<>(); // network confined
    private final String processId = UUID.randomUUID().toString();
    private volatile String lastScope;
    private JSONObject webContract;

    /** Same explicit schema as the Web logger; no text, URLs or arbitrary errors. */
    synchronized JSONObject cleanWebEvent(JSONObject input) throws Exception {
        if(webContract==null)try(java.io.InputStream stream=context.getAssets().open("client-diagnostics-contract.json")) {
            java.io.ByteArrayOutputStream bytes=new java.io.ByteArrayOutputStream();byte[] buffer=new byte[4096];int count;while((count=stream.read(buffer))!=-1)bytes.write(buffer,0,count);
            webContract=new JSONObject(new String(bytes.toByteArray(),StandardCharsets.UTF_8));
        }
        JSONObject out=new JSONObject().put("phase","client_diagnostic"),enums=webContract.getJSONObject("enums");
        java.util.Iterator<String> keys=enums.keys();
        while(keys.hasNext()){String key=keys.next();JSONArray allowed=enums.getJSONArray(key);Object value=input.opt(key);for(int i=0;i<allowed.length();i++)if(allowed.get(i).equals(value)){out.put(key,value);break;}}
        for(String group:new String[]{"uuid","hex","page","numeric","boolean"}) {
            JSONArray fields=webContract.getJSONArray(group);
            for(int i=0;i<fields.length();i++){String key=fields.getString(i);Object value=input.opt(key);boolean valid=false;
                if("uuid".equals(group))valid=value instanceof String&&isUuid((String)value);
                else if("hex".equals(group))valid=value instanceof String&&((String)value).matches("[a-f0-9]{16}");
                else if("page".equals(group))valid=value instanceof String&&((String)value).matches("[a-f0-9-]{8,12}");
                else if("boolean".equals(group))valid=value instanceof Boolean;
                else if(value instanceof Number){double n=((Number)value).doubleValue();valid=Double.isFinite(n)&&n>=0&&n<=9007199254740991d&&n==Math.rint(n);}
                if(valid)out.put(key,value);
            }
        }
        for(String key:new String[]{"rpcCode","reactErrorCode"}){Object value=input.opt(key);if(value instanceof Number){double n=((Number)value).doubleValue();if(n==Math.rint(n)&&n>=("rpcCode".equals(key)?-32768:0)&&n<=("rpcCode".equals(key)?99999:9999))out.put(key,value);}}
        JSONArray frames=input.optJSONArray("errorFrames");if(frames!=null){JSONArray safe=new JSONArray();for(int i=0;i<frames.length()&&safe.length()<8;i++){Object value=frames.opt(i);if(value instanceof String&&((String)value).matches(webContract.getString("framePattern")))safe.put(value);}out.put("errorFrames",safe);}
        if(!isUuid(out.optString("eventId"))||!out.has("kind")||out.optLong("clientAt")<System.currentTimeMillis()-TTL||out.optLong("clientAt")>System.currentTimeMillis()+300000)throw new IllegalArgumentException("invalid event identity");
        return out;
    }

    /** Durable device receipt only. The existing network outbox owns server delivery. */
    public void acceptWebEvents(String scope,JSONArray events,java.util.function.Consumer<JSONArray> result) {
        if(!DshConfig.isScope(scope)||events==null||events.length()>30||events.toString().getBytes(StandardCharsets.UTF_8).length>32768||!admit(2)){result.accept(null);return;}
        writer.execute(()->{
            JSONArray accepted=new JSONArray();SQLiteDatabase sql=null;boolean committed=false;
            try{
                java.util.List<JSONObject> rows=new java.util.ArrayList<>();for(int i=0;i<events.length();i++)rows.add(cleanWebEvent(events.getJSONObject(i)));
                sql=db.getWritableDatabase();sql.beginTransaction();
                for(JSONObject event:rows){String id=event.getString("eventId");ContentValues row=new ContentValues();row.put("id",id);row.put("scope",scope);row.put("at",event.getLong("clientAt"));row.put("payload",event.toString());row.put("priority",retentionPriority(event.optString("component"),event.optString("stage"),event));sql.insertWithOnConflict("outbox",null,row,SQLiteDatabase.CONFLICT_IGNORE);accepted.put(id);}
                int overflow=sql.delete("outbox","scope=? AND id NOT IN (SELECT id FROM outbox WHERE scope=? ORDER BY priority DESC,at DESC,rowid DESC LIMIT 2000)",new String[]{scope,scope});if(overflow>0)db.addMetric(scope,"journalDropped",overflow);
                // A retained receipt cannot acknowledge a row evicted in this batch.
                for(int i=0;i<accepted.length();i++)try(Cursor found=sql.rawQuery("SELECT 1 FROM outbox WHERE scope=? AND id=?",new String[]{scope,accepted.getString(i)})){if(!found.moveToFirst())throw new IllegalStateException("diagnostic retention full");}
                sql.setTransactionSuccessful();committed=true;
            }catch(Exception failure){volatilePersistFailures.incrementAndGet();}
            finally{try{if(sql!=null&&sql.inTransaction())sql.endTransaction();}catch(Exception failure){committed=false;}release(2);}
            result.accept(committed?accepted:null);if(committed)flushOnWriter(scope);
        });
    }
    private final OkHttpClient http;

    public static NativeDiagnostics get(Context context) {
        if (instance == null) synchronized (NativeDiagnostics.class) {
            if (instance == null) instance = new NativeDiagnostics(context.getApplicationContext());
        }
        return instance;
    }
    private NativeDiagnostics(Context context) {
        this.context = context; this.db = new Db(context);
this.http = DshNetwork.builder(context).connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS).writeTimeout(10, TimeUnit.SECONDS).callTimeout(15, TimeUnit.SECONDS)
            .followRedirects(false).followSslRedirects(false).build();
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread,error) -> {
            try { crashMarker(lastScope,error); } catch (Throwable ignored) {}
            if (previous != null) previous.uncaughtException(thread,error);
        });
        writer.execute(() -> { reclassifyOutbox(); restoreCrash("ai"); restoreCrash("zyy"); });
        writer.scheduleWithFixedDelay(() -> {
            // Upload each scope to its own authenticated endpoint; never merge identities.
            flushOnWriter("ai"); flushOnWriter("zyy");
        }, 5, 30, TimeUnit.SECONDS);
    }
    private synchronized String deviceId(String scope) {
        android.content.SharedPreferences prefs = context.getSharedPreferences("native-diagnostics", Context.MODE_PRIVATE);
        String key = "device:" + scope, id = prefs.getString(key, "");
        if (!isUuid(id)) { id = UUID.randomUUID().toString(); prefs.edit().putString(key, id).commit(); }
        return id;
    }
    public synchronized JSONObject identity(String scope) {
        JSONObject value = new JSONObject();
        if (!DshConfig.isScope(scope)) return value;
        try { value.put("deviceId", deviceId(scope)); value.put("processIdTag", processId); value.put("apkVersion", BuildConfig.VERSION_CODE); } catch (Exception ignored) {}
        return value;
    }
    static boolean isUuid(String value) { return value != null && value.matches("(?i)[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"); }
    static JSONObject safeFields(JSONObject fields) {
        JSONObject out = new JSONObject(); if (fields == null) return out;
        try {
            for (String key : IDS) { String value = fields.optString(key, ""); if (isUuid(value)) out.put(key, value); }
            for (String key : NUMBERS) { Object value = fields.opt(key); if (value instanceof Number) { double n = ((Number)value).doubleValue(); if (Double.isFinite(n) && n >= 0 && n <= 9007199254740991d && n == Math.rint(n)) out.put(key, value); } }
            for (String key : BOOLS) if (fields.opt(key) instanceof Boolean) out.put(key, fields.opt(key));
            String mode = fields.optString("syncMode", ""); if (Arrays.asList("foreground", "active", "settling", "checking", "idle", "offline").contains(mode)) out.put("syncMode", mode);
            String error = fields.optString("errorName", ""); if (!error.isEmpty()) out.put("errorName", ERRORS.contains(error) ? error : "unknown");
            String method=fields.optString("method", "");if(METHODS.contains(method))out.put("method",method);
            String route=fields.optString("routeClass", "");if(ROUTES.contains(route))out.put("routeClass",route);
            String failure=fields.optString("failureClass", "");if(FAILURE_CLASSES.contains(failure))out.put("failureClass",failure);
            String reason = fields.optString("reason", ""); if (!reason.isEmpty()) out.put("reason", REASONS.contains(reason) ? reason : "unknown");
            for (String key : new String[]{"uiVersion", "previousUiVersion", "contentHash"}) { String ui = fields.optString(key, ""); if (ui.matches("[a-f0-9]{16}")) out.put(key, ui); }
            for (String key : new String[]{"pageId", "previousPageId"}) { String page = fields.optString(key, ""); if (page.matches("[a-f0-9-]{8,12}")) out.put(key, page); }
        } catch (Exception ignored) {}
        return out;
    }
    private boolean admit(int priority) {
        synchronized (admissionLock) {
            if (queued.get() >= MAX_QUEUED
                    || (priority == 0 && queuedNormal.get() >= NORMAL_QUEUED_LIMIT)) {
                rejected.incrementAndGet();
                return false;
            }
            queued.incrementAndGet();
            if (priority == 0) queuedNormal.incrementAndGet();
            return true;
        }
    }
    private void release(int priority) {
        synchronized (admissionLock) {
            queued.decrementAndGet();
            if (priority == 0) queuedNormal.decrementAndGet();
        }
    }
    public void event(String scope, String component, String stage, JSONObject fields) {
        if (!DshConfig.isScope(scope) || !COMPONENTS.contains(component) || !STAGES.contains(stage)) return;
        lastScope=scope;
        final JSONObject event = safeFields(fields);
        final int priority = retentionPriority(component, stage, event);
        if (!admit(priority)) return;
        try {
            event.put("phase", "client_diagnostic"); event.put("kind", "android_diagnostic");
            event.put("eventId", UUID.randomUUID().toString()); event.put("component", component); event.put("stage", stage);
            event.put("clientAt", System.currentTimeMillis()); event.put("monoMs", SystemClock.elapsedRealtime());
            event.put("seq", sequence.incrementAndGet()); event.put("processIdTag", processId); event.put("apkVersion", BuildConfig.VERSION_CODE);
        } catch (Exception ignored) { release(priority); return; }
        writer.execute(() -> {
            try {
                SQLiteDatabase sql = db.getWritableDatabase();
                event.put("deviceId", deviceId(scope)); event.put("nativeDropped", rejected.get());
                event.put("storageFailures", db.metric(scope, "persistFailures") + volatilePersistFailures.get()); event.put("uploadFailures", db.metric(scope, "uploadFailures"));
                event.put("journalDropped", db.metric(scope, "journalDropped"));
                ContentValues row = new ContentValues(); row.put("id", event.getString("eventId")); row.put("scope", scope);
                row.put("at", event.getLong("clientAt")); row.put("payload", event.toString()); row.put("priority", retentionPriority(component, stage, event));
                sql.beginTransaction();
                try {
                    sql.insertOrThrow("outbox", null, row);
                    int expired = sql.delete("outbox", "scope=? AND at<?", new String[]{scope, Long.toString(System.currentTimeMillis()-TTL)});
                    int overflow = sql.delete("outbox", "scope=? AND id NOT IN (SELECT id FROM outbox WHERE scope=? ORDER BY priority DESC,at DESC,rowid DESC LIMIT 2000)", new String[]{scope, scope});
                    if (expired + overflow > 0) db.addMetric(scope, "journalDropped", expired + overflow);
                    sql.setTransactionSuccessful();
                } finally { sql.endTransaction(); }
            } catch (Exception ignored) { try { db.addMetric(scope, "persistFailures", 1); } catch (Exception unavailable) { volatilePersistFailures.incrementAndGet(); } }
            finally { release(priority); }
        });
    }
    public void flush(String scope) { if (DshConfig.isScope(scope) && queuedFlush.add(scope)) writer.execute(() -> {queuedFlush.remove(scope);flushOnWriter(scope);}); }
    private void flushOnWriter(String scope) {
        if (uploading.contains(scope)) return;
        try {
            int expired=db.getWritableDatabase().delete("outbox","scope=? AND at<?",new String[]{scope,Long.toString(System.currentTimeMillis()-TTL)});if(expired>0)db.addMetric(scope,"journalDropped",expired);
            JSONArray events = new JSONArray(); Set<String> ids = new HashSet<>();
            try (Cursor rows = db.getReadableDatabase().rawQuery("SELECT id,payload FROM outbox WHERE scope=? ORDER BY priority DESC,at,rowid LIMIT 20", new String[]{scope})) {
                while (rows.moveToNext()) { events.put(new JSONObject(rows.getString(1))); ids.add(rows.getString(0)); }
            }
            if (events.length() == 0) return;
            String url = DshConfig.ORIGIN + "/sync/v1/w/" + scope + "/performance";
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie == null || cookie.isEmpty()) return;
            JSONObject body = new JSONObject(); body.put("events", events);
            uploading.add(scope);
            network.execute(() -> upload(scope, url, cookie, body.toString(), ids));
        } catch (Exception ignored) { try { db.addMetric(scope, "persistFailures", 1); } catch (Exception unavailable) { volatilePersistFailures.incrementAndGet(); } }
    }
    private void upload(String scope, String url, String cookie, String body, Set<String> sent) {
        Set<String> acked = new HashSet<>(); boolean success = false;
        int statusCode = 0; String failureClass = "connection", outcome = "request_failed";
        String traceId = UUID.randomUUID().toString(); long started = SystemClock.elapsedRealtime();
        try {
            Request request = new Request.Builder().url(url).header("Origin", DshConfig.ORIGIN).header("Cookie", cookie)
                    .header("X-DSH-Diagnostic-Trace", traceId)
                    .post(RequestBody.create(body, MediaType.parse("application/json; charset=utf-8"))).build();
            try (Response response = http.newCall(request).execute()) {
                statusCode = response.code(); failureClass = statusCode == 401 || statusCode == 403 || statusCode == 303 ? "auth" : "http";
                if (response.isSuccessful() && response.body() != null) {
                    failureClass = "parse"; outcome = "ack_missing";
                    // Bounded ACK metadata only. Old servers lacking explicit IDs cannot erase the outbox.
                    String raw = response.peekBody(32768).string(); JSONObject result = new JSONObject(raw);
                    failureClass = "rpc_contract";
                    JSONArray ids = result.optJSONArray("acknowledgedEventIds");
                    if (result.optBoolean("received") && ids != null) {
                        for (int i=0;i<ids.length();i++) if (sent.contains(ids.optString(i))) acked.add(ids.optString(i));
                        success = acked.size() == sent.size();
                        outcome = success ? "diagnostic_flush" : "ack_partial";
                    }
                }
            }
        } catch (Exception error) {
            if (error instanceof java.net.SocketTimeoutException) failureClass = "timeout";
            else if (error instanceof java.net.UnknownHostException) failureClass = "dns";
            else if (error instanceof javax.net.ssl.SSLException) failureClass = "tls";
            else if (error instanceof org.json.JSONException) failureClass = "parse";
        }
        String signature = outcome + ":" + statusCode + ":" + (success ? "ok" : failureClass);
        if (!signature.equals(uploadOutcomes.put(scope, signature))) {
            JSONObject fields = new JSONObject();
            try { fields.put("traceId", traceId); fields.put("reason", outcome); fields.put("statusCode", statusCode); fields.put("itemCount", sent.size()); fields.put("count", acked.size()); fields.put("durationMs", SystemClock.elapsedRealtime()-started); if (!success) fields.put("failureClass", failureClass); } catch (Exception ignored) {}
            event(scope, "diagnostic-upload", success ? "received" : "failed", fields);
        }
        final boolean ok = success;
        writer.execute(() -> {
            boolean committed=false;
            try {
                SQLiteDatabase sql = db.getWritableDatabase(); sql.beginTransaction();
                try { for (String id : acked) sql.delete("outbox", "scope=? AND id=?", new String[]{scope,id}); if (!ok) db.addMetric(scope,"uploadFailures",1); sql.setTransactionSuccessful(); }
                finally { sql.endTransaction(); }
                committed=true;
            } catch (Exception ignored) { try { db.addMetric(scope,"persistFailures",1); } catch (Exception unavailable) { volatilePersistFailures.incrementAndGet(); } }
            finally { uploading.remove(scope); }
            // Drain only after a full accepted batch; failures wait for the normal next opportunity.
            if (ok && committed) writer.schedule(() -> flushOnWriter(scope), 300, TimeUnit.MILLISECONDS);
        });
    }
    private void reclassifyOutbox() {
        // Upgrade retained metadata in place; old periodic notifications must not
        // continue occupying every protected slot after installing this version.
        try {
            SQLiteDatabase sql = db.getWritableDatabase(); sql.beginTransaction();
            try (Cursor rows = sql.rawQuery("SELECT id,payload FROM outbox", null)) {
                while (rows.moveToNext()) {
                    JSONObject event = new JSONObject(rows.getString(1)); ContentValues values = new ContentValues();
                    values.put("priority", retentionPriority(event.optString("component"), event.optString("stage"), event));
                    sql.update("outbox", values, "id=?", new String[]{rows.getString(0)});
                }
                sql.setTransactionSuccessful();
            } finally { sql.endTransaction(); }
        } catch (Exception ignored) { volatilePersistFailures.incrementAndGet(); }
    }
    private AtomicFile marker(String scope) { return new AtomicFile(new File(context.getFilesDir(),"native-crash-"+scope+".json")); }
    private void crashMarker(String scope,Throwable error) throws Exception {
        if (!DshConfig.isScope(scope)) return;
        JSONObject value=new JSONObject(); String name=error==null?"unknown":error.getClass().getSimpleName();
        value.put("eventId",UUID.randomUUID().toString()); value.put("clientAt",System.currentTimeMillis());
        value.put("processIdTag",processId); value.put("apkVersion",BuildConfig.VERSION_CODE); value.put("errorName",ERRORS.contains(name)?name:"unknown");
        AtomicFile file=marker(scope); FileOutputStream stream=null;
        try { stream=file.startWrite();stream.write(value.toString().getBytes(StandardCharsets.UTF_8));file.finishWrite(stream); }
        catch(Exception failure){if(stream!=null)file.failWrite(stream);throw failure;}
    }
    private void restoreCrash(String scope) {
        AtomicFile file=marker(scope);
        try {
            if(!file.getBaseFile().exists())return;
            // AtomicFile backup recovery preserves a marker interrupted during the next write.
            byte[] bytes=file.readFully();if(bytes.length>4096)return;JSONObject raw=new JSONObject(new String(bytes,StandardCharsets.UTF_8));
            String id=raw.optString("eventId","");if(!isUuid(id))return;
            JSONObject event=safeFields(raw);event.put("phase","client_diagnostic");event.put("kind","android_diagnostic");
            event.put("component","android-app");event.put("stage","failed");event.put("reason","uncaught_exception");
            event.put("eventId",id);event.put("clientAt",raw.getLong("clientAt"));event.put("deviceId",deviceId(scope));
            if(isUuid(raw.optString("processIdTag")))event.put("processIdTag",raw.getString("processIdTag"));event.put("apkVersion",raw.optInt("apkVersion",BuildConfig.VERSION_CODE));
            ContentValues row=new ContentValues();row.put("id",id);row.put("scope",scope);row.put("at",event.getLong("clientAt"));row.put("payload",event.toString());row.put("priority",1);
            long inserted=db.getWritableDatabase().insertWithOnConflict("outbox",null,row,SQLiteDatabase.CONFLICT_IGNORE);
            if(inserted!=-1)file.delete();
            else try(Cursor cursor=db.getReadableDatabase().rawQuery("SELECT id FROM outbox WHERE scope=? AND id=?",new String[]{scope,id})){if(cursor.moveToFirst())file.delete();}
        } catch(Exception ignored) { /* Preserve the marker until a later startup can commit it. */ }
    }
    private static final class Db extends SQLiteOpenHelper {
        Db(Context context) { super(context, "native-diagnostics-v1.db", null, 1); }
        @Override public void onCreate(SQLiteDatabase db) {
            db.execSQL("CREATE TABLE outbox(id TEXT PRIMARY KEY,scope TEXT NOT NULL,at INTEGER NOT NULL,payload TEXT NOT NULL,priority INTEGER NOT NULL DEFAULT 0)");
            db.execSQL("CREATE INDEX diagnostic_scope_at ON outbox(scope,at)");
            db.execSQL("CREATE TABLE metrics(scope TEXT NOT NULL,name TEXT NOT NULL,value INTEGER NOT NULL,PRIMARY KEY(scope,name))");
        }
        @Override public void onUpgrade(SQLiteDatabase db,int oldVersion,int newVersion) { throw new IllegalStateException("Unsupported diagnostic schema"); }
        long metric(String scope,String name) { try(Cursor rows=getReadableDatabase().rawQuery("SELECT value FROM metrics WHERE scope=? AND name=?",new String[]{scope,name})) { return rows.moveToFirst()?rows.getLong(0):0; } }
        void addMetric(String scope,String name,long amount) { getWritableDatabase().execSQL("INSERT OR REPLACE INTO metrics(scope,name,value) VALUES(?,?,?)",new Object[]{scope,name,metric(scope,name)+amount}); }
    }
}
