package top.whytan.dsh;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.res.Configuration;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.webkit.CookieManager;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.FrameLayout;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.ServiceWorkerClientCompat;
import androidx.webkit.ServiceWorkerControllerCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONObject;
import org.json.JSONException;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.UUID;
import java.util.regex.Pattern;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import okhttp3.OkHttpClient;

/** Thin Android shell around the official DSH renderer. */
public final class MainActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST = 5101;
    private static final int NOTIFICATION_REQUEST = 5102;
    private static final int DOCUMENT_EXPORT_REQUEST = 5103;
    private static final int SMS_PERMISSION_REQUEST = 5104;
    private boolean phoneCodeEnablePending, phoneCodeBinding;
    private static final Pattern THREAD_ID = Pattern.compile("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");
    private static final long MAX_DOWNLOAD_BYTES = 512L * 1024L * 1024L;
    private static final long NOTIFICATION_WAIT_TIMEOUT_MILLIS = 15_000L;

    private final android.os.Handler uiHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable applyDownloadedUi = this::tryApplyDownloadedUi;
    @Nullable private String uiApplyPageId;
    private WebView webView;
    @Nullable private WebView startingWebView;
    private View nativeRoot;
    private NativeAppearance appearance;
    private LinearLayout nativeBar;
    private TextView connectionLabel;
    private UiReleaseStore uiReleaseStore;
    private volatile boolean startupDestroyed;
    @Nullable private View startupCover;
    private boolean startupSurfaceReady;
    private static final long AUTO_UPDATE_INTERVAL_MS = 15 * 60_000L;
    private final Runnable automaticUpdates = () -> {
        if (startupDestroyed || !this.activityResumed || webView == null || !hasDshCookie()) return;
        refreshUiInBackground(false);
        checkApkUpdate(false);
    };
    private SyncStore syncStore;
    private NativeBridge bridge;
    private NativeDiagnostics diagnostics;
    @Nullable private volatile UiReleaseStore.Release pageRelease;
    @Nullable private ApkUpdateManager apkUpdateManager;
    private final ExecutorService background = Executors.newSingleThreadExecutor();
    private final ExecutorService uiUpdateExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService apkUpdateExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean updateStarted = new AtomicBoolean();
    private final AtomicBoolean notificationPermissionRequestStarted = new AtomicBoolean();
    private final AtomicBoolean appUpdateStarted = new AtomicBoolean();
    private final AtomicBoolean apkDownloadStarted = new AtomicBoolean();
    private final AtomicBoolean renderProcessRecoveryScheduled = new AtomicBoolean();
    private boolean pendingShellAfterLogin;
    private long navigationSequence;
    private long pendingLoginSequence = -1L;
    private long pendingListSequence = -1L;
    private boolean activityResumed;
    private boolean firstForegroundResume = true;
    private boolean activityStopped = true;
    private boolean apkExternalReturnExpected;
    private boolean apkInstallerLaunched;
    private boolean apkPermissionSettingsLaunched;
    private boolean apkInstallPromptSuppressed;
    private boolean apkCheckAfterLoginPending;
    private String pageId = newPageId();
    @Nullable private String pageUrl;
    private long pageStartedAt = -1L;
    @Nullable private File pendingApkFile;
    @Nullable private ApkUpdateManager.CheckResult pendingApkUpdate;
    @Nullable private LaunchRequest launchRequest;
    @Nullable private LaunchRequest pendingNotificationRequest;
    @Nullable private FrameLayout notificationOverlay;
    @Nullable private TextView notificationOverlayLabel;
    @Nullable private Button notificationRetryButton;
    @Nullable private Button notificationBackButton;
    private final Runnable notificationWaitTimeout = this::onNotificationWaitTimeout;
    private volatile boolean pinnedMainFrameResponse;
    @Nullable private ValueCallback<Uri[]> fileCallback;
    @Nullable private byte[] documentBytes;
    @Nullable private NativeBridge.DocumentResult documentResult;
    private String scope = DshConfig.DEFAULT_SCOPE;

    private final BroadcastReceiver statusReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (!SyncForegroundService.ACTION_STATUS.equals(intent.getAction())) return;
            String stateScope = intent.getStringExtra(SyncForegroundService.EXTRA_SCOPE);
            String raw = intent.getStringExtra(SyncForegroundService.EXTRA_STATUS);
            if (stateScope == null || raw == null) return;
            try {
                JSONObject state = new JSONObject(raw);
                diagnosticEvent(stateScope, "android-app", "received", "periodic", null, null, null,
                        -1L, state.optBoolean("online", false), state.optBoolean("transportConnected", false),
                        state.optBoolean("enabled", false), -1);
                if (bridge != null) bridge.emitStatus(stateScope, state);
                updateNativeStatusControls(stateScope, state);
                if (state.optBoolean("enabled", false)) requestNotificationPermissionIfNeeded();
            } catch (Exception ignored) {
            }
        }
    };

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        launchRequest = readLaunchRequest(getIntent());
        scope = launchRequest.scope;
        diagnostics = NativeDiagnostics.get(this);
        diagnosticEvent(scope, "android-app", "attempt", "activity_create", launchRequest.traceId, null, null,
                -1L, null, null, null, -1);
        appearance = new NativeAppearance(this, scope);
        appearance.apply(null, null);
        syncStore = new SyncStore(this);
        apkUpdateManager = new ApkUpdateManager(this);
        apkUpdateManager.setDiagnosticScope(scope);
        nativeRoot = new FrameLayout(this);
        setContentView(nativeRoot);
        appearance.apply(null, nativeRoot);
        showStartupCover();
        // Let the native frame reach the screen before Chromium initialization.
        // Its first cold initialization may be slow even with a ready UI cache.
        nativeRoot.getViewTreeObserver().addOnDrawListener(new android.view.ViewTreeObserver.OnDrawListener() {
            private boolean scheduled;
            @Override public void onDraw() {
                if (scheduled) return;
                scheduled = true;
                uiHandler.post(() -> {
                    if (startupDestroyed || isFinishing() || isDestroyed()) return;
                    if (nativeRoot.getViewTreeObserver().isAlive()) nativeRoot.getViewTreeObserver().removeOnDrawListener(this);
                    startingWebView = createStartupWebView();
                    ((FrameLayout) nativeRoot).addView(startingWebView, 0, new FrameLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                    appearance.apply(startingWebView, nativeRoot);
                    startupSurfaceReady = true;
                    if (uiReleaseStore != null) finishVerifiedStartup();
                });
            }
        });
        String initialScope = scope;
        background.execute(() -> {
            if (startupDestroyed) return;
            UiReleaseStore verified = new UiReleaseStore(getApplicationContext(), initialScope);
            if (startupDestroyed || Thread.currentThread().isInterrupted()) { verified.close(); return; }
            runOnUiThread(() -> {
                if (startupDestroyed || isFinishing() || isDestroyed()) { verified.close(); return; }
                uiReleaseStore = verified;
                uiReleaseStore.setDiagnosticScope(scope);
                if (startupSurfaceReady) finishVerifiedStartup();
            });
        });
    }

    private void showStartupCover() {
        FrameLayout cover = new FrameLayout(this);
        cover.setBackgroundColor(appearance.dark() ? android.graphics.Color.BLACK : android.graphics.Color.WHITE);
        android.widget.ImageView icon = new android.widget.ImageView(this);
        icon.setImageResource(R.drawable.ic_launcher);
        int size = Math.round(48 * getResources().getDisplayMetrics().density);
        cover.addView(icon, new FrameLayout.LayoutParams(size, size, Gravity.CENTER));
        startupCover = cover;
        ((FrameLayout) nativeRoot).addView(cover, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void hideStartupCover() {
        if (startupCover == null) return;
        if (startupCover.getParent() instanceof ViewGroup) ((ViewGroup) startupCover.getParent()).removeView(startupCover);
        startupCover = null;
    }

    private WebView createStartupWebView() {
        return new WebView(this) {
            private boolean correcting;
            private long lastLayoutLog;
            @Override protected void onScrollChanged(int x,int y,int oldX,int oldY) {
                super.onScrollChanged(x,y,oldX,oldY);
                // The native root is fixed; conversation/editor scrolling is inside the DOM.
                // WebView may still move its own surface when an IME selection becomes empty.
                if(!correcting&&(x!=0||y!=0)&&DshConfig.isDshUri(Uri.parse(getUrl()==null?"":getUrl()))) {
                    correcting=true;scrollTo(0,0);correcting=false;
                    if(diagnostics!=null&&SystemClock.elapsedRealtime()-lastLayoutLog>500){lastLayoutLog=SystemClock.elapsedRealtime();
                        try{diagnostics.event(scope,"android-webview","committed",new JSONObject().put("reason","layout_repaired").put("webViewOffset",Math.abs(y)).put("viewportHeight",getHeight()).put("pageId",pageId));}catch(JSONException ignored){}
                    }
                }
            }
        };
    }

    private void finishVerifiedStartup() {
        webView = startingWebView == null ? createStartupWebView() : startingWebView;
        startingWebView = null;
        if (webView.getParent() instanceof android.view.ViewGroup)
            ((android.view.ViewGroup) webView.getParent()).removeView(webView);
        nativeRoot = buildNativeLayout(webView);
        if (startupCover != null) {
            ((ViewGroup) startupCover.getParent()).removeView(startupCover);
            ((FrameLayout) nativeRoot).addView(startupCover, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        setContentView(nativeRoot);
        appearance.apply(webView, nativeRoot);
        configureWebView();
        bridge = new NativeBridge(this, webView, syncStore, uiReleaseStore, this::showNativeSettings, this::requestNotificationPermissionIfNeeded, appearance, () -> appearance.apply(webView, nativeRoot), this::saveWordDocument, this::openDownloadedFile);
        bridge.install();
        installServiceWorkerResourceClient();
        installDocumentStartAdapter();
        IntentFilter filter = new IntentFilter(SyncForegroundService.ACTION_STATUS);
        ContextCompat.registerReceiver(this, statusReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBackNavigation);
        java.util.concurrent.atomic.AtomicBoolean initialLoaded=new java.util.concurrent.atomic.AtomicBoolean();
        Runnable loadInitial=()->{if(!startupDestroyed&&!isFinishing()&&!isDestroyed()&&initialLoaded.compareAndSet(false,true))loadInitialPage(launchRequest);};
        DshNetwork.get(this).prepareWebView(this::runOnUiThread,loadInitial);
        if(uiReleaseStore.activeRelease()!=null&&hasDshCookie())loadInitial.run();
        uiHandler.postDelayed(()->{
            if(initialLoaded.get()||startupDestroyed||!(startupCover instanceof FrameLayout))return;
            Button retry=new Button(this);retry.setText("连接准备未完成，点击重试");
            FrameLayout.LayoutParams position=new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,ViewGroup.LayoutParams.WRAP_CONTENT,Gravity.CENTER_HORIZONTAL|Gravity.BOTTOM);position.bottomMargin=Math.round(72*getResources().getDisplayMetrics().density);
            ((FrameLayout)startupCover).addView(retry,position);
            retry.setOnClickListener(view->DshNetwork.get(this).retryWebViewPreparation(this::runOnUiThread,loadInitial));
        },15_000L);
        diagnosticEvent(scope, "android-app", "started", "activity_create", launchRequest.traceId, null, null,
                -1L, null, null, null, -1);
        updateNativeStatusControls(scope, SyncForegroundService.statusSnapshot(this, scope));
        if (getIntent().getBooleanExtra("open_background_settings", false)) uiHandler.post(this::showNativeSettings);
    }

    private View buildNativeLayout(WebView content) {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.dsh_surface));
        root.addView(content, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        notificationOverlay = buildNotificationOverlay();
        root.addView(notificationOverlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP));
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            boolean ime=insets.isVisible(WindowInsetsCompat.Type.ime());int imeHeight=insets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
            if(webView!=null)webView.post(()->{
                if(webView==null)return;
                webView.evaluateJavascript("window.__DSH_ANDROID_INPUT__?.insets?.("+ime+","+imeHeight+")",null);
            });
            return insets;
        });
        ViewCompat.requestApplyInsets(root);
        return root;
    }

    private FrameLayout buildNotificationOverlay() {
        FrameLayout overlay = new FrameLayout(this);
        overlay.setBackgroundColor(getColor(R.color.dsh_surface));
        overlay.setClickable(false);
        overlay.setFocusable(false);
        overlay.setVisibility(View.GONE);

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setGravity(Gravity.CENTER_HORIZONTAL);
        card.setPadding(dp(12), dp(8), dp(12), dp(8));
        FrameLayout.LayoutParams cardParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER);
        overlay.addView(card, cardParams);

        TextView label = new TextView(this);
        label.setTextColor(getColor(R.color.dsh_on_surface));
        label.setTextSize(16);
        label.setGravity(Gravity.CENTER);
        label.setText("正在打开通知…");
        card.addView(label, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        LinearLayout actions = new LinearLayout(this);
        actions.setGravity(Gravity.CENTER);
        actions.setPadding(0, dp(4), 0, 0);
        card.addView(actions, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button retry = compactButton("重试");
        retry.setVisibility(View.GONE);
        retry.setOnClickListener(view -> retryNotificationNavigation());
        actions.addView(retry, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button back = compactButton("返回列表");
        back.setOnClickListener(view -> cancelNotificationNavigationToList());
        LinearLayout.LayoutParams backParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        backParams.setMarginStart(dp(8));
        actions.addView(back, backParams);

        notificationOverlayLabel = label;
        notificationRetryButton = retry;
        notificationBackButton = back;
        return overlay;
    }

    private Button compactButton(String text) {
        Button button = new Button(this);
        button.setText(text);
        button.setTextSize(12);
        button.setAllCaps(false);
        button.setMinHeight(0);
        button.setMinimumHeight(0);
        button.setPadding(dp(8), 0, dp(8), 0);
        return button;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private static String newPageId() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 12).toLowerCase(java.util.Locale.ROOT);
    }

    private void beginPageNavigation(String url) {
        String previousPageId = pageId;
        pageId = newPageId();
        try {
            JSONObject fields = new JSONObject(); fields.put("reason", "page_started"); fields.put("pageId", pageId); fields.put("previousPageId", previousPageId);
            if (pageRelease != null) fields.put("uiVersion", pageRelease.version);
            if (diagnostics != null) diagnostics.event(scope, "android-webview", "started", fields);
        } catch (JSONException ignored) {}
        pageUrl = url;
        pageStartedAt = SystemClock.elapsedRealtime();
    }

    private boolean isCurrentPageCallback(WebView view, @Nullable String url) {
        if (view != webView || isFinishing() || isDestroyed()) return false;
        // WebView may deliver a late callback after the next navigation has
        // already started. The page-start URL owns the generation; a loaded
        // URL is accepted only when it is the callback's current redirect.
        if (isCurrentPageCallbackUrl(url, pageUrl)) return true;
        String loadedUrl = view.getUrl();
        return loadedUrl != null && url != null && url.equals(loadedUrl);
    }

    static boolean isCurrentPageCallbackUrl(@Nullable String callbackUrl, @Nullable String currentPageUrl) {
        return callbackUrl != null && currentPageUrl != null && callbackUrl.equals(currentPageUrl);
    }

    private static boolean isUuid(@Nullable String value) {
        return value != null && value.matches("(?i)^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$");
    }

    @Nullable
    static String threadIdFromUri(@Nullable Uri uri) {
        if (uri == null || !"https".equalsIgnoreCase(uri.getScheme())
                || !"workbench.example.test".equalsIgnoreCase(uri.getHost())) return null;
        String path = uri.getPath();
        if (path == null || !path.startsWith("/local/")) return null;
        String value = path.substring("/local/".length());
        return THREAD_ID.matcher(value).matches() ? value : null;
    }

    /** Maps WebView's negative net error codes to the bounded diagnostics vocabulary. */
    static String failureClassForWebError(int code, @Nullable CharSequence description) {
        if (code == WebViewClient.ERROR_HOST_LOOKUP) return "dns";
        if (code == WebViewClient.ERROR_FAILED_SSL_HANDSHAKE) return "tls";
        if (code == WebViewClient.ERROR_TIMEOUT) return "timeout";
        if (code == WebViewClient.ERROR_CONNECT || code == WebViewClient.ERROR_IO
                || code == WebViewClient.ERROR_AUTHENTICATION
                || code == WebViewClient.ERROR_PROXY_AUTHENTICATION
                || code == WebViewClient.ERROR_UNSUPPORTED_AUTH_SCHEME) return "connection";
        if (code == WebViewClient.ERROR_UNKNOWN && description != null) {
            String normalized = description.toString().toLowerCase(java.util.Locale.ROOT);
            if (normalized.contains("err_aborted") || normalized.contains("aborted")
                    || normalized.contains("cancel")) return "aborted";
            if (normalized.contains("name_not_resolved") || normalized.contains("host_lookup")
                    || normalized.contains("dns")) return "dns";
            if (normalized.contains("ssl") || normalized.contains("cert")) return "tls";
            if (normalized.contains("timed_out") || normalized.contains("timeout")) return "timeout";
            if (normalized.contains("connection") || normalized.contains("connect")
                    || normalized.contains("reset")) return "connection";
        }
        return "unknown";
    }

    private void diagnosticEvent(String eventScope, String component, String stage, String reason,
                                 @Nullable String traceId, @Nullable String eventPageId,
                                 @Nullable String threadId, long startedAt,
                                 @Nullable Boolean online, @Nullable Boolean transportConnected,
                                 @Nullable Boolean enabled, int statusCode) {
        diagnosticEvent(eventScope, component, stage, reason, traceId, eventPageId, threadId, startedAt,
                online, transportConnected, enabled, statusCode, null, null);
    }

    private void diagnosticEvent(String eventScope, String component, String stage, String reason,
                                 @Nullable String traceId, @Nullable String eventPageId,
                                 @Nullable String threadId, long startedAt,
                                 @Nullable Boolean online, @Nullable Boolean transportConnected,
                                 @Nullable Boolean enabled, int statusCode, @Nullable Long count) {
        diagnosticEvent(eventScope, component, stage, reason, traceId, eventPageId, threadId, startedAt,
                online, transportConnected, enabled, statusCode, count, null);
    }

    private void diagnosticEvent(String eventScope, String component, String stage, String reason,
                                 @Nullable String traceId, @Nullable String eventPageId,
                                 @Nullable String threadId, long startedAt,
                                 @Nullable Boolean online, @Nullable Boolean transportConnected,
                                 @Nullable Boolean enabled, int statusCode, @Nullable Long count,
                                 @Nullable Boolean wasClean) {
        diagnosticEvent(eventScope, component, stage, reason, traceId, eventPageId, threadId, startedAt,
                online, transportConnected, enabled, statusCode, count, wasClean, null);
    }

    private void diagnosticEvent(String eventScope, String component, String stage, String reason,
                                 @Nullable String traceId, @Nullable String eventPageId,
                                 @Nullable String threadId, long startedAt,
                                 @Nullable Boolean online, @Nullable Boolean transportConnected,
                                 @Nullable Boolean enabled, int statusCode, @Nullable Long count,
                                 @Nullable Boolean wasClean, @Nullable String failureClass) {
        if (diagnostics == null || !DshConfig.isScope(eventScope)) return;
        JSONObject fields = new JSONObject();
        try {
            if (isUuid(traceId)) fields.put("traceId", traceId);
            if (eventPageId != null && eventPageId.matches("(?i)^[a-f0-9]{8,12}$")) fields.put("pageId", eventPageId);
            if (threadId != null && THREAD_ID.matcher(threadId).matches()) fields.put("threadId", threadId);
            UiReleaseStore.Release release = pageRelease;
            if (release != null && release.version.matches("[a-f0-9]{16}")) fields.put("uiVersion", release.version);
            if (reason != null) fields.put("reason", reason);
            if (startedAt >= 0L) fields.put("durationMs", Math.max(0L, SystemClock.elapsedRealtime() - startedAt));
            if (statusCode >= 100 && statusCode <= 999) fields.put("statusCode", statusCode);
            if (online != null) fields.put("online", online);
            if (transportConnected != null) fields.put("transportConnected", transportConnected);
            if (enabled != null) fields.put("enabled", enabled);
            if (count != null && count >= 0L) fields.put("count", count);
            if (wasClean != null) fields.put("wasClean", wasClean);
            if (failureClass != null && (failureClass.equals("dns") || failureClass.equals("tls")
                    || failureClass.equals("timeout") || failureClass.equals("connection")
                    || failureClass.equals("http") || failureClass.equals("aborted")
                    || failureClass.equals("unknown"))) fields.put("failureClass", failureClass);
        } catch (Exception ignored) {
            return;
        }
        try {
            diagnostics.event(eventScope, component, stage, fields);
        } catch (RuntimeException ignored) {
            // Diagnostics are observational; failures must not change app behavior.
        }
    }

    private void flushDiagnostics(@Nullable String eventScope) {
        if (diagnostics == null || !DshConfig.isScope(eventScope)) return;
        try {
            diagnostics.flush(eventScope);
        } catch (RuntimeException ignored) {
            // A diagnostics flush is best-effort and never gates navigation.
        }
    }

    private void installServiceWorkerResourceClient() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)
                || !WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_SHOULD_INTERCEPT_REQUEST)) {
            diagnosticEvent(scope, "android-update", "skipped", "ui_failed", null, pageId, null, -1L,
                    null, null, null, -1);
            return;
        }
        ServiceWorkerControllerCompat.getInstance().setServiceWorkerClient(new ServiceWorkerClientCompat() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                if (!DshConfig.isDshUri(request.getUrl()) || !"GET".equals(request.getMethod())) return null;
                WebResourceResponse cached=DeliverableCache.get(MainActivity.this).intercept(request.getUrl(),scope,request.getRequestHeaders().get("Range"),hasDshCookie());
                if(cached!=null)return cached;
                UiReleaseStore.LocalResource resource = uiReleaseStore.localResource(request.getUrl().getPath(), pageRelease);
                if (resource == null) return null;
                UiReleaseStore.Release release = pageRelease;
                if (release != null && release.shellPath.equals(request.getUrl().getPath())) {
                    diagnosticEvent(scope, "android-update", "committed", "ui_cached", null, pageId,
                            threadIdFromUri(request.getUrl()), -1L, null, null, null, 200);
                }
                return new WebResourceResponse(resource.mime, null, 200, "OK", null, resource.stream);
            }
        });
    }

    private void installDocumentStartAdapter() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return;
        try {
            String adapter = readAssetText("android-native-adapter.js");
            String startup = readAssetText("android-startup.js");
            String authRecovery = "(function(){try{if(location.origin!=='" + DshConfig.ORIGIN
                    + "'||window.top!==window)return;addEventListener('dsh:authentication-required',function(){"
                    + "if(location.pathname==='/'||/^\\/local\\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(location.pathname)||"
                    + "/^\\/dsh-native-assets\\/[a-f0-9]{16}\\//.test(location.pathname)){"
                    + "var s=new URL(location.href).searchParams.get('workspace');if(s==='ai'||s==='zyy')"
                    + "location.replace('/?workspace='+s+'&view=chat&nativeList=1&pwa='+s+'&launch=1&androidLogin=1'+(location.pathname.startsWith('/local/')?'&androidReturn='+encodeURIComponent(location.pathname+location.search):''));}},{once:true});}catch(e){}})();\n";
            WebViewCompat.addDocumentStartJavaScript(webView, startup + authRecovery + adapter,
                    Collections.singleton(DshConfig.ORIGIN));
        } catch (Exception ignored) {
            // A build without the packaged adapter still keeps the official
            // renderer usable; the bridge simply remains unavailable.
        }
    }

    private static String readAssetText(Context context, String name) throws IOException {
        try (InputStream input = context.getAssets().open(name);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            int read;
            int total = 0;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > 256 * 1024) throw new IOException("document-start script too large");
                output.write(buffer, 0, read);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private String readAssetText(String name) throws IOException {
        return readAssetText(this, name);
    }

    private void updateNativeStatusControls(String stateScope, JSONObject state) {
        if (nativeBar == null || state == null || !scope.equals(stateScope)) return;
        runOnUiThread(() -> {
            if (connectionLabel == null) return;
            boolean online = state.optBoolean("online", false);
            boolean running = state.optBoolean("running", false);
            connectionLabel.setText(online ? "已连接" : running ? "连接中" : "未启用");
        });
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportMultipleWindows(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUserAgentString(settings.getUserAgentString() + DshConfig.userAgentSuffix());
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        CookieManager.setAcceptFileSchemeCookies(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) cookies.setAcceptThirdPartyCookies(webView, false);

        webView.setWebViewClient(new DshWebViewClient());
        webView.setWebChromeClient(new DshWebChromeClient());
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            Uri target;
            try {
                target = Uri.parse(url);
            } catch (RuntimeException ignored) {
                Toast.makeText(this, "无法打开下载内容", Toast.LENGTH_SHORT).show();
                return;
            }
            if (DshConfig.isDshUri(target)) {
                downloadSameOrigin(target, contentDisposition, mimeType);
                return;
            }
            // Only user initiated downloads from another origin leave the
            // WebView. Scoped DSH downloads retain the current WebView cookie.
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, target));
            } catch (RuntimeException ignored) {
                Toast.makeText(this, "无法打开下载内容", Toast.LENGTH_SHORT).show();
            }
        });
    }

    private void downloadSameOrigin(Uri url, @Nullable String contentDisposition, @Nullable String mimeType) {
        if(url.getPath()!=null&&url.getPath().startsWith("/__dsh_deliverables/")) {
            final String capturedScope=scope;final boolean authorized=hasDshCookie();
            background.execute(()->{try{File file=DeliverableCache.get(this).exportCopy(this,url,capturedScope,authorized);
                runOnUiThread(()->{if(capturedScope.equals(scope))openDownloadedFile(file,mimeType==null?"application/octet-stream":mimeType);});
            }catch(Exception unavailable){runOnUiThread(()->Toast.makeText(this,"本机文件暂不可用，请返回回复重试",Toast.LENGTH_SHORT).show());}});return;
        }
        if (!isAllowedDownloadPath(url)) {
            Toast.makeText(this, "下载地址不可用", Toast.LENGTH_SHORT).show();
            return;
        }
        Toast.makeText(this, "正在准备下载", Toast.LENGTH_SHORT).show();
        background.execute(() -> {
            File output = null;
            try {
                okhttp3.OkHttpClient client = DshNetwork.builder(this)
                        .followRedirects(false).followSslRedirects(false).build();
                okhttp3.Request.Builder request = new okhttp3.Request.Builder()
                        .url(url.toString()).get().header("Origin", DshConfig.ORIGIN);
                addCookie(request, DshConfig.ORIGIN);
                try (okhttp3.Response response = client.newCall(request.build()).execute()) {
                    if (response.code() != 200 || response.body() == null) throw new IOException("download http");
                    long length = response.body().contentLength();
                    if (length > MAX_DOWNLOAD_BYTES) throw new IOException("download too large");
                    String responseType = response.header("Content-Type", mimeType == null ? "application/octet-stream" : mimeType);
                    String disposition = response.header("Content-Disposition", contentDisposition);
                    String filename = safeDownloadName(URLUtil.guessFileName(url.toString(), disposition, responseType));
                    File directory = new File(getCacheDir(), "downloads");
                    if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("download directory");
                    output = new File(directory, UUID.randomUUID() + "-" + filename);
                    long copied = 0L;
                    try (InputStream input = new BufferedInputStream(response.body().byteStream());
                         OutputStream stream = new BufferedOutputStream(new java.io.FileOutputStream(output, false))) {
                        byte[] buffer = new byte[64 * 1024];
                        int read;
                        while ((read = input.read(buffer)) != -1) {
                            copied += read;
                            if (copied > MAX_DOWNLOAD_BYTES) throw new IOException("download too large");
                            stream.write(buffer, 0, read);
                        }
                    }
                    if (length >= 0L && copied != length) throw new IOException("download incomplete");
                    File ready = output;
                    String type = responseType == null || responseType.isEmpty() ? "application/octet-stream" : responseType.split(";", 2)[0].trim();
                    runOnUiThread(() -> openDownloadedFile(ready, type));
                    output = null;
                }
                client.dispatcher().executorService().shutdown();
                client.connectionPool().evictAll();
            } catch (Exception failure) {
                if (output != null) {
                    //noinspection ResultOfMethodCallIgnored
                    output.delete();
                }
                runOnUiThread(() -> Toast.makeText(this, "下载失败，请重新登录后重试", Toast.LENGTH_SHORT).show());
            }
        });
    }

    private static boolean isAllowedDownloadPath(Uri url) {
        String path = url.getPath();
        return path != null && path.matches("^/w/(?:ai|zyy)/api/local-file/[A-Za-z0-9_-]{32}/[^/]+$");
    }

    private static String safeDownloadName(@Nullable String value) {
        String name = value == null ? "download" : value.replaceAll("[\\x00-\\x1f\\x7f\\\\/]+", "_").trim();
        if (name.isEmpty() || ".".equals(name) || "..".equals(name)) name = "download";
        return name.length() > 160 ? name.substring(0, 160) : name;
    }

    private void openDownloadedFile(File file, String mimeType) {
        if (file == null || !file.isFile()) {
            Toast.makeText(this, "下载文件不存在", Toast.LENGTH_SHORT).show();
            return;
        }
        Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", file);
        Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mimeType)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(view);
        } catch (RuntimeException failure) {
            Intent share = new Intent(Intent.ACTION_SEND).setType(mimeType)
                    .putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            try {
                startActivity(Intent.createChooser(share, "分享下载文件"));
            } catch (RuntimeException ignored) {
                Toast.makeText(this, "无法打开下载文件", Toast.LENGTH_SHORT).show();
            }
        }
    }

    private static void addCookie(okhttp3.Request.Builder request, String url) {
        try {
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null && !cookie.isEmpty()) request.header("Cookie", cookie);
        } catch (RuntimeException ignored) {
        }
    }

    private LaunchRequest readLaunchRequest(@Nullable Intent intent) {
        long sequence = ++navigationSequence;
        String target = notificationTargetUrl(intent);
        String selected = target == null && intent != null
                ? intent.getStringExtra("notification_scope") : null;
        if (target != null) selected = Uri.parse(target).getQueryParameter("workspace");
        if (!DshConfig.isScope(selected)) selected = getPreferences(0).getString("scope", DshConfig.DEFAULT_SCOPE);
        return new LaunchRequest(sequence, DshConfig.scopeOrDefault(selected), target);
    }

    private boolean isCurrentLaunch(LaunchRequest request) {
        return launchRequest == request && request.sequence == navigationSequence;
    }

    private void beginNotificationNavigation(LaunchRequest request) {
        boolean firstEntry = pendingNotificationRequest != request;
        pendingNotificationRequest = request;
        if (firstEntry) {
            diagnosticEvent(request.scope, "android-app", "started", "notification_open", request.traceId, pageId,
                    threadIdFromUri(request.target == null ? null : Uri.parse(request.target)), request.startedAt,
                    null, null, null, -1);
        }
        if (webView != null) webView.setVisibility(View.VISIBLE);
        pendingListSequence = -1L;
        // Route immediately in the existing visible document. Only a failure
        // shows the compact retry banner; opening never hides the WebView.
        if (notificationOverlay != null) notificationOverlay.setVisibility(View.GONE);
        uiHandler.removeCallbacks(notificationWaitTimeout);
        uiHandler.postDelayed(notificationWaitTimeout, NOTIFICATION_WAIT_TIMEOUT_MILLIS);
    }

    private void revealNotification(LaunchRequest request) {
        if (!isCurrentLaunch(request) || pendingNotificationRequest != request || webView == null) return;
        diagnosticEvent(request.scope, "android-app", "connected", "notification_ready", request.traceId, pageId,
                threadIdFromUri(request.target == null ? null : Uri.parse(request.target)), request.startedAt,
                null, null, null, -1);
        pendingNotificationRequest = null;
        pendingListSequence = -1L;
        uiHandler.removeCallbacks(notificationWaitTimeout);
        if (notificationOverlay != null) notificationOverlay.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
    }

    private void onNotificationWaitTimeout() {
        LaunchRequest request = pendingNotificationRequest;
        if (request == null || !isCurrentLaunch(request) || webView == null) return;
        diagnosticEvent(request.scope, "android-app", "failed", "navigation_timeout", request.traceId, pageId,
                threadIdFromUri(request.target == null ? null : Uri.parse(request.target)), request.startedAt,
                null, null, null, -1);
        if (notificationOverlayLabel != null) notificationOverlayLabel.setText("通知暂时无法打开");
        if (notificationRetryButton != null) notificationRetryButton.setVisibility(View.VISIBLE);
        if (notificationBackButton != null) notificationBackButton.setVisibility(View.VISIBLE);
        if (notificationOverlay != null) {
            notificationOverlay.setVisibility(View.VISIBLE);
            notificationOverlay.bringToFront();
        }
    }

    private void retryNotificationNavigation() {
        LaunchRequest current = pendingNotificationRequest;
        if (current == null || current.target == null || !isCurrentLaunch(current)) return;
        diagnosticEvent(current.scope, "android-app", "attempt", "notification_open", current.traceId, pageId,
                threadIdFromUri(Uri.parse(current.target)), current.startedAt, null, null, null, -1);
        LaunchRequest retry = new LaunchRequest(++navigationSequence, current.scope, current.target);
        launchRequest = retry;
        openNotificationTarget(retry);
    }

    private boolean cancelNotificationNavigationToList() {
        LaunchRequest notification = pendingNotificationRequest;
        if (notification == null || !isCurrentLaunch(notification) || webView == null) return false;

        diagnosticEvent(notification.scope, "android-app", "cancelled", "navigation_cancelled", notification.traceId, pageId,
                threadIdFromUri(notification.target == null ? null : Uri.parse(notification.target)), notification.startedAt,
                null, null, null, -1);

        LaunchRequest list = new LaunchRequest(++navigationSequence, notification.scope, null);
        launchRequest = list;
        pendingNotificationRequest = null;
        pendingLoginSequence = -1L;
        pendingShellAfterLogin = false;
        pendingListSequence = list.sequence;
        scope = list.scope;
        getPreferences(0).edit().putString("scope", scope).apply();
        webView.stopLoading();
        webView.setVisibility(View.VISIBLE);
        if (notificationOverlay != null) notificationOverlay.setVisibility(View.GONE);
        uiHandler.removeCallbacks(notificationWaitTimeout);

        // A launcher return is navigation within the retained renderer. Do not
        // discard its cache, scroll position or draft merely to cancel a notification.
        WebView current = webView;
        if (hasDshCookie()) {
            current.evaluateJavascript("(()=>{if(window.__DSH_SCOPE__?.id!==" + JSONObject.quote(list.scope)
                    + "||!window.__DSH_NAVIGATION__?.backToList)return false;window.__DSH_NAVIGATION__.backToList();return true;})()", handled -> {
                if (isFinishing() || isDestroyed() || webView != current || !isCurrentLaunch(list)) return;
                if ("true".equals(handled)) pendingListSequence = -1L;
                else loadListPage(list);
            });
        } else loadListPage(list);
        return true;
    }

    private void setPageRelease(@Nullable UiReleaseStore.Release release){
        if(pageRelease==release)return;uiReleaseStore.retainPage(release);UiReleaseStore.Release prior=pageRelease;pageRelease=release;uiReleaseStore.releasePage(prior);
    }

    private void loadListPage(LaunchRequest list) {
        if (!isCurrentLaunch(list) || webView == null) return;
        UiReleaseStore.Release release = uiReleaseStore.activeRelease();
        setPageRelease(release);
        if (release != null && hasDshCookie()) {
            webView.loadUrl(DshConfig.shellUrl(release.shellPath, scope));
        } else if (release != null) {
            pendingShellAfterLogin = true;
            webView.loadUrl(onlineLoginUrl(null));
        } else {
            webView.loadUrl(onlineLoginUrl(null));
        }
    }

    private void loadInitialPage(@Nullable LaunchRequest request) {
        UiReleaseStore.Release release = uiReleaseStore.activeRelease();
        setPageRelease(release);
        String target = request == null ? null : request.target;
        if (target != null) {
            beginNotificationNavigation(request);
            if (hasDshCookie()) loadNotificationPage(request);
            else {
                pendingShellAfterLogin = true;
                pendingLoginSequence = request.sequence;
                webView.loadUrl(onlineLoginUrl(request));
            }
            return;
        }
        if (release != null && hasDshCookie()) {
            webView.loadUrl(DshConfig.shellUrl(release.shellPath, scope));
        } else if (release != null) {
            // A first launch without the SSO cookie must complete the normal
            // top-level login redirect before the credential-free local shell
            // starts its session bootstrap fetches.
            pendingShellAfterLogin = true;
            webView.loadUrl(onlineLoginUrl(null));
        } else {
            pendingShellAfterLogin = true;
            webView.loadUrl(onlineLoginUrl(null));
        }
    }

    private String onlineLoginUrl(@Nullable LaunchRequest request) {
        return DshConfig.ORIGIN + "/?workspace=" + scope + "&view=chat&nativeList=1&pwa=" + scope
                + "&launch=1&androidLogin=1"
                + (request == null || request.target == null ? "" : "&androidReturn=" + Uri.encode(request.target));
    }

    private boolean hasDshCookie() {
        try {
            String cookie = CookieManager.getInstance().getCookie(DshConfig.ORIGIN);
            return cookie != null && !cookie.trim().isEmpty();
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    private void refreshUiInBackground() {
        refreshUiInBackground(true);
    }

    private void scheduleAutomaticUpdates() {
        uiHandler.removeCallbacks(automaticUpdates);
        if (startupDestroyed || !activityResumed || webView == null) return;
        uiHandler.postDelayed(automaticUpdates, 2_000L);
    }

    private void refreshUiInBackground(boolean manual) {
        if (!updateStarted.compareAndSet(false, true)) return;
        uiUpdateExecutor.execute(() -> {
            try {
                android.content.SharedPreferences checks = getSharedPreferences("update-checks", MODE_PRIVATE);
                long now = System.currentTimeMillis(), previous = checks.getLong("ui", 0L);
                if (!manual && previous <= now && now - previous < AUTO_UPDATE_INTERVAL_MS) return;
                UiReleaseStore.UpdateResult result = uiReleaseStore.refresh(DshNetwork.builder(this).build());
                if (result.success) checks.edit().putLong("ui", System.currentTimeMillis()).apply();
            } finally {
                updateStarted.set(false);
                runOnUiThread(() -> {
                    uiHandler.removeCallbacks(applyDownloadedUi);
                    tryApplyDownloadedUi();
                });
            }
        });
    }

    private void tryApplyDownloadedUi() {
        if (isFinishing() || isDestroyed() || webView == null || !activityResumed || pendingNotificationRequest != null) return;
        // Background download prepares the next launch. Only the user's update
        // button may replace this document; returning from a module is not consent.
        if (!pageId.equals(uiApplyPageId)) return;
        UiReleaseStore.Release next = uiReleaseStore.activeRelease();
        if (next == null || pageRelease == null || next.version.equals(pageRelease.version)) return;
        String url = webView.getUrl();
        if (url == null || !DshConfig.isDshUri(Uri.parse(url))) return;
        if (fileCallback != null || documentResult != null || !webView.hasWindowFocus()) { uiHandler.postDelayed(applyDownloadedUi, 2000); return; }
        String callbackPageId = pageId;
        UiReleaseStore.Release callbackRelease = pageRelease;
        webView.evaluateJavascript("window.__DSH_ANDROID_CAN_RELOAD__?.()===true", safe -> {
            if (isFinishing() || isDestroyed() || !activityResumed || pendingNotificationRequest != null) return;
            if (!callbackPageId.equals(pageId) || callbackRelease != pageRelease
                    || !"true".equals(safe) || fileCallback != null || documentResult != null
                    || !url.equals(webView.getUrl())) {
                uiHandler.postDelayed(applyDownloadedUi, 2000); return;
            }
            try {
                JSONObject fields = new JSONObject(); fields.put("reason", "ui_apply"); fields.put("traceId", UUID.randomUUID().toString()); fields.put("pageId", pageId);
                fields.put("previousUiVersion", pageRelease.version); fields.put("uiVersion", next.version);
                diagnostics.event(scope, "android-update", "started", fields);
            } catch (JSONException ignored) {}
            setPageRelease(next);
            uiApplyPageId = null;
            String target = Uri.parse(url).getPath();
            webView.loadUrl(target != null && target.startsWith("/dsh-native-assets/") ? DshConfig.shellUrl(next.shellPath, scope) : url);
            diagnosticEvent(scope, "android-update", "committed", "ui_verified", null, pageId,
                    threadIdFromUri(Uri.parse(url)), -1L, null, null, null, -1);
        });
    }

    private void handleApkForegroundEntry() {
        if (apkExternalReturnExpected) {
            apkExternalReturnExpected = false;
            if (apkPermissionSettingsLaunched) {
                apkPermissionSettingsLaunched = false;
                if (canInstallPackages() && startPendingApkInstall()) return;
                apkInstallPromptSuppressed = true;
            } else if (apkInstallerLaunched) {
                apkInstallerLaunched = false;
                diagnosticEvent(scope, "android-update", "received", "install_requested",
                        pendingApkUpdate == null ? null : pendingApkUpdate.traceId, pageId, null, -1L,
                        null, null, null, -1);
                // A canceled or completed installer must not be reopened by
                // this same foreground transition. A later natural entry can
                // run a fresh manifest check.
                apkInstallPromptSuppressed = true;
            }
            return;
        }
        if (apkInstallPromptSuppressed) {
            apkInstallPromptSuppressed = false;
            if (!hasDshCookie()) {
                apkCheckAfterLoginPending = true;
                return;
            }
            checkApkUpdate(false);
            return;
        }
        if (!hasDshCookie()) {
            apkCheckAfterLoginPending = true;
            return;
        }
        checkApkUpdate(false);
    }

    private void checkAllUpdates() {
        refreshUiInBackground();
        checkApkUpdate();
    }

    private void checkApkUpdate() {
        checkApkUpdate(true);
    }

    private void checkApkUpdate(boolean manual) {
        ApkUpdateManager manager = apkUpdateManager;
        if (!manual && webView == null) return; // local startup owns the first surface
        android.content.SharedPreferences checks = getSharedPreferences("update-checks", MODE_PRIVATE);
        long now = System.currentTimeMillis(), previous = checks.getLong("apk", 0L);
        if (!manual && previous <= now && now - previous < AUTO_UPDATE_INTERVAL_MS) return;
        if (manager == null || apkDownloadStarted.get() || !appUpdateStarted.compareAndSet(false, true)) return;
        apkUpdateExecutor.execute(() -> {
            ApkUpdateManager.CheckResult update = null;
            try {
                update = manager.check(DshNetwork.builder(this).build());
                if (update != null) checks.edit().putLong("apk", System.currentTimeMillis()).apply();
            } finally {
                appUpdateStarted.set(false);
            }
            ApkUpdateManager.CheckResult result = update;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                boolean retryAfterLogin = apkCheckAfterLoginPending;
                apkCheckAfterLoginPending = false;
                if (result == null) {
                    if (manual) Toast.makeText(this, "暂时无法检查应用更新", Toast.LENGTH_SHORT).show();
                    if (retryAfterLogin && hasDshCookie()) checkApkUpdate(false);
                } else if (!result.available) {
                    pendingApkFile = null;
                    pendingApkUpdate = null;
                    if (manual) Toast.makeText(this, "应用已是最新版本", Toast.LENGTH_SHORT).show();
                } else {
                    pendingApkUpdate = result;
                    if (manual) {
                        new AlertDialog.Builder(this)
                                .setTitle("发现应用更新")
                                .setMessage(result.versionName)
                                .setNegativeButton("稍后", null)
                                .setPositiveButton("下载并安装", (dialog, which) -> downloadApkUpdate(manager, result))
                                .show();
                    } else {
                        downloadApkUpdate(manager, result, false);
                    }
                }
            });
        });
    }

    private void requestApkCheckAfterLogin() {
        apkCheckAfterLoginPending = true;
        if (!appUpdateStarted.get()) {
            apkCheckAfterLoginPending = false;
            checkApkUpdate(false);
        }
    }

    private void downloadApkUpdate(ApkUpdateManager manager, ApkUpdateManager.CheckResult update) {
        downloadApkUpdate(manager, update, true);
    }

    private void downloadApkUpdate(ApkUpdateManager manager, ApkUpdateManager.CheckResult update, boolean manual) {
        if (manager == null || update == null || !update.available
                || !apkDownloadStarted.compareAndSet(false, true)) return;
        pendingApkUpdate = update;
        if (manual) Toast.makeText(this, "正在下载应用更新", Toast.LENGTH_SHORT).show();
        apkUpdateExecutor.execute(() -> {
            File apk = null;
            try {
                apk = manager.download(update, DshNetwork.builder(this).build());
            } finally {
                apkDownloadStarted.set(false);
            }
            File result = apk;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (result == null) {
                    if (manual) Toast.makeText(this, "应用更新下载失败", Toast.LENGTH_SHORT).show();
                    return;
                }
                pendingApkFile = result;
                pendingApkUpdate = update;
                startPendingApkInstall();
            });
        });
    }

    private boolean startPendingApkInstall() {
        if (!activityResumed || apkInstallPromptSuppressed || apkExternalReturnExpected || apkInstallerLaunched
                || apkPermissionSettingsLaunched) return false;
        File apk = pendingApkFile;
        ApkUpdateManager manager = apkUpdateManager;
        if (apk == null || manager == null) return false;
        if (!apk.isFile()) {
            pendingApkFile = null;
            pendingApkUpdate = null;
            return false;
        }
        if (!canInstallPackages()) {
            diagnosticEvent(scope, "android-update", "skipped", "permission_required",
                    pendingApkUpdate == null ? null : pendingApkUpdate.traceId, pageId, null, -1L,
                    null, null, null, -1);
            openInstallPermissionSettings();
            return true;
        }
        try {
            diagnosticEvent(scope, "android-update", "attempt", "install_requested",
                    pendingApkUpdate == null ? null : pendingApkUpdate.traceId, pageId, null, -1L,
                    null, null, null, -1);
            apkExternalReturnExpected = true;
            apkInstallerLaunched = true;
            startActivity(manager.installerIntent(apk));
            diagnosticEvent(scope, "android-update", "started", "install_requested",
                    pendingApkUpdate == null ? null : pendingApkUpdate.traceId, pageId, null, -1L,
                    null, null, null, -1);
            return true;
        } catch (Exception failure) {
            apkExternalReturnExpected = false;
            apkInstallerLaunched = false;
            apkInstallPromptSuppressed = true;
            diagnosticEvent(scope, "android-update", "failed", "install_failed",
                    pendingApkUpdate == null ? null : pendingApkUpdate.traceId, pageId, null, -1L,
                    null, null, null, -1);
            Toast.makeText(this, "无法打开安装程序", Toast.LENGTH_SHORT).show();
            return true;
        }
    }

    private boolean canInstallPackages() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O
                || getPackageManager().canRequestPackageInstalls();
    }

    private void openInstallPermissionSettings() {
        Toast.makeText(this, "请先允许安装未知应用", Toast.LENGTH_LONG).show();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            Intent intent = new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getPackageName()));
            apkExternalReturnExpected = true;
            apkPermissionSettingsLaunched = true;
            startActivity(intent);
            diagnosticEvent(scope, "android-update", "started", "permission_required",
                    pendingApkUpdate == null ? null : pendingApkUpdate.traceId, pageId, null, -1L,
                    null, null, null, -1);
        } catch (RuntimeException ignored) {
            apkExternalReturnExpected = false;
            apkPermissionSettingsLaunched = false;
            diagnosticEvent(scope, "android-update", "failed", "install_failed",
                    pendingApkUpdate == null ? null : pendingApkUpdate.traceId, pageId, null, -1L,
                    null, null, null, -1);
            Toast.makeText(this, "无法打开安装权限设置", Toast.LENGTH_SHORT).show();
        }
    }

    private void showNativeSettings() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(22), dp(4), dp(22), 0);

        Switch sync = new Switch(this);
        Switch enhanced = new Switch(this);
        Switch completion = new Switch(this);
        TextView backgroundStatus = new TextView(this);
        Button battery = compactButton("检查电池优化豁免");
        Button reconnect = compactButton("立即重连");
        Button ownerButton = compactButton("选择设备使用者");
        TextView ownerInfo = new TextView(this);
        ownerInfo.setText("临时切换工作区不会改变通知归属。更换使用者会关闭旧提醒与后台同步。");
        boolean[] painting = {false};
        Runnable refresh = () -> {
            painting[0] = true;
            String owner = SyncForegroundService.deviceOwner(this);
            String selected = SyncForegroundService.syncScope(this, scope);
            ownerButton.setText("设备使用者：" + (owner.isEmpty() ? "请选择" : "ai".equals(owner) ? "Whytan（AI）" : "ZYY"));
            JSONObject state = SyncForegroundService.statusSnapshot(this, selected);
            sync.setText("常驻通知与后台同步（" + selected.toUpperCase(java.util.Locale.ROOT) + "）");
            sync.setChecked(state.optBoolean("enabled", false));
            enhanced.setText("加强后台连接（更耗电）");
            enhanced.setChecked(SyncForegroundService.isEnhanced(this));
            reconnect.setEnabled(state.optBoolean("enabled", false));
            JSONObject conditions = state.optJSONObject("background");
            battery.setText(conditions != null && conditions.optBoolean("batteryExempt") ? "电池优化：已豁免" : "申请不受电池优化限制");
            backgroundStatus.setText(backgroundStatusText(state));
            completion.setText("任务完成提醒" + (owner.isEmpty() ? "（请先选择使用者）" : "（" + owner.toUpperCase(java.util.Locale.ROOT) + "）"));
            completion.setEnabled(!owner.isEmpty());
            completion.setChecked(SyncForegroundService.areCompletionNotificationsEnabled(this));
            painting[0] = false;
        };
        ownerButton.setOnClickListener(view -> showDeviceOwnerPicker(refresh));
        panel.addView(ownerButton, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));
        panel.addView(ownerInfo, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        sync.setOnCheckedChangeListener((button, checked) -> {
            if (painting[0]) return;
            try {
                if (checked) {
                    SyncForegroundService.startSync(this, scope);
                    requestNotificationPermissionIfNeeded();
                } else SyncForegroundService.stopSync(this, SyncForegroundService.syncScope(this, scope));
            } catch (RuntimeException failure) { Toast.makeText(this, "后台同步未启动，请重试", Toast.LENGTH_SHORT).show(); }
            refresh.run();
        });
        panel.addView(sync, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));
        enhanced.setOnCheckedChangeListener((button, checked) -> {
            if (painting[0]) return;
            try {
                if (checked) {
                    SyncForegroundService.startSync(this, scope);
                    requestNotificationPermissionIfNeeded();
                }
                SyncForegroundService.setEnhanced(this, checked);
            } catch (RuntimeException failure) { Toast.makeText(this, "加强后台模式未开启，请检查后台与通知权限", Toast.LENGTH_LONG).show(); }
            refresh.run();
        });
        panel.addView(enhanced, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));
        TextView enhancedInfo = new TextView(this);
        enhancedInfo.setText("有任务或正文待同步时，加强模式可在息屏后帮助接收更新。任务完成后自动省电，释放唤醒并降低核对频率；重新打开立即补齐。强制停止 App 后需要重新打开。");
        panel.addView(enhancedInfo);
        backgroundStatus.setPadding(0, dp(10), 0, dp(6));
        panel.addView(backgroundStatus);
        reconnect.setOnClickListener(view -> { SyncForegroundService.reconnectEnabled(this); refresh.run(); });
        panel.addView(reconnect, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));
        battery.setOnClickListener(view -> openBatteryExemptionSettings());
        panel.addView(battery, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));
        Button appSettings = compactButton("打开系统应用设置");
        appSettings.setOnClickListener(view -> {
            try { startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))); }
            catch (RuntimeException ignored) { Toast.makeText(this, "请在系统设置中搜索 Codex 工作台", Toast.LENGTH_SHORT).show(); }
        });
        panel.addView(appSettings, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));
        if ((Build.MANUFACTURER + " " + Build.BRAND).toLowerCase(java.util.Locale.ROOT).contains("vivo")
                || Build.BRAND.toLowerCase(java.util.Locale.ROOT).contains("iqoo")) {
            TextView vivoHelp = new TextView(this);
            vivoHelp.setText("vivo / iQOO：在系统设置中检查自启动、允许后台高耗电和后台联网；在最近任务卡片中给 App 加锁。不同 OriginOS 版本入口可能不同，可搜索这些名称。");
            panel.addView(vivoHelp);
        }
        completion.setOnCheckedChangeListener((button, checked) -> {
            if (painting[0]) return;
            try {
                SyncForegroundService.setCompletionNotificationsEnabled(this, checked);
                if (checked) requestNotificationPermissionIfNeeded();
            } catch (RuntimeException failure) { Toast.makeText(this, "完成提醒未开启，请检查使用者和后台权限", Toast.LENGTH_SHORT).show(); }
            refresh.run();
        });
        panel.addView(completion, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));
        refresh.run();

        addPhoneCodeSettings(panel);

        Button uiUpdate = compactButton("检查并应用界面更新");
        uiUpdate.setOnClickListener(view -> { uiApplyPageId = pageId; refreshUiInBackground(); });
        panel.addView(uiUpdate, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));

        Button apkUpdate = compactButton("检查应用更新");
        apkUpdate.setOnClickListener(view -> checkApkUpdate());
        panel.addView(apkUpdate, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));

        Button notifications = compactButton("打开系统通知设置");
        notifications.setOnClickListener(view -> openNotificationSettings());
        panel.addView(notifications, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));

        android.widget.ScrollView settingsScroll = new android.widget.ScrollView(this);
        settingsScroll.addView(panel);
        AlertDialog settingsDialog = new AlertDialog.Builder(this)
                .setTitle("应用与后台")
                .setView(settingsScroll)
                .setNegativeButton("关闭", null)
                .create();
        Runnable ticker = new Runnable() {
            @Override public void run() {
                if (!settingsDialog.isShowing() || isFinishing() || isDestroyed()) return;
                refresh.run(); uiHandler.postDelayed(this, 2_000L);
            }
        };
        settingsDialog.setOnDismissListener(dialog -> { uiHandler.removeCallbacks(ticker); SyncForegroundService.setPresentationActive(activityResumed); });
        SyncForegroundService.setPresentationActive(false);
        settingsDialog.show();
        uiHandler.post(ticker);
    }

    private void addPhoneCodeSettings(LinearLayout panel) {
        TextView title = new TextView(this);
        title.setText("短信验证码"); title.setTypeface(null, Typeface.BOLD); title.setPadding(0, dp(20), 0, dp(8)); panel.addView(title);
        TextView description = new TextView(this);
        description.setText("Mac 请求时，自动返回近期匹配的验证码。无请求时不读取短信，短信原文留在手机。开启后自动绑定当前登录的 Mac，并申请系统短信权限；部分系统可能限制验证码读取。"); panel.addView(description);
        TextView status = new TextView(this); status.setPadding(0, dp(8), 0, dp(4)); panel.addView(status);
        Switch automatic = new Switch(this); automatic.setText("自动响应 Mac 验证码请求"); boolean[] painting = {false};
        Runnable update = () -> { painting[0] = true; automatic.setChecked(PhoneCodeSettings.enabled(this)); automatic.setEnabled(!phoneCodeBinding && !phoneCodeEnablePending); status.setText(phoneCodeBinding ? "正在绑定 Mac…" : PhoneCodeSettings.status(this)); painting[0] = false; };
        automatic.setOnCheckedChangeListener((button, checked) -> {
            if (painting[0]) return;
            if (checked) { enablePhoneCodes(); update.run(); return; }
            phoneCodeEnablePending = false;
            PhoneCodeSettings.setEnabled(this, false); SyncForegroundService.refreshPhoneCode(this); update.run();
        }); panel.addView(automatic, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));
        Button forget = compactButton("解除此手机的绑定"); forget.setOnClickListener(view -> {
            new AlertDialog.Builder(this).setTitle("解除验证码绑定")
                    .setMessage("解除后 Mac 无法再从此手机请求验证码。重新开启此功能可恢复。")
                    .setNegativeButton("取消", null).setPositiveButton("解除", (dialog, which) -> { phoneCodeEnablePending = false; PhoneCodeSettings.forgetBinding(this); SyncForegroundService.refreshPhoneCode(this); update.run(); }).show();
        }); panel.addView(forget, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));
        // Only keep this small status refresh while its settings view is attached.
        Runnable tick = new Runnable() { public void run() { if (!status.isAttachedToWindow()) return; update.run(); status.postDelayed(this, 2000); } };
        status.addOnAttachStateChangeListener(new View.OnAttachStateChangeListener() {
            public void onViewAttachedToWindow(View view) { status.post(tick); }
            public void onViewDetachedFromWindow(View view) { status.removeCallbacks(tick); }
        }); update.run();
    }

    private void enablePhoneCodes() {
        if (phoneCodeBinding || phoneCodeEnablePending) return;
        if (!"ai".equals(SyncForegroundService.deviceOwner(this))) { Toast.makeText(this, "请先将设备使用者设为 Whytan（AI）", Toast.LENGTH_LONG).show(); return; }
        if (!PhoneCodeReader.hasPermission(this)) {
            phoneCodeEnablePending = true;
            requestPermissions(new String[]{Manifest.permission.READ_SMS}, SMS_PERMISSION_REQUEST);
            return;
        }
        phoneCodeBinding = true;
        ExecutorService bindingWorker = Executors.newSingleThreadExecutor();
        bindingWorker.execute(() -> {
            boolean succeeded = false;
            try { PhoneCodeClient.bind(this); succeeded = true; } catch (Exception ignoredFailure) { /* Binding credentials never enter logs. */ }
            final boolean ok = succeeded;
            runOnUiThread(() -> {
                phoneCodeBinding = false;
                if (isFinishing() || isDestroyed()) return;
                if (!ok) { Toast.makeText(this, "绑定失败，请检查 App 登录；若已绑定其他手机，请先在 Mac 解除旧绑定", Toast.LENGTH_LONG).show(); return; }
                if (!"ai".equals(SyncForegroundService.deviceOwner(this)) || !PhoneCodeReader.hasPermission(this)) return;
                PhoneCodeSettings.setEnabled(this, true);
                try { SyncForegroundService.startSync(this, "ai"); requestNotificationPermissionIfNeeded(); }
                catch (RuntimeException failure) { PhoneCodeSettings.setEnabled(this, false); Toast.makeText(this, "后台服务未启动，请重试", Toast.LENGTH_LONG).show(); }
                SyncForegroundService.refreshPhoneCode(this);
            });
            bindingWorker.shutdown();
        });
    }

    private String backgroundStatusText(JSONObject state) {
        boolean enabled = state.optBoolean("enabled"), running = state.optBoolean("running");
        String text = !enabled ? "后台同步未开启" : !running ? "已开启，但服务尚未运行" :
                !state.optBoolean("transportConnected") ? "后台服务运行中，连接正在恢复" :
                state.optBoolean("hostOnline") ? "后台服务运行中，手机与电脑端已连接" : "手机已连接，电脑端暂未在线";
        if ("auth_required".equals(state.optString("state"))) text += "\n登录已过期，请回到 App 重新登录";
        long at = state.optLong("lastSuccessfulSyncAt");
        text += at > 0 ? "\n最近成功同步：" + android.text.format.DateFormat.format("HH:mm:ss", at) : "\n尚无本次启动后的成功同步记录";
        text += " · 断线 " + state.optLong("disconnectCount") + " 次";
        JSONObject conditions = state.optJSONObject("background");
        if (conditions != null) {
            if (!conditions.optBoolean("syncNotificationAllowed")) text += "\n常驻通知被关闭，加强唤醒暂不启用";
            if (!conditions.optBoolean("batteryExempt")) text += "\n系统电池优化尚未豁免";
            if (conditions.optBoolean("backgroundRestricted")) text += "\n系统正在限制后台运行";
            if (conditions.optBoolean("deviceIdle")) text += "\n设备处于系统休眠模式";
            if (conditions.optBoolean("wakeHeld")) text += "\n加强后台唤醒已启用";
        }
        return text + "\n" + Build.MANUFACTURER + " " + Build.MODEL + " · Android " + Build.VERSION.RELEASE;
    }

    private void openBatteryExemptionSettings() {
        android.os.PowerManager power = getSystemService(android.os.PowerManager.class);
        try {
            boolean exempt = power != null && power.isIgnoringBatteryOptimizations(getPackageName());
            Intent intent = new Intent(exempt ? android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS
                    : android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            if (!exempt) intent.setData(Uri.parse("package:" + getPackageName()));
            startActivity(intent);
        } catch (RuntimeException unavailable) {
            try { startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))); }
            catch (RuntimeException ignored) { Toast.makeText(this, "请在系统设置中搜索电池优化", Toast.LENGTH_SHORT).show(); }
        }
    }

    private void showDeviceOwnerPicker(Runnable onSaved) {
        String previous = SyncForegroundService.deviceOwner(this);
        int[] choice = {"ai".equals(previous) ? 0 : "zyy".equals(previous) ? 1 : -1};
        AlertDialog picker = new AlertDialog.Builder(this)
                .setTitle("这台设备由谁使用")
                .setSingleChoiceItems(new String[]{"Whytan（AI）", "ZYY"}, choice[0], (dialog, which) -> choice[0] = which)
                .setNegativeButton("取消", null).setPositiveButton("保存", null).create();
        picker.setOnShowListener(ignored -> picker.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            if (choice[0] < 0) { Toast.makeText(this, "请选择使用者", Toast.LENGTH_SHORT).show(); return; }
            String selected = choice[0] == 0 ? "ai" : "zyy";
            Runnable save = () -> {
                SyncForegroundService.setDeviceOwner(this, selected);
                picker.dismiss();
                onSaved.run();
            };
            if (!previous.isEmpty() && !previous.equals(selected)) {
                new AlertDialog.Builder(this).setTitle("更换设备使用者")
                        .setMessage("将关闭原使用者的提醒与后台同步。保存后，请重新开启完成提醒。")
                        .setNegativeButton("取消", null).setPositiveButton("确认更换", (dialog, which) -> save.run()).show();
            } else save.run();
        }));
        picker.show();
    }

    private void openNotificationSettings() {
        try {
            Intent intent = new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getPackageName());
            startActivity(intent);
        } catch (RuntimeException ignored) {
            Toast.makeText(this, "无法打开通知设置", Toast.LENGTH_SHORT).show();
        }
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                && !getPreferences(0).getBoolean("notification_permission_asked", false)
                && notificationPermissionRequestStarted.compareAndSet(false, true)) {
            // The first request has no rationale yet. Gate on the explicit
            // start action rather than shouldShowRequestPermissionRationale so
            // the initial Android permission dialog is actually reachable.
            getPreferences(0).edit().putBoolean("notification_permission_asked", true).apply();
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_REQUEST);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == NOTIFICATION_REQUEST) notificationPermissionRequestStarted.set(false);
        if (requestCode == SMS_PERMISSION_REQUEST) {
            boolean requested = phoneCodeEnablePending; phoneCodeEnablePending = false;
            if (PhoneCodeReader.hasPermission(this)) { if (requested) enablePhoneCodes(); return; }
            PhoneCodeSettings.setEnabled(this, false); SyncForegroundService.refreshPhoneCode(this);
            Toast.makeText(this, "短信权限未授予；若系统限制此权限，请在应用信息中检查。验证码功能尚未开启。", Toast.LENGTH_LONG).show();
        }
    }

    private boolean isNotificationDocument(LaunchRequest request, Uri page) {
        if (request == null || request.target == null || !DshConfig.isDshUri(page)) return false;
        Uri target = Uri.parse(request.target);
        if (!request.scope.equals(page.getQueryParameter("workspace"))) return false;
        if (target.getPath().equals(page.getPath())) return true;
        UiReleaseStore.Release release = pageRelease;
        return release != null && release.shellPath.equals(page.getPath())
                && target.getLastPathSegment() != null
                && target.getLastPathSegment().equals(page.getQueryParameter("notificationThread"));
    }

    private boolean isNotificationLoginDocument(LaunchRequest request, Uri page) {
        if (request == null || request.target == null || !isCurrentLaunch(request)
                || pendingNotificationRequest != request || !pendingShellAfterLogin
                || request.sequence != pendingLoginSequence) return false;
        if (DshConfig.isAllowedSsoPath(page)) return true;
        if (!DshConfig.isDshUri(page) || isNotificationDocument(request, page)) return false;
        String path = page.getPath();
        return "1".equals(page.getQueryParameter("androidLogin"))
                || "/".equals(path)
                || "/login".equals(path)
                || (path != null && path.startsWith("/login/"));
    }

    private boolean isPendingListDocument(Uri page) {
        if (pendingListSequence < 0L || launchRequest == null
                || launchRequest.sequence != pendingListSequence) return false;
        if (DshConfig.isAllowedSsoPath(page)) return true;
        if (!DshConfig.isDshUri(page)) return false;
        String path = page.getPath();
        if ("1".equals(page.getQueryParameter("androidLogin"))
                || "/".equals(path)
                || "/login".equals(path)
                || (path != null && path.startsWith("/login/"))) return true;
        UiReleaseStore.Release release = pageRelease;
        return release != null && release.shellPath.equals(path)
                && page.getQueryParameter("notificationThread") == null
                && page.getQueryParameter("fromNotification") == null;
    }

    @Nullable
    private String validatedConversationUrl(@Nullable String value) {
        if (value == null) return null;
        try {
            Uri url = Uri.parse(value.startsWith("/") ? DshConfig.ORIGIN + value : value);
            String path = url.getPath(), selected = url.getQueryParameter("workspace");
            if (!DshConfig.isDshUri(url) || !DshConfig.isScope(selected) || path == null
                    || !path.startsWith("/local/") || !THREAD_ID.matcher(path.substring(7)).matches()) return null;
            String turn = url.getQueryParameter("notificationTurn");
            if (turn != null && !THREAD_ID.matcher(turn).matches()) return null;
            return DshConfig.ORIGIN + path + "?workspace=" + selected + "&view=chat&pwa=" + selected + "&fromNotification=1"
                    + (turn == null ? "" : "&notificationTurn=" + Uri.encode(turn));
        } catch (RuntimeException invalid) { return null; }
    }

    @Nullable
    private String notificationTargetUrl(@Nullable Intent intent) {
        if (intent == null) return null;
        String selected = intent.getStringExtra("notification_scope"), thread = intent.getStringExtra("notification_thread");
        if (!DshConfig.isScope(selected) || thread == null || !THREAD_ID.matcher(thread).matches()) return null;
        String turn = intent.getStringExtra("notification_turn");
        if (turn != null && !THREAD_ID.matcher(turn).matches()) return null;
        return validatedConversationUrl(DshConfig.ORIGIN + "/local/" + thread + "?workspace=" + selected
                + (turn == null ? "" : "&notificationTurn=" + Uri.encode(turn)));
    }

    private void openNotificationTarget(LaunchRequest request) {
        if (request == null || request.target == null || webView == null) return;
        launchRequest = request;
        scope = request.scope;
        getPreferences(0).edit().putString("scope", scope).apply();
        beginNotificationNavigation(request);
        if (hasDshCookie()) {
            WebView current = webView;
            String script = "(()=>{const nav=window.__DSH_NAVIGATION__;return !!nav?.openConversation("
                    + JSONObject.quote(request.target) + ");})()";
            current.evaluateJavascript(script, handled -> {
                if (isFinishing() || isDestroyed() || webView != current || !isCurrentLaunch(request)) return;
                if (!"true".equals(handled)) {
                    diagnosticEvent(request.scope, "android-app", "received", "notification_open", request.traceId,
                            pageId, threadIdFromUri(Uri.parse(request.target)), request.startedAt, null, null, null, -1);
                    loadNotificationPage(request);
                } else {
                    diagnosticEvent(request.scope, "android-app", "connected", "notification_ready", request.traceId,
                            pageId, threadIdFromUri(Uri.parse(request.target)), request.startedAt, null, null, null, -1);
                    revealNotification(request);
                }
            });
        } else {
            pendingShellAfterLogin = true;
            pendingLoginSequence = request.sequence;
            webView.loadUrl(onlineLoginUrl(request));
        }
    }

    /** Cold notification launches use the installed, checksum verified UI shell. */
    private void loadNotificationPage(LaunchRequest request) {
        if (request == null || request.target == null || webView == null || !isCurrentLaunch(request)) return;
        Uri conversation = Uri.parse(request.target);
        UiReleaseStore.Release release = uiReleaseStore.activeRelease();
        setPageRelease(release);
        scope = request.scope;
        beginNotificationNavigation(request);
        if (release == null) { webView.loadUrl(request.target); return; }
        String thread = conversation.getLastPathSegment();
        if (thread == null || !THREAD_ID.matcher(thread).matches()) return;
        String local = DshConfig.ORIGIN + release.shellPath + "?workspace=" + scope
                + "&view=chat&pwa=" + scope + "&fromNotification=1&notificationThread=" + Uri.encode(thread)
                + (conversation.getQueryParameter("notificationTurn") == null ? "" : "&notificationTurn="
                + Uri.encode(conversation.getQueryParameter("notificationTurn")));
        pendingShellAfterLogin = false;
        pendingLoginSequence = -1L;
        webView.loadUrl(local);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (webView == null) {
            launchRequest = readLaunchRequest(intent);
            scope = launchRequest.scope;
            if (apkUpdateManager != null) apkUpdateManager.setDiagnosticScope(scope);
            return;
        }
        String incomingScope = intent == null ? null : intent.getStringExtra("notification_scope");
        if (DshConfig.isScope(incomingScope)) {
            diagnosticEvent(incomingScope, "android-app", "received", "new_intent", null, pageId, null,
                    -1L, null, null, null, -1);
        } else {
            diagnosticEvent(scope, "android-app", "received", "new_intent", null, pageId, null,
                    -1L, null, null, null, -1);
        }
        if (notificationTargetUrl(intent) == null && pendingNotificationRequest != null) {
            cancelNotificationNavigationToList();
            if (intent != null && intent.getBooleanExtra("open_background_settings", false)) showNativeSettings();
            return;
        }
        LaunchRequest request = readLaunchRequest(intent);
        launchRequest = request;
        if (request.target != null) {
            diagnosticEvent(request.scope, "android-app", "attempt", "notification_open", request.traceId, pageId,
                    threadIdFromUri(Uri.parse(request.target)), request.startedAt, null, null, null, -1);
            openNotificationTarget(request);
        }
        if (DshConfig.isScope(request.scope)) {
            scope = request.scope;
            if (uiReleaseStore != null) uiReleaseStore.setDiagnosticScope(scope);
            if (apkUpdateManager != null) apkUpdateManager.setDiagnosticScope(scope);
        }
        if (intent != null && intent.getBooleanExtra("open_background_settings", false)) showNativeSettings();
    }

    @Override
    protected void onResume() {
        super.onResume();
        boolean enteringForeground = firstForegroundResume || activityStopped;
        firstForegroundResume = false;
        activityStopped = false;
        activityResumed = true;
        SyncForegroundService.setPresentationActive(true);
        SyncForegroundService.setAppVisible(true);
        SyncForegroundService.restoreEnabled(this, true);
        diagnosticEvent(scope, "android-app", "foreground", "foreground",
                launchRequest == null ? null : launchRequest.traceId, pageId, null, -1L,
                null, null, null, -1);
        flushDiagnostics(scope);
        if (webView != null) webView.onResume();
        if (appearance != null) appearance.apply(webView, nativeRoot);
        uiHandler.removeCallbacks(applyDownloadedUi);
        uiHandler.removeCallbacks(automaticUpdates);
        tryApplyDownloadedUi();
        if (enteringForeground && startupSurfaceReady) scheduleAutomaticUpdates();
        if (enteringForeground) handleApkForegroundEntry();
    }

    @Override
    public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        if (appearance != null) appearance.apply(webView, nativeRoot);
    }

    @Override
    public void onTrimMemory(int level) {
        if (level == TRIM_MEMORY_UI_HIDDEN
                || level == TRIM_MEMORY_RUNNING_MODERATE
                || level == TRIM_MEMORY_RUNNING_LOW
                || level == TRIM_MEMORY_RUNNING_CRITICAL
                || level == TRIM_MEMORY_BACKGROUND
                || level == TRIM_MEMORY_COMPLETE) {
            diagnosticEvent(scope, "android-app", "received", "memory_pressure", null, pageId, null, -1L,
                    null, null, null, -1, (long) level);
        }
        super.onTrimMemory(level);
    }

    @Override
    protected void onPause() {
        activityResumed = false;
        uiHandler.removeCallbacks(automaticUpdates);
        SyncForegroundService.setPresentationActive(false);
        diagnosticEvent(scope, "android-app", "background", "background",
                launchRequest == null ? null : launchRequest.traceId, pageId, null, -1L,
                null, null, null, -1);
        flushDiagnostics(scope);
        if (webView != null) webView.onPause();
        try {
            CookieManager.getInstance().flush();
        } catch (RuntimeException ignored) {
        }
        super.onPause();
    }

    @Override
    protected void onStop() {
        activityStopped = true;
        SyncForegroundService.setAppVisible(false);
        diagnosticEvent(scope, "android-app", "stopped", "activity_stop",
                launchRequest == null ? null : launchRequest.traceId, pageId, null, -1L,
                null, null, null, -1);
        super.onStop();
    }

    // Android 13+ uses the platform callback registered above; keep the older button fallback.
    @android.annotation.SuppressLint("GestureBackNavigation")
    @Override
    public void onBackPressed() { handleBackNavigation(); }

    private void handleBackNavigation() {
        if (cancelNotificationNavigationToList()) return;
        if (pendingListSequence >= 0L) {
            pendingListSequence = -1L;
            navigationSequence++;
            launchRequest = null;
            pendingNotificationRequest = null;
            uiHandler.removeCallbacks(notificationWaitTimeout);
            if (webView != null) webView.stopLoading();
            finish();
            return;
        }
        WebView target = webView;
        if (target == null) { super.onBackPressed(); return; }
        target.evaluateJavascript("(()=>{const workbench=window.__DSH_NATIVE_WORKBENCH__;if(workbench?.current){workbench.close();return true;}return window.__DSH_NAVIGATION__?.handleBack?.()===true;})()", handled -> {
            if (isFinishing() || isDestroyed() || webView != target || "true".equals(handled)) return;
            if (target.canGoBack()) target.goBack();
            else MainActivity.super.onBackPressed();
        });
    }

    private static final class LaunchRequest {
        final long sequence;
        final String scope;
        @Nullable final String target;
        final String traceId;
        final long startedAt;

        LaunchRequest(long sequence, String scope, @Nullable String target) {
            this.sequence = sequence;
            this.scope = DshConfig.scopeOrDefault(scope);
            this.target = target;
            this.traceId = UUID.randomUUID().toString();
            this.startedAt = SystemClock.elapsedRealtime();
        }
    }

    private void saveWordDocument(String requestScope, String filename, byte[] bytes, NativeBridge.DocumentResult result) {
        if (isFinishing() || isDestroyed() || !"zyy".equals(requestScope) || !requestScope.equals(scope) || documentResult != null) {
            result.complete(false, false); return;
        }
        documentBytes = bytes;
        documentResult = result;
        String name = filename.replaceAll("[\\x00-\\x1f\\x7f\\\\/]+", "_");
        Intent picker = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
                .putExtra(Intent.EXTRA_TITLE, name);
        try { startActivityForResult(picker, DOCUMENT_EXPORT_REQUEST); }
        catch (RuntimeException failure) { documentBytes = null; documentResult = null; result.complete(false, false); }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == DOCUMENT_EXPORT_REQUEST) {
            NativeBridge.DocumentResult callback = documentResult;
            byte[] bytes = documentBytes;
            documentResult = null; documentBytes = null;
            if (callback == null) return;
            Uri target = data == null ? null : data.getData();
            if (resultCode != RESULT_OK || target == null || bytes == null) { callback.complete(false, true); return; }
            background.execute(() -> {
                boolean saved = false;
                try (OutputStream output = getContentResolver().openOutputStream(target, "w")) {
                    if (output == null) throw new IOException("document output unavailable");
                    output.write(bytes); output.flush(); saved = true;
                } catch (IOException | RuntimeException ignored) {}
                boolean success = saved;
                runOnUiThread(() -> callback.complete(success, false));
            });
            return;
        }
        if (requestCode != FILE_CHOOSER_REQUEST || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                result = new Uri[count];
                for (int index = 0; index < count; index++) result[index] = data.getClipData().getItemAt(index).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    protected void onDestroy() {
        startupDestroyed = true;
        hideStartupCover();
        diagnosticEvent(scope, "android-app", "closed", "activity_destroy",
                launchRequest == null ? null : launchRequest.traceId, pageId, null, -1L,
                null, null, null, -1);
        flushDiagnostics(scope);
        uiHandler.removeCallbacks(applyDownloadedUi);
        uiHandler.removeCallbacks(automaticUpdates);
        uiHandler.removeCallbacks(notificationWaitTimeout);
        if (documentResult != null) { documentResult.complete(false, true); documentResult = null; documentBytes = null; }
        if (fileCallback != null) {
            fileCallback.onReceiveValue(null);
            fileCallback = null;
        }
        try {
            unregisterReceiver(statusReceiver);
        } catch (IllegalArgumentException ignored) {
        }
        if (bridge != null) bridge.close();
        if (startingWebView != null) {
            startingWebView.stopLoading();
            startingWebView.destroy();
            startingWebView = null;
        }
        if (webView != null) {
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
        }
        background.shutdownNow();
        uiUpdateExecutor.shutdownNow();
        if (apkUpdateManager != null) apkUpdateManager.close();
        apkUpdateExecutor.shutdownNow();
        if (syncStore != null) syncStore.close();
        if (uiReleaseStore != null) {setPageRelease(null);uiReleaseStore.close();}
        super.onDestroy();
    }

    private final class DshWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handleNavigation(request.getUrl(), request.isForMainFrame());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleNavigation(Uri.parse(url), true);
        }

        private boolean handleNavigation(Uri url, boolean mainFrame) {
            if (!mainFrame) return false;
            if (DshConfig.isDshUri(url)) return false;
            if (DshConfig.isAllowedSsoPath(url)) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, url));
            } catch (RuntimeException ignored) {
                Toast.makeText(MainActivity.this, "无法打开链接", Toast.LENGTH_SHORT).show();
            }
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (!request.isForMainFrame() && !DshConfig.isDshUri(url)) return super.shouldInterceptRequest(view, request);
            if (!DshConfig.isDshUri(url) || !"GET".equalsIgnoreCase(request.getMethod())) return super.shouldInterceptRequest(view, request);
            WebResourceResponse cached=DeliverableCache.get(MainActivity.this).intercept(url,scope,request.getRequestHeaders().get("Range"),hasDshCookie());
            if(cached!=null)return cached;
            if (request.isForMainFrame() && isPinnedShellRoute(url) && hasDshCookie()) {
                UiReleaseStore.LocalResource shell = uiReleaseStore.localResource(pageRelease == null ? null : pageRelease.shellPath, pageRelease);
                if (shell != null) {
                    pinnedMainFrameResponse = true;
                    diagnosticEvent(scope, "android-update", "committed", "ui_cached", null, pageId,
                            threadIdFromUri(url), -1L, null, null, null, 200);
                    return new WebResourceResponse(shell.mime, "UTF-8", 200, "OK", null, shell.stream);
                }
                diagnosticEvent(scope, "android-update", "failed", "ui_failed", null, pageId,
                        threadIdFromUri(url), -1L, null, null, null, -1);
            }
            UiReleaseStore.LocalResource resource = uiReleaseStore.localResource(url.getPath(), pageRelease);
            if (resource == null) return super.shouldInterceptRequest(view, request);
            return new WebResourceResponse(resource.mime, null, 200, "OK", null, resource.stream);
        }

        private boolean isPinnedShellRoute(Uri url) {
            if (isAuthOrLogoutNavigation(url)) return false;
            String path = url.getPath();
            if ("/".equals(path)) return true;
            return path != null && path.matches("^/local/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");
        }

        private boolean isAuthOrLogoutNavigation(Uri url) {
            String path = url.getPath();
            if (path != null && (path.equals("/login") || path.startsWith("/login/")
                    || path.equals("/logout") || path.startsWith("/logout/")
                    || path.equals("/sso") || path.startsWith("/sso/")
                    || path.equals("/auth") || path.startsWith("/auth/"))) return true;
            return "1".equals(url.getQueryParameter("androidLogin"))
                    || "1".equals(url.getQueryParameter("logout"))
                    || "1".equals(url.getQueryParameter("sso"));
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            beginPageNavigation(url);
            diagnosticEvent(scope, "android-webview", "attempt", "page_started", null, pageId,
                    threadIdFromUri(Uri.parse(url)), pageStartedAt, null, null, null, -1);
            bridge.clearProxy();
            Uri started = Uri.parse(url);
            pinnedMainFrameResponse = false;
            if ("1".equals(started.getQueryParameter("androidLogin"))) {
                pendingShellAfterLogin = true;
                String returned = validatedConversationUrl(started.getQueryParameter("androidReturn"));
                if (returned != null) {
                    LaunchRequest current = launchRequest;
                    if (current != null && current.target != null && !current.target.equals(returned)) return;
                    if (current == null || current.target == null) {
                        current = new LaunchRequest(++navigationSequence,
                                Uri.parse(returned).getQueryParameter("workspace"), returned);
                        launchRequest = current;
                    }
                    pendingLoginSequence = current.sequence;
                    scope = current.scope;
                    beginNotificationNavigation(current);
                }
            }
            super.onPageStarted(view, url, favicon);
        }

        @Override
        public void onPageCommitVisible(WebView view, String url) {
            super.onPageCommitVisible(view, url);
            if (isCurrentPageCallback(view, url)) {
                hideStartupCover();
                diagnosticEvent(scope, "android-webview", "connected", "page_commit", null, pageId,
                        threadIdFromUri(Uri.parse(url)), pageStartedAt, null, null, null, 200);
            }
            LaunchRequest request = pendingNotificationRequest;
            if (request != null) {
                Uri committed = Uri.parse(url);
                if (isNotificationLoginDocument(request, committed)
                        || isNotificationDocument(request, committed)) revealNotification(request);
            } else if (isPendingListDocument(Uri.parse(url))) {
                pendingListSequence = -1L;
                if (notificationOverlay != null) notificationOverlay.setVisibility(View.GONE);
                uiHandler.removeCallbacks(notificationWaitTimeout);
                webView.setVisibility(View.VISIBLE);
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            Uri uri = Uri.parse(url);
            if (isCurrentPageCallback(view, url)) {
                diagnosticEvent(scope, "android-webview", "committed", "page_finished", null, pageId,
                        threadIdFromUri(uri), pageStartedAt, null, null, null, 200);
            }
            if (DshConfig.isDshUri(uri)) {
                String pageScope = uri.getQueryParameter("workspace");
                if (DshConfig.isScope(pageScope)) {
                    scope = pageScope;
                    if (uiReleaseStore != null) uiReleaseStore.setDiagnosticScope(scope);
                    if (apkUpdateManager != null) apkUpdateManager.setDiagnosticScope(scope);
                    appearance.selectScope(scope);
                    appearance.apply(webView, nativeRoot);
                    getPreferences(0).edit().putString("scope", scope).apply();
                }
                if (pendingShellAfterLogin && "/".equals(uri.getPath()) && hasDshCookie()) {
                    requestApkCheckAfterLogin();
                    LaunchRequest request = launchRequest;
                    if (request != null && request.target != null && request.sequence == pendingLoginSequence) {
                        pendingShellAfterLogin = false;
                        pendingLoginSequence = -1L;
                        loadNotificationPage(request);
                    } else {
                        pendingShellAfterLogin = false;
                        pendingLoginSequence = -1L;
                        if (pageRelease != null) webView.loadUrl(DshConfig.shellUrl(pageRelease.shellPath, scope));
                    }
                }
                if (hasDshCookie()) flushDiagnostics(scope);
                // Updates are optional work after the local document has painted.
                scheduleAutomaticUpdates();
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
            super.onReceivedError(view, request, error);
            String callbackUrl = request.getUrl() == null ? null : request.getUrl().toString();
            if (request.isForMainFrame() && isCurrentPageCallback(view, callbackUrl)) {
                hideStartupCover();
                int code = error == null ? 0 : error.getErrorCode();
                String reason = code == WebViewClient.ERROR_FAILED_SSL_HANDSHAKE ? "ssl_error" : "web_error";
                diagnosticEvent(scope, "android-webview", "failed", reason, null, pageId,
                        threadIdFromUri(request.getUrl()), pageStartedAt, null, null, null, -1,
                        null, null, failureClassForWebError(code, error == null ? null : error.getDescription()));
            }
            if (request.isForMainFrame() && uiReleaseStore.activeRelease() == null) {
                Toast.makeText(MainActivity.this, "私有工作台暂时无法连接", Toast.LENGTH_SHORT).show();
            }
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
            super.onReceivedHttpError(view, request, errorResponse);
            String callbackUrl = request.getUrl() == null ? null : request.getUrl().toString();
            if (request.isForMainFrame() && isCurrentPageCallback(view, callbackUrl)) {
                int status = errorResponse == null ? -1 : errorResponse.getStatusCode();
                diagnosticEvent(scope, "android-webview", "failed", "http_error", null, pageId,
                        threadIdFromUri(request.getUrl()), pageStartedAt, null, null, null, status,
                        null, null, "http");
            }
        }

        @Override
        public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
            diagnosticEvent(scope, "android-webview", "failed", "renderer_gone", null, pageId, null,
                    pageStartedAt, null, null, null, -1, null,
                    detail == null ? null : !detail.didCrash());
            // Chromium has invalidated this WebView. A dead instance cannot be
            // navigated or safely reused; recreate the Activity so bridge,
            // clients, and the renderer are rebuilt together.
            if (!isFinishing() && renderProcessRecoveryScheduled.compareAndSet(false, true)) {
                runOnUiThread(() -> {
                    if (!isFinishing()) recreate();
                });
            }
            return true;
        }
    }

    private final class DshWebChromeClient extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("*/*");
            if (params != null) {
                String[] accepted = params.getAcceptTypes();
                if (accepted != null) for (String type : accepted) if (type != null && type.contains("/")) {
                    picker.setType(type);
                    break;
                }
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) picker.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            }
            try {
                startActivityForResult(Intent.createChooser(picker, "选择附件"), FILE_CHOOSER_REQUEST);
                return true;
            } catch (RuntimeException failure) {
                fileCallback.onReceiveValue(null);
                fileCallback = null;
                return false;
            }
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            // The official renderer uses the document picker for attachments;
            // camera/microphone capabilities are intentionally not exposed.
            request.deny();
        }

        @Override
        public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
            result.cancel();
            return true;
        }
    }
}
