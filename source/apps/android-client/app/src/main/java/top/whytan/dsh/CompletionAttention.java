package top.whytan.dsh;

import java.util.LinkedHashMap;

/** Ephemeral presentation receipts only; Native completion state stays in SyncStore. */
final class CompletionAttention {
    private Object owner;
    private String scope = "", thread = "";
    private boolean visible;
    private final LinkedHashMap<String, Boolean> seen = new LinkedHashMap<>();
    synchronized void present(Object source, String nextScope, String nextThread, boolean showing) {
        owner = source; scope = nextScope; thread = nextThread; visible = showing;
    }
    synchronized void clear(Object source) {
        if (owner == source) { owner = null; visible = false; scope = ""; thread = ""; }
    }
    synchronized boolean viewing(boolean foreground, String targetScope, String targetThread) {
        return foreground && visible && targetScope.equals(scope) && targetThread.equals(thread);
    }
    synchronized void seen(boolean foreground, String targetScope, String targetThread, String turn) {
        if (!viewing(foreground, targetScope, targetThread)) return;
        String key = targetScope + ":" + targetThread + ":" + turn;
        seen.remove(key); seen.put(key, true);
        while (seen.size() > 128) seen.remove(seen.keySet().iterator().next());
    }
    synchronized boolean suppress(boolean foreground, String targetScope, String targetThread, String turn) {
        return foreground
                || seen.containsKey(targetScope + ":" + targetThread + ":" + turn);
    }
}
