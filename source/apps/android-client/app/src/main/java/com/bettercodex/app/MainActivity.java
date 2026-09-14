package com.bettercodex.app;

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

/** Thin Android shell around the official BETTER_CODEX renderer. */
public final class MainActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST = 5101;
    private static final int NOTIFICATION_REQUEST = 5102;
    private static final int DOCUMENT_EXPORT_REQUEST = 5103;
    private static final Pattern THREAD_ID = Pattern.compile("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");
    private static final long MAX_DOWNLOAD_BYTES = 512L * 1024L * 1024L;

    private final android.os.Handler uiHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable applyDownloadedUi = this::tryApplyDownloadedUi;
    private WebView webView;
    private View nativeRoot;
    private NativeAppearance appearance;
    private LinearLayout nativeBar;
    private TextView connectionLabel;
    private UiReleaseStore uiReleaseStore;
    private SyncStore syncStore;
    private NativeBridge bridge;
    @Nullable private volatile UiReleaseStore.Release pageRelease;
    @Nullable private ApkUpdateManager apkUpdateManager;
    private final ExecutorService background = Executors.newSingleThreadExecutor();
    private final AtomicBoolean updateStarted = new AtomicBoolean();
    private final AtomicBoolean notificationPermissionRequestStarted = new AtomicBoolean();
    private final AtomicBoolean appUpdateStarted = new AtomicBoolean();
    private final AtomicBoolean renderProcessRecoveryScheduled = new AtomicBoolean();
    private boolean pendingShellAfterLogin;
    @Nullable private String pendingNotificationUrl;
    private volatile boolean pinnedMainFrameResponse;
    @Nullable private ValueCallback<Uri[]> fileCallback;
    @Nullable private byte[] documentBytes;
    @Nullable private NativeBridge.DocumentResult documentResult;
    private String scope = BetterCodexConfig.DEFAULT_SCOPE;

    private final BroadcastReceiver statusReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (!SyncForegroundService.ACTION_STATUS.equals(intent.getAction())) return;
            String stateScope = intent.getStringExtra(SyncForegroundService.EXTRA_SCOPE);
            String raw = intent.getStringExtra(SyncForegroundService.EXTRA_STATUS);
            if (stateScope == null || raw == null) return;
            try {
                JSONObject state = new JSONObject(raw);
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
        String notificationScope = getIntent().getStringExtra("notification_scope");
        scope = BetterCodexConfig.scopeOrDefault(notificationScope != null ? notificationScope : getPreferences(0).getString("scope", BetterCodexConfig.DEFAULT_SCOPE));
        appearance = new NativeAppearance(this, scope);
        appearance.apply(null, null);
        uiReleaseStore = new UiReleaseStore(this);
        syncStore = new SyncStore(this);
        apkUpdateManager = new ApkUpdateManager(this);
        webView = new WebView(this);
        nativeRoot = buildNativeLayout(webView);
        setContentView(nativeRoot);
        appearance.apply(webView, nativeRoot);
        configureWebView();
        bridge = new NativeBridge(this, webView, syncStore, uiReleaseStore, this::showNativeSettings, this::requestNotificationPermissionIfNeeded, appearance, () -> appearance.apply(webView, nativeRoot), this::saveWordDocument);
        bridge.install();
        installServiceWorkerResourceClient();
        installDocumentStartAdapter();
        IntentFilter filter = new IntentFilter(SyncForegroundService.ACTION_STATUS);
        ContextCompat.registerReceiver(this, statusReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBackNavigation);
        loadInitialPage();
        updateNativeStatusControls(scope, SyncForegroundService.statusSnapshot(this, scope));
        if (getIntent().getBooleanExtra("open_background_settings", false)) uiHandler.post(this::showNativeSettings);
    }

    private View buildNativeLayout(WebView content) {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.betterCodex_surface));
        root.addView(content, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
        });
        ViewCompat.requestApplyInsets(root);
        return root;
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

    private void installServiceWorkerResourceClient() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)
                || !WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_SHOULD_INTERCEPT_REQUEST)) return;
        ServiceWorkerControllerCompat.getInstance().setServiceWorkerClient(new ServiceWorkerClientCompat() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                if (!BetterCodexConfig.isBetterCodexUri(request.getUrl()) || !"GET".equals(request.getMethod())) return null;
                UiReleaseStore.LocalResource resource = uiReleaseStore.localResource(request.getUrl().getPath(), pageRelease);
                if (resource == null) return null;
                return new WebResourceResponse(resource.mime, null, 200, "OK", null, resource.stream);
            }
        });
    }

    private void installDocumentStartAdapter() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return;
        try {
            String adapter = readAssetText("android-native-adapter.js");
            String startup = readAssetText("android-startup.js");
            String authRecovery = "(function(){try{if(location.origin!=='" + BetterCodexConfig.ORIGIN
                    + "'||window.top!==window)return;addEventListener('betterCodex:authentication-required',function(){"
                    + "if(location.pathname==='/'||/^\\/local\\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(location.pathname)||"
                    + "/^\\/betterCodex-native-assets\\/[a-f0-9]{16}\\//.test(location.pathname)){"
                    + "var s=new URL(location.href).searchParams.get('workspace');if(s==='ai'||s==='secondary')"
                    + "location.replace('/?workspace='+s+'&view=chat&nativeList=1&pwa='+s+'&launch=1&androidLogin=1'+(location.pathname.startsWith('/local/')?'&androidReturn='+encodeURIComponent(location.pathname+location.search):''));}},{once:true});}catch(e){}})();\n";
            WebViewCompat.addDocumentStartJavaScript(webView, startup + authRecovery + adapter,
                    Collections.singleton(BetterCodexConfig.ORIGIN));
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
        settings.setUserAgentString(settings.getUserAgentString() + BetterCodexConfig.userAgentSuffix());
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        CookieManager.setAcceptFileSchemeCookies(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) cookies.setAcceptThirdPartyCookies(webView, false);

        webView.setWebViewClient(new BetterCodexWebViewClient());
        webView.setWebChromeClient(new BetterCodexWebChromeClient());
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            Uri target;
            try {
                target = Uri.parse(url);
            } catch (RuntimeException ignored) {
                Toast.makeText(this, "无法打开下载内容", Toast.LENGTH_SHORT).show();
                return;
            }
            if (BetterCodexConfig.isBetterCodexUri(target)) {
                downloadSameOrigin(target, contentDisposition, mimeType);
                return;
            }
            // Only user initiated downloads from another origin leave the
            // WebView. Scoped BETTER_CODEX downloads retain the current WebView cookie.
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, target));
            } catch (RuntimeException ignored) {
                Toast.makeText(this, "无法打开下载内容", Toast.LENGTH_SHORT).show();
            }
        });
    }

    private void downloadSameOrigin(Uri url, @Nullable String contentDisposition, @Nullable String mimeType) {
        if (!isAllowedDownloadPath(url)) {
            Toast.makeText(this, "下载地址不可用", Toast.LENGTH_SHORT).show();
            return;
        }
        Toast.makeText(this, "正在准备下载", Toast.LENGTH_SHORT).show();
        background.execute(() -> {
            File output = null;
            try {
                okhttp3.OkHttpClient client = new okhttp3.OkHttpClient.Builder()
                        .followRedirects(false).followSslRedirects(false).build();
                okhttp3.Request.Builder request = new okhttp3.Request.Builder()
                        .url(url.toString()).get().header("Origin", BetterCodexConfig.ORIGIN);
                addCookie(request, BetterCodexConfig.ORIGIN);
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
        return path != null && path.matches("^/w/(?:ai|secondary)/api/local-file/[A-Za-z0-9_-]{32}/[^/]+$");
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

    private void loadInitialPage() {
        UiReleaseStore.Release release = uiReleaseStore.activeRelease();
        pageRelease = release;
        String target = notificationTargetUrl(getIntent());
        if (target != null) {
            pendingNotificationUrl = target;
            scope = Uri.parse(target).getQueryParameter("workspace");
            if (hasBetterCodexCookie()) loadNotificationPage(target);
            else {
                pendingShellAfterLogin = true;
                webView.loadUrl(onlineLoginUrl());
            }
            return;
        }
        if (release != null && hasBetterCodexCookie()) {
            webView.loadUrl(BetterCodexConfig.shellUrl(release.shellPath, scope));
        } else if (release != null) {
            // A first launch without the SSO cookie must complete the normal
            // top-level login redirect before the credential-free local shell
            // starts its session bootstrap fetches.
            pendingShellAfterLogin = true;
            webView.loadUrl(onlineLoginUrl());
        } else {
            webView.loadUrl(onlineLoginUrl());
        }
    }

    private String onlineLoginUrl() {
        return BetterCodexConfig.ORIGIN + "/?workspace=" + scope + "&view=chat&nativeList=1&pwa=" + scope
                + "&launch=1&androidLogin=1"
                + (pendingNotificationUrl == null ? "" : "&androidReturn=" + Uri.encode(pendingNotificationUrl));
    }

    private boolean hasBetterCodexCookie() {
        try {
            String cookie = CookieManager.getInstance().getCookie(BetterCodexConfig.ORIGIN);
            return cookie != null && !cookie.trim().isEmpty();
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    private void refreshUiInBackground() {
        if (!updateStarted.compareAndSet(false, true)) return;
        background.execute(() -> {
            UiReleaseStore.UpdateResult result = uiReleaseStore.refresh(new OkHttpClient());
            updateStarted.set(false);
            runOnUiThread(() -> { uiHandler.removeCallbacks(applyDownloadedUi); tryApplyDownloadedUi(); });
        });
    }

    private void tryApplyDownloadedUi() {
        if (isFinishing() || isDestroyed() || webView == null) return;
        UiReleaseStore.Release next = uiReleaseStore.activeRelease();
        if (next == null || pageRelease == null || next.version.equals(pageRelease.version)) return;
        String url = webView.getUrl();
        if (url == null || !BetterCodexConfig.isBetterCodexUri(Uri.parse(url))) return;
        if (fileCallback != null || documentResult != null || !webView.hasWindowFocus()) { uiHandler.postDelayed(applyDownloadedUi, 2000); return; }
        webView.evaluateJavascript("window.__BETTER_CODEX_ANDROID_CAN_RELOAD__?.()===true", safe -> {
            if (isFinishing() || isDestroyed()) return;
            if (!"true".equals(safe) || fileCallback != null || documentResult != null || !url.equals(webView.getUrl())) {
                uiHandler.postDelayed(applyDownloadedUi, 2000); return;
            }
            pageRelease = next;
            String target = Uri.parse(url).getPath();
            webView.loadUrl(target != null && target.startsWith("/betterCodex-native-assets/") ? BetterCodexConfig.shellUrl(next.shellPath, scope) : url);
            Toast.makeText(this, "界面已更新", Toast.LENGTH_SHORT).show();
        });
    }

    private void checkAllUpdates() {
        refreshUiInBackground();
        checkApkUpdate();
    }

    private void checkApkUpdate() {
        ApkUpdateManager manager = apkUpdateManager;
        if (manager == null || !appUpdateStarted.compareAndSet(false, true)) return;
        background.execute(() -> {
            ApkUpdateManager.CheckResult update = manager.check(new OkHttpClient());
            appUpdateStarted.set(false);
            runOnUiThread(() -> {
                if (isFinishing()) return;
                if (update == null) {
                    Toast.makeText(this, "暂时无法检查应用更新", Toast.LENGTH_SHORT).show();
                } else if (!update.available) {
                    Toast.makeText(this, "应用已是最新版本", Toast.LENGTH_SHORT).show();
                } else {
                    new AlertDialog.Builder(this)
                            .setTitle("发现应用更新")
                            .setMessage(update.versionName)
                            .setNegativeButton("稍后", null)
                            .setPositiveButton("下载并安装", (dialog, which) -> downloadApkUpdate(manager, update))
                            .show();
                }
            });
        });
    }

    private void downloadApkUpdate(ApkUpdateManager manager, ApkUpdateManager.CheckResult update) {
        if (!canInstallPackages()) {
            openInstallPermissionSettings();
            return;
        }
        Toast.makeText(this, "正在下载应用更新", Toast.LENGTH_SHORT).show();
        background.execute(() -> {
            File apk = manager.download(update, new OkHttpClient());
            runOnUiThread(() -> {
                if (apk == null) {
                    Toast.makeText(this, "应用更新下载失败", Toast.LENGTH_SHORT).show();
                    return;
                }
                if (!canInstallPackages()) {
                    openInstallPermissionSettings();
                    return;
                }
                try {
                    startActivity(manager.installerIntent(apk));
                } catch (Exception failure) {
                    Toast.makeText(this, "无法打开安装程序", Toast.LENGTH_SHORT).show();
                }
            });
        });
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
            startActivity(intent);
        } catch (RuntimeException ignored) {
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
            ownerButton.setText("设备使用者：" + (owner.isEmpty() ? "请选择" : "ai".equals(owner) ? "AI Workspace（AI）" : "SECONDARY"));
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
        enhancedInfo.setText("加强模式在息屏且有网络时保持唤醒，帮助持续接收更新，会增加耗电。关闭后台同步后立即停止；强制停止 App 后需要重新打开。请保留常驻通知，并检查下方电池豁免。");
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

        Button uiUpdate = compactButton("检查界面更新");
        uiUpdate.setOnClickListener(view -> refreshUiInBackground());
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
        settingsDialog.setOnDismissListener(dialog -> uiHandler.removeCallbacks(ticker));
        settingsDialog.show();
        uiHandler.post(ticker);
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
        int[] choice = {"ai".equals(previous) ? 0 : "secondary".equals(previous) ? 1 : -1};
        AlertDialog picker = new AlertDialog.Builder(this)
                .setTitle("这台设备由谁使用")
                .setSingleChoiceItems(new String[]{"AI Workspace（AI）", "SECONDARY"}, choice[0], (dialog, which) -> choice[0] = which)
                .setNegativeButton("取消", null).setPositiveButton("保存", null).create();
        picker.setOnShowListener(ignored -> picker.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            if (choice[0] < 0) { Toast.makeText(this, "请选择使用者", Toast.LENGTH_SHORT).show(); return; }
            String selected = choice[0] == 0 ? "ai" : "secondary";
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
    }

    @Nullable
    private String validatedConversationUrl(@Nullable String value) {
        if (value == null) return null;
        try {
            Uri url = Uri.parse(value.startsWith("/") ? BetterCodexConfig.ORIGIN + value : value);
            String path = url.getPath(), selected = url.getQueryParameter("workspace");
            if (!BetterCodexConfig.isBetterCodexUri(url) || !BetterCodexConfig.isScope(selected) || path == null
                    || !path.startsWith("/local/") || !THREAD_ID.matcher(path.substring(7)).matches()) return null;
            return BetterCodexConfig.ORIGIN + path + "?workspace=" + selected + "&view=chat&pwa=" + selected + "&fromNotification=1";
        } catch (RuntimeException invalid) { return null; }
    }

    @Nullable
    private String notificationTargetUrl(@Nullable Intent intent) {
        if (intent == null) return null;
        String selected = intent.getStringExtra("notification_scope"), thread = intent.getStringExtra("notification_thread");
        if (!BetterCodexConfig.isScope(selected) || thread == null || !THREAD_ID.matcher(thread).matches()) return null;
        return validatedConversationUrl(BetterCodexConfig.ORIGIN + "/local/" + thread + "?workspace=" + selected);
    }

    private void openNotificationTarget(Intent intent) {
        String target = notificationTargetUrl(intent);
        if (target == null || webView == null) return;
        pendingNotificationUrl = target;
        scope = Uri.parse(target).getQueryParameter("workspace");
        getPreferences(0).edit().putString("scope", scope).apply();
        if (hasBetterCodexCookie()) {
            WebView current = webView;
            String script = "(()=>{const nav=window.__BETTER_CODEX_NAVIGATION__;return !!nav?.openConversation("
                    + JSONObject.quote(target) + ");})()";
            current.evaluateJavascript(script, handled -> {
                if (isFinishing() || isDestroyed() || webView != current) return;
                if (!"true".equals(handled)) loadNotificationPage(target);
                else pendingNotificationUrl = null;
            });
        } else {
            pendingShellAfterLogin = true;
            webView.loadUrl(onlineLoginUrl());
        }
    }

    /** Cold notification launches use the installed, checksum verified UI shell. */
    private void loadNotificationPage(String target) {
        Uri conversation = Uri.parse(target);
        UiReleaseStore.Release release = uiReleaseStore.activeRelease();
        pageRelease = release;
        if (release == null) { webView.loadUrl(target); return; }
        String thread = conversation.getLastPathSegment();
        if (thread == null || !THREAD_ID.matcher(thread).matches()) return;
        String local = BetterCodexConfig.ORIGIN + release.shellPath + "?workspace=" + scope
                + "&view=chat&pwa=" + scope + "&fromNotification=1&notificationThread=" + Uri.encode(thread);
        pendingNotificationUrl = null;
        webView.loadUrl(local);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent != null && intent.hasExtra("notification_thread")) openNotificationTarget(intent);
        if (intent != null && intent.getBooleanExtra("open_background_settings", false)) showNativeSettings();
    }

    @Override
    protected void onResume() {
        super.onResume();
        SyncForegroundService.restoreEnabled(this, true);
        if (webView != null) webView.onResume();
        if (appearance != null) appearance.apply(webView, nativeRoot);
        uiHandler.removeCallbacks(applyDownloadedUi);
        tryApplyDownloadedUi();
    }

    @Override
    public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        if (appearance != null) appearance.apply(webView, nativeRoot);
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        try {
            CookieManager.getInstance().flush();
        } catch (RuntimeException ignored) {
        }
        super.onPause();
    }

    // Android 13+ uses the platform callback registered above; keep the older button fallback.
    @android.annotation.SuppressLint("GestureBackNavigation")
    @Override
    public void onBackPressed() { handleBackNavigation(); }

    private void handleBackNavigation() {
        WebView target = webView;
        if (target == null) { super.onBackPressed(); return; }
        target.evaluateJavascript("(()=>{const workbench=window.__BETTER_CODEX_NATIVE_WORKBENCH__;if(workbench?.current){workbench.close();return true;}return window.__BETTER_CODEX_NAVIGATION__?.handleBack?.()===true;})()", handled -> {
            if (isFinishing() || isDestroyed() || webView != target || "true".equals(handled)) return;
            if (target.canGoBack()) target.goBack();
            else MainActivity.super.onBackPressed();
        });
    }

    private void saveWordDocument(String requestScope, String filename, byte[] bytes, NativeBridge.DocumentResult result) {
        if (isFinishing() || isDestroyed() || !"secondary".equals(requestScope) || !requestScope.equals(scope) || documentResult != null) {
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
        uiHandler.removeCallbacks(applyDownloadedUi);
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
        if (webView != null) {
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
        }
        background.shutdownNow();
        if (syncStore != null) syncStore.close();
        if (uiReleaseStore != null) uiReleaseStore.close();
        super.onDestroy();
    }

    private final class BetterCodexWebViewClient extends WebViewClient {
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
            if (BetterCodexConfig.isBetterCodexUri(url)) return false;
            if (BetterCodexConfig.isAllowedSsoPath(url)) return false;
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
            if (!request.isForMainFrame() && !BetterCodexConfig.isBetterCodexUri(url)) return super.shouldInterceptRequest(view, request);
            if (!BetterCodexConfig.isBetterCodexUri(url) || !"GET".equalsIgnoreCase(request.getMethod())) return super.shouldInterceptRequest(view, request);
            if (request.isForMainFrame() && isPinnedShellRoute(url) && hasBetterCodexCookie()) {
                UiReleaseStore.LocalResource shell = uiReleaseStore.localResource(pageRelease == null ? null : pageRelease.shellPath, pageRelease);
                if (shell != null) {
                    pinnedMainFrameResponse = true;
                    return new WebResourceResponse(shell.mime, "UTF-8", 200, "OK", null, shell.stream);
                }
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
            bridge.clearProxy();
            Uri started = Uri.parse(url);
            pinnedMainFrameResponse = false;
            if ("1".equals(started.getQueryParameter("androidLogin"))) {
                pendingShellAfterLogin = true;
                pendingNotificationUrl = validatedConversationUrl(started.getQueryParameter("androidReturn"));
            }
            super.onPageStarted(view, url, favicon);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            Uri uri = Uri.parse(url);
            if (BetterCodexConfig.isBetterCodexUri(uri)) {
                String pageScope = uri.getQueryParameter("workspace");
                if (BetterCodexConfig.isScope(pageScope)) {
                    scope = pageScope;
                    appearance.selectScope(scope);
                    appearance.apply(webView, nativeRoot);
                    getPreferences(0).edit().putString("scope", scope).apply();
                }
                if (pendingShellAfterLogin && "/".equals(uri.getPath()) && hasBetterCodexCookie()) {
                    pendingShellAfterLogin = false;
                    String target = pendingNotificationUrl;
                    pendingNotificationUrl = null;
                    if (target != null) loadNotificationPage(target);
                    else if (pageRelease != null) webView.loadUrl(BetterCodexConfig.shellUrl(pageRelease.shellPath, scope));
                }
                refreshUiInBackground();
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
            super.onReceivedError(view, request, error);
            if (request.isForMainFrame() && uiReleaseStore.activeRelease() == null) {
                Toast.makeText(MainActivity.this, "私有工作台暂时无法连接", Toast.LENGTH_SHORT).show();
            }
        }

        @Override
        public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
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

    private final class BetterCodexWebChromeClient extends WebChromeClient {
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
