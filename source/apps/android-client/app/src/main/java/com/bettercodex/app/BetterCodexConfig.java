package com.bettercodex.app;

import android.net.Uri;

import androidx.annotation.Nullable;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/** Fixed, private endpoints for the BETTER_CODEX Android shell. */
public final class BetterCodexConfig {
    public static final String ORIGIN = "http://localhost:3080";
    public static final String HOST = "localhost:3080";
    public static final String SSO_HOST = "localhost:3080";
    public static final String DEFAULT_SCOPE = "ai";
    public static final String BRIDGE_NAME = "BetterCodexNative";

    private BetterCodexConfig() {}

    public static boolean isScope(@Nullable String scope) {
        return "ai".equals(scope) || "secondary".equals(scope);
    }

    public static String scopeOrDefault(@Nullable String scope) {
        return isScope(scope) ? scope : DEFAULT_SCOPE;
    }

    public static boolean isBetterCodexUri(@Nullable Uri uri) {
        return uri != null
                && "https".equalsIgnoreCase(uri.getScheme())
                && HOST.equalsIgnoreCase(uri.getHost())
                && (uri.getPort() == -1 || uri.getPort() == 443);
    }

    public static boolean isSsoUri(@Nullable Uri uri) {
        return uri != null
                && "https".equalsIgnoreCase(uri.getScheme())
                && SSO_HOST.equalsIgnoreCase(uri.getHost())
                && (uri.getPort() == -1 || uri.getPort() == 443);
    }

    public static boolean isAllowedSsoPath(@Nullable Uri uri) {
        if (!isSsoUri(uri)) return false;
        String path = uri.getPath();
        return path != null
                && (path.equals("/login")
                || path.startsWith("/login/")
                || path.equals("/api/ai-home/v1/sso/authorize")
                || path.startsWith("/api/ai-home/v1/sso/authorize/"));
    }

    public static String encodeQuery(@Nullable String value) {
        try { return URLEncoder.encode(value == null ? "" : value, "UTF-8"); }
        catch (java.io.UnsupportedEncodingException impossible) { throw new AssertionError(impossible); }
    }

    public static String syncEventsUrl(String scope, String epoch, long after) {
        return ORIGIN + "/sync/v1/w/" + scope + "/events?epoch="
                + encodeQuery(epoch) + "&after=" + Math.max(0L, after);
    }

    public static String nativeCatalogUrl(String scope, long after, @Nullable String generation) {
        StringBuilder value = new StringBuilder(ORIGIN)
                .append("/sync/v1/w/").append(scope)
                .append("/native-catalog?after=").append(Math.max(0L, after));
        if (generation != null && !generation.isEmpty()) {
            value.append("&generation=").append(encodeQuery(generation));
        }
        return value.toString();
    }

    public static String nativeReadUrl(String scope) {
        return ORIGIN + "/sync/v1/w/" + scope + "/native-read";
    }

    public static String shellUrl(String shellPath, String scope) {
        return ORIGIN + shellPath + "?workspace=" + scope + "&view=chat&nativeList=1&pwa=" + scope + "&launch=1";
    }

    public static String userAgentSuffix() {
        return String.format(Locale.ROOT, " BETTER_CODEXAndroid/%s", BuildConfig.VERSION_NAME);
    }
}
