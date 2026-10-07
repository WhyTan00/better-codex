package top.whytan.dsh;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONObject;

/** Android and Web Push consume the same scoped server notification policy. */
final class CompletionPushPolicy {
    interface Reader { JSONObject read() throws Exception; }
    private CompletionPushPolicy() {}

    static boolean allows(Context context, String scope, String threadId, Reader reader) {
        SharedPreferences saved = context.getSharedPreferences("completion-push-policy-" + scope, Context.MODE_PRIVATE);
        boolean silent = saved.getBoolean(threadId, false);
        try {
            JSONObject value = reader.read();
            // Reject a different thread or an absent/malformed flag. Keep only
            // the last verified policy when the optional endpoint is unavailable.
            if (value != null && threadId.equals(value.opt("threadId")) && value.opt("silent") instanceof Boolean) {
                silent = value.getBoolean("silent");
                saved.edit().putBoolean(threadId, silent).apply();
            }
        } catch (Exception unavailable) {
            // A failed policy read does not change an already verified choice.
        }
        return !silent;
    }
}
