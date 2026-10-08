package top.whytan.dsh;

import android.content.Context;
import android.content.res.AssetManager;
import android.os.SystemClock;
import android.webkit.CookieManager;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.Closeable;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.BufferedSource;

/**
 * Owns the credential-free, versioned WebView asset cache. A release becomes
 * active only after every declared file has passed size and SHA-256 checks.
 */
public final class UiReleaseStore implements Closeable {
    private static final Pattern VERSION = Pattern.compile("^[a-f0-9]{16}$");
    private static final Pattern SHA256 = Pattern.compile("^[a-f0-9]{64}$");
    private static final Pattern TRACE_ID = Pattern.compile("(?i)^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$");
    private static final Pattern NATIVE = Pattern.compile("^/dsh-native-assets/[a-f0-9]{16}/(?:scope|runtime|pwa|loader|turn)\\.(?:js|css)$");
    private static final Pattern OFFICIAL = Pattern.compile("^/official-patched-v[0-9]+/assets/[A-Za-z0-9_.-]+\\.(?:js|mjs|css|woff2?|ttf|png|svg|jpg|jpeg|webp)$");
    private static final long MAX_FILE_BYTES = 24L * 1024L * 1024L;
    private static final long MAX_TOTAL_BYTES = 100L * 1024L * 1024L;
    private static final int MAX_FILES = 600;
    private static final long REFRESH_TIMEOUT_MILLIS = 120_000L;
    private static final long CALL_TIMEOUT_MILLIS = 45_000L;
    private static final long CONNECT_TIMEOUT_MILLIS = 10_000L;
    private static final long READ_TIMEOUT_MILLIS = 20_000L;
    private static final long WRITE_TIMEOUT_MILLIS = 20_000L;

    private final Context context;
    private final File root;
    private final NativeDiagnostics diagnostics;
    private static final Object lock = new Object();
    private static final Map<String,Integer> pageLeases = new HashMap<>();
    public void retainPage(@Nullable Release release){if(release==null)return;synchronized(lock){String key=release.filesDir.getAbsolutePath();pageLeases.put(key,pageLeases.getOrDefault(key,0)+1);}}
    public void releasePage(@Nullable Release release){if(release==null)return;synchronized(lock){String key=release.filesDir.getAbsolutePath();int count=pageLeases.getOrDefault(key,0);if(count<=1)pageLeases.remove(key);else pageLeases.put(key,count-1);}}
    private final AtomicReference<Call> activeCall = new AtomicReference<>();
    private final AtomicBoolean cancelRequested = new AtomicBoolean();
    private final AtomicBoolean closed = new AtomicBoolean();
    private volatile String diagnosticScope;
    private volatile Release active;
    // Bytes read before the first local document. Kept separate from lazy asset
    // checks so startup diagnostics/tests can detect accidental full rescans.
    private long startupVerifiedBytes;

    public UiReleaseStore(Context context) {
        this(context, DshConfig.DEFAULT_SCOPE);
    }

    public UiReleaseStore(Context context, String scope) {
        this.context = context.getApplicationContext();
        this.diagnosticScope = DshConfig.scopeOrDefault(scope);
        this.diagnostics = NativeDiagnostics.get(this.context);
        this.root = new File(this.context.getFilesDir(), "ui-releases");
        // The app-private directory is not exported and is excluded from
        // backup by the manifest's data extraction rules.
        //noinspection ResultOfMethodCallIgnored
        root.mkdirs();
        synchronized (lock) {
            File marker = new File(root, "active.json");
            boolean hadMarker = marker.isFile();
            long cachedStartedAt = SystemClock.elapsedRealtime();
            if (hadMarker) diagnostic("attempt", "ui_cached", null, null, cachedStartedAt, -1, -1L);
            if (Thread.currentThread().isInterrupted()) return;
            active = readMarkedRelease(marker);
            if (active == null && !Thread.currentThread().isInterrupted()) {
                active = readMarkedRelease(new File(root, "lastgood.json"));
                if (active != null) {
                    try { writeMarkerAtomically(marker, active.version); } catch (IOException ignored) {}
                }
            }
            if (active != null) diagnostic("verified", "ui_cached", null, active.version, cachedStartedAt, -1, active.entries.size());
            else if (hadMarker) diagnostic("failed", "ui_failed", null, null, -1L, -1, -1L);
            int installedApp = this.context.getSharedPreferences("ui-install", Context.MODE_PRIVATE)
                    .getInt("appVersion", 0);
            if (!Thread.currentThread().isInterrupted() && (active == null || installedApp != BuildConfig.VERSION_CODE)) installBundledLocked();
        }
    }

    public void setDiagnosticScope(String scope) {
        if (DshConfig.isScope(scope)) diagnosticScope = scope;
    }

    @Nullable
    public Release activeRelease() {
        return active;
    }

    @Nullable
    public String activeVersion() {
        Release release = active;
        return release == null ? null : release.version;
    }

    private void diagnostic(String stage, String reason, @Nullable String traceId,
                            @Nullable String uiVersion, long startedAt, int statusCode, long count) {
        diagnostic(diagnosticScope, stage, reason, traceId, uiVersion, startedAt, statusCode, count);
    }

    private void diagnostic(@Nullable String scope, String stage, String reason, @Nullable String traceId,
                            @Nullable String uiVersion, long startedAt, int statusCode, long count) {
        if (!DshConfig.isScope(scope)) return;
        JSONObject fields = new JSONObject();
        try {
            if (traceId != null && TRACE_ID.matcher(traceId).matches()) fields.put("traceId", traceId);
            String version = uiVersion;
            if (version != null && version.matches("[a-f0-9]{16}")) fields.put("uiVersion", version);
            if (reason != null) fields.put("reason", reason);
            if (startedAt >= 0L) fields.put("durationMs", Math.max(0L, SystemClock.elapsedRealtime() - startedAt));
            if (statusCode >= 100 && statusCode <= 999) fields.put("statusCode", statusCode);
            if (count >= 0L) fields.put("count", count);
        } catch (Exception ignored) {
            return;
        }
        try {
            diagnostics.event(scope, "android-update", stage, fields);
        } catch (RuntimeException ignored) {
            // Store verification and activation must remain independent of diagnostics.
        }
    }

    @Nullable
    public LocalResource localResource(String path) {
        return localResource(path, active);
    }

    @Nullable
    public LocalResource localResource(String path, @Nullable Release release) {
        if (path == null || path.isEmpty()) return null;
        if (release == null) return null;
        EntryView entry = release.entries.get(path);
        if (entry == null) return null;
        File file = new File(release.filesDir, path.substring(1));
        if (!isInside(file, release.filesDir) || !file.isFile() || file.length() != entry.bytes) return null;
        // A committed release was verified when installed. On later launches,
        // verify only the assets actually requested, once per process. Unused
        // editors/media modules must not hold up the first local page.
        synchronized (release.verifiedFiles) {
            String stamp = fileStamp(file);
            if (stamp == null) return null;
            if (!stamp.equals(release.verifiedFiles.get(path))) {
                if (!verifyFile(file, entry.bytes, entry.sha256) || !stamp.equals(fileStamp(file))) {
                    release.corrupt.set(true);
                    return null;
                }
                release.verifiedFiles.put(path, stamp);
            }
        }
        try {
            return new LocalResource(entry.mime, new FileInputStream(file), entry.bytes);
        } catch (FileNotFoundException ignored) {
            return null;
        }
    }

    /**
     * Fetch and stage the latest UI release. It never reloads the current page;
    * the new release is used at the next shell launch.
     */
    public UpdateResult refresh(OkHttpClient baseClient) {
        String eventScope = diagnosticScope;
        String traceId = UUID.randomUUID().toString();
        long startedAt = SystemClock.elapsedRealtime();
        int[] statusCode = {-1};
        boolean[] terminal = {false};
        diagnostic(eventScope, "attempt", "check_start", traceId, activeVersion(), startedAt, -1, -1L);
        if (closed.get() || baseClient == null) {
            terminal[0] = true;
            diagnostic(eventScope, "skipped", "cancelled", traceId, activeVersion(), startedAt, -1, -1L);
            return UpdateResult.failure("closed");
        }
        cancelRequested.set(false);
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(REFRESH_TIMEOUT_MILLIS);
        try {
            OkHttpClient client = baseClient.newBuilder()
                    .followRedirects(false).followSslRedirects(false)
                    .callTimeout(CALL_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS)
                    .connectTimeout(CONNECT_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS)
                    .readTimeout(READ_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS)
                    .writeTimeout(WRITE_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS)
                    .build();
            Request.Builder request = new Request.Builder()
                    .url(DshConfig.ORIGIN + "/android/ui-release.json")
                    .get()
                    .header("Origin", DshConfig.ORIGIN);
            addCookie(request, DshConfig.ORIGIN);
            JSONObject rawManifest;
            try (Response response = executeBounded(client, request.build(), deadline)) {
                statusCode[0] = response.code();
                if (response.code() != 200 || response.body() == null) return UpdateResult.failure("manifest_unavailable");
                String contentType = response.header("Content-Type", "").toLowerCase(Locale.ROOT);
                if (!contentType.contains("json")) return UpdateResult.failure("manifest_type");
                rawManifest = new JSONObject(readText(response.body().byteStream()));
            }
            Manifest manifest = parseManifest(rawManifest);
            diagnostic(eventScope, "received", "check_start", traceId, manifest.version, startedAt, statusCode[0], manifest.entries.size());
            if (BuildConfig.VERSION_CODE < manifest.minAppVersionCode) return UpdateResult.failure("app_too_old");
            Release current = active;
            if (current != null && current.version.equals(manifest.version)) {
                if (releaseFilesValid(current)) {
                    terminal[0] = true;
                    diagnostic(eventScope, "committed", "check_latest", traceId, manifest.version, startedAt, statusCode[0], current.entries.size());
                    return UpdateResult.unchanged(manifest.version);
                }
                // A same-version active release may have changed on disk after
                // startup. Do not let the fast path preserve a corrupt cache.
                current = null;
            }

            File staging = new File(root, ".staging-" + manifest.version + "-" + UUID.randomUUID());
            File filesDir = new File(staging, "files");
            if (!filesDir.mkdirs() && !filesDir.isDirectory()) return UpdateResult.failure("staging_unavailable");
            try {
                for (Entry entry : manifest.entries.values()) {
                    ensureWithinDeadline(deadline);
                    File target = safeFile(filesDir, entry.path.substring(1));
                    File parent = target.getParentFile();
                    if (parent == null || (!parent.mkdirs() && !parent.isDirectory())) throw new IOException("staging path");
                    EntryView oldEntry = current == null ? null : current.entries.get(entry.path);
                    File oldFile = current == null ? null : new File(current.filesDir, entry.path.substring(1));
                    if (oldEntry != null && oldFile != null && oldEntry.bytes == entry.bytes
                            && entry.sha256.equals(oldEntry.sha256) && oldFile.isFile()) {
                        try (InputStream input = new FileInputStream(oldFile)) {
                            copyVerified(input, target, entry);
                        }
                    } else {
                        Request.Builder fileRequest = new Request.Builder()
                                .url(DshConfig.ORIGIN + entry.url)
                                .get()
                                .header("Origin", DshConfig.ORIGIN);
                        addCookie(fileRequest, DshConfig.ORIGIN);
                        AssetDiagnostic asset = new AssetDiagnostic(eventScope, traceId, manifest.version, entry);
                        asset.event("started", "download_start", null);
                        try (Response response = executeBounded(client, fileRequest.build(), deadline)) {
                            statusCode[0] = response.code();
                            asset.statusCode = response.code();
                            asset.event("received", "request_received", null);
                            if (response.code() != 200 || response.body() == null) throw new IOException("asset unavailable");
                            verifyAndWrite(response.body(), target, entry, asset);
                            asset.event("downloaded", "download_complete", null);
                        } catch (Exception failure) {
                            asset.failure(failure);
                            throw failure;
                        }
                    }
                }
                diagnostic(eventScope, "downloaded", "ui_download", traceId, manifest.version, startedAt, statusCode[0], manifest.entries.size());
                verifyShell(manifest, filesDir);
                diagnostic(eventScope, "verified", "ui_verified", traceId, manifest.version, startedAt, statusCode[0], manifest.entries.size());
                writeJsonAtomically(new File(staging, "ui-release.json"), rawManifest.toString() + "\n");
                activateLocked(new Release(manifest, filesDir));
                diagnostic(eventScope, "committed", "ui_verified", traceId, manifest.version, startedAt, statusCode[0], manifest.entries.size());
                terminal[0] = true;
                deleteRecursively(staging);
                return UpdateResult.updated(manifest.version);
            } catch (Exception failure) {
                deleteRecursively(staging);
                return UpdateResult.failure("release_rejected");
            }
        } catch (Exception failure) {
            return UpdateResult.failure("manifest_unavailable");
        } finally {
            if (!terminal[0]) {
                diagnostic(eventScope, cancelRequested.get() ? "cancelled" : "failed",
                        cancelRequested.get() ? "cancelled" : "ui_failed", traceId,
                        activeVersion(), startedAt, statusCode[0], -1L);
            }
        }
    }

    /** Cancel the current manifest/file call and prevent the next staged step. */
    public void cancelRefresh() {
        cancelRequested.set(true);
        Call call = activeCall.get();
        if (call != null) call.cancel();
    }

    private Response executeBounded(OkHttpClient client, Request request, long deadline) throws IOException {
        ensureWithinDeadline(deadline);
        long remaining = Math.max(1L, TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime()));
        OkHttpClient bounded = client.newBuilder()
                .callTimeout(Math.min(CALL_TIMEOUT_MILLIS, remaining), TimeUnit.MILLISECONDS)
                .build();
        Call call = bounded.newCall(request);
        activeCall.set(call);
        if (closed.get() || cancelRequested.get()) call.cancel();
        try {
            Response response = call.execute();
            ResponseBody body = response.body();
            if (body == null) {
                activeCall.compareAndSet(call, null);
                return response;
            }
            try {
                // Keep the Call visible while the caller consumes the body.
                // call.execute() only covers response headers; clearing here
                // would make cancelRefresh ineffective during a slow body.
                ResponseBody trackedBody = new TrackedResponseBody(body, call);
                return response.newBuilder().body(trackedBody).build();
            } catch (RuntimeException failure) {
                response.close();
                throw failure;
            }
        } catch (IOException | RuntimeException failure) {
            activeCall.compareAndSet(call, null);
            throw failure;
        }
    }

    private final class TrackedResponseBody extends ResponseBody {
        private final ResponseBody delegate;
        private final Call call;

        TrackedResponseBody(ResponseBody delegate, Call call) {
            this.delegate = delegate;
            this.call = call;
        }

        @Override
        public MediaType contentType() {
            return delegate.contentType();
        }

        @Override
        public long contentLength() {
            return delegate.contentLength();
        }

        @Override
        public BufferedSource source() {
            return delegate.source();
        }

        @Override
        public void close() {
            try {
                delegate.close();
            } finally {
                activeCall.compareAndSet(call, null);
            }
        }
    }

    private void ensureWithinDeadline(long deadline) throws IOException {
        if (closed.get() || cancelRequested.get() || System.nanoTime() >= deadline) {
            throw new IOException("refresh cancelled or timed out");
        }
    }

    private static void addCookie(Request.Builder request, String url) {
        try {
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null && !cookie.isEmpty()) request.header("Cookie", cookie);
        } catch (RuntimeException ignored) {
            // A missing WebView cookie simply results in a normal SSO response.
        }
    }

    private void installBundledIfPresent() {
        synchronized (lock) {
            installBundledLocked();
        }
    }

    private void installBundledLocked() {
        AssetManager assets = context.getAssets();
        String traceId = UUID.randomUUID().toString();
        long startedAt = SystemClock.elapsedRealtime();
        boolean[] completed = {false};
        boolean[] skipped = {false};
        diagnostic("attempt", "ui_embedded", traceId, null, startedAt, -1, -1L);
        try (InputStream stream = assets.open("ui-release.json")) {
            String raw = readText(stream);
            JSONObject json = new JSONObject(raw);
            Manifest manifest = parseManifest(json);
            if (BuildConfig.VERSION_CODE < manifest.minAppVersionCode) {
                skipped[0] = true;
                diagnostic("skipped", "check_failed", traceId, manifest.version, startedAt, -1, -1L);
                return;
            }
            if (active != null && active.version.equals(manifest.version)) {
                // An APK upgrade may carry the UI already downloaded by the
                // previous APK. Its committed cache need not be copied again.
                context.getSharedPreferences("ui-install", Context.MODE_PRIVATE).edit()
                        .putInt("appVersion", BuildConfig.VERSION_CODE).apply();
                skipped[0] = true;
                diagnostic("skipped", "check_latest", traceId, manifest.version, startedAt, -1, manifest.entries.size());
                return;
            }
            File staging = new File(root, ".staging-bundled-" + UUID.randomUUID());
            File filesDir = new File(staging, "files");
            if (!filesDir.mkdirs() && !filesDir.isDirectory()) return;
            try {
                for (Entry entry : manifest.entries.values()) {
                    if (closed.get() || Thread.currentThread().isInterrupted()) throw new IOException("cancelled");
                    File target = safeFile(filesDir, entry.path.substring(1));
                    File parent = target.getParentFile();
                    if (parent == null || (!parent.mkdirs() && !parent.isDirectory())) throw new IOException("asset path");
                    try (InputStream input = assets.open("ui/" + entry.path.substring(1))) {
                        copyVerified(input, target, entry);
                    }
                }
                verifyShell(manifest, filesDir);
                writeJsonAtomically(new File(staging, "ui-release.json"), json.toString() + "\n");
                activateLocked(new Release(manifest, filesDir));
                context.getSharedPreferences("ui-install", Context.MODE_PRIVATE).edit()
                        .putInt("appVersion", BuildConfig.VERSION_CODE).apply();
                diagnostic("verified", "ui_embedded", traceId, manifest.version, startedAt, -1, manifest.entries.size());
                diagnostic("committed", "ui_embedded", traceId, manifest.version, startedAt, -1, manifest.entries.size());
                completed[0] = true;
            } finally {
                deleteRecursively(staging);
            }
        } catch (Exception ignored) {
            // Development builds may deliberately omit the bundled cache.
        } finally {
            if (!completed[0] && !skipped[0]) diagnostic("failed", "ui_failed", traceId, null, startedAt, -1, -1L);
        }
    }

    private Release readMarkedRelease(File marker) {
        if (!marker.isFile()) return null;
        try (InputStream input = new FileInputStream(marker)) {
            JSONObject value = new JSONObject(readText(input));
            String version = value.optString("version", "");
            if (!VERSION.matcher(version).matches()) return null;
            File directory = new File(root, version);
            File manifestFile = new File(directory, "ui-release.json");
            if (!manifestFile.isFile()) return null;
            try (InputStream manifestInput = new FileInputStream(manifestFile)) {
                String manifestText = readText(manifestInput);
                Manifest manifest = parseManifest(new JSONObject(manifestText));
                if (!manifest.version.equals(version) || BuildConfig.VERSION_CODE < manifest.minAppVersionCode) return null;
                String manifestHash = hex(sha256().digest(manifestText.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
                String receipt = value.optString("manifestSha256", "");
                if (!receipt.isEmpty() && !manifestHash.equals(receipt)) return null;
                boolean committed = manifestHash.equals(value.optString("manifestSha256", ""));
                File filesDir = new File(directory, "files");
                if (!filesDir.isDirectory()) return null;
                for (Entry entry : manifest.entries.values()) {
                    if (closed.get() || Thread.currentThread().isInterrupted()) return null;
                    File file = safeFile(filesDir, entry.path.substring(1));
                    if (!file.isFile() || file.length() != entry.bytes) return null;
                    if (!committed || entry.path.equals(manifest.shell)) {
                        startupVerifiedBytes += entry.bytes;
                        if (!verifyFile(file, entry.bytes, entry.sha256)) return null;
                    }
                }
                verifyShell(manifest, filesDir);
                // Older installs migrate once after the original complete
                // check. Only our verified installer writes this receipt.
                if (!committed) writeMarkerAtomically(marker, version);
                Release release = new Release(manifest, filesDir);
                File shell = safeFile(filesDir, manifest.shell.substring(1));
                release.verifiedFiles.put(manifest.shell, fileStamp(shell));
                return release;
            }
        } catch (Exception ignored) {
            return null;
        }
    }

    private void activateLocked(Release release) throws IOException {
      synchronized (lock) {
        if (closed.get() || Thread.currentThread().isInterrupted()) throw new IOException("cancelled");
        File releaseDir = new File(root, release.version);
        // An immutable version already referenced by a live document cannot
        // be replaced, even by an otherwise valid same-version download.
        if (releaseDir.exists() && pageLeases.containsKey(new File(releaseDir,"files").getAbsolutePath())) {
            Release existing=active;
            if(existing!=null&&existing.version.equals(release.version)&&sameEntries(existing,release))return;
            throw new IOException("release still used by a page");
        }
        if (releaseDir.exists()) deleteRecursively(releaseDir);
        File staging = release.filesDir.getParentFile();
        if (!staging.renameTo(releaseDir)) {
            try {
                Files.move(staging.toPath(), releaseDir.toPath(), StandardCopyOption.ATOMIC_MOVE);
            } catch (Exception failure) {
                throw new IOException("release move", failure);
            }
        }
        Release installed = new Release(release.manifest, new File(releaseDir, "files"));
        for (String path : installed.entries.keySet()) {
            installed.verifiedFiles.put(path, fileStamp(new File(installed.filesDir, path.substring(1))));
        }
        Release old = active;
        if (old != null) writeMarker(new File(root, "lastgood.json"), old.version);
        writeMarkerAtomically(new File(root, "active.json"), installed.version);
        active = installed;
        pruneOldReleases(installed.version, old == null ? null : old.version);
      }
    }

    private static boolean sameEntries(Release a,Release b){
        if(!a.shellPath.equals(b.shellPath)||a.manifest.minAppVersionCode!=b.manifest.minAppVersionCode||!a.entries.keySet().equals(b.entries.keySet()))return false;
        for(String path:a.entries.keySet()){EntryView x=a.entries.get(path),y=b.entries.get(path);if(x.bytes!=y.bytes||!x.sha256.equals(y.sha256)||!x.mime.equals(y.mime))return false;}
        return true;
    }

    private void pruneOldReleases(String activeVersion, @Nullable String lastGoodVersion) {
        File[] children = root.listFiles();
        if (children == null) return;
        for (File child : children) {
            String name = child.getName();
            if (!child.isDirectory() || name.startsWith(".")) continue;
            if (name.equals(activeVersion) || (lastGoodVersion != null && name.equals(lastGoodVersion))) continue;
            if (pageLeases.containsKey(new File(child,"files").getAbsolutePath())) continue;
            if (VERSION.matcher(name).matches()) deleteRecursively(child);
        }
    }

    private static Manifest parseManifest(JSONObject raw) throws JSONException {
        if (raw.optInt("schemaVersion", -1) != 1) throw new JSONException("schema");
        String version = raw.optString("version", "");
        String shell = raw.optString("shell", "");
        int minAppVersionCode = raw.optInt("minAppVersionCode", 1);
        if (!VERSION.matcher(version).matches() || minAppVersionCode < 1 || !shell.equals("/dsh-native-assets/" + version + "/shell.html")) {
            throw new JSONException("manifest identity");
        }
        JSONArray files = raw.optJSONArray("files");
        if (files == null || files.length() < 1 || files.length() > MAX_FILES) throw new JSONException("manifest files");
        Map<String, Entry> entries = new HashMap<>();
        long total = 0L;
        for (int index = 0; index < files.length(); index++) {
            JSONObject value = files.optJSONObject(index);
            if (value == null) throw new JSONException("file entry");
            String path = value.optString("path", "");
            String url = value.optString("url", "");
            String sha256 = value.optString("sha256", "");
            String mime = value.optString("mime", "").toLowerCase(Locale.ROOT);
            long bytes = value.optLong("bytes", -1L);
            if (!isAllowedPath(path, version) || !url.equals("/android/ui/" + version + "/files" + path)
                    || !SHA256.matcher(sha256).matches() || bytes < 1L || bytes > MAX_FILE_BYTES
                    || mime.isEmpty() || entries.containsKey(path)) throw new JSONException("file contract");
            boolean shellFile = path.equals(shell);
            if (shellFile) {
                if (!mime.contains("html")) throw new JSONException("shell type");
            } else if (mime.contains("html") || mime.contains("json")) {
                throw new JSONException("dependency type");
            }
            total += bytes;
            if (total > MAX_TOTAL_BYTES) throw new JSONException("release too large");
            entries.put(path, new Entry(path, url, sha256, bytes, mime));
        }
        if (!entries.containsKey(shell)) throw new JSONException("shell missing");
        return new Manifest(version, shell, minAppVersionCode, Collections.unmodifiableMap(entries));
    }

    private static boolean isAllowedPath(String path, String version) {
        return (path.equals("/dsh-native-assets/" + version + "/shell.html") || NATIVE.matcher(path).matches() || OFFICIAL.matcher(path).matches());
    }

    private static void verifyAndWrite(ResponseBody body, File target, Entry entry) throws IOException {
        verifyAndWrite(body, target, entry, null);
    }

    private static void verifyAndWrite(ResponseBody body, File target, Entry entry,
                                       @Nullable AssetDiagnostic asset) throws IOException {
        if (asset != null) asset.operation = "body_partial";
        try (InputStream input = body.byteStream()) {
            copyVerified(input, target, entry, asset);
            if (asset != null) asset.operation = "body_partial";
        }
    }

    // Observation only: fixed labels and manifest digest prefix; no URL/body/error text.
    // The original refresh trace, return values, timeouts, cleanup and active marker remain authoritative.
    private final class AssetDiagnostic {
        final String scope, traceId, version, hash;
        final long startedAt = SystemClock.elapsedRealtime();
        long bytes;
        int statusCode = -1;
        String operation = "request_failed", firstFailure;

        AssetDiagnostic(String scope, String traceId, String version, Entry entry) {
            this.scope = scope; this.traceId = traceId; this.version = version;
            this.hash = entry.sha256.substring(0, 16);
        }

        void failedAt(String fixedOperation) {
            if (firstFailure == null) firstFailure = fixedOperation;
        }

        void event(String stage, String reason, @Nullable String failureClass) {
            try {
                JSONObject fields = new JSONObject().put("traceId", traceId).put("uiVersion", version)
                        .put("contentHash", hash).put("count", bytes).put("reason", reason)
                        .put("durationMs", Math.max(0L, SystemClock.elapsedRealtime() - startedAt));
                if (statusCode >= 100 && statusCode <= 999) fields.put("statusCode", statusCode);
                if (failureClass != null) fields.put("failureClass", failureClass);
                diagnostics.event(scope, "android-update", stage, fields);
            } catch (Exception ignored) {
                // Diagnostics cannot change asset download, validation or storage behavior.
            }
        }

        void failure(Exception failure) {
            String reason = firstFailure == null ? operation : firstFailure;
            if (cancelRequested.get()) {
                event("cancelled", "cancelled", "aborted");
                return;
            }
            String kind;
            if ("store_failed".equals(reason)) kind = "storage";
            else if ("verify_failed".equals(reason)) kind = "rpc_contract";
            else if (failure instanceof java.net.UnknownHostException) kind = "dns";
            else if (failure instanceof javax.net.ssl.SSLException) kind = "tls";
            else if (failure instanceof java.io.InterruptedIOException) kind = "timeout";
            else if (statusCode == 401 || statusCode == 403 || statusCode == 303) kind = "auth";
            else if (statusCode >= 100 && statusCode != 200) kind = "http";
            else if (failure instanceof IOException) kind = "connection";
            else kind = "unknown";
            event("failed", reason, kind);
        }
    }

    private static final class AssetInput extends BufferedInputStream {
        final AssetDiagnostic asset;
        AssetInput(InputStream input, AssetDiagnostic asset) { super(input); this.asset = asset; }
        @Override public synchronized int read(byte[] bytes, int offset, int length) throws IOException {
            asset.operation = "body_partial";
            try {
                int count = super.read(bytes, offset, length);
                if (count > 0) asset.bytes += count;
                return count;
            } catch (IOException | RuntimeException failure) {
                asset.failedAt("body_partial"); throw failure;
            }
        }
        @Override public void close() throws IOException {
            try { super.close(); }
            catch (IOException | RuntimeException failure) { asset.failedAt("body_partial"); throw failure; }
        }
    }

    private static final class AssetOutput extends BufferedOutputStream {
        final AssetDiagnostic asset;
        AssetOutput(OutputStream output, AssetDiagnostic asset) { super(output); this.asset = asset; }
        @Override public synchronized void write(byte[] bytes, int offset, int length) throws IOException {
            asset.operation = "store_failed";
            try { super.write(bytes, offset, length); }
            catch (IOException | RuntimeException failure) { asset.failedAt("store_failed"); throw failure; }
        }
        @Override public void close() throws IOException {
            asset.operation = "store_failed";
            try { super.close(); }
            catch (IOException | RuntimeException failure) { asset.failedAt("store_failed"); throw failure; }
        }
    }

    private static boolean verifyFile(File file, long bytes, String expectedSha256) {
        if (!file.isFile() || file.length() != bytes) return false;
        try (InputStream input = new BufferedInputStream(new FileInputStream(file))) {
            return verifyStream(input, bytes, expectedSha256);
        } catch (IOException ignored) {
            return false;
        }
    }

    private boolean releaseFilesValid(Release release) {
        if (release.corrupt.get()) return false;
        for (Map.Entry<String, EntryView> value : release.entries.entrySet()) {
            EntryView entry = value.getValue();
            File file = new File(release.filesDir, value.getKey().substring(1));
            if (!isInside(file, release.filesDir) || !file.isFile() || file.length() != entry.bytes) return false;
            // Unused files are checked when requested. Already used files only
            // need another digest if their identity changes; an unchanged update
            // manifest must not trigger another full bundle read.
            synchronized (release.verifiedFiles) {
                String previous = release.verifiedFiles.get(value.getKey());
                String stamp = fileStamp(file);
                if (stamp == null) return false;
                if (previous != null && !previous.equals(stamp)) {
                    if (!verifyFile(file, entry.bytes, entry.sha256)) return false;
                    release.verifiedFiles.put(value.getKey(), stamp);
                }
            }
        }
        return true;
    }

    private static boolean verifyStream(InputStream input, long bytes, String expectedSha256) throws IOException {
        MessageDigest digest = sha256();
        long count = 0L;
        byte[] buffer = new byte[32 * 1024];
        int read;
        while ((read = input.read(buffer)) != -1) {
            if (Thread.currentThread().isInterrupted()) throw new IOException("cancelled");
            count += read;
            if (count > bytes || count > MAX_FILE_BYTES) return false;
            digest.update(buffer, 0, read);
        }
        return count == bytes && hex(digest.digest()).equals(expectedSha256);
    }

    private static void copyVerified(InputStream source, File target, Entry entry) throws IOException {
        copyVerified(source, target, entry, null);
    }

    private static void copyVerified(InputStream source, File target, Entry entry,
                                     @Nullable AssetDiagnostic asset) throws IOException {
        File temporary = new File(target.getParentFile(), target.getName() + ".part");
        MessageDigest digest = sha256();
        long count = 0L;
        if (asset != null) asset.operation = "store_failed";
        try (InputStream input = asset == null ? new BufferedInputStream(source) : new AssetInput(source, asset);
             OutputStream output = asset == null ? new BufferedOutputStream(new FileOutputStream(temporary, false))
                     : new AssetOutput(new FileOutputStream(temporary, false), asset)) {
            byte[] buffer = new byte[32 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                if (Thread.currentThread().isInterrupted()) throw new IOException("cancelled");
                count += read;
                if (count > entry.bytes || count > MAX_FILE_BYTES) {
                    if (asset != null) asset.operation = "verify_failed";
                    if (asset != null) asset.failedAt("verify_failed");
                    throw new IOException("asset size");
                }
                digest.update(buffer, 0, read);
                output.write(buffer, 0, read);
            }
        } catch (Exception failure) {
            //noinspection ResultOfMethodCallIgnored
            temporary.delete();
            if (failure instanceof IOException) throw (IOException) failure;
            throw new IOException("asset write", failure);
        }
        if (asset != null) {
            asset.operation = "verify_failed";
            asset.event("received", "body_ready", null);
        }
        if (count != entry.bytes || !hex(digest.digest()).equals(entry.sha256)) {
            //noinspection ResultOfMethodCallIgnored
            temporary.delete();
            throw new IOException("asset integrity");
        }
        if (asset != null) {
            asset.event("verified", "verify_ok", null);
            asset.operation = "store_failed";
        }
        if (!temporary.renameTo(target)) {
            try {
                Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (Exception failure) {
                throw new IOException("asset move", failure);
            }
        }
    }

    private static void verifyShell(Manifest manifest, File filesDir) throws IOException {
        Entry shell = manifest.entries.get(manifest.shell);
        File file = safeFile(filesDir, manifest.shell.substring(1));
        if (shell == null || !file.isFile() || file.length() != shell.bytes) throw new IOException("shell missing");
        try (InputStream input = new BufferedInputStream(new FileInputStream(file))) {
            String text = readText(input);
            if (text.contains("scopeToken=") || text.contains("__DSH_SCOPE__")) throw new IOException("shell contains credential");
        }
    }

    private static MessageDigest sha256() throws IOException {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException failure) {
            throw new IOException("sha256 unavailable", failure);
        }
    }

    private static String hex(byte[] value) {
        StringBuilder result = new StringBuilder(value.length * 2);
        for (byte item : value) result.append(String.format(Locale.ROOT, "%02x", item & 0xff));
        return result.toString();
    }

    private static String readText(InputStream source) throws IOException {
        StringBuilder result = new StringBuilder();
        byte[] buffer = new byte[16 * 1024];
        int read;
        long total = 0L;
        while ((read = source.read(buffer)) != -1) {
            total += read;
            if (total > 2L * 1024L * 1024L) throw new IOException("text too large");
            result.append(new String(buffer, 0, read, java.nio.charset.StandardCharsets.UTF_8));
        }
        return result.toString();
    }

    private static File safeFile(File root, String relative) throws IOException {
        File result = new File(root, relative);
        if (!isInside(result, root)) throw new IOException("path escape");
        return result;
    }

    private static boolean isInside(File candidate, File root) {
        try {
            String rootPath = root.getCanonicalPath();
            String candidatePath = candidate.getCanonicalPath();
            return candidatePath.equals(rootPath) || candidatePath.startsWith(rootPath + File.separator);
        } catch (IOException ignored) {
            return false;
        }
    }

    private static void writeMarkerAtomically(File marker, String version) throws IOException {
        File temporary = new File(marker.getParentFile(), marker.getName() + ".next");
        writeMarker(temporary, version);
        try {
            Files.move(temporary.toPath(), marker.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (Exception failure) {
            if (!temporary.renameTo(marker)) throw new IOException("marker move", failure);
        }
    }

    private static void writeMarker(File marker, String version) throws IOException {
        File manifest = new File(new File(marker.getParentFile(), version), "ui-release.json");
        String manifestHash;
        try (InputStream input = new FileInputStream(manifest)) {
            manifestHash = hex(sha256().digest(readText(input).getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        }
        writeJsonAtomically(marker, "{\"version\":\"" + version + "\",\"manifestSha256\":\"" + manifestHash + "\"}\n");
    }

    @Nullable private static String fileStamp(File file) {
        try {
            java.nio.file.attribute.BasicFileAttributes attributes = Files.readAttributes(file.toPath(),
                    java.nio.file.attribute.BasicFileAttributes.class, java.nio.file.LinkOption.NOFOLLOW_LINKS);
            if (!attributes.isRegularFile()) return null;
            return attributes.fileKey() + ":" + attributes.size() + ":" + attributes.lastModifiedTime();
        } catch (IOException ignored) { return null; }
    }

    private static void writeJsonAtomically(File file, String text) throws IOException {
        File temporary = new File(file.getParentFile(), file.getName() + ".next");
        try (OutputStream output = new BufferedOutputStream(new FileOutputStream(temporary, false))) {
            output.write(text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            output.flush();
        }
        try {
            Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (Exception failure) {
            if (!temporary.renameTo(file)) throw new IOException("file move", failure);
        }
    }

    private static void deleteRecursively(@Nullable File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursively(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    @Override
    public void close() {
        closed.set(true);
        cancelRefresh();
    }

    public static final class LocalResource implements Closeable {
        public final String mime;
        public final InputStream stream;
        public final long bytes;

        LocalResource(String mime, InputStream stream, long bytes) {
            this.mime = mime;
            this.stream = stream;
            this.bytes = bytes;
        }

        @Override
        public void close() throws IOException {
            stream.close();
        }
    }

    public static final class UpdateResult {
        public final boolean success;
        public final boolean changed;
        @Nullable public final String version;
        @Nullable public final String reason;

        private UpdateResult(boolean success, boolean changed, @Nullable String version, @Nullable String reason) {
            this.success = success;
            this.changed = changed;
            this.version = version;
            this.reason = reason;
        }

        static UpdateResult updated(String version) { return new UpdateResult(true, true, version, null); }
        static UpdateResult unchanged(String version) { return new UpdateResult(true, false, version, null); }
        static UpdateResult failure(String reason) { return new UpdateResult(false, false, null, reason); }
    }

    private static final class Entry {
        final String path;
        final String url;
        final String sha256;
        final long bytes;
        final String mime;

        Entry(String path, String url, String sha256, long bytes, String mime) {
            this.path = path;
            this.url = url;
            this.sha256 = sha256;
            this.bytes = bytes;
            this.mime = mime;
        }
    }

    private static final class Manifest {
        final String version;
        final String shell;
        final int minAppVersionCode;
        final Map<String, Entry> entries;

        Manifest(String version, String shell, int minAppVersionCode, Map<String, Entry> entries) {
            this.version = version;
            this.shell = shell;
            this.minAppVersionCode = minAppVersionCode;
            this.entries = entries;
        }
    }

    public static final class Release {
        public final String version;
        public final String shellPath;
        public final Map<String, EntryView> entries;
        private final File filesDir;
        private final Manifest manifest;
        private final Map<String, String> verifiedFiles = new HashMap<>();
        private final AtomicBoolean corrupt = new AtomicBoolean();

        Release(Manifest manifest, File filesDir) {
            this.manifest = manifest;
            this.version = manifest.version;
            this.shellPath = manifest.shell;
            this.filesDir = filesDir;
            Map<String, EntryView> copy = new HashMap<>();
            for (Entry entry : manifest.entries.values()) copy.put(entry.path, new EntryView(entry.mime, entry.bytes, entry.sha256));
            this.entries = Collections.unmodifiableMap(copy);
        }
    }

    public static final class EntryView {
        public final String mime;
        public final long bytes;
        public final String sha256;

        EntryView(String mime, long bytes, String sha256) {
            this.mime = mime;
            this.bytes = bytes;
            this.sha256 = sha256;
        }
    }
}
