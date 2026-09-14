package com.bettercodex.app;

import android.content.Context;
import android.content.res.AssetManager;
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
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Owns the credential-free, versioned WebView asset cache. A release becomes
 * active only after every declared file has passed size and SHA-256 checks.
 */
public final class UiReleaseStore implements Closeable {
    private static final Pattern VERSION = Pattern.compile("^[a-f0-9]{16}$");
    private static final Pattern SHA256 = Pattern.compile("^[a-f0-9]{64}$");
    private static final Pattern NATIVE = Pattern.compile("^/betterCodex-native-assets/[a-f0-9]{16}/(?:scope|runtime|pwa|loader|turn)\\.(?:js|css)$");
    private static final Pattern OFFICIAL = Pattern.compile("^/official-patched-v[0-9]+/assets/[A-Za-z0-9_.-]+\\.(?:js|mjs|css|woff2?|ttf|png|svg|jpg|jpeg|webp)$");
    private static final long MAX_FILE_BYTES = 24L * 1024L * 1024L;
    private static final long MAX_TOTAL_BYTES = 100L * 1024L * 1024L;
    private static final int MAX_FILES = 600;

    private final Context context;
    private final File root;
    private final Object lock = new Object();
    private volatile Release active;

    public UiReleaseStore(Context context) {
        this.context = context.getApplicationContext();
        this.root = new File(this.context.getFilesDir(), "ui-releases");
        // The app-private directory is not exported and is excluded from
        // backup by the manifest's data extraction rules.
        //noinspection ResultOfMethodCallIgnored
        root.mkdirs();
        synchronized (lock) {
            active = readMarkedRelease(new File(root, "active.json"));
            int installedApp = this.context.getSharedPreferences("ui-install", Context.MODE_PRIVATE)
                    .getInt("appVersion", 0);
            if (active == null || installedApp != BuildConfig.VERSION_CODE) installBundledLocked();
        }
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
        try {
            OkHttpClient client = baseClient.newBuilder().followRedirects(false).followSslRedirects(false).build();
            Request.Builder request = new Request.Builder()
                    .url(BetterCodexConfig.ORIGIN + "/android/ui-release.json")
                    .get()
                    .header("Origin", BetterCodexConfig.ORIGIN);
            addCookie(request, BetterCodexConfig.ORIGIN);
            JSONObject rawManifest;
            try (Response response = client.newCall(request.build()).execute()) {
                if (response.code() != 200 || response.body() == null) return UpdateResult.failure("manifest_unavailable");
                String contentType = response.header("Content-Type", "").toLowerCase(Locale.ROOT);
                if (!contentType.contains("json")) return UpdateResult.failure("manifest_type");
                rawManifest = new JSONObject(response.body().string());
            }
            Manifest manifest = parseManifest(rawManifest);
            if (BuildConfig.VERSION_CODE < manifest.minAppVersionCode) return UpdateResult.failure("app_too_old");
            Release current = active;
            if (current != null && current.version.equals(manifest.version)) return UpdateResult.unchanged(manifest.version);

            File staging = new File(root, ".staging-" + manifest.version + "-" + UUID.randomUUID());
            File filesDir = new File(staging, "files");
            if (!filesDir.mkdirs() && !filesDir.isDirectory()) return UpdateResult.failure("staging_unavailable");
            try {
                for (Entry entry : manifest.entries.values()) {
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
                                .url(BetterCodexConfig.ORIGIN + entry.url)
                                .get()
                                .header("Origin", BetterCodexConfig.ORIGIN);
                        addCookie(fileRequest, BetterCodexConfig.ORIGIN);
                        try (Response response = client.newCall(fileRequest.build()).execute()) {
                            if (response.code() != 200 || response.body() == null) throw new IOException("asset unavailable");
                            verifyAndWrite(response.body(), target, entry);
                        }
                    }
                }
                verifyShell(manifest, filesDir);
                writeJsonAtomically(new File(staging, "ui-release.json"), rawManifest.toString() + "\n");
                activateLocked(new Release(manifest, filesDir));
                deleteRecursively(staging);
                return UpdateResult.updated(manifest.version);
            } catch (Exception failure) {
                deleteRecursively(staging);
                return UpdateResult.failure("release_rejected");
            }
        } catch (Exception failure) {
            return UpdateResult.failure("manifest_unavailable");
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
        try (InputStream stream = assets.open("ui-release.json")) {
            String raw = readText(stream);
            JSONObject json = new JSONObject(raw);
            Manifest manifest = parseManifest(json);
            if (BuildConfig.VERSION_CODE < manifest.minAppVersionCode) return;
            File staging = new File(root, ".staging-bundled-" + UUID.randomUUID());
            File filesDir = new File(staging, "files");
            if (!filesDir.mkdirs() && !filesDir.isDirectory()) return;
            try {
                for (Entry entry : manifest.entries.values()) {
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
            } finally {
                deleteRecursively(staging);
            }
        } catch (Exception ignored) {
            // Development builds may deliberately omit the bundled cache.
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
                Manifest manifest = parseManifest(new JSONObject(readText(manifestInput)));
                if (!manifest.version.equals(version) || BuildConfig.VERSION_CODE < manifest.minAppVersionCode) return null;
                File filesDir = new File(directory, "files");
                if (!filesDir.isDirectory()) return null;
                for (Entry entry : manifest.entries.values()) {
                    File file = safeFile(filesDir, entry.path.substring(1));
                    if (!file.isFile() || file.length() != entry.bytes) return null;
                }
                verifyShell(manifest, filesDir);
                return new Release(manifest, filesDir);
            }
        } catch (Exception ignored) {
            return null;
        }
    }

    private void activateLocked(Release release) throws IOException {
        File releaseDir = new File(root, release.version);
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
        Release old = active;
        if (old != null) writeMarker(new File(root, "lastgood.json"), old.version);
        writeMarkerAtomically(new File(root, "active.json"), installed.version);
        active = installed;
        pruneOldReleases(installed.version, old == null ? null : old.version);
    }

    private void pruneOldReleases(String activeVersion, @Nullable String lastGoodVersion) {
        File[] children = root.listFiles();
        if (children == null) return;
        for (File child : children) {
            String name = child.getName();
            if (!child.isDirectory() || name.startsWith(".")) continue;
            if (name.equals(activeVersion) || (lastGoodVersion != null && name.equals(lastGoodVersion))) continue;
            if (VERSION.matcher(name).matches()) deleteRecursively(child);
        }
    }

    private static Manifest parseManifest(JSONObject raw) throws JSONException {
        if (raw.optInt("schemaVersion", -1) != 1) throw new JSONException("schema");
        String version = raw.optString("version", "");
        String shell = raw.optString("shell", "");
        int minAppVersionCode = raw.optInt("minAppVersionCode", 1);
        if (!VERSION.matcher(version).matches() || minAppVersionCode < 1 || !shell.equals("/betterCodex-native-assets/" + version + "/shell.html")) {
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
        return (path.equals("/betterCodex-native-assets/" + version + "/shell.html") || NATIVE.matcher(path).matches() || OFFICIAL.matcher(path).matches());
    }

    private static void verifyAndWrite(ResponseBody body, File target, Entry entry) throws IOException {
        try (InputStream input = body.byteStream()) {
            copyVerified(input, target, entry);
        }
    }

    private static void copyVerified(InputStream source, File target, Entry entry) throws IOException {
        File temporary = new File(target.getParentFile(), target.getName() + ".part");
        MessageDigest digest = sha256();
        long count = 0L;
        try (InputStream input = new BufferedInputStream(source); OutputStream output = new BufferedOutputStream(new FileOutputStream(temporary, false))) {
            byte[] buffer = new byte[32 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                count += read;
                if (count > entry.bytes || count > MAX_FILE_BYTES) throw new IOException("asset size");
                digest.update(buffer, 0, read);
                output.write(buffer, 0, read);
            }
        } catch (Exception failure) {
            //noinspection ResultOfMethodCallIgnored
            temporary.delete();
            if (failure instanceof IOException) throw (IOException) failure;
            throw new IOException("asset write", failure);
        }
        if (count != entry.bytes || !hex(digest.digest()).equals(entry.sha256)) {
            //noinspection ResultOfMethodCallIgnored
            temporary.delete();
            throw new IOException("asset integrity");
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
            if (text.contains("scopeToken=") || text.contains("__BETTER_CODEX_SCOPE__")) throw new IOException("shell contains credential");
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
        writeJsonAtomically(marker, "{\"version\":\"" + version + "\"}\n");
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
        // The store owns no long-lived sockets or threads.
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
