package com.bettercodex.app;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
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

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/** Explicit APK update checker; installation remains behind Android's installer confirmation. */
public final class ApkUpdateManager implements Closeable {
    private static final Pattern APK_PATH = Pattern.compile("^/android/releases/[1-9][0-9]*/[A-Za-z0-9_.-]+\\.apk$");
    private static final Pattern SHA256 = Pattern.compile("^[a-f0-9]{64}$");
    private static final long MAX_APK_BYTES = 256L * 1024L * 1024L;

    private final Context context;
    private final File updateDir;

    public ApkUpdateManager(Context context) {
        this.context = context.getApplicationContext();
        this.updateDir = new File(this.context.getCacheDir(), "updates");
        //noinspection ResultOfMethodCallIgnored
        updateDir.mkdirs();
    }

    @Nullable
    public CheckResult check(OkHttpClient baseClient) {
        try {
            OkHttpClient client = baseClient.newBuilder().followRedirects(false).followSslRedirects(false).build();
            Request.Builder request = new Request.Builder()
                    .url(BetterCodexConfig.ORIGIN + "/android/app-release.json")
                    .header("Origin", BetterCodexConfig.ORIGIN)
                    .get();
            addCookie(request);
            try (Response response = client.newCall(request.build()).execute()) {
                if (response.code() != 200 || response.body() == null) return null;
                JSONObject value = new JSONObject(response.body().string());
                if (value.optInt("schemaVersion", -1) != 1) return null;
                if (value.optInt("minSdk", 26) > Build.VERSION.SDK_INT) return null;
                long versionCode = value.optLong("versionCode", 0L);
                String versionName = value.optString("versionName", "");
                String url = value.optString("url", "");
                String sha = value.optString("sha256", "");
                long bytes = value.optLong("bytes", -1L);
                if (!"com.bettercodex.app".equals(value.optString("packageName", "")) || versionCode < 1L
                        || versionName.isEmpty() || !SHA256.matcher(sha).matches() || bytes < 1L || bytes > MAX_APK_BYTES) return null;
                Uri download = Uri.parse(BetterCodexConfig.ORIGIN + url);
                if (!BetterCodexConfig.isBetterCodexUri(download) || !APK_PATH.matcher(download.getPath() == null ? "" : download.getPath()).matches()) return null;
                if (currentVersionCode() >= versionCode) return new CheckResult(false, versionCode, versionName, url, sha, bytes);
                return new CheckResult(true, versionCode, versionName, url, sha, bytes);
            }
        } catch (Exception ignored) {
            return null;
        }
    }

    /** Download and verify a checked release. No installer is opened here. */
    @Nullable
    public File download(CheckResult update, OkHttpClient baseClient) {
        if (update == null || !update.available) return null;
        try {
            OkHttpClient client = baseClient.newBuilder().followRedirects(false).followSslRedirects(false).build();
            File temporary = new File(updateDir, "app-" + update.versionCode + "." + UUID.randomUUID() + ".part");
            File target = new File(updateDir, "app-" + update.versionCode + ".apk");
            Request.Builder request = new Request.Builder()
                    .url(BetterCodexConfig.ORIGIN + update.url)
                    .header("Origin", BetterCodexConfig.ORIGIN)
                    .get();
            addCookie(request);
            try (Response response = client.newCall(request.build()).execute()) {
                if (response.code() != 200 || response.body() == null) return null;
                String type = response.header("Content-Type", "").toLowerCase(Locale.ROOT);
                if (!type.contains("application/vnd.android.package-archive")) return null;
                copyVerified(response.body().byteStream(), temporary, update);
            }
            verifyPackage(temporary, update.versionCode);
            if (!temporary.renameTo(target)) Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            return target;
        } catch (Exception ignored) {
            return null;
        }
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
            String cookie = CookieManager.getInstance().getCookie(BetterCodexConfig.ORIGIN);
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
        // No long-lived resources; cached APKs remain until the system clears app cache.
    }

    public static final class CheckResult {
        public final boolean available;
        public final long versionCode;
        public final String versionName;
        public final String url;
        public final String sha256;
        public final long bytes;

        CheckResult(boolean available, long versionCode, String versionName, String url, String sha256, long bytes) {
            this.available = available;
            this.versionCode = versionCode;
            this.versionName = versionName;
            this.url = url;
            this.sha256 = sha256;
            this.bytes = bytes;
        }
    }
}
