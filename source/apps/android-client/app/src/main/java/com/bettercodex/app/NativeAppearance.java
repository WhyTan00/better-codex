package com.bettercodex.app;

import android.app.Activity;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.view.View;
import android.webkit.WebView;
import androidx.core.view.WindowCompat;
import org.json.JSONObject;

/** Device appearance is independent of WebView's app-theme media query. */
final class NativeAppearance {
    private final Activity activity;
    private String scope;
    NativeAppearance(Activity activity, String scope) { this.activity = activity; this.scope = scope; }
    boolean systemDark() {
        return (activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
    }
    String mode() { return activity.getSharedPreferences("appearance", 0).getString("mode:" + scope, "system"); }
    boolean dark() { return "dark".equals(mode()) || ("system".equals(mode()) && systemDark()); }
    JSONObject snapshot() {
        JSONObject value = new JSONObject();
        try { value.put("mode", mode()).put("systemDark", systemDark()).put("variant", dark() ? "dark" : "light"); }
        catch (Exception ignored) { }
        return value;
    }
    void selectScope(String scope) { this.scope = scope; }
    void setMode(String mode) {
        if (!"system".equals(mode) && !"light".equals(mode) && !"dark".equals(mode)) throw new IllegalArgumentException("无效主题");
        activity.getSharedPreferences("appearance", 0).edit().putString("mode:" + scope, mode).apply();
    }
    void apply(WebView webView, View root) {
        boolean dark = dark();
        int color = dark ? Color.BLACK : Color.WHITE;
        activity.setTheme(dark ? R.style.AppThemeDark : R.style.AppThemeLight);
        activity.getWindow().setStatusBarColor(color);
        activity.getWindow().setNavigationBarColor(color);
        activity.getWindow().getDecorView().setBackgroundColor(color);
        if (Build.VERSION.SDK_INT >= 29) {
            activity.getWindow().setStatusBarContrastEnforced(false);
            activity.getWindow().setNavigationBarContrastEnforced(false);
        }
        WindowCompat.getInsetsController(activity.getWindow(), activity.getWindow().getDecorView()).setAppearanceLightStatusBars(!dark);
        WindowCompat.getInsetsController(activity.getWindow(), activity.getWindow().getDecorView()).setAppearanceLightNavigationBars(!dark);
        if (root != null) root.setBackgroundColor(color);
        if (webView != null) {
            webView.setBackgroundColor(color);
            webView.evaluateJavascript("(()=>{if(location.origin==='http://localhost:3080')dispatchEvent(new CustomEvent('betterCodex:android-theme',{detail:" + snapshot() + "}));})()", null);
        }
    }
}
