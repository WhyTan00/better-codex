package top.whytan.dsh;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.webkit.CookieManager;

import androidx.annotation.Nullable;
import androidx.core.content.FileProvider;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.Closeable;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import okhttp3.Call;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/** Verified APK updates; installation remains behind Android's installer confirmation. */
public final class ApkUpdateManager implements Closeable {
    private static final Pattern APK_PATH = Pattern.compile("^/android/releases/[1-9][0-9]*/[A-Za-z0-9_.-]+\\.apk$");
    private static final Pattern SHA256 = Pattern.compile("^[a-f0-9]{64}$");
    private static final Pattern TRACE_ID = Pattern.compile("(?i)^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$");
    private static final long MAX_APK_BYTES = 256L * 1024L * 1024L;

    private final Context context;
    private final File updateDir;
    private final NativeDiagnostics diagnostics;
    private final AtomicBoolean closed = new AtomicBoolean();
    private final AtomicReference<Call> activeCall = new AtomicReference<>();
    private volatile String diagnosticScope = DshConfig.DEFAULT_SCOPE;

    public ApkUpdateManager(Context context) {
        this.context = context.getApplicationContext();
        this.diagnostics = NativeDiagnostics.get(this.context);
        this.updateDir = new File(this.context.getCacheDir(), "updates");
        //noinspection ResultOfMethodCallIgnored
        updateDir.mkdirs();
    }

    public void setDiagnosticScope(String scope) {
        if (DshConfig.isScope(scope)) diagnosticScope = scope;
    }

    private void diagnostic(String scope, String stage, String reason, @Nullable String traceId,
                            long startedAt, int statusCode, long count) {
        if (!DshConfig.isScope(scope)) return;
        JSONObject fields = new JSONObject();
        try {
            if (traceId != null && TRACE_ID.matcher(traceId).matches()) fields.put("traceId", traceId);
            if (reason != null) fields.put("reason", reason);
            if (startedAt >= 0L) fields.put("durationMs", Math.max(0L, SystemClock.elapsedRealtime() - startedAt));
            if (statusCode >= 100 && statusCode <= 999) fields.put("statusCode", statusCode);
            if (count >= 0L) fields.put("count", count);
        } catch (JSONException ignored) {
            return;
        }
        try {
            diagnostics.event(scope, "android-update", stage, fields);
        } catch (RuntimeException ignored) {
            // Update checks and verification must remain independent of diagnostics.
        }
    }

    @Nullable
    public CheckResult check(OkHttpClient baseClient) {
        String eventScope = diagnosticScope;
        String traceId = UUID.randomUUID().toString();
        long startedAt = SystemClock.elapsedRealtime();
        int[] statusCode = {-1};
        boolean[] terminal = {false};
        diagnostic(eventScope, "attempt", "check_start", traceId, startedAt, -1, -1L);
        if (closed.get() || baseClient == null) {
            terminal[0] = true;
            diagnostic(eventScope, "skipped", "cancelled", traceId, startedAt, -1, -1L);
            return null;
        }
        Call call = null;
        try {
            OkHttpClient client = boundedClient(baseClient, 15);
            Request.Builder request = new Request.Builder()
                    .url(DshConfig.ORIGIN + "/android/app-release.json")
                    .header("Origin", DshConfig.ORIGIN)
                    .get();
            addCookie(request);
            call = trackedCall(client, request.build());
            try (Response response = call.execute()) {
                statusCode[0] = response.code();
                if (response.code() != 200 || response.body() == null) return null;
                byte[] manifest = readManifest(response.body().byteStream());
                if (manifest.length > 64 * 1024 || closed.get()) return null;
                JSONObject value = new JSONObject(new String(manifest, java.nio.charset.StandardCharsets.UTF_8));
                if (value.optInt("schemaVersion", -1) != 1) return null;
                if (value.optInt("minSdk", 26) > Build.VERSION.SDK_INT) return null;
                long versionCode = value.optLong("versionCode", 0L);
                String versionName = value.optString("versionName", "");
                String url = value.optString("url", "");
                String sha = value.optString("sha256", "");
                long bytes = value.optLong("bytes", -1L);
                if (!"top.whytan.dsh".equals(value.optString("packageName", "")) || versionCode < 1L
                        || versionName.isEmpty() || !SHA256.matcher(sha).matches() || bytes < 1L || bytes > MAX_APK_BYTES) return null;
                Uri download = Uri.parse(DshConfig.ORIGIN + url);
                if (!DshConfig.isDshUri(download) || !APK_PATH.matcher(download.getPath() == null ? "" : download.getPath()).matches()) return null;
                diagnostic(eventScope, "received", "check_start", traceId, startedAt, statusCode[0], 1L);
                if (currentVersionCode() >= versionCode) {
                    terminal[0] = true;
                    diagnostic(eventScope, "committed", "check_latest", traceId, startedAt, statusCode[0], 1L);
                    return new CheckResult(false, versionCode, versionName, url, sha, bytes, traceId);
                }
                terminal[0] = true;
                diagnostic(eventScope, "committed", "check_available", traceId, startedAt, statusCode[0], 1L);
                return new CheckResult(true, versionCode, versionName, url, sha, bytes, traceId);
            }
        } catch (Exception ignored) {
            return null;
        } finally {
            if (call != null) activeCall.compareAndSet(call, null);
            if (!terminal[0]) {
                boolean cancelled = closed.get();
                diagnostic(eventScope, cancelled ? "cancelled" : "failed",
                        cancelled ? "cancelled" : "check_failed", traceId, startedAt, statusCode[0], -1L);
            }
        }
    }

    /** Download and verify a checked release. No installer is opened here. */
    @Nullable
    public File download(CheckResult update, OkHttpClient baseClient) {
        String eventScope = diagnosticScope;
        String traceId = update != null && TRACE_ID.matcher(update.traceId).matches()
                ? update.traceId : UUID.randomUUID().toString();
        long startedAt = SystemClock.elapsedRealtime();
        int[] statusCode = {-1};
        boolean[] terminal = {false};
        diagnostic(eventScope, "attempt", "download_start", traceId, startedAt, -1, -1L);
        if (closed.get() || update == null || !update.available || baseClient == null) {
            terminal[0] = true;
            diagnostic(eventScope, "skipped", "cancelled", traceId, startedAt, -1, -1L);
            return null;
        }
        File temporary = null;
        Call call = null;
        try {
            File target = new File(updateDir, "app-" + update.versionCode + ".apk");
            // Returning from the installer, or opening the app again, does not
            // redownload an already verified release.
            if (matchesRelease(target, update)) {
                try {
                    verifyPackage(target, update.versionCode);
                    if (closed.get()) return null;
                    diagnostic(eventScope, "verified", "verify_ok", traceId, startedAt, -1, 1L);
                    diagnostic(eventScope, "committed", "download_complete", traceId, startedAt, -1, 1L);
                    terminal[0] = true;
                    return target;
                }
                catch (IOException ignored) {
                    diagnostic(eventScope, "failed", "verify_failed", traceId, startedAt, -1, -1L);
                    /* Replace only after the new file verifies. */
                }
            }
            OkHttpClient client = boundedClient(baseClient, 180);
            temporary = new File(updateDir, "app-" + update.versionCode + "." + UUID.randomUUID() + ".part");
            Request.Builder request = new Request.Builder()
                    .url(DshConfig.ORIGIN + update.url)
                    .header("Origin", DshConfig.ORIGIN)
                    .get();
            addCookie(request);
            call = trackedCall(client, request.build());
            try (Response response = call.execute()) {
                statusCode[0] = response.code();
                if (response.code() != 200 || response.body() == null) return null;
                String type = response.header("Content-Type", "").toLowerCase(Locale.ROOT);
                if (!type.contains("application/vnd.android.package-archive")) return null;
                copyVerified(response.body().byteStream(), temporary, update);
            }
            diagnostic(eventScope, "downloaded", "download_complete", traceId, startedAt, statusCode[0], 1L);
            try {
                verifyPackage(temporary, update.versionCode);
            } catch (IOException failure) {
                diagnostic(eventScope, "failed", "verify_failed", traceId, startedAt, statusCode[0], -1L);
                throw failure;
            }
            diagnostic(eventScope, "verified", "verify_ok", traceId, startedAt, statusCode[0], 1L);
            if (closed.get()) return null;
            if (!temporary.renameTo(target)) Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            diagnostic(eventScope, "committed", "download_complete", traceId, startedAt, statusCode[0], 1L);
            terminal[0] = true;
            return target;
        } catch (Exception ignored) {
            return null;
        } finally {
            if (call != null) activeCall.compareAndSet(call, null);
            if (temporary != null && temporary.exists()) temporary.delete();
            if (!terminal[0]) {
                boolean cancelled = closed.get();
                diagnostic(eventScope, cancelled ? "cancelled" : "failed",
                        cancelled ? "cancelled" : "download_failed", traceId, startedAt, statusCode[0], -1L);
            }
        }
    }

    private static OkHttpClient boundedClient(OkHttpClient base, long seconds) {
        return base.newBuilder().followRedirects(false).followSslRedirects(false)
                .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
                .writeTimeout(30, TimeUnit.SECONDS).callTimeout(seconds, TimeUnit.SECONDS).build();
    }

    private static byte[] readManifest(InputStream input) throws IOException {
        java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int count;
        while ((count = input.read(buffer)) != -1) {
            if (output.size() + count > 64 * 1024) throw new IOException("update manifest too large");
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    private Call trackedCall(OkHttpClient client, Request request) throws IOException {
        Call call = client.newCall(request);
        if (!activeCall.compareAndSet(null, call)) throw new IOException("update already running");
        if (closed.get()) call.cancel();
        return call;
    }

    private static boolean matchesRelease(File file, CheckResult update) {
        if (!file.isFile() || file.length() != update.bytes) return false;
        try (InputStream input = new BufferedInputStream(new FileInputStream(file))) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
            return hex(digest.digest()).equals(update.sha256);
        } catch (Exception ignored) { return false; }
    }

    private void verifyPackage(File apk, long expectedVersion) throws IOException {
        try {
            PackageManager pm = context.getPackageManager();
            int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
            PackageInfo archive = pm.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
            PackageInfo installed = pm.getPackageInfo(context.getPackageName(), flags);
            if (archive == null || !context.getPackageName().equals(archive.packageName)
                    || archive.applicationInfo == null || archive.applicationInfo.minSdkVersion > Build.VERSION.SDK_INT)
                throw new IOException("apk package incompatible");
            long version = Build.VERSION.SDK_INT >= 28 ? archive.getLongVersionCode() : archive.versionCode;
            if (version != expectedVersion || version <= currentVersionCode()) throw new IOException("apk version mismatch");
            Signature[] proposed = Build.VERSION.SDK_INT >= 28 && archive.signingInfo != null
                    ? archive.signingInfo.getApkContentsSigners() : archive.signatures;
            Signature[] current = Build.VERSION.SDK_INT >= 28 && installed.signingInfo != null
                    ? installed.signingInfo.getApkContentsSigners() : installed.signatures;
            if (proposed == null || current == null || proposed.length != current.length || current.length == 0)
                throw new IOException("apk signer missing");
            java.util.Set<String> expected = new java.util.HashSet<>();
            for (Signature item : current) expected.add(item.toCharsString());
            for (Signature item : proposed) if (!expected.remove(item.toCharsString())) throw new IOException("apk signer mismatch");
            if (!expected.isEmpty()) throw new IOException("apk signer mismatch");
        } catch (PackageManager.NameNotFoundException failure) {
            throw new IOException("installed package unavailable", failure);
        }
    }

    public Intent installerIntent(File apk) throws IOException {
        if (apk == null || !apk.isFile()) throw new IOException("apk missing");
        Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", apk);
        return new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    private long currentVersionCode() {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
        } catch (Exception ignored) {
            return BuildConfig.VERSION_CODE;
        }
    }

    private static void addCookie(Request.Builder request) {
        try {
            String cookie = CookieManager.getInstance().getCookie(DshConfig.ORIGIN);
            if (cookie != null && !cookie.isEmpty()) request.header("Cookie", cookie);
        } catch (RuntimeException ignored) {
        }
    }

    private static void copyVerified(InputStream source, File target, CheckResult update) throws IOException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (Exception failure) {
            throw new IOException("sha256 unavailable", failure);
        }
        long count = 0L;
        try (InputStream input = new BufferedInputStream(source); OutputStream output = new BufferedOutputStream(new FileOutputStream(target, false))) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                count += read;
                if (count > update.bytes || count > MAX_APK_BYTES) throw new IOException("apk too large");
                digest.update(buffer, 0, read);
                output.write(buffer, 0, read);
            }
        }
        if (count != update.bytes || !hex(digest.digest()).equals(update.sha256)) {
            //noinspection ResultOfMethodCallIgnored
            target.delete();
            throw new IOException("apk integrity");
        }
    }

    private static String hex(byte[] value) {
        StringBuilder result = new StringBuilder(value.length * 2);
        for (byte item : value) result.append(String.format(Locale.ROOT, "%02x", item & 0xff));
        return result.toString();
    }

    @Override
    public void close() {
        boolean firstClose = closed.compareAndSet(false, true);
        Call call = activeCall.get();
        if (call != null) {
            if (firstClose) diagnostic(diagnosticScope, "cancelled", "cancelled", null, -1L, -1, -1L);
            call.cancel();
        }
    }

    public static final class CheckResult {
        public final boolean available;
        public final long versionCode;
        public final String versionName;
        public final String url;
        public final String sha256;
        public final long bytes;
        public final String traceId;

        CheckResult(boolean available, long versionCode, String versionName, String url, String sha256, long bytes) {
            this(available, versionCode, versionName, url, sha256, bytes, UUID.randomUUID().toString());
        }

        CheckResult(boolean available, long versionCode, String versionName, String url, String sha256, long bytes, String traceId) {
            this.available = available;
            this.versionCode = versionCode;
            this.versionName = versionName;
            this.url = url;
            this.sha256 = sha256;
            this.bytes = bytes;
            this.traceId = traceId == null ? UUID.randomUUID().toString() : traceId;
        }
    }
}
