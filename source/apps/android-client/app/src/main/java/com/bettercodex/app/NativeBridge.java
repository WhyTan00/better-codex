package com.bettercodex.app;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Narrow sync bridge, plus explicit user-chosen local Word export. */
public final class NativeBridge implements AutoCloseable {
    public interface DocumentResult { void complete(boolean saved, boolean cancelled); }
    public interface DocumentExporter { void save(String scope, String name, byte[] bytes, DocumentResult result); }
    private final DocumentExporter documentExporter;
    private final Context context;
    private final WebView webView;
    private final SyncStore store;
    private final UiReleaseStore uiReleaseStore;
    private final Runnable openSettings;
    private final Runnable requestNotificationPermission;
    private final NativeAppearance appearance;
    private final Runnable applyAppearance;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile JavaScriptReplyProxy proxy;
    private volatile String proxyScope;
    private volatile boolean installed;

    public NativeBridge(Context context, WebView webView, SyncStore store, UiReleaseStore uiReleaseStore, Runnable openSettings, Runnable requestNotificationPermission, NativeAppearance appearance, Runnable applyAppearance, DocumentExporter documentExporter) {
        this.context = context.getApplicationContext();
        this.webView = webView;
        this.store = store;
        this.uiReleaseStore = uiReleaseStore;
        this.openSettings = openSettings;
        this.requestNotificationPermission = requestNotificationPermission;
        this.appearance = appearance;
        this.applyAppearance = applyAppearance;
        this.documentExporter = documentExporter;
    }

    public boolean install() {
        if (installed) return true;
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false;
        WebViewCompat.addWebMessageListener(webView, BetterCodexConfig.BRIDGE_NAME,
                Collections.singleton("https://" + BetterCodexConfig.HOST),
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
            if (!isMainFrame || !BetterCodexConfig.isBetterCodexUri(sourceOrigin) || text == null || text.length() > 12 * 1024 * 1024) {
                throw new BridgeException("BRIDGE_ORIGIN", "桥接来源不可用");
            }
            JSONObject request = new JSONObject(text);
            if (text.length() > 256 * 1024 && !"saveDocument".equals(request.optString("method"))) throw new BridgeException("INVALID_REQUEST", "请求过大");
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
            if (!BetterCodexConfig.isScope(scope)) throw new BridgeException("SCOPE_MISMATCH", "工作区不可访问");
            String pageScope = pageScope(view);
            if (!scope.equals(pageScope)) throw new BridgeException("SCOPE_MISMATCH", "工作区与页面不一致");
            this.proxy = replyProxy;
            this.proxyScope = scope;
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
        if (!"status".equals(method) && !"requestSync".equals(method) && !"readRecords".equals(method)
                && !"getTheme".equals(method) && !"setTheme".equals(method) && !"saveDocument".equals(method)
                && !"getNotificationSettings".equals(method) && !"setDeviceOwner".equals(method) && !"setCompletionNotifications".equals(method)
                && !"startSync".equals(method) && !"stopSync".equals(method) && !"openSettings".equals(method)) {
            postError(replyProxy, requestId, scope, "METHOD_NOT_ALLOWED", "桥接方法未开放");
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
            if (!"secondary".equals(scope) || !"application/vnd.openxmlformats-officedocument.wordprocessingml.document".equals(request.optString("mimeType"))) {
                postError(replyProxy, requestId, scope, "DOCUMENT_SCOPE", "此入口仅保存 SECONDARY 的 Word 文件"); return;
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
            if (!BetterCodexConfig.isBetterCodexUri(url)) return null;
            String scope = url.getQueryParameter("workspace");
            return BetterCodexConfig.isScope(scope) ? scope : BetterCodexConfig.DEFAULT_SCOPE;
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private void reply(JavaScriptReplyProxy target, String requestId, String scope, JSONObject result) {
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
        proxy = null;
        proxyScope = null;
    }

    @Override
    public void close() {
        clearProxy();
        worker.shutdownNow();
    }

    private static final class BridgeException extends Exception {
        final String code;

        BridgeException(String code, String message) {
            super(message);
            this.code = code;
        }
    }
}
