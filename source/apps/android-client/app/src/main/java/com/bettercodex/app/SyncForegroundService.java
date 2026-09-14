package com.bettercodex.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.concurrent.atomic.AtomicReference;

/** Explicitly user-controlled foreground service for read-only sync. */
public final class SyncForegroundService extends Service implements SyncClient.Listener {
    public static final String ACTION_START = "com.bettercodex.app.action.START_SYNC";
    public static final String ACTION_STOP = "com.bettercodex.app.action.STOP_SYNC";
    public static final String ACTION_STATUS = "com.bettercodex.app.action.SYNC_STATUS";
    public static final String EXTRA_SCOPE = "scope";
    public static final String EXTRA_STATUS = "status";

    private static final String PREFS = "sync-control";
    private static final String PREF_ENABLED_PREFIX = "enabled:";
    private static final String PREF_SCOPE = "last-scope";
    private static final String PREF_ENHANCED = "enhanced-background";
    /** The ongoing foreground notification must stay quiet. */
    private static final String SYNC_CHANNEL_ID = "betterCodex_sync_v1";
    /** Completion reminders have their own user controlled, heads-up channel. */
    private static final String COMPLETION_CHANNEL_ID = "betterCodex_completion_v1";
    private static final String PREF_COMPLETION_ENABLED = "completion-enabled";
    private static final String PREF_DEVICE_OWNER = "notification-owner";
    private static final int FOREGROUND_ID = 4101;
    private static final AtomicReference<SyncForegroundService> INSTANCE = new AtomicReference<>();

    private SyncStore store;
    private volatile SyncClient client;
    private BackgroundConnection backgroundConnection;
    private volatile String scope = BetterCodexConfig.DEFAULT_SCOPE;
    private volatile boolean enabled;
    private volatile String runningThreadId = "";
    private volatile int runningSessionCount;

    @Override
    public void onCreate() {
        super.onCreate();
        INSTANCE.set(this);
        store = new SyncStore(this);
        createNotificationChannel();
        backgroundConnection = new BackgroundConnection(this, new BackgroundConnection.Listener() {
            @Override public void onRecovery(String reason) {
                SyncClient current = client;
                if (enabled && current != null) current.recoverConnection(reason, "network_changed".equals(reason));
            }
            @Override public void onConditionsChanged() {
                if (!enabled || client == null) return;
                JSONObject state = statusSnapshot(SyncForegroundService.this, scope);
                updateForeground(state);
                publishStatus(state);
            }
        });
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            String requestedScope = BetterCodexConfig.scopeOrDefault(intent == null ? null : intent.getStringExtra(EXTRA_SCOPE));
            if (BetterCodexConfig.isScope(scope)) setEnabled(scope, false);
            if (!requestedScope.equals(scope)) {
                getPreferences().edit().putBoolean(PREF_ENABLED_PREFIX + requestedScope, false).apply();
            }
            // The service has one active scope. Keep the persisted status and
            // stop behavior tied to that active instance even if an old page
            // sends a stop request for the other workspace.
            if (scope == null || !BetterCodexConfig.isScope(scope)) scope = requestedScope;
            stopSyncAndSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_START.equals(action)) {
            String requestedScope = syncScope(this, intent.getStringExtra(EXTRA_SCOPE));
            if (client != null && !requestedScope.equals(scope)) {
                client.close();
                client = null;
                setEnabled(scope, false);
                JSONObject previous = store.getState(scope);
                try { previous.put("running", false); previous.put("online", false); previous.put("enabled", false); previous.put("state", "stopped"); } catch (JSONException ignored) {}
                store.setState(scope, previous);
            }
            scope = requestedScope;
            getPreferences().edit().putString(PREF_SCOPE, scope).apply();
            enabled = true;
            setEnabled(scope, true);
            startForegroundNow();
            startClient();
            backgroundConnection.start(isEnhanced(this));
            return START_STICKY;
        }
        // START_STICKY may recreate the process after a system kill. Resume
        // only when a prior explicit user action left this scope enabled.
        scope = syncScope(this, getPreferences().getString(PREF_SCOPE, BetterCodexConfig.DEFAULT_SCOPE));
        enabled = isEnabled(scope);
        if (enabled) {
            startForegroundNow();
            startClient();
            backgroundConnection.start(isEnhanced(this));
            return START_STICKY;
        }
        stopSelf(startId);
        return START_NOT_STICKY;
    }

    private void startForegroundNow() {
        Notification notification = foregroundNotification("正在准备持续同步");
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(FOREGROUND_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        } else {
            startForeground(FOREGROUND_ID, notification);
        }
    }

    private void startClient() {
        if (client != null) return;
        JSONObject state = new JSONObject();
        try {
            state.put("state", "starting");
            state.put("running", true);
            state.put("enabled", true);
            state.put("online", false);
            state.put("scope", scope);
        } catch (JSONException ignored) {
        }
        store.setState(scope, state);
        publishStatus(state);
        client = new SyncClient(this, scope, store, this);
        client.start();
    }

    private void stopSyncAndSelf() {
        if (backgroundConnection != null) backgroundConnection.close();
        if (client != null) {
            client.close();
            client = null;
        }
        JSONObject state = store.getState(scope);
        try {
            state.put("state", "stopped");
            state.put("running", false);
            state.put("enabled", false);
            state.put("online", false);
        } catch (JSONException ignored) {
        }
        store.setState(scope, state);
        publishStatus(state);
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private Notification foregroundNotification(String text) {
        Intent stop = new Intent(this, SyncForegroundService.class).setAction(ACTION_STOP);
        PendingIntent action = PendingIntent.getService(this, 4102, stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent open = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra("open_background_settings", true);
        Intent conversation = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra("notification_scope", scope);
        if (!runningThreadId.isEmpty()) conversation.putExtra("notification_thread", runningThreadId)
                .setData(android.net.Uri.parse(BetterCodexConfig.ORIGIN + "/local/" + runningThreadId + "?workspace=" + scope));
        PendingIntent content = PendingIntent.getActivity(this, 4104, conversation,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent settings = PendingIntent.getActivity(this, 4103, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, SYNC_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_launcher)
                .setContentTitle(runningSessionCount > 0 ? runningSessionCount + " 个会话运行中" : getString(R.string.sync_notification_title))
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(content)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .addAction(new NotificationCompat.Action(0, "后台设置", settings))
                .addAction(new NotificationCompat.Action(0, getString(R.string.sync_notification_stop), action))
                .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(SYNC_CHANNEL_ID, getString(R.string.sync_channel_name), NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("BETTER_CODEX 持续同步状态");
        NotificationChannel completion = new NotificationChannel(COMPLETION_CHANNEL_ID,
                getString(R.string.completion_channel_name), NotificationManager.IMPORTANCE_HIGH);
        completion.setDescription("任务完成提醒，可单独关闭");
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(channel);
            manager.createNotificationChannel(completion);
        }
    }

    private void updateForeground(JSONObject state) {
        long syncedAt = state.optLong("lastSuccessfulSyncAt", 0L);
        boolean fresh = state.optBoolean("online", false) && syncedAt > 0
                && System.currentTimeMillis() - syncedAt < 90_000L;
        JSONObject sessions = fresh ? store.runningSessions(scope) : new JSONObject();
        runningSessionCount = sessions.optInt("count", 0);
        runningThreadId = sessions.optString("threadId", "");
        String text;
        if ("auth_required".equals(state.optString("state"))) text = "登录已过期，点此打开 App";
        else if (!state.optBoolean("transportConnected", false)) text = "连接中断，等待网络恢复";
        else if (!state.optBoolean("hostOnline", false)) text = "手机已连接，等待电脑端恢复";
        else if (!fresh) text = "已连接，正在核对会话状态";
        else if (runningSessionCount > 0) text = "电脑端正在处理 · 持续接收会话更新";
        else text = "暂无运行中的会话 · 持续接收更新";
        if (isEnhanced(this)) text += " · 加强后台（较耗电）";
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this,
                android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) return;
        try { NotificationManagerCompat.from(this).notify(FOREGROUND_ID, foregroundNotification(text)); }
        catch (SecurityException permissionRevoked) { /* Notification permission may change between check and post. */ }
    }

    @Override
    public void onState(String stateScope, JSONObject state) {
        if (!enabled || client == null || !scope.equals(stateScope)) return;
        JSONObject next;
        try {
            next = new JSONObject(state.toString());
        } catch (JSONException ignored) {
            next = new JSONObject();
        }
        try {
            next.put("running", true);
            next.put("enabled", enabled);
            if (backgroundConnection != null) next.put("background", backgroundConnection.snapshot());
        } catch (JSONException ignored) {
        }
        store.setState(scope, next);
        updateForeground(next);
        publishStatus(next);
    }

    @Override
    public void onCompletion(String stateScope, String threadId, String turnId) {
        synchronized (SyncForegroundService.class) {
        if (!scope.equals(stateScope) || !stateScope.equals(deviceOwner(this)) || threadId == null || turnId == null) return;
        if (!completionNotificationsEnabled()) return;
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) return;
        String title = "会话已完成";
        JSONObject catalog = store.catalogRecord(scope, threadId);
        if (catalog != null) {
            JSONObject payload = catalog.optJSONObject("payload");
            JSONObject thread = payload == null ? null : payload.optJSONObject("nativeThread");
            String name = thread == null ? "" : thread.optString("name", "");
            if (!name.isEmpty()) title = name;
        }
        Intent open = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra("notification_scope", scope)
                .putExtra("notification_thread", threadId)
                .setData(android.net.Uri.parse(BetterCodexConfig.ORIGIN + "/local/" + threadId + "?workspace=" + scope));
        PendingIntent target = PendingIntent.getActivity(this, stableId(scope + ":" + threadId), open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new NotificationCompat.Builder(this, COMPLETION_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_launcher)
                .setContentTitle(title)
                .setContentText(getString(R.string.completion_notification_text))
                .setAutoCancel(true)
                .setContentIntent(target)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .build();
        try {
            NotificationManagerCompat.from(this).notify(stableId(scope + ":" + threadId + ":" + turnId), notification);
        } catch (SecurityException ignored) {
            // Notification permission may be revoked between the check and
            // delivery. The completion event remains persisted for dedupe.
        }
        }
    }

    private void publishStatus(JSONObject state) {
        Intent intent = new Intent(ACTION_STATUS)
                .setPackage(getPackageName())
                .putExtra(EXTRA_SCOPE, scope)
                .putExtra(EXTRA_STATUS, state.toString());
        sendBroadcast(intent);
    }

    private SharedPreferences getPreferences() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private boolean isEnabled(String value) {
        return getPreferences().getBoolean(PREF_ENABLED_PREFIX + value, false);
    }

    /**
     * Completion reminders are independently controllable from the ongoing
     * sync notification. Android's channel switch is the primary control;
     * the preference gives a future in-app setting a stable local contract.
     */
    private boolean completionNotificationsEnabled() {
        if (!areCompletionNotificationsEnabled(this)) return false;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel channel = manager == null ? null : manager.getNotificationChannel(COMPLETION_CHANNEL_ID);
        return channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    /** One explicit owner per installation; viewing another scope never changes it. */
    public static String deviceOwner(Context context) {
        String owner = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(PREF_DEVICE_OWNER, "");
        return BetterCodexConfig.isScope(owner) ? owner : "";
    }

    public static String syncScope(Context context, String fallback) {
        String owner = deviceOwner(context);
        return owner.isEmpty() ? BetterCodexConfig.scopeOrDefault(fallback) : owner;
    }

    public static synchronized void setDeviceOwner(Context context, String owner) {
        if (!BetterCodexConfig.isScope(owner)) throw new IllegalArgumentException("请选择设备使用者");
        if (owner.equals(deviceOwner(context))) return;
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String previousScope = prefs.getString(PREF_SCOPE, BetterCodexConfig.DEFAULT_SCOPE);
        boolean wasEnabled = prefs.getBoolean(PREF_ENABLED_PREFIX + previousScope, false) || INSTANCE.get() != null;
        prefs.edit().putString(PREF_DEVICE_OWNER, owner).putBoolean(PREF_COMPLETION_ENABLED, false)
                .putBoolean(PREF_ENABLED_PREFIX + "ai", false).putBoolean(PREF_ENABLED_PREFIX + "secondary", false).apply();
        cancelCompletionNotifications(context);
        if (wasEnabled) stopSync(context, previousScope);
    }

    private static void cancelCompletionNotifications(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        for (android.service.notification.StatusBarNotification entry : manager.getActiveNotifications()) {
            if (COMPLETION_CHANNEL_ID.equals(entry.getNotification().getChannelId())) manager.cancel(entry.getTag(), entry.getId());
        }
    }

    public static boolean areCompletionNotificationsEnabled(Context context) {
        return !deviceOwner(context).isEmpty() && context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean(PREF_COMPLETION_ENABLED, false);
    }

    public static synchronized void setCompletionNotificationsEnabled(Context context, boolean enabled) {
        String owner = deviceOwner(context);
        if (enabled && owner.isEmpty()) throw new IllegalArgumentException("请先选择设备使用者");
        // Enabling reminders explicitly starts the owner's read-only background sync.
        if (enabled) startSync(context, owner);
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putBoolean(PREF_COMPLETION_ENABLED, enabled).apply();
        if (!enabled) cancelCompletionNotifications(context);
    }

    public static JSONObject notificationSettings(Context context) {
        JSONObject result = new JSONObject();
        String owner = deviceOwner(context);
        SyncForegroundService service = INSTANCE.get();
        try {
            result.put("owner", owner);
            result.put("enabled", areCompletionNotificationsEnabled(context));
            result.put("syncScope", service == null ? context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(PREF_SCOPE, "") : service.scope);
            result.put("syncRunning", service != null && service.client != null && service.enabled);
            boolean allowed = NotificationManagerCompat.from(context).areNotificationsEnabled();
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            NotificationChannel channel = manager == null ? null : manager.getNotificationChannel(COMPLETION_CHANNEL_ID);
            result.put("systemAllowed", allowed && (channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE));
        } catch (JSONException ignored) {}
        return result;
    }

    private void setEnabled(String value, boolean enabled) {
        this.enabled = enabled;
        getPreferences().edit().putBoolean(PREF_ENABLED_PREFIX + value, enabled).apply();
    }

    public static boolean startSync(Context context, String scope) {
        String selected = syncScope(context, scope);
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean(PREF_ENABLED_PREFIX + selected, true)
                .putString(PREF_SCOPE, selected)
                .apply();
        Intent intent = new Intent(context, SyncForegroundService.class)
                .setAction(ACTION_START)
                .putExtra(EXTRA_SCOPE, selected);
        ContextCompat.startForegroundService(context, intent);
        return true;
    }

    public static boolean isEnhanced(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(PREF_ENHANCED, false);
    }

    public static void reconnectEnabled(Context context) {
        restoreEnabled(context, false);
        SyncForegroundService service = INSTANCE.get();
        if (service != null && service.enabled && service.client != null) service.client.recoverConnection("manual", true);
    }

    public static void setEnhanced(Context context, boolean value) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(PREF_ENHANCED, value).apply();
        SyncForegroundService service = INSTANCE.get();
        if (service != null && service.backgroundConnection != null) service.backgroundConnection.setEnhanced(value);
    }

    /** A prior explicit start survives process loss; a stop never resumes itself. */
    public static void restoreEnabled(Context context, boolean appVisible) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String selected = syncScope(context, prefs.getString(PREF_SCOPE, BetterCodexConfig.DEFAULT_SCOPE));
        if (!prefs.getBoolean(PREF_ENABLED_PREFIX + selected, false)) return;
        SyncForegroundService service = INSTANCE.get();
        if (service != null && service.enabled && service.client != null && selected.equals(service.scope)) {
            if (appVisible) service.client.recoverConnection("app_resumed", false);
            return;
        }
        try { startSync(context, selected); }
        catch (RuntimeException restricted) {
            // Background starts can still be denied by Android/OEM policy.
            // Keep user intent, mark actual state, and retry on visible resume.
            try (SyncStore store = new SyncStore(context)) {
                JSONObject state = store.getState(selected);
                try {
                    state.put("state", "start_restricted"); state.put("running", false);
                    state.put("online", false); state.put("transportConnected", false);
                    state.put("error", "BACKGROUND_START_RESTRICTED");
                } catch (JSONException ignored) {}
                store.setState(selected, state);
            }
        }
    }

    public static boolean stopSync(Context context, String scope) {
        String selected = BetterCodexConfig.scopeOrDefault(scope);
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean(PREF_ENABLED_PREFIX + selected, false)
                .apply();
        Intent intent = new Intent(context, SyncForegroundService.class)
                .setAction(ACTION_STOP)
                .putExtra(EXTRA_SCOPE, selected);
        try {
            // Deliver ACTION_STOP so the service publishes a stopped state and
            // removes its foreground notification before being destroyed.
            context.startService(intent);
        } catch (RuntimeException ignored) {
            context.stopService(intent);
        }
        return true;
    }

    /** Returns false when no explicitly started service is available. */
    public static boolean requestSync(String scope) {
        SyncForegroundService service = INSTANCE.get();
        if (service == null || service.client == null || !service.scope.equals(BetterCodexConfig.scopeOrDefault(scope))) return false;
        service.client.requestSync();
        return true;
    }

    public static JSONObject statusSnapshot(Context context, String scope) {
        String selected = BetterCodexConfig.scopeOrDefault(scope);
        try (SyncStore store = new SyncStore(context)) {
            JSONObject result = store.getState(selected);
            try {
                result.put("version", 1);
                result.put("notificationOwnerSupported", true);
                result.put("notificationSettings", notificationSettings(context));
                result.put("scope", selected);
                SyncForegroundService service = INSTANCE.get();
                boolean running = service != null && service.enabled && service.client != null && service.scope.equals(selected);
                result.put("running", running);
                result.put("enabled", context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(PREF_ENABLED_PREFIX + selected, false));
                result.put("online", running && result.optBoolean("online", false));
                result.put("transportConnected", running && result.optBoolean("transportConnected", false));
                JSONObject conditions = running && service.backgroundConnection != null
                        ? service.backgroundConnection.snapshot() : BackgroundConnection.systemSnapshot(context);
                conditions.put("enhanced", isEnhanced(context));
                conditions.put("syncNotificationAllowed", areSyncNotificationsAllowed(context));
                result.put("background", conditions);
                result.put("recordCursor", store.localRecordCursor(selected));
                String generation = store.catalogCursor(selected).generation;
                result.put("generation", generation.isEmpty() ? "uninitialized" : generation);
            } catch (JSONException ignored) {
            }
            return result;
        }
    }

    private static int stableId(String value) {
        int result = value == null ? 0 : value.hashCode();
        return result == Integer.MIN_VALUE ? 1 : Math.abs(result);
    }

    static boolean areSyncNotificationsAllowed(Context context) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel channel = manager == null ? null : manager.getNotificationChannel(SYNC_CHANNEL_ID);
        return channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    @Override
    public void onDestroy() {
        enabled = false;
        if (backgroundConnection != null) backgroundConnection.close();
        if (client != null) {
            client.close();
            client = null;
        }
        SyncForegroundService current = INSTANCE.get();
        if (current == this) INSTANCE.compareAndSet(this, null);
        if (store != null) store.close();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
