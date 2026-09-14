package com.bettercodex.app;

import android.app.ActivityManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;

import androidx.core.content.ContextCompat;

import org.json.JSONException;
import org.json.JSONObject;

/** Network recovery and the explicitly enabled, visible stronger background mode. */
final class BackgroundConnection implements AutoCloseable {
    interface Listener { void onRecovery(String reason); void onConditionsChanged(); }
    private static final long WAKE_LEASE_MS = 3 * 60_000L;
    private final Context context;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ConnectivityManager connectivity;
    private final PowerManager power;
    private final PowerManager.WakeLock wakeLock;
    private volatile boolean started;
    private volatile boolean enhanced;
    private volatile boolean networkAvailable;
    private volatile boolean wakeHeld;
    private boolean callbackRegistered;
    private boolean receiverRegistered;
    private Network activeNetwork;
    private long leaseAt;

    BackgroundConnection(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
        connectivity = context.getSystemService(ConnectivityManager.class);
        power = context.getSystemService(PowerManager.class);
        wakeLock = power == null ? null : power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,
                "com.bettercodex.app:BackgroundMessages");
        if (wakeLock != null) wakeLock.setReferenceCounted(false);
    }

    private final ConnectivityManager.NetworkCallback networkCallback = new ConnectivityManager.NetworkCallback() {
        @Override public void onAvailable(Network network) { checkNetwork(true); }
        @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) { checkNetwork(true); }
        @Override public void onLost(Network network) { checkNetwork(true); }
    };

    private final BroadcastReceiver powerReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (!started) return;
            checkNetwork(false);
            String action = intent.getAction();
            if (Intent.ACTION_SCREEN_ON.equals(action)
                    || (PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED.equals(action) && power != null && !power.isDeviceIdleMode())) {
                listener.onRecovery("device_awake");
            }
            updateWakeLease();
            listener.onConditionsChanged();
        }
    };

    private final Runnable maintenance = new Runnable() {
        @Override public void run() {
            if (!started) return;
            checkNetwork(true);
            updateWakeLease();
            main.postDelayed(this, 30_000L);
        }
    };

    void start(boolean stronger) {
        enhanced = stronger;
        if (started) { refresh(); return; }
        started = true;
        if (connectivity != null) {
            try {
                connectivity.registerDefaultNetworkCallback(networkCallback, main);
                callbackRegistered = true;
            } catch (RuntimeException ignored) { /* System state remains visible in settings. */ }
        }
        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_SCREEN_ON);
        filter.addAction(Intent.ACTION_SCREEN_OFF);
        filter.addAction(PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED);
        filter.addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED);
        try {
            ContextCompat.registerReceiver(context, powerReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
            receiverRegistered = true;
        } catch (RuntimeException ignored) {}
        checkNetwork(false);
        updateWakeLease();
        main.postDelayed(maintenance, 30_000L);
    }

    void setEnhanced(boolean value) { enhanced = value; refresh(); }

    private void refresh() {
        main.post(() -> { if (started) { updateWakeLease(); listener.onConditionsChanged(); } });
    }

    private void checkNetwork(boolean recover) {
        if (!started) return;
        Network current = null;
        boolean available = false;
        try {
            if (connectivity != null) {
                current = connectivity.getActiveNetwork();
                NetworkCapabilities caps = connectivity.getNetworkCapabilities(current);
                available = caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                        && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
            }
        } catch (RuntimeException ignored) {}
        boolean changed = available != networkAvailable || (available && !current.equals(activeNetwork));
        activeNetwork = current;
        networkAvailable = available;
        updateWakeLease();
        if (changed) {
            if (recover && available) listener.onRecovery("network_changed");
            listener.onConditionsChanged();
        }
    }

    private void updateWakeLease() {
        // A normal foreground service stays lightweight. Stronger mode is
        // useful only with a network and the screen off. Every lease expires
        // if this service stops executing; there is no unbounded acquire().
        boolean needed = started && enhanced && networkAvailable && power != null && !power.isInteractive()
                && SyncForegroundService.areSyncNotificationsAllowed(context);
        if (wakeLock == null) return;
        if (!needed) { releaseWake(); return; }
        long now = SystemClock.elapsedRealtime();
        if (!wakeLock.isHeld() || now - leaseAt >= 60_000L) {
            try { wakeLock.acquire(WAKE_LEASE_MS); leaseAt = now; }
            catch (RuntimeException ignored) {}
        }
        wakeHeld = wakeLock.isHeld();
    }

    private void releaseWake() {
        try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); }
        catch (RuntimeException ignored) {}
        wakeHeld = false;
    }

    JSONObject snapshot() {
        JSONObject value = systemSnapshot(context);
        try {
            value.put("enhanced", enhanced);
            value.put("wakeHeld", wakeHeld);
            value.put("networkAvailable", networkAvailable);
            value.put("networkMonitorRegistered", callbackRegistered);
        } catch (JSONException ignored) {}
        return value;
    }

    static JSONObject systemSnapshot(Context context) {
        JSONObject value = new JSONObject();
        PowerManager power = context.getSystemService(PowerManager.class);
        ActivityManager activity = context.getSystemService(ActivityManager.class);
        try {
            value.put("batteryExempt", power != null && power.isIgnoringBatteryOptimizations(context.getPackageName()));
            value.put("deviceIdle", power != null && power.isDeviceIdleMode());
            value.put("powerSave", power != null && power.isPowerSaveMode());
            value.put("screenInteractive", power != null && power.isInteractive());
            value.put("backgroundRestricted", Build.VERSION.SDK_INT >= 28 && activity != null && activity.isBackgroundRestricted());
        } catch (JSONException ignored) {}
        return value;
    }

    @Override public void close() {
        started = false;
        main.removeCallbacksAndMessages(null);
        if (callbackRegistered && connectivity != null) {
            try { connectivity.unregisterNetworkCallback(networkCallback); } catch (RuntimeException ignored) {}
        }
        if (receiverRegistered) {
            try { context.unregisterReceiver(powerReceiver); } catch (RuntimeException ignored) {}
        }
        callbackRegistered = receiverRegistered = false;
        releaseWake();
    }
}
