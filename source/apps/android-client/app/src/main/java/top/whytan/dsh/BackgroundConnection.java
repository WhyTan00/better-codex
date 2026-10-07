package top.whytan.dsh;

import android.app.ActivityManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.LinkProperties;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;

import androidx.core.content.ContextCompat;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.UUID;

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
    private volatile boolean workPending;
    private volatile boolean networkAvailable;
    private volatile boolean networkValidated;
    private volatile boolean networkMetered;
    private volatile boolean networkWifi;
    private volatile boolean networkCellular;
    private volatile boolean networkVpn;
    private volatile boolean wakeHeld;
    private boolean powerStateInitialized;
    private boolean lastBatteryExempt;
    private boolean lastDeviceIdle;
    private boolean lastPowerSave;
    private boolean lastBackgroundRestricted;
    private boolean lastScreenInteractive;
    private boolean callbackRegistered;
    private boolean receiverRegistered;
    private Network activeNetwork;
    private Network callbackNetwork;
    private LinkProperties linkProperties;
    private long networkGeneration;
    private long leaseAt;
    private final String connectionId = UUID.randomUUID().toString();
    private final long connectionStartedAt = SystemClock.elapsedRealtime();

    BackgroundConnection(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
        connectivity = context.getSystemService(ConnectivityManager.class);
        power = context.getSystemService(PowerManager.class);
        wakeLock = power == null ? null : power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,
                "top.whytan.dsh:BackgroundMessages");
        if (wakeLock != null) wakeLock.setReferenceCounted(false);
    }

    private void diagnostic(String stage, String reason, boolean available, boolean validated,
                            boolean metered, boolean wifi, boolean cellular, boolean vpn) {
        JSONObject fields = new JSONObject();
        try {
            fields.put("reason", reason);
            fields.put("traceId", UUID.randomUUID().toString());
            fields.put("connectionId", connectionId);
            fields.put("online", available);
            fields.put("networkAvailable", available);
            fields.put("validated", validated);
            fields.put("metered", metered);
            fields.put("wifi", wifi);
            fields.put("cellular", cellular);
            fields.put("vpn", vpn);
            fields.put("durationMs", Math.max(0L, SystemClock.elapsedRealtime() - connectionStartedAt));
            putPowerFields(fields);
        } catch (JSONException ignored) {}
        try {
            NativeDiagnostics.get(context).event(SyncForegroundService.deviceOwner(context),
                    "android-network", stage, fields);
        } catch (Exception ignored) {
            // Network observation is auxiliary and must never block recovery.
        }
    }

    private final ConnectivityManager.NetworkCallback networkCallback = new ConnectivityManager.NetworkCallback() {
        @Override public void onAvailable(Network network) {
            if (!started) return;
            if (!network.equals(callbackNetwork)) linkProperties = null;
            callbackNetwork = network;
            // Android delivers ordered capabilities next; querying here races it.
        }
        @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {
            if (started && network.equals(callbackNetwork)) applyNetwork(network, capabilities, true);
        }
        @Override public void onLinkPropertiesChanged(Network network, LinkProperties properties) {
            if (!started || !network.equals(callbackNetwork)) return;
            boolean changed = linkProperties != null && !linkProperties.equals(properties);
            linkProperties = properties;
            if (changed && networkAvailable && network.equals(activeNetwork)) {
                networkGeneration++; DshNetwork.networkChanged(context);
                diagnostic("connected", "network_changed", networkAvailable, networkValidated,
                        networkMetered, networkWifi, networkCellular, networkVpn);
                listener.onRecovery("network_changed");
                listener.onConditionsChanged();
            }
        }
        @Override public void onLost(Network network) {
            if (!started || !network.equals(callbackNetwork)) return;
            callbackNetwork = null; linkProperties = null;
            applyNetwork(null, null, true);
        }
    };

    private final BroadcastReceiver powerReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (!started) return;
            checkNetwork(false);
            String action = intent.getAction();
            String powerReason = powerReason(action);
            if (powerReason != null && powerStateChanged()) {
                diagnostic("background", powerReason, networkAvailable, networkValidated,
                        networkMetered, networkWifi, networkCellular, networkVpn);
            }
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
            main.postDelayed(this, workPending ? 30_000L : BackgroundSyncPolicy.IDLE_MS);
        }
    };

    void start(boolean stronger) {
        enhanced = stronger;
        if (started) { refresh(); return; }
        started = true;
        diagnostic("attempt", "service_start", false, false, false, false, false, false);
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
        capturePowerState();
        updateWakeLease();
        main.postDelayed(maintenance, 30_000L);
    }

    void setEnhanced(boolean value) { enhanced = value; refresh(); }

    void setWorkPending(boolean value) {
        if (workPending == value) return;
        workPending = value;
        main.post(() -> {
            if (!started) return;
            updateWakeLease();
            main.removeCallbacks(maintenance);
            main.postDelayed(maintenance, workPending ? 30_000L : BackgroundSyncPolicy.IDLE_MS);
            listener.onConditionsChanged();
        });
    }

    private void refresh() {
        main.post(() -> { if (started) { updateWakeLease(); listener.onConditionsChanged(); } });
    }

    private void checkNetwork(boolean recover) {
        if (!started) return;
        Network current = null; NetworkCapabilities caps = null;
        try {
            if (connectivity != null) {
                current = connectivity.getActiveNetwork();
                caps = connectivity.getNetworkCapabilities(current);
            }
        } catch (RuntimeException ignored) {}
        if (callbackNetwork == null) callbackNetwork = current;
        applyNetwork(current, caps, recover);
    }

    private void applyNetwork(Network current, NetworkCapabilities caps, boolean recover) {
        boolean validated = caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
        boolean available = caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) && validated;
        boolean metered = caps != null && !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED);
        boolean wifi = caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
        boolean cellular = caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR);
        boolean vpn = caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
        boolean connectionChanged = available != networkAvailable || validated != networkValidated
                || wifi != networkWifi || cellular != networkCellular
                || vpn != networkVpn || (available && (current == null || !current.equals(activeNetwork)));
        // Billing policy still updates the conditions consumer; it does not
        // invalidate an otherwise healthy socket on the same network path.
        boolean changed = connectionChanged || metered != networkMetered;
        boolean wasAvailable = networkAvailable;
        boolean wasValidated = networkValidated;
        if (connectionChanged) { networkGeneration++; DshNetwork.networkChanged(context); }
        activeNetwork = current;
        networkAvailable = available;
        networkValidated = validated;
        networkMetered = metered;
        networkWifi = wifi;
        networkCellular = cellular;
        networkVpn = vpn;
        updateWakeLease();
        if (changed) {
            String reason = !connectionChanged ? "capabilities_changed" : !available ? "network_lost"
                    : !wasAvailable ? "network_available"
                    : wasValidated != validated ? "validated_changed" : "network_changed";
            diagnostic(available ? "connected" : "failed", reason, available, validated,
                    metered, wifi, cellular, vpn);
            if (recover && available && connectionChanged) listener.onRecovery("network_changed");
            listener.onConditionsChanged();
        }
    }

    private static String powerReason(String action) {
        if (Intent.ACTION_SCREEN_ON.equals(action)) return "screen_on";
        if (Intent.ACTION_SCREEN_OFF.equals(action)) return "screen_off";
        if (PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED.equals(action)) return "idle_changed";
        if (PowerManager.ACTION_POWER_SAVE_MODE_CHANGED.equals(action)) return "power_save_changed";
        return null;
    }

    private boolean powerStateChanged() {
        JSONObject state = systemSnapshot(context);
        boolean batteryExempt = state.optBoolean("batteryExempt", false);
        boolean deviceIdle = state.optBoolean("deviceIdle", false);
        boolean powerSave = state.optBoolean("powerSave", false);
        boolean backgroundRestricted = state.optBoolean("backgroundRestricted", false);
        boolean screenInteractive = state.optBoolean("screenInteractive", false);
        boolean changed = !powerStateInitialized || batteryExempt != lastBatteryExempt
                || deviceIdle != lastDeviceIdle || powerSave != lastPowerSave
                || backgroundRestricted != lastBackgroundRestricted
                || screenInteractive != lastScreenInteractive;
        lastBatteryExempt = batteryExempt;
        lastDeviceIdle = deviceIdle;
        lastPowerSave = powerSave;
        lastBackgroundRestricted = backgroundRestricted;
        lastScreenInteractive = screenInteractive;
        powerStateInitialized = true;
        return changed;
    }

    private void capturePowerState() {
        powerStateChanged();
    }

    private void putPowerFields(JSONObject fields) throws JSONException {
        JSONObject state = systemSnapshot(context);
        for (String key : new String[]{"batteryExempt", "deviceIdle", "powerSave",
                "backgroundRestricted", "screenInteractive"}) {
            if (state.has(key)) fields.put(key, state.optBoolean(key, false));
        }
        fields.put("wakeHeld", wakeHeld);
    }

    private void updateWakeLease() {
        // A normal foreground service stays lightweight. Stronger mode is
        // useful only for pending work, with a network and the screen off. Every lease expires
        // if this service stops executing; there is no unbounded acquire().
        boolean needed = started && enhanced && workPending && networkAvailable && networkValidated && power != null && !power.isInteractive()
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
            value.put("networkMonitorId", connectionId);
            value.put("networkGeneration", networkGeneration);
            value.put("validated", networkValidated);
            value.put("metered", networkMetered);
            value.put("wifi", networkWifi);
            value.put("cellular", networkCellular);
            value.put("vpn", networkVpn);
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
        if (started) diagnostic("closed", "service_stop", networkAvailable, networkValidated,
                networkMetered, networkWifi, networkCellular, networkVpn);
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
