package top.whytan.dsh;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.UUID;

/** Restore only a previously enabled service, never a stopped workspace. */
public final class SyncRestoreReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        final String reason;
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)) reason = "boot_restore";
        else if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) reason = "package_replaced";
        else return;

        String scope = SyncForegroundService.syncScope(context,
                context.getSharedPreferences("sync-control", Context.MODE_PRIVATE)
                        .getString("last-scope", DshConfig.DEFAULT_SCOPE));
        JSONObject fields = new JSONObject();
        try {
            fields.put("traceId", UUID.randomUUID().toString());
            fields.put("enabled", context.getSharedPreferences("sync-control", Context.MODE_PRIVATE)
                    .getBoolean("enabled:" + scope, false));
        } catch (JSONException ignored) {}
        diagnostic(context, scope, "attempt", reason, fields);
        if (!context.getSharedPreferences("sync-control", Context.MODE_PRIVATE)
                .getBoolean("enabled:" + scope, false)) {
            diagnostic(context, scope, "skipped", "stopped", fields);
            return;
        }
        try {
            // The receiver only restores an earlier explicit enabled state;
            // restoreEnabled itself preserves the no-auto-start boundary.
            SyncForegroundService.restoreEnabled(context, false);
            diagnostic(context, scope, "committed", reason, fields);
        } catch (RuntimeException failure) {
            diagnostic(context, scope, "failed", "request_failed", fields);
        }
    }

    private static void diagnostic(Context context, String scope, String stage,
                                   String reason, JSONObject fields) {
        try {
            fields.put("reason", reason);
            NativeDiagnostics.get(context).event(scope, "android-app", stage, fields);
        } catch (Exception ignored) {
            // A restore log cannot be allowed to prevent the receiver path.
        }
    }
}
