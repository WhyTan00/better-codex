package top.whytan.dsh;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.webkit.WebView;

import androidx.annotation.Nullable;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Collections;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/** Narrow sync bridge, plus explicit user-chosen local Word export. */
public final class NativeBridge implements AutoCloseable {
    private static final Pattern UUID = Pattern.compile("(?i)^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$");
    public interface DocumentResult { void complete(boolean saved, boolean cancelled); }
    public interface DocumentExporter { void save(String scope, String name, byte[] bytes, DocumentResult result); }
    private final DocumentExporter documentExporter;
    private final java.util.function.BiConsumer<java.io.File,String> deliverableOpener;
    private final Context context;
    private final WebView webView;
    private final SyncStore store;
    private final UiReleaseStore uiReleaseStore;
    private final Runnable openSettings;
    private final Runnable requestNotificationPermission;
    private final NativeAppearance appearance;
    private final Runnable applyAppearance;
    private final NativeDiagnostics diagnostics;
    private final ScopeSessionClient controlSession;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Map<String, Long> bridgeStartedAt = new ConcurrentHashMap<>();
    private final Map<String, String> bridgeMethods = new ConcurrentHashMap<>();
    private volatile JavaScriptReplyProxy proxy;
    private volatile String proxyScope;
    private volatile boolean installed;

    public NativeBridge(Context context, WebView webView, SyncStore store, UiReleaseStore uiReleaseStore, Runnable openSettings, Runnable requestNotificationPermission, NativeAppearance appearance, Runnable applyAppearance, DocumentExporter documentExporter, java.util.function.BiConsumer<java.io.File,String> deliverableOpener) {
        this.context = context.getApplicationContext();
        this.webView = webView;
        this.store = store;
        this.uiReleaseStore = uiReleaseStore;
        this.openSettings = openSettings;
        this.requestNotificationPermission = requestNotificationPermission;
        this.appearance = appearance;
        this.applyAppearance = applyAppearance;
        this.documentExporter = documentExporter;
        this.deliverableOpener = deliverableOpener;
        this.diagnostics = NativeDiagnostics.get(this.context);
        this.controlSession = new ScopeSessionClient(this.context);
    }

    public boolean install() {
        if (installed) return true;
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false;
        WebViewCompat.addWebMessageListener(webView, DshConfig.BRIDGE_NAME,
                Collections.singleton("https://" + DshConfig.HOST),
                new WebViewCompat.WebMessageListener() {
                    @Override
                    public void onPostMessage(WebView view, WebMessageCompat message, Uri sourceOrigin,
                                               boolean isMainFrame, JavaScriptReplyProxy replyProxy) {
                        receive(view, message, sourceOrigin, isMainFrame, replyProxy);
                    }
                });
        installed = true;
        return true;
    }

    private void receive(WebView view, @Nullable WebMessageCompat message, @Nullable Uri sourceOrigin,
                         boolean isMainFrame, JavaScriptReplyProxy replyProxy) {
        String text = message == null ? null : message.getData();
        String requestId = "";
        String scope = "";
        try {
            if (!isMainFrame || !DshConfig.isDshUri(sourceOrigin) || text == null || text.length() > 12 * 1024 * 1024) {
                throw new BridgeException("BRIDGE_ORIGIN", "桥接来源不可用");
            }
            JSONObject request = new JSONObject(text);
            if (text.length() > 256 * 1024 && !"saveDocument".equals(request.optString("method")) && !("saveReadRecord".equals(request.optString("method"))&&text.length()<SyncStore.MAX_RECORD_BYTES+4096) && !("saveVisibleProcesses".equals(request.optString("method"))&&text.length()<SyncStore.MAX_VISIBLE_PROCESS_BYTES+4096)) throw new BridgeException("INVALID_REQUEST", "请求过大");
            int version = request.optInt("version", -1);
            String id = request.optString("id", "");
            requestId = request.optString("requestId", "");
            if (requestId.isEmpty()) requestId = id;
            if (id.isEmpty()) id = requestId;
            if (requestId.isEmpty() || requestId.length() > 160 || (!id.equals(requestId))) {
                throw new BridgeException("INVALID_REQUEST", "请求标识无效");
            }
            if (version != 1) throw new BridgeException("UNSUPPORTED_VERSION", "桥接版本不支持");
            scope = request.optString("scope", "");
            if (!DshConfig.isScope(scope)) throw new BridgeException("SCOPE_MISMATCH", "工作区不可访问");
            String pageScope = pageScope(view);
            if (!scope.equals(pageScope)) throw new BridgeException("SCOPE_MISMATCH", "工作区与页面不一致");
            this.proxy = replyProxy;
            this.proxyScope = scope;
            if("recordDiagnostics".equals(request.optString("method")))bridgeMethods.put(bridgeKey(scope,requestId),"recordDiagnostics");
            if (isUuid(requestId) && !"recordDiagnostics".equals(request.optString("method"))) {
                bridgeStartedAt.put(bridgeKey(scope, requestId), SystemClock.elapsedRealtime());
                bridgeMethods.put(bridgeKey(scope,requestId),request.optString("method", ""));
                diagnostic(scope, "received", "bridge_request", requestId, -1L);
            }
            dispatch(request, requestId, scope, replyProxy);
        } catch (BridgeException failure) {
            postError(replyProxy, requestId, scope, failure.code, failure.getMessage());
        } catch (JSONException failure) {
            postError(replyProxy, requestId, scope, "INVALID_REQUEST", "请求格式无效");
        } catch (RuntimeException failure) {
            postError(replyProxy, requestId, scope, "BRIDGE_UNAVAILABLE", "桥接暂不可用");
        }
    }

    private void dispatch(JSONObject request, String requestId, String scope, JavaScriptReplyProxy replyProxy) {
        String method = request.optString("method", "");
        if (!"scopeSession".equals(method) && !"recordDiagnostics".equals(method) && !"readSavedRecord".equals(method) && !"saveReadRecord".equals(method) && !"readSavedThreadRecords".equals(method) && !"readThreadRecords".equals(method) && !"readStream".equals(method) && !"status".equals(method) && !"requestSync".equals(method) && !"readRecords".equals(method)
                && !"openDeliverable".equals(method) && !"resolveDeliverable".equals(method) && !"getTheme".equals(method) && !"setTheme".equals(method) && !"saveDocument".equals(method)
                && !"getNotificationSettings".equals(method) && !"setDeviceOwner".equals(method) && !"setCompletionNotifications".equals(method)
                && !"startSync".equals(method) && !"stopSync".equals(method) && !"openSettings".equals(method)
                && !"diagnosticContext".equals(method) && !"focusThread".equals(method) && !"presentConversation".equals(method)
                && !"saveVisibleProcesses".equals(method) && !"readVisibleProcesses".equals(method) && !"invalidateVisibleProcesses".equals(method)) {
            postError(replyProxy, requestId, scope, "METHOD_NOT_ALLOWED", "桥接方法未开放");
            return;
        }
        if ("scopeSession".equals(method)) {
            String requestedTrace = request.optString("traceId", "");
            String traceId = isUuid(requestedTrace) ? requestedTrace : requestId;
            String cookie = android.webkit.CookieManager.getInstance().getCookie(DshConfig.ORIGIN);
            controlSession.read(scope, cookie, traceId, new ScopeSessionClient.Trace() {
                public void event(String stage,String reason,int status,long elapsed) { log(stage,reason,status,elapsed,null); }
                public void failure(String reason,int status,long elapsed,String failureClass) { log("failed",reason,status,elapsed,failureClass); }
                private void log(String stage,String reason,int status,long elapsed,String failureClass) {
                    try { JSONObject fields=new JSONObject().put("reason",reason).put("routeClass","scope_session").put("method","GET")
                            .put("traceId",traceId).put("statusCode",status).put("durationMs",elapsed);
                        if(failureClass!=null)fields.put("failureClass",failureClass);
                        diagnostics.event(scope,"android-network",stage,fields);
                    } catch(Exception ignored) { }
                }
            }, (result, failure) -> {
                if (failure != null) postError(replyProxy,requestId,scope,failure,"执行连接凭据暂不可用");
                else reply(replyProxy,requestId,scope,result);
            });
            return;
        }
        if("recordDiagnostics".equals(method)) {
            diagnostics.acceptWebEvents(scope,request.optJSONArray("events"),ids->{
                if(ids==null){postError(replyProxy,requestId,scope,"DIAGNOSTIC_STORE_FAILED","日志尚未写入");return;}
                try{reply(replyProxy,requestId,scope,new JSONObject().put("received",true).put("acknowledgedEventIds",ids));}
                catch(JSONException failure){postError(replyProxy,requestId,scope,"DIAGNOSTIC_STORE_FAILED","日志尚未写入");}
            });return;
        }
        if ("openDeliverable".equals(method)) {
            worker.execute(()->{try{DeliverableCache cache=DeliverableCache.get(context);JSONObject d=cache.resolve(scope,request.optString("path",""));
                if(!d.optBoolean("available"))throw new IllegalStateException("not cached");
                java.io.File file=cache.exportCopy(context,Uri.parse(d.getString("url")),scope,true);
                main.post(()->{if(scope.equals(pageScope(webView))){deliverableOpener.accept(file,d.optString("mime","application/octet-stream"));reply(replyProxy,requestId,scope,d);}else postError(replyProxy,requestId,scope,"SCOPE_MISMATCH","工作区已切换");});
            }catch(Exception unavailable){postError(replyProxy,requestId,scope,"FILE_UNAVAILABLE","文件尚未完整保存在本机");}});return;
        }
        if ("resolveDeliverable".equals(method)) {
            String path=request.optString("path", "");
            if(!path.startsWith("/")||path.length()>8192){postError(replyProxy,requestId,scope,"INVALID_PATH","文件路径无效");return;}
            worker.execute(()->{try{reply(replyProxy,requestId,scope,DeliverableCache.get(context).resolve(scope,path));}
                catch(Exception unavailable){postError(replyProxy,requestId,scope,"FILE_UNAVAILABLE","文件尚未保存在本机");}});
            return;
        }
        if ("presentConversation".equals(method)) {
            String thread = request.optString("threadId", "");
            boolean visible = request.optBoolean("visible") && NativeDiagnostics.isUuid(thread);
            SyncForegroundService.presentConversation(this, scope, visible ? thread : "", visible);
            String turn = request.optString("seenTurnId", "");
            if (visible && NativeDiagnostics.isUuid(turn)) SyncForegroundService.markCompletionSeen(context, scope, thread, turn);
            reply(replyProxy, requestId, scope, new JSONObject()); return;
        }
        if ("focusThread".equals(method)) {
            String threadId=request.optString("threadId", "");
            JSONObject result=new JSONObject();
            try { result.put("accepted", NativeDiagnostics.isUuid(threadId) && SyncForegroundService.focusThread(context,scope,threadId)); }
            catch (JSONException ignored) {}
            reply(replyProxy,requestId,scope,result);return;
        }
        if ("diagnosticContext".equals(method)) {
            JSONObject result = diagnostics.identity(scope);
            try {
                String version = uiReleaseStore.activeVersion();
                if (version != null && version.matches("[a-f0-9]{16}")) result.put("uiVersion", version);
            } catch (JSONException ignored) {
            }
            reply(replyProxy, requestId, scope, result);
            return;
        }
        if ("getNotificationSettings".equals(method) || "setDeviceOwner".equals(method) || "setCompletionNotifications".equals(method)) {
            try {
                if ("setDeviceOwner".equals(method)) SyncForegroundService.setDeviceOwner(context, request.optString("owner", ""));
                if ("setCompletionNotifications".equals(method)) {
                    if (!(request.opt("enabled") instanceof Boolean)) throw new IllegalArgumentException("提醒开关无效");
                    boolean enabled = request.optBoolean("enabled");
                    SyncForegroundService.setCompletionNotificationsEnabled(context, enabled);
                    if (enabled) requestNotificationPermission.run();
                }
                reply(replyProxy, requestId, scope, SyncForegroundService.notificationSettings(context));
            } catch (IllegalArgumentException failure) {
                postError(replyProxy, requestId, scope, "INVALID_NOTIFICATION_SETTING", failure.getMessage());
            } catch (RuntimeException failure) {
                postError(replyProxy, requestId, scope, "NOTIFICATION_SETTING_FAILED", "通知设置未完成，请重试");
            }
            return;
        }
        if ("saveDocument".equals(method)) {
            if (!"zyy".equals(scope) || !"application/vnd.openxmlformats-officedocument.wordprocessingml.document".equals(request.optString("mimeType"))) {
                postError(replyProxy, requestId, scope, "DOCUMENT_SCOPE", "此入口仅保存 ZYY 的 Word 文件"); return;
            }
            String filename = request.optString("filename", "");
            String encoded = request.optString("data", "");
            if (filename.isEmpty() || filename.length() > 160 || !filename.endsWith(".docx") || encoded.length() > 11200000) {
                postError(replyProxy, requestId, scope, "INVALID_DOCUMENT", "Word 文件无效或过大"); return;
            }
            worker.execute(() -> {
                try {
                    byte[] data = Base64.decode(encoded, Base64.DEFAULT);
                    if (data.length < 4 || data.length > 8 * 1024 * 1024 || data[0] != 'P' || data[1] != 'K' || data[2] != 3 || data[3] != 4) throw new IllegalArgumentException();
                    main.post(() -> documentExporter.save(scope, filename, data, (saved, cancelled) -> {
                        if (saved || cancelled) {
                            JSONObject value = new JSONObject();
                            try { value.put("saved", saved); value.put("cancelled", cancelled); } catch (JSONException ignored) {}
                            reply(replyProxy, requestId, scope, value);
                        } else postError(replyProxy, requestId, scope, "DOCUMENT_SAVE_FAILED", "Word 文件未保存，请重试");
                    }));
                } catch (RuntimeException failure) { postError(replyProxy, requestId, scope, "INVALID_DOCUMENT", "Word 文件无效或过大"); }
            });
            return;
        }
        if ("getTheme".equals(method) || "setTheme".equals(method)) {
            appearance.selectScope(scope);
            if ("setTheme".equals(method)) {
                try { appearance.setMode(request.optString("mode", "")); }
                catch (IllegalArgumentException failure) { postError(replyProxy, requestId, scope, "INVALID_THEME", "无效主题"); return; }
            }
            applyAppearance.run();
            reply(replyProxy, requestId, scope, appearance.snapshot());
            return;
        }
        if ("openSettings".equals(method)) {
            main.post(openSettings);
            reply(replyProxy, requestId, scope, new JSONObject());
            return;
        }
        if ("startSync".equals(method)) {
            try {
                SyncForegroundService.startSync(context, scope);
                reply(replyProxy, requestId, scope, SyncForegroundService.statusSnapshot(context, scope));
            } catch (RuntimeException failure) {
                postError(replyProxy, requestId, scope, "SYNC_START_FAILED", "同步服务暂不能启动");
            }
            return;
        }
        if ("stopSync".equals(method)) {
            SyncForegroundService.stopSync(context, scope);
            reply(replyProxy, requestId, scope, SyncForegroundService.statusSnapshot(context, scope));
            return;
        }
        if ("readSavedRecord".equals(method) || "saveReadRecord".equals(method)) {
            worker.execute(()->{try{
                if("saveReadRecord".equals(method)){store.saveReadRecord(scope,request.getJSONObject("record"));reply(replyProxy,requestId,scope,new JSONObject().put("saved",true));}
                else reply(replyProxy,requestId,scope,store.readSavedRecord(scope,request.optString("key"),request.optString("sourceGeneration"),request.optString("generation")));
            }catch(Exception failure){postError(replyProxy,requestId,scope,"ARCHIVE_FAILED","本地历史暂不可读写");}});return;
        }
        if ("readThreadRecords".equals(method) || "readSavedThreadRecords".equals(method)) {
            String thread=request.optString("threadId");
            if(!NativeDiagnostics.isUuid(thread)){postError(replyProxy,requestId,scope,"INVALID_REQUEST","会话标识无效");return;}
            worker.execute(()->{try{reply(replyProxy,requestId,scope,"readSavedThreadRecords".equals(method)?store.readSavedThreadRecords(scope,thread):store.readThreadRecords(scope,thread));}
                catch(Exception failure){postError(replyProxy,requestId,scope,"READ_FAILED","本地会话暂不可读");}});return;
        }
        if ("saveVisibleProcesses".equals(method) || "readVisibleProcesses".equals(method) || "invalidateVisibleProcesses".equals(method)) {
            worker.execute(()->{try{
                if("saveVisibleProcesses".equals(method)){store.saveVisibleProcesses(scope,request.getJSONObject("value"));reply(replyProxy,requestId,scope,new JSONObject().put("saved",true));}
                else if("invalidateVisibleProcesses".equals(method)){store.invalidateVisibleProcesses(scope,request.optString("threadId"),request.optLong("at"));reply(replyProxy,requestId,scope,new JSONObject().put("saved",true));}
                else reply(replyProxy,requestId,scope,store.readVisibleProcesses(scope,request.optString("threadId"),request.optString("turnId")));
            }catch(Exception failure){postError(replyProxy,requestId,scope,"PROCESS_CACHE_FAILED","本机过程记录暂不可读写");}});return;
        }
        if ("readStream".equals(method)) {
            String thread=request.optString("threadId");
            if(!NativeDiagnostics.isUuid(thread)){postError(replyProxy,requestId,scope,"INVALID_REQUEST","会话标识无效");return;}
            worker.execute(()->{try{reply(replyProxy,requestId,scope,store.readStream(scope,thread));}
                catch(Exception failure){postError(replyProxy,requestId,scope,"READ_FAILED","本地增量暂不可读");}});return;
        }
        if ("status".equals(method)) {
            JSONObject result = SyncForegroundService.statusSnapshot(context, scope);
            try {
                result.put("uiReleaseVersion", uiReleaseStore.activeVersion());
                result.put("documentExport", true);
            } catch (JSONException ignored) {
            }
            reply(replyProxy, requestId, scope, result);
            return;
        }
        if ("requestSync".equals(method)) {
            boolean accepted = SyncForegroundService.requestSync(scope);
            JSONObject result = SyncForegroundService.statusSnapshot(context, scope);
            try {
                result.put("accepted", accepted);
            } catch (JSONException ignored) {
            }
            reply(replyProxy, requestId, scope, result);
            return;
        }
        long after;
        int limit;
        try {
            after = nonNegativeLong(request, "after", 0L);
            limit = (int) nonNegativeLong(request, "limit", 200L);
            if (limit < 1 || limit > 200) throw new BridgeException("INVALID_PAGE", "读取页大小无效");
        } catch (BridgeException failure) {
            postError(replyProxy, requestId, scope, failure.code, failure.getMessage());
            return;
        }
        final long requestedAfter = after;
        final int requestedLimit = limit;
        worker.execute(() -> {
            try {
                JSONObject result = store.readRecords(scope, requestedAfter, requestedLimit);
                reply(replyProxy, requestId, scope, result);
            } catch (RuntimeException failure) {
                postError(replyProxy, requestId, scope, "READ_UNAVAILABLE", "本地同步记录暂不可读");
            }
        });
    }

    private static long nonNegativeLong(JSONObject request, String key, long fallback) throws BridgeException {
        if (!request.has(key)) return fallback;
        Object value = request.opt(key);
        if (!(value instanceof Number)) throw new BridgeException("INVALID_PAGE", "读取游标无效");
        double number = ((Number) value).doubleValue();
        if (!Double.isFinite(number) || number < 0 || number > 9_007_199_254_740_991d || number != Math.rint(number)) {
            throw new BridgeException("INVALID_PAGE", "读取游标无效");
        }
        return ((Number) value).longValue();
    }

    @Nullable
    private static String pageScope(WebView view) {
        try {
            Uri url = Uri.parse(view.getUrl());
            if (!DshConfig.isDshUri(url)) return null;
            String scope = url.getQueryParameter("workspace");
            return DshConfig.isScope(scope) ? scope : DshConfig.DEFAULT_SCOPE;
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private void reply(JavaScriptReplyProxy target, String requestId, String scope, JSONObject result) {
        diagnostic(scope, "dispatch", "bridge_reply", requestId, bridgeDuration(scope, requestId));
        JSONObject value = new JSONObject();
        try {
            value.put("version", 1);
            value.put("requestId", requestId);
            value.put("id", requestId);
            value.put("scope", scope);
            value.put("ok", true);
            value.put("result", result == null ? JSONObject.NULL : result);
        } catch (JSONException ignored) {
        }
        post(target, value.toString());
    }

    private void postError(JavaScriptReplyProxy target, String requestId, String scope, String code, String message) {
        diagnostic(scope, "failed", "bridge_failed", requestId, bridgeDuration(scope, requestId));
        JSONObject value = new JSONObject();
        try {
            value.put("version", 1);
            if (!requestId.isEmpty()) {
                value.put("requestId", requestId);
                value.put("id", requestId);
            }
            if (!scope.isEmpty()) value.put("scope", scope);
            value.put("ok", false);
            JSONObject error = new JSONObject();
            error.put("code", code);
            error.put("message", message);
            value.put("error", error);
        } catch (JSONException ignored) {
        }
        post(target, value.toString());
    }

    private void post(JavaScriptReplyProxy target, String value) {
        main.post(() -> {
            try {
                target.postMessage(value);
            } catch (RuntimeException ignored) {
                // The page may have navigated away since the request arrived.
            }
        });
    }

    public void emitStatus(String scope, JSONObject state) {
        JavaScriptReplyProxy target = proxy;
        if (target == null || !scope.equals(proxyScope)) return;
        diagnostic(scope, "dispatch", "bridge_reply", null, -1L);
        JSONObject value = new JSONObject();
        try {
            value.put("version", 1);
            value.put("event", "status");
            value.put("scope", scope);
            value.put("status", state == null ? JSONObject.NULL : state);
        } catch (JSONException ignored) {
        }
        post(target, value.toString());
    }

    public void clearProxy() {
        controlSession.cancel();
        SyncForegroundService.clearPresentation(this);
        proxy = null;
        proxyScope = null;
    }

    private static boolean isUuid(String value) {
        return value != null && UUID.matcher(value).matches();
    }

    private static String bridgeKey(String scope, String requestId) {
        return scope + "\u0000" + requestId;
    }

    private long bridgeDuration(String scope, String requestId) {
        if (!isUuid(requestId)) return -1L;
        Long started = bridgeStartedAt.remove(bridgeKey(scope, requestId));
        if (started == null) return -1L;
        return Math.max(0L, SystemClock.elapsedRealtime() - started);
    }

    private void diagnostic(String scope, String stage, String reason, String traceId, long durationMs) {
        if (!DshConfig.isScope(scope)) return;
        if(isUuid(traceId)&&"recordDiagnostics".equals(bridgeMethods.get(bridgeKey(scope,traceId)))){bridgeMethods.remove(bridgeKey(scope,traceId));return;}
        JSONObject fields = new JSONObject();
        try {
            if (isUuid(traceId)) fields.put("traceId", traceId);
            if (reason != null) fields.put("reason", reason);
            if(isUuid(traceId)){String key=bridgeKey(scope,traceId);String method=("dispatch".equals(stage)||"failed".equals(stage))?bridgeMethods.remove(key):bridgeMethods.get(key);if(method!=null)fields.put("method",method);}
            if (durationMs >= 0L) fields.put("durationMs", durationMs);
        } catch (JSONException ignored) {
            return;
        }
        try {
            diagnostics.event(scope, "android-bridge", stage, fields);
        } catch (RuntimeException ignored) {
            // Diagnostics must never change bridge behavior.
        }
    }

    @Override
    public void close() {
        SyncForegroundService.clearPresentation(this);
        String scope = proxyScope;
        if (DshConfig.isScope(scope)) diagnostic(scope, "closed", "activity_destroy", null, -1L);
        clearProxy();
        bridgeStartedAt.clear();bridgeMethods.clear();
        worker.shutdownNow();
        controlSession.close();
    }

    private static final class BridgeException extends Exception {
        final String code;

        BridgeException(String code, String message) {
            super(message);
            this.code = code;
        }
    }
}
