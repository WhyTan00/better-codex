package top.whytan.dsh;

import org.json.JSONObject;

/** Internal agents update the conversation, but never send their own completion alert. */
final class CompletionNotificationPolicy {
    private CompletionNotificationPolicy() {}

    static boolean isInternalDirectoryThread(JSONObject thread) {
        return thread != null && (thread.optBoolean("ephemeral", false)
                || "thread_title".equals(thread.optString("threadSource")) || isSubagent(thread));
    }

    private static boolean subagentSource(Object source) {
        if (source instanceof JSONObject) return ((JSONObject) source).has("subAgent") || ((JSONObject) source).has("subagent");
        if (source instanceof String && ((String) source).length() < 8192 && ((String) source).startsWith("{")) {
            try { return subagentSource(new JSONObject((String) source)); }
            catch (org.json.JSONException ignored) { return false; }
        }
        return "subagent".equals(source) || "subAgent".equals(source)
                || "subAgentReview".equals(source) || "subAgentCompact".equals(source)
                || "subAgentThreadSpawn".equals(source) || "subAgentOther".equals(source);
    }

    static boolean isSubagent(JSONObject thread) {
        if (thread == null) return false;
        if (subagentSource(thread.opt("threadSource"))) return true;
        Object parent = thread.opt("parentThreadId");
        if (parent instanceof String) {
            String id = ((String) parent).trim();
            if (!id.isEmpty() && !"null".equalsIgnoreCase(id)) return true;
        }
        return subagentSource(thread.opt("source")) || subagentSource(thread.opt("sourceKind"));
    }
}
