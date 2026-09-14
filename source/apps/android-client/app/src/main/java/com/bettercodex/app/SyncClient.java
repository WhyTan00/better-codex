package com.bettercodex.app;

import android.content.Context;
import android.webkit.CookieManager;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.Closeable;
import java.io.IOException;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/** Read-only event and native-cache client for one workspace scope. */
public final class SyncClient implements Closeable {
    public interface Listener {
        void onState(String scope, JSONObject state);

        void onCompletion(String scope, String threadId, String turnId);
    }

    private static final MediaType JSON = MediaType.parse("application/json; charset=utf-8");
    private static final long CATALOG_INTERVAL_MS = 30_000L;
    private static final long MAX_THREAD_REFRESHES = 64L;

    private final Context context;
    private final String scope;
    private final SyncStore store;
    private final Listener listener;
    private final OkHttpClient http;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService timers = Executors.newScheduledThreadPool(1);
    private final Object socketLock = new Object();
    private volatile boolean stopped;
    private final Set<String> warmingThreads = new HashSet<>();
    private volatile WebSocket socket;
    private volatile boolean nativeOnline;
    private volatile boolean socketConnected;
    private volatile boolean reconnectScheduled;
    private volatile int reconnectAttempt;
    private ScheduledFuture<?> periodicCatalog;
    private final AtomicBoolean catalogQueued = new AtomicBoolean();
    private final AtomicBoolean catalogForce = new AtomicBoolean();
    private final AtomicBoolean recoveryQueued = new AtomicBoolean();
    private volatile long lastSuccessfulSyncAt;
    private volatile long connectedAt;
    private volatile long lastFrameAt;
    private volatile long lastRecoveryAt;
    private volatile long disconnectCount;
    private volatile String lastRecoveryReason = "";

    public SyncClient(Context context, String scope, SyncStore store, Listener listener) {
        this.context = context.getApplicationContext();
        this.scope = BetterCodexConfig.scopeOrDefault(scope);
        this.store = store;
        this.listener = listener;
        this.http = new OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(35, TimeUnit.SECONDS)
                .writeTimeout(35, TimeUnit.SECONDS)
                .callTimeout(45, TimeUnit.SECONDS)
                .pingInterval(20, TimeUnit.SECONDS)
                .followRedirects(false)
                .followSslRedirects(false)
                .build();
    }

    private void submitWork(Runnable work) {
        if (stopped) return;
        try {
            worker.execute(() -> { if (!stopped) work.run(); });
        } catch (RejectedExecutionException ignored) {
            // Service teardown can race an OkHttp callback or scheduled task.
        }
    }

    public void start() {
        if (stopped) return;
        periodicCatalog = timers.scheduleWithFixedDelay(() -> requestCatalog(false), 2L, CATALOG_INTERVAL_MS, TimeUnit.MILLISECONDS);
        // Establish live events before a potentially slow history/catalog read.
        submitWork(this::connect);
        requestCatalog(true);
        timers.scheduleWithFixedDelay(() -> {
            WebSocket current = socket;
            if (current != null) {
                try {
                    JSONObject ping = new JSONObject();
                    ping.put("type", "ping");
                    if (!current.send(ping.toString())) recoverConnection("send_failed", true);
                } catch (JSONException ignored) {
                    // Constant frame.
                }
            }
        }, 20L, 20L, TimeUnit.SECONDS);
    }

    /** Queue a user-requested read-only catalog refresh without starting the service. */
    public void requestSync() {
        requestCatalog(true);
    }

    private void requestCatalog(boolean force) {
        if (stopped) return;
        if (force) catalogForce.set(true);
        // Slow mobile reads must not accumulate an unbounded periodic queue
        // ahead of live events and recovery callbacks.
        if (!catalogQueued.compareAndSet(false, true)) return;
        submitWork(() -> {
            try { syncCatalogSafe(catalogForce.getAndSet(false)); }
            finally {
                catalogQueued.set(false);
                if (catalogForce.get() && !stopped) requestCatalog(false);
            }
        });
    }

    /** Cancel a dead network promptly and resume strictly read-only sync. */
    public void recoverConnection(String reason, boolean networkChanged) {
        if (stopped || !recoveryQueued.compareAndSet(false, true)) return;
        long now = System.currentTimeMillis();
        boolean reconnect = networkChanged || socket == null || !socketConnected
                || lastSuccessfulSyncAt == 0L || now - lastSuccessfulSyncAt > 90_000L;
        if (reconnect) {
            synchronized (socketLock) {
                WebSocket old = socket;
                socket = null;
                socketConnected = false;
                nativeOnline = false;
                if (old != null) old.cancel();
            }
            // The old network's HTTP read may otherwise block the single
            // projection worker for its entire timeout before it can reconnect.
            http.dispatcher().cancelAll();
        }
        submitWork(() -> {
            try {
                lastRecoveryAt = System.currentTimeMillis();
                lastRecoveryReason = reason;
                if (reconnect) connect();
                emitState(socketConnected ? "running" : "reconnecting", null);
                requestCatalog(true);
            } finally { recoveryQueued.set(false); }
        });
    }

    private void connect() {
        if (stopped) return;
        synchronized (socketLock) {
            if (socket != null) return;
            SyncStore.CursorState cursor = store.eventCursor(scope);
            Request.Builder request = new Request.Builder()
                    .url(BetterCodexConfig.syncEventsUrl(scope, cursor.epoch, cursor.seq))
                    .header("Origin", BetterCodexConfig.ORIGIN)
                    .get();
            addCookie(request, BetterCodexConfig.ORIGIN);
            WebSocketListener listener = new WebSocketListener() {
                @Override
                public void onOpen(WebSocket webSocket, Response response) {
                    if (stopped) {
                        webSocket.close(1000, "stopped");
                        return;
                    }
                    submitWork(() -> {
                        if (socket != webSocket) return;
                        reconnectAttempt = 0;
                        socketConnected = true;
                        connectedAt = System.currentTimeMillis();
                        emitState("connected", null);
                        requestCatalog(false);
                    });
                }

                @Override
                public void onMessage(WebSocket webSocket, String text) {
                    submitWork(() -> handleFrame(webSocket, text));
                }

                @Override
                public void onClosing(WebSocket webSocket, int code, String reason) {
                    webSocket.close(code, reason);
                }

                @Override
                public void onClosed(WebSocket webSocket, int code, String reason) {
                    disconnected(webSocket, "closed");
                }

                @Override
                public void onFailure(WebSocket webSocket, Throwable failure, @Nullable Response response) {
                    int code = response == null ? 0 : response.code();
                    disconnected(webSocket, code == 401 || code == 302 || code == 303 || code == 403 ? "auth_required" : "transport_error");
                }
            };
            WebSocket created = http.newWebSocket(request.build(), listener);
            // OkHttp may invoke onOpen before returning on a very fast local
            // connection; the callback assignment is still authoritative.
            if (socket == null) socket = created;
        }
    }

    private void disconnected(WebSocket webSocket, String reason) {
        submitWork(() -> {
            if (socket != webSocket) return;
            socket = null;
            socketConnected = false;
            nativeOnline = false;
            disconnectCount++;
            emitState(reason, reason.equals("auth_required") ? "AUTH_REQUIRED" : "DISCONNECTED");
            scheduleReconnect();
        });
    }

    private void scheduleReconnect() {
        if (stopped || reconnectScheduled) return;
        reconnectScheduled = true;
        long delay = Math.min(15_000L, 500L * (1L << Math.min(reconnectAttempt++, 5)));
        try {
            timers.schedule(() -> {
                reconnectScheduled = false;
                submitWork(this::connect);
            }, delay, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException ignored) {
            reconnectScheduled = false;
        }
    }

    private void handleFrame(WebSocket source, String text) {
        if (stopped || socket != source) return;
        lastFrameAt = System.currentTimeMillis();
        try {
            JSONObject frame = new JSONObject(text);
            String type = frame.optString("type", "");
            if ("hello".equals(type)) {
                setNativeOnline(frame.optBoolean("online", false));
                emitState("connected", null);
                return;
            }
            if ("resync".equals(type)) {
                String epoch = frame.optString("epoch", "");
                long seq = Math.max(0L, frame.optLong("seq", 0L));
                syncCatalogInternal(true);
                store.saveEventCursor(scope, epoch, seq);
                sendAck(source, seq);
                return;
            }
            if (!isEnvelope(frame)) return;
            String frameScope = frame.optString("scope", "");
            if (!scope.equals(frameScope)) return;
            String epoch = frame.optString("epoch", "");
            long seq = frame.optLong("seq", -1L);
            if (epoch.isEmpty() || seq < 1L) return;
            SyncStore.CursorState cursor = store.eventCursor(scope);
            if (epoch.equals(cursor.epoch) && seq <= cursor.seq) {
                sendAck(source, cursor.seq);
                return;
            }
            if (!epoch.equals(cursor.epoch) || seq != cursor.seq + 1L) {
                syncCatalogInternal(true);
                store.saveEventCursor(scope, epoch, seq - 1L);
            }
            JSONObject event = frame.optJSONObject("event");
            if (event != null) {
                // The gateway keeps the thread identity on the envelope.
                // Carry it into the event object for turn notifications.
                if (!event.has("threadId")) event.put("threadId", frame.optString("threadId", ""));
                processEvent(event, false);
            }
            // Cursor advancement follows the event's read-only projection. If
            // a required native read fails, the socket is closed and replayed.
            store.saveEventCursor(scope, epoch, seq);
            sendAck(source, seq);
            emitState("running", null);
        } catch (Exception failure) {
            if (!stopped && socket == source) {
                emitState("error", "SYNC_FRAME_FAILED");
                source.close(1011, "frame processing failed");
            }
        }
    }

    private static boolean isEnvelope(JSONObject value) {
        return value.has("epoch") && value.has("seq") && value.has("scope") && value.has("event");
    }

    private void processEvent(JSONObject event, boolean baseline) throws IOException, JSONException {
        String type = event.optString("type", "");
        if ("host".equals(type)) {
            setNativeOnline(event.optBoolean("online", false));
            return;
        }
        if ("turn".equals(type)) {
            JSONObject turn = event.optJSONObject("turn");
            if (turn != null) processTurn(turn, event.optString("threadId", ""), nativeOnline && !baseline, baseline);
            return;
        }
        if (!"nativeChanged".equals(type)) return;
        String cacheKey = event.optString("cacheKey", "");
        String threadId = event.optString("threadId", "");
        if (cacheKey.startsWith("invalidate:") && BetterCodexConfig.isScope(scope) && !threadId.isEmpty()) {
            fetchThreadTurns(threadId, false);
        } else if (!threadId.isEmpty() && !cacheKey.startsWith("read:")) {
            fetchThreadTurns(threadId, false);
        }
        if (cacheKey.startsWith("thread:") || cacheKey.startsWith("catalog")) syncCatalogInternal(false);
    }

    private void syncCatalogSafe(boolean force) {
        if (stopped) return;
        try {
            syncCatalogInternal(force);
            lastSuccessfulSyncAt = System.currentTimeMillis();
            emitState("running", null);
        } catch (AuthException failure) {
            nativeOnline = false;
            emitState("auth_required", "AUTH_REQUIRED");
        } catch (Exception failure) {
            emitState("error", "SYNC_UNAVAILABLE");
        }
    }

    private void syncCatalogInternal(boolean force) throws IOException, JSONException {
        fetchBootstrapIfAvailable();
        SyncStore.CatalogCursor cursor = store.catalogCursor(scope);
        String generation = cursor.generation;
        long after = cursor.cursor;
        Set<String> activeThreads = new HashSet<>();
        boolean generationReset = false;
        boolean first = true;
        for (int pageCount = 0; pageCount < 128; pageCount++) {
            if (stopped) return;
            String url = BetterCodexConfig.nativeCatalogUrl(scope, after, generation);
            if (force && first) url += "&refresh=1";
            JSONObject page = getJson(url);
            first = false;
            String pageGeneration = page.optString("generation", "");
            if (pageGeneration.isEmpty()) pageGeneration = firstRecordGeneration(page.optJSONArray("records"));
            if (pageGeneration.isEmpty()) pageGeneration = generation;
            if (pageGeneration.isEmpty()) pageGeneration = "uninitialized";
            if (!generation.isEmpty() && !"uninitialized".equals(generation) && !generation.equals(pageGeneration)) {
                store.resetGeneration(scope, pageGeneration);
                generation = pageGeneration;
                after = 0L;
                generationReset = true;
                // The gateway has already reset its source cursor for the new
                // generation; read the first page again using the new marker.
                page = getJson(BetterCodexConfig.nativeCatalogUrl(scope, 0L, generation));
            } else if (generation.isEmpty() || "uninitialized".equals(generation)) {
                generation = pageGeneration;
                store.saveCatalogCursor(scope, generation, 0L);
            }
            JSONArray records = page.optJSONArray("records");
            JSONObject status = page.optJSONObject("status");
            if (status != null) store.saveCatalogStatus(scope, status);
            if (records != null) {
                for (int index = 0; index < records.length(); index++) {
                    JSONObject record = records.optJSONObject(index);
                    if (record == null || !scope.equals(record.optString("scope", ""))) continue;
                    String sourceGeneration = record.optString("sourceGeneration", "");
                    if (!sourceGeneration.isEmpty() && !"uninitialized".equals(generation) && !generation.equals(sourceGeneration)) continue;
                    try {
                        store.applyNativeRecord(record);
                    } catch (JSONException ignored) {
                        continue;
                    }
                    if (!record.optBoolean("deleted", false) && "catalog".equals(record.optString("kind", ""))) {
                        JSONObject payload = record.optJSONObject("payload");
                        JSONObject thread = payload == null ? null : payload.optJSONObject("nativeThread");
                        JSONObject threadStatus = thread == null ? null : thread.optJSONObject("status");
                        if (threadStatus != null && "active".equals(threadStatus.optString("type", ""))) {
                            String id = record.optString("threadId", "");
                            if (!id.isEmpty() && activeThreads.size() < MAX_THREAD_REFRESHES) activeThreads.add(id);
                        }
                    }
                }
            }
            long next = Math.max(after, page.optLong("cursor", after));
            boolean hasMore = page.optBoolean("hasMore", false);
            if (hasMore && next <= after) throw new IOException("catalog cursor stalled");
            after = next;
            if (!hasMore) break;
        }
        store.saveCatalogCursor(scope, generation, after);
        nativeOnline = pageOnlineFallback(nativeOnline);
        boolean baseline = !store.isBootstrapComplete(scope);
        for (String threadId : activeThreads) fetchThreadTurns(threadId, baseline);
        if (baseline || generationReset) store.markBootstrapComplete(scope, true);
        queueHistoryWarm();
        emitState("running", null);
    }

    private void queueHistoryWarm() {
        if (stopped || !warmingThreads.isEmpty()) return;
        for (JSONObject candidate : store.historyWarmCandidates(scope, 4)) {
            String id = candidate.optString("threadId");
            if (!warmingThreads.add(id)) continue;
            // Separate queue entries allow already queued live events to run first.
            submitWork(() -> {
                try {
                    JSONObject params = new JSONObject().put("threadId", id).put("limit", 20)
                            .put("sortDirection", "desc").put("itemsView", "summary");
                    JSONObject response = postJson(BetterCodexConfig.nativeReadUrl(scope), new JSONObject()
                            .put("method", "thread/turns/list").put("params", params).put("fresh", false));
                    JSONObject payload = response.optJSONObject("payload");
                    JSONObject result = payload == null ? null : payload.optJSONObject("result");
                    if (!scope.equals(response.optString("scope")) || !id.equals(response.optString("threadId"))
                            || response.optBoolean("deleted") || result == null) return;
                    store.applyNativeRecord(response);
                    saveHistoryCursors(id, result);
                    cacheRecentTurnItems(id, result.optJSONArray("data"), false);
                    if (!response.optBoolean("stale", false)) store.markHistoryWarm(scope, candidate, response.getString("key"));
                    // Historical prefetch never updates completion observations.
                    emitState("running", null);
                } catch (Exception ignored) {
                    // Optional read replica work must not disconnect the live stream.
                } finally {
                    warmingThreads.remove(id);
                }
            });
        }
    }

    private void fetchBootstrapIfAvailable() throws IOException, JSONException {
        try {
            JSONObject value = getJson(BetterCodexConfig.ORIGIN + "/sync/v1/w/" + scope + "/native-bootstrap");
            JSONObject config = value.optJSONObject("config");
            if (config == null) return;
            JSONObject safe = new JSONObject(config.toString());
            String gatewayWs = safe.optString("gatewayWsUrl", "");
            if (!gatewayWs.isEmpty()) {
                try {
                    android.net.Uri uri = android.net.Uri.parse(gatewayWs);
                    safe.put("gatewayWsUrl", uri.buildUpon().clearQuery().fragment(null).build().toString());
                } catch (RuntimeException ignored) {
                    safe.remove("gatewayWsUrl");
                }
            }
            store.saveBootstrap(scope, safe);
        } catch (AuthException failure) {
            throw failure;
        } catch (Exception ignored) {
            // Bootstrap is an optimization. Catalog/read records remain usable
            // if the server has not cached it yet.
        }
    }

    private void fetchThreadTurns(String threadId, boolean baseline) throws IOException, JSONException {
        if (threadId == null || threadId.isEmpty() || threadId.length() > 160) return;
        JSONObject params = new JSONObject();
        params.put("threadId", threadId);
        params.put("limit", 20);
        params.put("sortDirection", "desc");
        params.put("itemsView", "summary");
        JSONObject body = new JSONObject();
        body.put("method", "thread/turns/list");
        body.put("params", params);
        body.put("fresh", true);
        JSONObject response = postJson(BetterCodexConfig.nativeReadUrl(scope), body);
        try {
            if (scope.equals(response.optString("scope", ""))) store.applyNativeRecord(response);
        } catch (JSONException ignored) {
            // A malformed cache record cannot be used for notification state.
        }
        JSONObject payload = response.optJSONObject("payload");
        JSONObject result = payload == null ? null : payload.optJSONObject("result");
        saveHistoryCursors(threadId, result);
        JSONArray turns = result == null ? null : result.optJSONArray("data");
        if (turns == null && result != null) turns = result.optJSONArray("turns");
        if (turns == null) return;
        try { cacheRecentTurnItems(threadId, turns, true); }
        catch (IOException | JSONException cacheUnavailable) {
            // A body-cache miss must not suppress a real completion reminder.
        }
        boolean fresh = response.optBoolean("nativeOnline", nativeOnline)
                && !response.optBoolean("stale", false)
                && !"cloud-cache".equals(response.optString("source", ""));
        for (int index = 0; index < turns.length(); index++) {
            JSONObject turn = turns.optJSONObject(index);
            if (turn != null) processTurn(turn, threadId, fresh, baseline);
        }
    }

    /** Persist visible message bodies before a notification can open the thread. */
    private void cacheRecentTurnItems(String threadId, @Nullable JSONArray turns, boolean fresh) throws IOException, JSONException {
        if (turns == null) return;
        for (int index = 0; index < Math.min(2, turns.length()); index++) {
            JSONObject turn = turns.optJSONObject(index);
            if (turn == null || turn.optString("id").isEmpty() || "full".equals(turn.optString("itemsView"))) continue;
            JSONObject params = new JSONObject().put("threadId", threadId).put("turnId", turn.getString("id"))
                    .put("limit", 48).put("sortDirection", "desc");
            JSONObject record = postJson(BetterCodexConfig.nativeReadUrl(scope), new JSONObject()
                    .put("method", "thread/items/list").put("params", params).put("fresh", fresh));
            if (!scope.equals(record.optString("scope")) || !threadId.equals(record.optString("threadId"))
                    || record.optBoolean("deleted")) throw new IOException("history cache scope mismatch");
            store.applyNativeRecord(record);
        }
    }

    private void processTurn(JSONObject turn, String threadId, boolean fresh, boolean baseline) {
        String turnId = turn.optString("id", "");
        String status = turn.optString("status", "");
        if (threadId == null || threadId.isEmpty() || turnId.isEmpty() || status.isEmpty()) return;
        boolean notify = store.observeTurn(scope, threadId, turnId, status, fresh, baseline, System.currentTimeMillis());
        if (notify) listener.onCompletion(scope, threadId, turnId);
    }

    private void saveHistoryCursors(String threadId, @Nullable JSONObject result) {
        if (result == null || threadId == null || threadId.isEmpty()) return;
        JSONObject cursors = new JSONObject();
        boolean present = false;
        for (String key : new String[]{"itemsBackwardsCursor", "turnsBackwardsCursor"}) {
            if (!result.has(key)) continue;
            Object value = result.opt(key);
            if (value == JSONObject.NULL || value == null || value instanceof String) {
                try {
                    cursors.put(key, value == null ? JSONObject.NULL : value);
                    present = true;
                } catch (JSONException ignored) {
                    return;
                }
            }
        }
        if (present) store.saveHistoryCursor(scope, threadId, cursors);
    }

    private JSONObject getJson(String url) throws IOException, JSONException {
        Request.Builder request = new Request.Builder().url(url).get().header("Origin", BetterCodexConfig.ORIGIN);
        addCookie(request, BetterCodexConfig.ORIGIN);
        try (Response response = http.newCall(request.build()).execute()) {
            if (stopped) throw new IOException("sync stopped");
            if (response.code() == 401 || response.code() == 303 || response.code() == 302) throw new AuthException();
            if (!response.isSuccessful() || response.body() == null) throw new IOException("http " + response.code());
            return new JSONObject(response.body().string());
        }
    }

    private JSONObject postJson(String url, JSONObject body) throws IOException, JSONException {
        Request.Builder request = new Request.Builder().url(url)
                .post(RequestBody.create(body.toString(), JSON))
                .header("Origin", BetterCodexConfig.ORIGIN);
        addCookie(request, BetterCodexConfig.ORIGIN);
        try (Response response = http.newCall(request.build()).execute()) {
            if (stopped) throw new IOException("sync stopped");
            if (response.code() == 401 || response.code() == 303 || response.code() == 302) throw new AuthException();
            if (!response.isSuccessful() || response.body() == null) throw new IOException("http " + response.code());
            return new JSONObject(response.body().string());
        }
    }

    private static void addCookie(Request.Builder request, String url) {
        try {
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null && !cookie.isEmpty()) request.header("Cookie", cookie);
        } catch (RuntimeException ignored) {
            // Login may not have established a cookie yet.
        }
    }

    private static String firstRecordGeneration(@Nullable JSONArray records) {
        if (records == null) return "";
        for (int index = 0; index < records.length(); index++) {
            JSONObject record = records.optJSONObject(index);
            if (record != null && !record.optString("sourceGeneration", "").isEmpty()) return record.optString("sourceGeneration");
        }
        return "";
    }

    private boolean pageOnlineFallback(boolean prior) {
        return prior || nativeOnline;
    }

    private void setNativeOnline(boolean online) {
        if (nativeOnline == online) return;
        nativeOnline = online;
        emitState("running", null);
    }

    private void sendAck(WebSocket source, long seq) {
        try {
            JSONObject value = new JSONObject();
            value.put("type", "ack");
            value.put("seq", Math.max(0L, seq));
            source.send(value.toString());
        } catch (JSONException ignored) {
            // Constant frame.
        }
    }

    private void emitState(String state, @Nullable String error) {
        if (stopped) return;
        JSONObject value = store.getState(scope);
        try {
            value.put("state", state);
            value.put("online", nativeOnline && socketConnected);
            value.put("hostOnline", nativeOnline);
            value.put("transportConnected", socketConnected);
            value.put("scope", scope);
            value.put("recordCursor", store.localRecordCursor(scope));
            String generation = store.catalogCursor(scope).generation;
            value.put("generation", generation.isEmpty() ? "uninitialized" : generation);
            value.put("at", System.currentTimeMillis());
            value.put("connectedAt", connectedAt);
            value.put("lastSuccessfulSyncAt", lastSuccessfulSyncAt);
            value.put("lastFrameAt", lastFrameAt);
            value.put("lastRecoveryAt", lastRecoveryAt);
            value.put("lastRecoveryReason", lastRecoveryReason);
            value.put("disconnectCount", disconnectCount);
            value.put("reconnectAttempt", reconnectAttempt);
            if (error == null) value.remove("error"); else value.put("error", error);
        } catch (JSONException ignored) {
            // All fields are primitives.
        }
        store.setState(scope, value);
        listener.onState(scope, value);
    }

    @Override
    public void close() {
        stopped = true;
        socketConnected = false;
        if (periodicCatalog != null) periodicCatalog.cancel(true);
        WebSocket current = socket;
        socket = null;
        if (current != null) current.cancel();
        http.dispatcher().cancelAll();
        timers.shutdownNow();
        worker.shutdownNow();
        http.dispatcher().executorService().shutdown();
        http.connectionPool().evictAll();
    }

    private static final class AuthException extends IOException {
        AuthException() { super("authentication required"); }
    }
}
