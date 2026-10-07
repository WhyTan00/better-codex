package top.whytan.dsh;

import android.content.Context;
import android.os.SystemClock;
import android.webkit.CookieManager;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.Closeable;
import java.io.InterruptedIOException;
import java.io.IOException;
import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.Comparator;
import java.util.concurrent.Executors;
import java.util.concurrent.PriorityBlockingQueue;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.UUID;

import javax.net.ssl.SSLException;

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

        void onCompletion(String scope, String threadId, String turnId, boolean bodyReady);
    }

    private static final MediaType JSON = MediaType.parse("application/json; charset=utf-8");
    private static final long CATALOG_INTERVAL_MS = 30_000L;
    private static final long MAX_THREAD_REFRESHES = 64L;
    private static final int MAX_PREFETCH_QUEUE = (int) MAX_THREAD_REFRESHES + 4;
    private static final int PREFETCH_FOCUS_PRIORITY = 0;
    private static final int PREFETCH_ACTIVE_PRIORITY = 1;
    private static final int PREFETCH_PINNED_PRIORITY = 2;
    private static final int PREFETCH_HISTORY_PRIORITY = 3;

    private final Context context;
    private final String scope;
    private final SyncStore store;
    private final Listener listener;
    private final OkHttpClient http;
    private long lastStreamDiagnosticAt;
    private long lastReceivedDiagnosticAt;
    private int receivedDiagnosticCount;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    /** Slow projection reads never own the socket/ACK worker. */
    private final ExecutorService projectionWorker = Executors.newSingleThreadExecutor();
    /** Ordered local stream commits never wait for catalog or history HTTP. */
    private final ExecutorService streamWorker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean inboxQueued = new AtomicBoolean();
    private volatile boolean started;
    private volatile boolean appVisible;
    private volatile long hiddenAt = SystemClock.elapsedRealtime();
    private volatile long lastWorkAt = SystemClock.elapsedRealtime();
    private volatile long catalogCompletedAt;
    private volatile boolean catalogComplete;
    private volatile int runningCount;
    private volatile String runningThread = "";
    private volatile boolean adaptiveHeartbeat;
    private volatile String sentHeartbeatMode = "";
    private volatile String energyMode = "checking";
    private volatile long lastCatalogAttemptAt;
    private final Object statePublishLock = new Object();
    private ScheduledFuture<?> statePublishTask;
    private long statePublishEpoch;
    private String lastPublishedState = "";
    private boolean lastPublishedOnline;
    private boolean lastPublishedTransport;
    private volatile boolean authenticationRequired;
    @Nullable private volatile String rejectedCookie;
    private final ScheduledExecutorService timers = Executors.newScheduledThreadPool(1);
    /** One history reader and one reserved foreground reader; total stays two. */
    private final ThreadPoolExecutor prefetchWorkers = new ThreadPoolExecutor(
            1, 1, 0L, TimeUnit.MILLISECONDS,
            new BoundedPriorityQueue<>(MAX_PREFETCH_QUEUE, (left, right) ->
                    ((PrefetchTask) left).compareTo((PrefetchTask) right)));
    private final ThreadPoolExecutor focusWorkers = new ThreadPoolExecutor(
            1, 1, 0L, TimeUnit.MILLISECONDS,
            new BoundedPriorityQueue<>(MAX_PREFETCH_QUEUE, (left, right) ->
                    ((PrefetchTask) left).compareTo((PrefetchTask) right)));
    private final Object socketLock = new Object();
    private final Object prefetchLock = new Object();
    private volatile boolean stopped;
    /** Merges repeated active-thread refresh requests by thread identity. */
    private final Map<String, PrefetchTask> prefetchByThread = new HashMap<>();
    /** Direct event reads share the same per-thread exclusion as prefetch jobs. */
    private final Set<String> directRefreshThreads = new HashSet<>();
    /** Derived read receipts, not execution state. New Native events revoke them. */
    private final Map<String, EmptyCompletionRead> completionWithoutFinal = new java.util.LinkedHashMap<>();
    private final Map<String, Long> completionReadChanges = new java.util.LinkedHashMap<>();
    private long completionReadSequence;
    private enum CompletionRead { READY, NO_FINAL, TERMINATED, PENDING }
    private static final class CompletionBody {
        final CompletionRead state; final java.util.List<JSONObject> identities;
        CompletionBody(CompletionRead state,java.util.List<JSONObject> identities) {this.state=state;this.identities=new java.util.ArrayList<>(identities);}
    }
    private static final class EmptyCompletionRead {
        final String version,streamVersion; final java.util.List<JSONObject> identities;
        EmptyCompletionRead(String version,String streamVersion,java.util.List<JSONObject> identities) {this.version=version;this.streamVersion=streamVersion;this.identities=identities;}
    }
    private long prefetchSequence;
    private volatile WebSocket socket;
    private volatile boolean nativeOnline;
    private volatile boolean socketConnected;
    private volatile boolean reconnectScheduled;
    private volatile int reconnectAttempt;
    private ScheduledFuture<?> periodicCatalog;
    private long maintenanceEpoch;
    private final AtomicBoolean catalogQueued = new AtomicBoolean();
    private final AtomicBoolean catalogForce = new AtomicBoolean();
    private final AtomicBoolean recoveryQueued = new AtomicBoolean();
    /** At most one explicit conversation is promoted ahead of the bounded background set. */
    private final AtomicReference<String> focusThreadId = new AtomicReference<>();
    private volatile String currentFocusThreadId = "";
    private final AtomicLong requestCancelGeneration = new AtomicLong();
    private volatile long lastSuccessfulSyncAt;
    private volatile long connectedAt;
    private volatile long lastFrameAt;
    private volatile long lastRecoveryAt;
    private volatile long disconnectCount;
    private volatile String lastRecoveryReason = "";
    private volatile String connectionId = "";
    private volatile long connectionStartedAt;
    /** Per-request status avoids cross-thread/past-request contamination. */
    private final ThreadLocal<Integer> lastHttpStatusCode = ThreadLocal.withInitial(() -> 0);

    /** PriorityBlockingQueue's constructor size is only an allocation hint. */
    private static final class BoundedPriorityQueue<E> extends PriorityBlockingQueue<E> {
        private final int capacity;

        BoundedPriorityQueue(int capacity, Comparator<? super E> comparator) {
            super(Math.max(1, Math.min(capacity, 11)), comparator);
            this.capacity = Math.max(1, capacity);
        }

        @Override public boolean offer(E value) {
            synchronized (this) {
                if (size() >= capacity) return false;
                return super.offer(value);
            }
        }

        @Override public int remainingCapacity() {
            synchronized (this) { return Math.max(0, capacity - size()); }
        }
    }

    public SyncClient(Context context, String scope, SyncStore store, Listener listener) {
        this.context = context.getApplicationContext();
        this.scope = DshConfig.scopeOrDefault(scope);
        this.store = store;
        store.clearPreparationFocus(this.scope);
        this.listener = listener;
        this.http = DshNetwork.builder(context)
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(35, TimeUnit.SECONDS)
                .writeTimeout(35, TimeUnit.SECONDS)
                .callTimeout(45, TimeUnit.SECONDS)
                // The gateway owns heartbeat timing. Legacy control ping is
                // answered by OkHttp; negotiated heartbeat by this listener.
                .pingInterval(0, TimeUnit.SECONDS)
                .followRedirects(false)
                .followSslRedirects(false)
                .build();
    }

    /**
     * Promote one user-visible thread into the next bounded read pass. This is
     * read-only and intentionally keeps the existing single worker so a focus
     * read cannot race cursor or notification ordering with live events.
     */
    public boolean focusThread(String threadId) {
        if (stopped || !isUuid(threadId)) return false;
        boolean changed=!threadId.equals(currentFocusThreadId);
        if(changed){focusThreadId.set(null);store.clearPreparationFocus(scope);currentFocusThreadId=threadId;synchronized(prefetchLock){for(PrefetchTask task:new java.util.ArrayList<>(prefetchByThread.values()))if(task.priority==PREFETCH_FOCUS_PRIORITY&&!threadId.equals(task.threadId)&&!task.started){cancelQueuedPrefetchLocked(task);prefetchByThread.remove(task.threadId);}}}
        if(store.isUnstartedHistory(scope,threadId)){store.retireUnstartedPreparations(scope,threadId);diagnostic("skipped","empty",newFields(null,null,threadId,null));return true;}
        store.promotePreparationFocus(scope,threadId,changed);
        focusThreadId.set(threadId);
        JSONObject fields = newFields(null, null, threadId, null);
        try { fields.put("count", 1); } catch (JSONException ignored) {}
        diagnostic("attempt", "focus_requested", fields);
        scheduleThreadPrefetch(threadId, false, PREFETCH_FOCUS_PRIORITY);
        drainPreparations();
        requestCatalog(false);
        return true;
    }

    private static boolean isUuid(@Nullable String value) {
        if (value == null || value.length() != 36) return false;
        try {
            UUID.fromString(value);
            return true;
        } catch (IllegalArgumentException ignored) {
            return false;
        }
    }

    private JSONObject newFields(@Nullable String traceId, @Nullable String currentConnection,
                                 @Nullable String threadId, @Nullable String turnId) {
        return newFields(traceId, currentConnection, threadId, turnId, null);
    }

    private JSONObject newFields(@Nullable String traceId, @Nullable String currentConnection,
                                 @Nullable String threadId, @Nullable String turnId,
                                 @Nullable String parentTraceId) {
        JSONObject fields = new JSONObject();
        try {
            if (traceId != null) fields.put("traceId", traceId);
            if (NativeDiagnostics.isUuid(parentTraceId)) fields.put("parentTraceId", parentTraceId);
            if (currentConnection != null) fields.put("connectionId", currentConnection);
            if (threadId != null && isUuid(threadId)) fields.put("threadId", threadId);
            if (turnId != null && isUuid(turnId)) fields.put("turnId", turnId);
        } catch (JSONException ignored) {
        }
        return fields;
    }

    private void diagnostic(String stage, String reason, JSONObject fields) {
        try {
            fields.put("reason", reason);
            NativeDiagnostics.get(context).event(scope, "android-sync", stage, fields);
        } catch (Exception ignored) {
            // Diagnostics must never affect read-only synchronization.
        }
    }

    private static long elapsed(long startedAt) {
        return Math.max(0L, SystemClock.elapsedRealtime() - startedAt);
    }

    private void submitWork(Runnable work) {
        if (stopped) return;
        try {
            worker.execute(() -> { if (!stopped) work.run(); });
        } catch (RejectedExecutionException ignored) {
            // Service teardown can race an OkHttp callback or scheduled task.
        }
    }

    private void submitProjection(Runnable work) {
        if (stopped) return;
        try { projectionWorker.execute(() -> { if (!stopped) work.run(); }); }
        catch (RejectedExecutionException ignored) {}
    }

    private boolean authenticationPaused() {
        if (!authenticationRequired) return false;
        String current = CookieManager.getInstance().getCookie(DshConfig.ORIGIN);
        if (java.util.Objects.equals(current, rejectedCookie)) return true;
        authenticationRequired = false; rejectedCookie = null;
        submitWork(this::connect);
        return false;
    }

    private void requireAuthentication() {
        rejectedCookie = CookieManager.getInstance().getCookie(DshConfig.ORIGIN);
        authenticationRequired = true;
        emitState("auth_required", "AUTH_REQUIRED");
    }

    public void start() {
        if (stopped || started) return;
        started = true;
        diagnostic("attempt", "sync_start", newFields(UUID.randomUUID().toString(), connectionId, null, null));
        scheduleMaintenance(2L);
        // Establish live events before a potentially slow history/catalog read.
        submitWork(this::connect);
        requestCatalog(true);
        drainInbox(); drainPreparations();
    }

    public void setAppVisible(boolean visible) {
        if (appVisible == visible) return;
        appVisible = visible;
        if (!visible) hiddenAt = SystemClock.elapsedRealtime();
        submitWork(() -> { emitState("running", null, true); if (visible) requestCatalog(true); });
        scheduleMaintenance(visible ? 1L : BackgroundSyncPolicy.SETTLE_MS);
    }

    private BackgroundSyncPolicy.Decision energyPolicy() {
        long now = SystemClock.elapsedRealtime();
        return BackgroundSyncPolicy.decide(appVisible, !authenticationRequired && nativeOnline && socketConnected,
                catalogComplete, now - catalogCompletedAt, runningCount,
                store.criticalPreparations(scope), now - lastWorkAt, now - hiddenAt);
    }

    private synchronized void scheduleMaintenance(long delayMs) {
        if (stopped) return;
        long epoch = ++maintenanceEpoch;
        if (periodicCatalog != null) periodicCatalog.cancel(false);
        try { periodicCatalog = timers.schedule(() -> {
            synchronized (this) { if (stopped || epoch != maintenanceEpoch) return; }
            BackgroundSyncPolicy.Decision policy = energyPolicy();
            if (SystemClock.elapsedRealtime() - lastCatalogAttemptAt >= policy.catalogIntervalMs) requestCatalog(false);
            drainInbox(); drainPreparations();
            emitState("running", null);
            // A foreground transition or incoming event may already have
            // scheduled an earlier pass while this callback was executing.
            synchronized (this) {
                if (epoch == maintenanceEpoch) scheduleMaintenance(policy.catalogIntervalMs);
            }
        }, Math.max(1L, delayMs), TimeUnit.MILLISECONDS); } catch (RejectedExecutionException ignored) {}
    }

    private void updateHeartbeat(BackgroundSyncPolicy.Decision policy) {
        energyMode = policy.mode;
        String mode = policy.idle() ? "idle" : "active";
        WebSocket current = socket;
        // Negotiate only after the server advertises support. Old gateways keep
        // their existing heartbeat and never receive an unknown control frame.
        if (!adaptiveHeartbeat || current == null || !socketConnected || mode.equals(sentHeartbeatMode)) return;
        try { if (current.send(new JSONObject().put("type", "syncPolicy").put("mode", mode).toString())) sentHeartbeatMode = mode; }
        catch (JSONException ignored) {}
    }

    /** Queue a user-requested read-only catalog refresh without starting the service. */
    public void requestSync() {
        diagnostic("attempt", "user_request", newFields(UUID.randomUUID().toString(), connectionId, null, null));
        requestCatalog(true);
    }

    private void requestCatalog(boolean force) {
        if (stopped || authenticationPaused()) return;
        if (force) catalogForce.set(true);
        // Slow mobile reads must not accumulate an unbounded periodic queue
        // ahead of live events and recovery callbacks.
        if (!catalogQueued.compareAndSet(false, true)) return;
        lastCatalogAttemptAt = SystemClock.elapsedRealtime();
        submitProjection(() -> {
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
        diagnostic("reconnecting", reason == null || reason.isEmpty() ? "request_failed" : reason,
                newFields(UUID.randomUUID().toString(), connectionId, null, null));
        long now = System.currentTimeMillis();
        boolean reconnect = networkChanged || socket == null || !socketConnected
                || now - Math.max(lastFrameAt, connectedAt) > (adaptiveHeartbeat ? 360_000L : 90_000L);
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
            requestCancelGeneration.incrementAndGet();
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
        if (stopped || authenticationPaused()) return;
        synchronized (socketLock) {
            if (socket != null) return;
            adaptiveHeartbeat = false;
            sentHeartbeatMode = "";
            catalogComplete = false;
            final String attemptedConnectionId = UUID.randomUUID().toString();
            final String traceId = UUID.randomUUID().toString();
            final long startedAt = SystemClock.elapsedRealtime();
            connectionId = attemptedConnectionId;
            connectionStartedAt = startedAt;
            diagnostic("attempt", "socket_open", newFields(traceId, attemptedConnectionId, null, null));
            SyncStore.CursorState cursor = store.eventCursor(scope);
            Request.Builder request = new Request.Builder()
                    .url(DshConfig.syncEventsUrl(scope, cursor.epoch, cursor.seq) + "&dshDiag=" + attemptedConnectionId)
                    .header("Origin", DshConfig.ORIGIN)
                    .get();
            addCookie(request, DshConfig.ORIGIN);
            WebSocketListener listener = new WebSocketListener() {
                @Override
                public void onOpen(WebSocket webSocket, Response response) {
                    if (stopped) {
                        webSocket.close(1000, "stopped");
                        return;
                    }
                    JSONObject fields = newFields(traceId, attemptedConnectionId, null, null);
                    try {
                        fields.put("durationMs", elapsed(startedAt));
                        fields.put("statusCode", response == null ? 0 : response.code());
                    } catch (JSONException ignored) {}
                    diagnostic("connected", "socket_open", fields);
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
                    if (socket == webSocket) lastFrameAt = System.currentTimeMillis();
                    // Keep liveness off the persistence/stream worker. Quiet
                    // business traffic must not be mistaken for a dead socket.
                    if (replyHeartbeat(webSocket, text)) return;
                    submitWork(() -> handleFrame(webSocket, text));
                }

                @Override
                public void onClosing(WebSocket webSocket, int code, String reason) {
                    webSocket.close(code, reason);
                }

                @Override
                public void onClosed(WebSocket webSocket, int code, String reason) {
                    disconnected(webSocket, "closed", attemptedConnectionId, traceId, startedAt, code);
                }

            @Override
            public void onFailure(WebSocket webSocket, Throwable failure, @Nullable Response response) {
                int code = response == null ? 0 : response.code();
                    String failureReason = code == 401 || code == 302 || code == 303 || code == 403
                            ? "auth_required" : "socket_error";
                    JSONObject fields = newFields(traceId, attemptedConnectionId, null, null);
                    try {
                    fields.put("statusCode", code);
                    fields.put("durationMs", elapsed(startedAt));
                } catch (JSONException ignored) {}
                putFailureClass(fields, failureClass(failure, code, stopped));
                diagnostic("failed", failureReason, fields);
                    disconnected(webSocket, failureReason, attemptedConnectionId, traceId, startedAt, code);
                }
            };
            try {
                WebSocket created = http.newWebSocket(request.build(), listener);
                // OkHttp may invoke onOpen before returning on a very fast local
                // connection; the callback assignment is still authoritative.
                if (socket == null) socket = created;
            } catch (RuntimeException failure) {
                JSONObject fields = newFields(traceId, attemptedConnectionId, null, null);
                putFailureClass(fields, failureClass(failure, 0, stopped));
                diagnostic("failed", "request_failed", fields);
                throw failure;
            }
        }
    }

    private boolean replyHeartbeat(WebSocket source, String text) {
        if (stopped || socket != source || !adaptiveHeartbeat || text.length() > 256) return false;
        try {
            if (!"heartbeat".equals(new JSONObject(text).optString("type"))) return false;
            source.send("{\"type\":\"ping\"}");
            return true;
        } catch (JSONException ignored) { return false; }
    }

    private void disconnected(WebSocket webSocket, String reason, String closedConnectionId,
                              String traceId, long startedAt, int statusCode) {
        submitWork(() -> {
            if (socket != webSocket) return;
            socket = null;
            socketConnected = false;
            nativeOnline = false;
            disconnectCount++;
            JSONObject fields = newFields(traceId, closedConnectionId, null, null);
            try {
                fields.put("durationMs", elapsed(startedAt));
                fields.put("statusCode", Math.max(0, statusCode));
                fields.put("closeCode", Math.max(0, statusCode));
                fields.put("count", disconnectCount);
            } catch (JSONException ignored) {}
            diagnostic("closed", "socket_closed", fields);
            if (reason.equals("auth_required")) requireAuthentication();
            else { emitState(reason, "DISCONNECTED"); scheduleReconnect(); }
        });
    }

    private void scheduleReconnect() {
        if (stopped || authenticationRequired || reconnectScheduled) return;
        reconnectScheduled = true;
        long delay = Math.min(appVisible || runningCount > 0 ? 15_000L : 60_000L,
                500L * (1L << Math.min(reconnectAttempt++, 7)));
        JSONObject fields = newFields(UUID.randomUUID().toString(), connectionId, null, null);
        try {
            fields.put("retryDelayMs", delay);
            fields.put("attempt", reconnectAttempt);
        } catch (JSONException ignored) {}
        diagnostic("reconnecting", "socket_closed", fields);
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
        if (stopped || socket != source) {
            diagnostic("skipped", "stopped", newFields(UUID.randomUUID().toString(), connectionId, null, null));
            return;
        }
        lastFrameAt = System.currentTimeMillis();
        try {
            JSONObject frame = new JSONObject(text);
            String type = frame.optString("type", "");
            if ("hello".equals(type)) {
                adaptiveHeartbeat = frame.optInt("syncPolicyVersion", 0) == 1;
                setNativeOnline(frame.optBoolean("online", false));
                emitState("connected", null);
                return;
            }
            if ("resync".equals(type)) {
                String epoch = frame.optString("epoch", "");
                long seq = Math.max(0L, frame.optLong("seq", 0L));
                store.receiveEvent(scope, epoch, seq, new JSONObject().put("resync", true));
                sendAck(source, seq);
                drainInbox(); requestCatalog(true);
                return;
            }
            if (!isEnvelope(frame) || !scope.equals(frame.optString("scope", ""))) return;
            String epoch = frame.optString("epoch", "");
            long seq = frame.optLong("seq", -1L);
            if (epoch.isEmpty() || seq < 1L) return;
            SyncStore.CursorState cursor = store.eventCursor(scope);
            if (epoch.equals(cursor.epoch) && seq <= cursor.seq) { sendAck(source,cursor.seq); return; }
            JSONObject event = frame.optJSONObject("event");
            if (event == null) throw new JSONException("event missing");
            if (!store.isInternalDirectoryThread(scope, frame.optString("threadId", event.optString("threadId")))
                    && java.util.Arrays.asList("snapshot", "turn", "item", "delta").contains(event.optString("type"))) {
                lastWorkAt = SystemClock.elapsedRealtime();
                if ("idle".equals(energyMode)) scheduleMaintenance(1L);
            }
            if (!event.has("threadId")) event.put("threadId",frame.optString("threadId",""));
            JSONObject pending = new JSONObject().put("event",event)
                    .put("resync",!epoch.equals(cursor.epoch) || seq != cursor.seq + 1L);
            // ACK means safely received, never 'body/files ready'. No HTTP on this worker.
            store.receiveEvent(scope,epoch,seq,pending);
            sendAck(source,seq);
            recordReceivedEvent(event, seq);
            drainInbox();
            emitState("running",null);
        } catch (Exception failure) {
            if (!stopped && socket == source) {
                JSONObject fields = newFields(UUID.randomUUID().toString(), connectionId, null, null);
                putFailureClass(fields, failureClass(failure, 0, stopped));
                diagnostic("failed", "request_failed", fields);
                emitState("error", "SYNC_FRAME_FAILED");
                source.close(1011, "frame processing failed");
            }
        }
    }

    private void recordReceivedEvent(JSONObject event, long seq) throws JSONException {
        JSONObject turn = event.optJSONObject("turn");
        boolean completed = "turn".equals(event.optString("type")) && turn != null
                && "completed".equals(turn.optString("status"));
        receivedDiagnosticCount++;
        long now = SystemClock.elapsedRealtime();
        if (!completed && now - lastReceivedDiagnosticAt < 5_000L) return;
        JSONObject fields = newFields(UUID.randomUUID().toString(), connectionId,
                event.optString("threadId"), turn == null ? event.optString("turnId") : turn.optString("id"));
        fields.put("eventCursor", seq).put("count", receivedDiagnosticCount).put("localStored", true);
        diagnostic("received", completed ? "completion_received" : "stream_received", fields);
        receivedDiagnosticCount = 0;
        lastReceivedDiagnosticAt = now;
    }

    private void drainInbox() {
        if (stopped || !started || authenticationPaused() || !inboxQueued.compareAndSet(false,true)) return;
        try { streamWorker.execute(() -> {
            boolean retryOnArrival = true;
            try {
                for (int count=0;count<32 && !stopped && !authenticationRequired;count++) {
                    SyncStore.InboxEntry entry = store.nextEvent(scope);
                    if (entry == null) break;
                    if (!entry.epoch.equals(store.eventCursor(scope).epoch)) {
                        store.completeEvent(scope,entry.id); continue;
                    }
                    if (entry.payload.optBoolean("resync")) { store.resetStreams(scope); requestCatalog(true); }
                    JSONObject event=entry.payload.optJSONObject("event");
                    if (event != null) {
                        event.put("deliveryVersion",entry.epoch+":"+entry.seq);
                        if (store.isInternalDirectoryThread(scope, event.optString("threadId"))) {
                            store.completeEvent(scope, entry.id);
                            continue;
                        }
                        if ("threadStatus".equals(event.optString("type")) || "status".equals(event.optString("type"))) {
                            store.commitRuntimeStatus(scope, entry, event);
                            refreshRunningSessions();
                            emitState("running", null, true);
                            continue;
                        }
                        if(java.util.Arrays.asList("snapshot","turn","item","delta").contains(event.optString("type"))) {
                            store.commitStreamEvent(scope,entry,event);
                            JSONObject completed=event.optJSONObject("turn");
                            if ("turn".equals(event.optString("type")) && completed!=null && "completed".equals(completed.optString("status")))
                                invalidateCompletionRead(event);
                            // Completion preparation was committed with the stream.
                            // Its bounded priority worker may fetch missing history;
                            // this ordered local worker always keeps accepting text.
                            if (!("turn".equals(event.optString("type")) && completed!=null && "completed".equals(completed.optString("status")))) processEvent(event,false);
                            if(!"delta".equals(event.optString("type"))||SystemClock.elapsedRealtime()-lastStreamDiagnosticAt>=1000){
                                lastStreamDiagnosticAt=SystemClock.elapsedRealtime();
                                JSONObject stream=store.readStream(scope,event.optString("threadId"));
                                JSONObject proof=newFields(UUID.randomUUID().toString(),connectionId,event.optString("threadId"),event.optString("turnId"));
                                proof.put("eventCursor",entry.seq).put("localStored",stream.optBoolean("available")).put("recordCursor",store.localRecordCursor(scope));
                                String hash=StreamProjection.latestHash(stream);if(hash!=null)proof.put("contentHash",hash);
                                diagnostic("committed",stream.optBoolean("gap")?"stream_gap":"stream_committed",proof);
                            }
                            continue;
                        }
                        processEvent(event,false);
                    }
                    store.completeEvent(scope,entry.id);
                }
                emitState("running",null);
            } catch(AuthException failure) { requireAuthentication(); }
            catch(Exception failure) {
                diagnostic("failed","request_failed",newFields(UUID.randomUUID().toString(),connectionId,null,null));
                emitState("error","SYNC_PREPARATION_PENDING");
                // Keep the durable frame. Existing catalog cadence or recovery retries it.
                retryOnArrival=false;
            } finally {
                inboxQueued.set(false); drainPreparations();
                // A new frame may arrive between the empty read and releasing
                // inboxQueued. Recheck after releasing the owner so that frame
                // cannot remain parked until the next catalog timer.
                if (retryOnArrival && !stopped && !authenticationRequired && store.hasPendingEvents(scope)) drainInbox();
            }
        }); } catch(RejectedExecutionException ignored) { inboxQueued.set(false); }
    }

    private static boolean isEnvelope(JSONObject value) {
        return value.has("epoch") && value.has("seq") && value.has("scope") && value.has("event");
    }

    private void processEvent(JSONObject event, boolean baseline) throws IOException, JSONException {
        invalidateCompletionRead(event);
        String type = event.optString("type", "");
        if ("host".equals(type)) {
            setNativeOnline(event.optBoolean("online", false));
            return;
        }
        if ("turn".equals(type)) {
            JSONObject turn = event.optJSONObject("turn");
            if (turn != null) {
                String threadId = event.optString("threadId", "");
                boolean fresh = nativeOnline && !baseline;
                if(fresh&&"inProgress".equals(turn.optString("status"))&&isUuid(threadId))scheduleThreadPrefetch(threadId,false,PREFETCH_ACTIVE_PRIORITY,event.optString("deliveryVersion",""));
                boolean bodyReady = hasEmbeddedBody(turn);
                if (fresh && "completed".equals(turn.optString("status", ""))
                        && !threadId.isEmpty() && !turn.optString("id", "").isEmpty()) {
                    // A live turn event is usually a summary. Read its body
                    // before observing completion so notification ordering is
                    // received -> committed -> shown.
                    CompletionRead read = prepareCompletion(threadId, turn.optString("id", ""), true,
                            UUID.randomUUID().toString(), store.catalogCursor(scope).generation);
                    if (read == CompletionRead.NO_FINAL || read == CompletionRead.TERMINATED) return;
                    bodyReady = read == CompletionRead.READY;
                }
                if (fresh && "completed".equals(turn.optString("status")) && !bodyReady && isUuid(threadId)
                        && isUuid(turn.optString("id"))) {
                    store.requestPreparation(scope,"completion",threadId,turn.optString("id"),
                            PREFETCH_ACTIVE_PRIORITY,false,event.optString("deliveryVersion",""));
                }
                processTurn(turn, threadId, fresh, baseline, bodyReady);
            }
            return;
        }
        if (!"nativeChanged".equals(type)) return;
        String cacheKey = event.optString("cacheKey", "");
        String threadId = event.optString("threadId", "");
        // Resolve parent/source metadata before observing completion from this change.
        if (cacheKey.startsWith("thread:") || cacheKey.startsWith("catalog-invalidation")) requestCatalog(false);
        if (cacheKey.startsWith("invalidate:") && DshConfig.isScope(scope) && !threadId.isEmpty()) {
            scheduleThreadPrefetch(threadId,false,PREFETCH_ACTIVE_PRIORITY,event.optString("deliveryVersion",""));
        } else if (!threadId.isEmpty() && cacheKey.startsWith("turn:")) {
            scheduleThreadPrefetch(threadId,false,PREFETCH_ACTIVE_PRIORITY,event.optString("deliveryVersion",""));
        }
    }

    private void syncCatalogSafe(boolean force) {
        if (stopped) return;
        String traceId = UUID.randomUUID().toString();
        long startedAt = SystemClock.elapsedRealtime();
        lastHttpStatusCode.set(0);
        JSONObject attempt = newFields(traceId, connectionId, null, null);
        try { attempt.put("count", force ? 1 : 0); } catch (JSONException ignored) {}
        diagnostic("attempt", "catalog_refresh", attempt);
        try {
            syncCatalogInternal(force);
            lastSuccessfulSyncAt = System.currentTimeMillis();
            JSONObject committed = newFields(traceId, connectionId, null, null);
            try {
                committed.put("durationMs", elapsed(startedAt));
                committed.put("recordCursor", store.localRecordCursor(scope));
            } catch (JSONException ignored) {}
            diagnostic("committed", "catalog_committed", committed);
            emitState("running", null);
        } catch (AuthException failure) {
            // HTTP credentials and Native host availability are independent.
            // A healthy event socket may not send another hello/host event
            // after credentials recover, so keep its last authoritative state.
            JSONObject failed = newFields(traceId, connectionId, null, null);
            try { failed.put("durationMs", elapsed(startedAt)); failed.put("statusCode", Math.max(0, lastHttpStatusCode.get())); } catch (JSONException ignored) {}
            diagnostic("failed", "auth_required", failed);
            requireAuthentication();
        } catch (Exception failure) {
            JSONObject failed = newFields(traceId, connectionId, null, null);
            try { failed.put("durationMs", elapsed(startedAt)); failed.put("statusCode", Math.max(0, lastHttpStatusCode.get())); } catch (JSONException ignored) {}
            diagnostic("failed", "request_failed", failed);
            emitState("error", "SYNC_UNAVAILABLE");
        } finally {
            // Diagnostics use their own durable outbox; this is one bounded
            // flush opportunity per catalog cycle, never one network call per
            // event or body.
            try { NativeDiagnostics.get(context).flush(scope); } catch (RuntimeException ignored) {}
        }
    }

    private void syncCatalogInternal(boolean force) throws IOException, JSONException {
        // A refresh in flight does not invalidate the last committed catalog.
        // Failure or a source-generation change does; partial pages never
        // establish a new successful sync.
        try {
            syncCatalogPages(force);
        } catch (IOException | JSONException | RuntimeException failure) {
            catalogComplete = false;
            throw failure;
        }
    }

    private long lastNativeStatusCheck;
    private void syncCatalogPages(boolean force) throws IOException, JSONException {
        boolean statusRecovery=store.runningSessions(scope).optInt("count")>0&&SystemClock.elapsedRealtime()-lastNativeStatusCheck>=120000L;
        force=force||statusRecovery;
        if(statusRecovery)lastNativeStatusCheck=SystemClock.elapsedRealtime();
        SyncStore.CursorState statusWitness = store.eventCursor(scope);
        String focused = focusThreadId.getAndSet(null);
        if (focused != null && !focused.isEmpty()) {
            // Focused work is placed at priority zero. It shares the same
            // per-thread merge map as active refreshes, so a stale queued job
            // is promoted rather than duplicated.
            scheduleThreadPrefetch(focused, false, PREFETCH_FOCUS_PRIORITY);
        }
        SyncStore.CatalogCursor cursor = store.catalogCursor(scope);
        String generation = cursor.generation;
        long after = cursor.cursor;
        Set<String> activeThreads = new HashSet<>();
        boolean generationReset = false;
        boolean complete = false;
        boolean first = true;
        int catalogueRestarts=0;String restartSource=generation;
        for (int pageCount = 0; pageCount < 128; pageCount++) {
            if (stopped) return;
            String url = DshConfig.nativeCatalogUrl(scope, after, generation);
            if (force && first) url += "&refresh=1";
            JSONObject page;
            try{page=getJson(url);}catch(CatalogSessionChangedException conflict){if(catalogueRestarts++>0)throw conflict;after=0L;first=true;force=false;activeThreads.clear();continue;}
            first = false;
            String pageGeneration = page.optString("generation", "");
            if (pageGeneration.isEmpty()) pageGeneration = firstRecordGeneration(page.optJSONArray("records"));
            if (pageGeneration.isEmpty()) pageGeneration = generation;
            if (pageGeneration.isEmpty()) pageGeneration = "uninitialized";
            if(catalogueRestarts>0&&!restartSource.isEmpty()&&!"uninitialized".equals(restartSource)&&!restartSource.equals(pageGeneration))throw new IOException("catalog source changed after session conflict");
            if (!generation.isEmpty() && !"uninitialized".equals(generation) && !generation.equals(pageGeneration)) {
                catalogComplete = false;
                store.resetGeneration(scope, pageGeneration);
                generation = pageGeneration;
                after = 0L;
                generationReset = true;
                // The gateway has already reset its source cursor for the new
                // generation; read the first page again using the new marker.
                page = getJson(DshConfig.nativeCatalogUrl(scope, 0L, generation));
            } else if (generation.isEmpty() || "uninitialized".equals(generation)) {
                catalogComplete = false;
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
                        if (force) store.reconcileCatalogRuntime(scope, record, statusWitness.epoch, statusWitness.seq);
                    } catch (JSONException ignored) {
                        continue;
                    }
                    if (!record.optBoolean("deleted", false) && "catalog".equals(record.optString("kind", ""))) {
                        JSONObject payload = record.optJSONObject("payload");
                        JSONObject thread = payload == null ? null : payload.optJSONObject("nativeThread");
                        JSONObject threadStatus = thread == null ? null : thread.optJSONObject("status");
                        if (!CompletionNotificationPolicy.isInternalDirectoryThread(thread)
                                && threadStatus != null && "active".equals(threadStatus.optString("type", ""))) {
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
            // Checkpoint progress even if this bounded pass cannot finish.
            // Partial catalog progress is never a successful full sync.
            store.saveCatalogCursor(scope, generation, after);
            if (!hasMore) { complete = true; break; }
        }
        if (!complete) { catalogComplete = false; throw new IOException("catalog pass incomplete"); }
        refreshRunningSessions();
        catalogCompletedAt = SystemClock.elapsedRealtime();
        catalogComplete = true;
        boolean baseline = !store.isBootstrapComplete(scope);
        if (baseline || generationReset) store.markBootstrapComplete(scope, true);

        // Catalog/cursor state is useful to the UI even while bounded thread
        // body reads are still in flight. Publish it before the active set is
        // scheduled so the single sync worker never waits behind 64 histories.
        emitState("running", null);
        submitProjection(() -> {
            try { fetchBootstrapIfAvailable(); }
            catch (AuthException ignored) { requireAuthentication(); }
            catch (IOException | JSONException ignored) { /* bootstrap is optional */ }
        });
        for (String threadId : activeThreads) {
            if (threadId.equals(focused)) continue;
            scheduleThreadPrefetch(threadId, baseline, PREFETCH_ACTIVE_PRIORITY);
        }
        queueHistoryWarm();
    }

    private void refreshRunningSessions() {
        JSONObject running = store.runningSessions(scope);
        runningCount = running.optInt("count", 0);
        runningThread = running.optString("threadId", "");
    }

    private void scheduleThreadPrefetch(String threadId, boolean baseline, int priority) {
        scheduleThreadPrefetch(threadId,baseline,priority,"");
    }

    private void scheduleThreadPrefetch(String threadId, boolean baseline, int priority, String desired) {
        if (stopped || !isUuid(threadId)) return;
        if(priority!=PREFETCH_ACTIVE_PRIORITY&&store.isUnstartedHistory(scope,threadId)){store.retireUnstartedPreparations(scope,threadId);return;}
        if (priority != PREFETCH_FOCUS_PRIORITY && store.isInternalDirectoryThread(scope, threadId)) return;
        if (priority == PREFETCH_FOCUS_PRIORITY) store.clearHistoryWarmFailure(scope, threadId);
        String version=desired.isEmpty()?store.historyPreparationVersion(scope,threadId):desired;
        boolean focus=priority==PREFETCH_FOCUS_PRIORITY&&threadId.equals(currentFocusThreadId);
        SyncStore.Preparation job=store.requestPreparation(scope,"history",threadId,"",priority==PREFETCH_FOCUS_PRIORITY?PREFETCH_HISTORY_PRIORITY:priority,baseline,version);
        if(focus){store.promotePreparationFocus(scope,threadId,false);for(SyncStore.Preparation due:store.duePreparations(scope,System.currentTimeMillis(),MAX_PREFETCH_QUEUE))if(threadId.equals(due.threadId))queuePreparation(due);}else queuePreparation(job);
    }

    private void drainPreparations() {
        if (stopped || !started || authenticationPaused()) return;
        for (SyncStore.Preparation job : store.duePreparations(scope,System.currentTimeMillis(),MAX_PREFETCH_QUEUE)) {
            if(store.optionalHistoryPreparation(scope,job)&&store.isUnstartedHistory(scope,job.threadId)){store.finishPreparation(scope,job);continue;}
            if (job.priority != PREFETCH_FOCUS_PRIORITY && store.isInternalDirectoryThread(scope, job.threadId)) { store.finishPreparation(scope, job); continue; }
            if ("artifacts".equals(job.kind)) queueArtifactPreparation(job); else queuePreparation(job);
        }
    }

    private void scheduleArtifacts(String threadId,String turnId,JSONArray items,String generation) {
        if(stopped||!hasFinalAnswer(items)||!isUuid(threadId)||!isUuid(turnId))return;
        String desired=DeliverableCache.digest(generation+"\n"+items.toString());
        if(DeliverableCache.get(context).prepared(scope,threadId,turnId,desired))return;
        queueArtifactPreparation(store.requestPreparation(scope,"artifacts",threadId,turnId,2,true,desired));
    }

    private void queueArtifactPreparation(SyncStore.Preparation job) {
        if(!stopped&&started&&!authenticationRequired) DeliverableJobService.schedule(context,scope);
    }

    private void queuePreparation(SyncStore.Preparation job) {
        if (stopped || authenticationRequired || job.dueAt > System.currentTimeMillis()) return;
        if (job.priority != PREFETCH_FOCUS_PRIORITY && store.isInternalDirectoryThread(scope, job.threadId)) {
            store.finishPreparation(scope, job); return;
        }
        synchronized(prefetchLock) {
            boolean archive="archive".equals(job.kind);String key=archive?"archive:"+job.threadId:job.threadId;
            if (!archive&&directRefreshThreads.contains(job.threadId)) return;
            PrefetchTask prior=prefetchByThread.get(key);
            if (prior != null) {
                if (prior.started || prior.priority <= job.priority) return;
                cancelQueuedPrefetchLocked(prior); prefetchByThread.remove(key);
            }
            PrefetchTask task=new PrefetchTask(job,++prefetchSequence,UUID.randomUUID().toString());
            prefetchByThread.put(key,task);
            try { (task.priority <= PREFETCH_ACTIVE_PRIORITY ? focusWorkers : prefetchWorkers).execute(task); }
            catch(RejectedExecutionException ignored) {
                if (prefetchByThread.get(key)==task) prefetchByThread.remove(key);
                // The persistent row remains pending when the bounded executor is full.
            }
        }
    }

    private void cancelQueuedPrefetchLocked(PrefetchTask task) {
        if (task == null || task.started) return;
        task.cancelled = true;
        prefetchWorkers.getQueue().remove(task);
        focusWorkers.getQueue().remove(task);
    }

    /** Claim a live event read, cancelling only a queued lower-priority job. */
    private boolean claimDirectRefresh(String threadId) {
        synchronized (prefetchLock) {
            PrefetchTask prior = prefetchByThread.get(threadId);
            if (prior != null) {
                if (prior.started) return false;
                cancelQueuedPrefetchLocked(prior);
                prefetchByThread.remove(threadId);
            }
            return directRefreshThreads.add(threadId);
        }
    }

    private void releaseDirectRefresh(String threadId) {
        synchronized (prefetchLock) { directRefreshThreads.remove(threadId); }
    }

    private final class PrefetchTask implements Runnable, Comparable<PrefetchTask> {
        final String threadId;
        final String queueKey;
        final boolean baseline;
        final int priority;
        final long sequence;
        final String traceId;
        final long queuedAt = SystemClock.elapsedRealtime();
        @Nullable final JSONObject historyCandidate;
        @Nullable final SyncStore.Preparation preparation;
        volatile boolean started;
        volatile boolean cancelled;

        PrefetchTask(SyncStore.Preparation job, long sequence, String traceId) {
            this.threadId=job.threadId;this.queueKey="archive".equals(job.kind)?"archive:"+job.threadId:job.threadId;this.baseline=job.baseline;this.priority="archive".equals(job.kind)?4:job.priority;
            this.sequence=sequence;this.traceId=traceId;this.historyCandidate=null;this.preparation=job;
        }

        PrefetchTask(String threadId, boolean baseline, int priority, long sequence, String traceId) {
            this(threadId, baseline, priority, sequence, traceId, null);
        }

        PrefetchTask(String threadId, @Nullable JSONObject historyCandidate, int priority,
                     long sequence, String traceId) {
            this(threadId, false, priority, sequence, traceId, historyCandidate);
        }

        private PrefetchTask(String threadId, boolean baseline, int priority, long sequence,
                             String traceId, @Nullable JSONObject historyCandidate) {
            this.threadId = threadId;
            this.queueKey = threadId;
            this.baseline = baseline;
            this.priority = priority;
            this.sequence = sequence;
            this.traceId = traceId;
            this.historyCandidate = historyCandidate;
            this.preparation = null;
        }

        @Override public int compareTo(PrefetchTask other) {
            int result = Integer.compare(priority, other.priority);
            return result != 0 ? result : Long.compare(sequence, other.sequence);
        }

        @Override public void run() {
            synchronized (prefetchLock) {
                if (cancelled || prefetchByThread.get(queueKey) != this
                        || !(preparation!=null&&"archive".equals(preparation.kind))&&directRefreshThreads.contains(threadId)) {
                    if (prefetchByThread.get(queueKey) == this) prefetchByThread.remove(queueKey);
                    return;
                }
                started = true;
            }
            // One event when a queued job actually starts. No polling or timer:
            // pair its trace with the existing focus/history completion event.
            JSONObject dispatch = newFields(traceId, connectionId, threadId, null);
            try {
                dispatch.put("durationMs", elapsed(queuedAt));
                dispatch.put("pendingCount", priority <= PREFETCH_ACTIVE_PRIORITY
                        ? focusWorkers.getQueue().size() : prefetchWorkers.getQueue().size());
                dispatch.put("fresh", priority == PREFETCH_FOCUS_PRIORITY);
            } catch (JSONException ignored) {}
            diagnostic("dispatch", priority == PREFETCH_FOCUS_PRIORITY ? "focus_requested" : "history_prefetch", dispatch);
            try {
                if((historyCandidate!=null||preparation!=null&&store.optionalHistoryPreparation(scope,preparation))&&store.isUnstartedHistory(scope,threadId))throw new UnstartedHistoryException();
                if (priority != PREFETCH_FOCUS_PRIORITY && store.isInternalDirectoryThread(scope, threadId)) {
                    if (preparation != null) store.finishPreparation(scope, preparation);
                    return;
                }
                if (historyCandidate != null) {
                    runHistoryWarm(historyCandidate);
                } else if (preparation != null && "archive".equals(preparation.kind)) {
                    if(!archiveHistoryBatch(threadId,traceId,preparation.desired)){
                        store.continuePreparation(scope,preparation,System.currentTimeMillis()+60_000L);return;
                    }
                } else if (preparation != null && "completion".equals(preparation.kind)) {
                    CompletionRead read=prepareCompletion(threadId,preparation.turnId,true,traceId,store.catalogCursor(scope).generation);
                    if (read == CompletionRead.PENDING)
                        throw new IOException("completion body pending");
                    if (read == CompletionRead.READY)
                        processTurn(new JSONObject().put("id",preparation.turnId).put("status","completed"),threadId,nativeOnline,preparation.baseline,true);
                } else {
                    fetchThreadTurnsInternal(threadId, baseline, traceId, priority == PREFETCH_FOCUS_PRIORITY);
                }
                if(historyCandidate==null&&(preparation==null||!"archive".equals(preparation.kind)))scheduleArchive(threadId);
                if (preparation != null) store.finishPreparation(scope,preparation);
                if (preparation != null && "completion".equals(preparation.kind))
                    submitWork(() -> emitState("running",null,true));
                if (priority == PREFETCH_FOCUS_PRIORITY) {
                    JSONObject fields = newFields(traceId, connectionId, threadId, null);
                    try { fields.put("count", 1); } catch (JSONException ignored) {}
                    diagnostic("committed", "focus_committed", fields);
                }
            } catch (UnstartedHistoryException skipped) {
                if(preparation!=null)store.finishPreparation(scope,preparation);
                diagnostic("skipped","empty",newFields(traceId,connectionId,threadId,null));
            } catch (InternalDirectoryThreadException skipped) {
                if (preparation != null) store.finishPreparation(scope, preparation);
            } catch (AuthException failure) {
                if (preparation != null) store.deferPreparation(scope,preparation,System.currentTimeMillis()+CATALOG_INTERVAL_MS);
                requireAuthentication();
                if (priority == 0&&threadId.equals(currentFocusThreadId)) {
                    diagnostic("failed", "focus_failed", newFields(traceId, connectionId, threadId, null));
                }
            } catch (Exception failure) {
                if (preparation != null) store.deferPreparation(scope,preparation,System.currentTimeMillis()+CATALOG_INTERVAL_MS);
                if (priority == 0&&threadId.equals(currentFocusThreadId)) {
                    diagnostic("failed", "focus_failed", newFields(traceId, connectionId, threadId, null));
                }
            } finally {
                synchronized (prefetchLock) {
                    if (prefetchByThread.get(queueKey) == this) prefetchByThread.remove(queueKey);
                }
                drainPreparations();
            }
        }
    }

    private void queueHistoryWarm() {
        // Historical warmup is optional; live/final/focused work uses the
        // separate existing priority path and remains enabled in background.
        if (!appVisible) return;
        if (stopped) return;
        for (JSONObject candidate : store.historyWarmCandidates(scope, 4)) {
            String id = candidate.optString("threadId");
            if (!NativeDiagnostics.isUuid(id)) continue;
            scheduleHistoryWarm(candidate);
        }
    }

    private void scheduleHistoryWarm(JSONObject candidate) {
        if (stopped || candidate == null) return;
        String threadId = candidate.optString("threadId", "");
        if (!NativeDiagnostics.isUuid(threadId)) return;
        if (store.isInternalDirectoryThread(scope, threadId)) return;
        if (!store.historyWarmDue(scope, threadId, candidate.optString("version"), System.currentTimeMillis())) return;
        synchronized (prefetchLock) {
            if (directRefreshThreads.contains(threadId)) return;
            PrefetchTask prior = prefetchByThread.get(threadId);
            if (prior != null) {
                // Focus and active refreshes always win; another queued warm
                // task is already the merged request for this thread.
                if (prior.started || prior.priority <= PREFETCH_HISTORY_PRIORITY) return;
                cancelQueuedPrefetchLocked(prior);
                prefetchByThread.remove(threadId);
            }
            PrefetchTask task = new PrefetchTask(threadId, candidate, candidate.optBoolean("pinned") ? PREFETCH_PINNED_PRIORITY : PREFETCH_HISTORY_PRIORITY,
                    ++prefetchSequence, UUID.randomUUID().toString());
            prefetchByThread.put(threadId, task);
            try {
                prefetchWorkers.execute(task);
            } catch (RejectedExecutionException rejected) {
                if (prefetchByThread.get(threadId) == task) prefetchByThread.remove(threadId);
            }
        }
    }

    private void runHistoryWarm(JSONObject candidate) {
        String id = candidate.optString("threadId", "");
        if (store.isInternalDirectoryThread(scope, id)) return;
        String traceId = UUID.randomUUID().toString();
        long startedAt = SystemClock.elapsedRealtime();
        String expectedGeneration = store.catalogCursor(scope).generation;
        diagnostic("attempt", "history_prefetch", newFields(traceId, connectionId, id, null));
        try {
            JSONObject params = new JSONObject().put("threadId", id).put("limit", 20)
                    .put("sortDirection", "desc").put("itemsView", "summary");
            long bodyFence=store.historyBodyFence(scope,id);
            TurnProjection projection = readTurnProjection(id, candidate.optString("version").startsWith("verify-body-v1:"), traceId, expectedGeneration);
            JSONObject response = projection.record;
            JSONObject payload = response.optJSONObject("payload");
            JSONObject result = payload == null ? null : payload.optJSONObject("result");
            JSONArray turns = result == null ? null : result.optJSONArray("data");
            if (turns == null && result != null) turns = result.optJSONArray("turns");
            JSONObject received = newFields(traceId, connectionId, id, null);
            try {
                received.put("statusCode", Math.max(0, lastHttpStatusCode.get()));
                received.put("count", turns == null ? 0 : turns.length());
            } catch (JSONException ignored) {}
            diagnostic("received", "history_prefetch", received);
            if (!scope.equals(response.optString("scope")) || !id.equals(response.optString("threadId"))
                    || response.optBoolean("deleted") || result == null) throw new IOException("history scope mismatch");
            if (!store.applyReadRecord(response, traceId, expectedGeneration)) return;
            saveHistoryCursors(id, result);
            Set<String> readyTurns = cacheRecentTurnItems(id, turns, false, traceId, expectedGeneration,
                    projection.itemPagingSupported, response, projection.readChange, projection.streamVersion);
            boolean cacheReady = historyWarmComplete(id, turns, readyTurns, response);
            if (!response.optBoolean("stale", false) && cacheReady) {
                if(bodyFence==store.historyBodyFence(scope,id)){JSONObject acceptedCandidate=new JSONObject(candidate.toString()).put("version",store.historyPreparationVersion(scope,id));store.markHistoryWarm(scope, acceptedCandidate, response.getString("key"));}
                scheduleArchive(id);
            }
            JSONObject committed = newFields(traceId, connectionId, id, null);
            try {
                committed.put("durationMs", elapsed(startedAt));
                committed.put("count", turns == null ? 0 : turns.length());
                committed.put("cacheReady", cacheReady && !response.optBoolean("stale", false));
            } catch (JSONException ignored) {}
            diagnostic("committed", "history_committed", committed);
            // Historical prefetch never updates completion observations.
            emitState("running", null);
        } catch (Exception failure) {
            store.deferHistoryWarm(scope, candidate, System.currentTimeMillis());
            // Optional read replica work must not disconnect the live stream.
            JSONObject failed = newFields(traceId, connectionId, id, null);
            try { failed.put("durationMs", elapsed(startedAt)); failed.put("statusCode", Math.max(0, lastHttpStatusCode.get())); } catch (JSONException ignored) {}
            diagnostic("failed", "history_failed", failed);
        }
    }

    private boolean historyWarmComplete(String threadId, @Nullable JSONArray turns,
                                        Set<String> readyTurns, JSONObject record) {
        if (turns == null) return false;
        for (int index = 0; index < Math.min(2, turns.length()); index++) {
            JSONObject turn = turns.optJSONObject(index);
            if (turn == null) continue;
            String turnId = turn.optString("id", "");
            if (turnId.isEmpty()) continue;
            if (hasEmbeddedBody(turn) || readyTurns.contains(turnId)) continue;
            String status = turn.optString("status"), view = turn.optString("itemsView");
            // A complete stopped/failed summary does not owe a final answer.
            // This settles optional history warmup only, never notification readiness.
            if (("interrupted".equals(status) || "failed".equals(status) || "cancelled".equals(status))
                    && ("summary".equals(view) || "full".equals(view))
                    && turn.optJSONArray("items") != null) continue;
            if (confirmedWithoutFinal(threadId, turn, record)) continue;
            return false;
        }
        return true;
    }

    private void fetchBootstrapIfAvailable() throws IOException, JSONException {
        String traceId = UUID.randomUUID().toString();
        long startedAt = SystemClock.elapsedRealtime();
        diagnostic("attempt", "catalog_refresh", newFields(traceId, connectionId, null, null));
        try {
            JSONObject value = getJson(DshConfig.ORIGIN + "/sync/v1/w/" + scope + "/native-bootstrap", traceId);
            JSONObject config = value.optJSONObject("config");
            if (config == null) {
                diagnostic("skipped", "empty", newFields(traceId, connectionId, null, null));
                return;
            }
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
            JSONObject fields = newFields(traceId, connectionId, null, null);
            try { fields.put("durationMs", elapsed(startedAt)); } catch (JSONException ignored) {}
            diagnostic("committed", "catalog_committed", fields);
        } catch (AuthException failure) {
            diagnostic("failed", "auth_required", newFields(traceId, connectionId, null, null));
            throw failure;
        } catch (Exception ignored) {
            // Bootstrap is an optimization. Catalog/read records remain usable
            // if the server has not cached it yet.
            diagnostic("failed", "request_failed", newFields(traceId, connectionId, null, null));
        }
    }

    private void fetchThreadTurns(String threadId, boolean baseline) throws IOException, JSONException {
        if (threadId == null || threadId.isEmpty() || threadId.length() > 160) return;
        if (!claimDirectRefresh(threadId)) return;
        try {
            fetchThreadTurnsInternal(threadId, baseline, null);
        } finally {
            releaseDirectRefresh(threadId);
        }
    }

    private void fetchThreadTurnsInternal(String threadId, boolean baseline,
                                          @Nullable String batchTraceId) throws IOException, JSONException {
        fetchThreadTurnsInternal(threadId, baseline, batchTraceId, false);
    }

    private void fetchThreadTurnsInternal(String threadId, boolean baseline,
                                          @Nullable String batchTraceId, boolean allowInternal) throws IOException, JSONException {
        if (threadId == null || threadId.isEmpty() || threadId.length() > 160) return;
        String traceId = NativeDiagnostics.isUuid(batchTraceId) ? batchTraceId : UUID.randomUUID().toString();
        long startedAt = SystemClock.elapsedRealtime();
        String expectedGeneration = store.catalogCursor(scope).generation;
        String preparedVersion = store.historyPreparationVersion(scope,threadId);
        long preparedBodyFence=store.historyBodyFence(scope,threadId);
        JSONObject attempt = newFields(traceId, connectionId, threadId, null);
        try { attempt.put("count", 1); } catch (JSONException ignored) {}
        diagnostic("attempt", "history_prefetch", attempt);
        JSONObject params = new JSONObject();
        params.put("threadId", threadId);
        params.put("limit", 20);
        params.put("sortDirection", "desc");
        params.put("itemsView", "summary");
        JSONObject body = new JSONObject();
        body.put("method", "thread/turns/list");
        body.put("params", params);
        body.put("fresh", true);
        try {
            TurnProjection projection = readTurnProjection(threadId, true, traceId, expectedGeneration, allowInternal);
            JSONObject response = projection.record;
            JSONObject payload = response.optJSONObject("payload");
            JSONObject result = payload == null ? null : payload.optJSONObject("result");
            JSONArray turns = result == null ? null : result.optJSONArray("data");
            if (turns == null && result != null) turns = result.optJSONArray("turns");
            JSONObject received = newFields(traceId, connectionId, threadId, null);
            try {
                received.put("statusCode", Math.max(0, lastHttpStatusCode.get()));
                received.put("count", turns == null ? 0 : turns.length());
            } catch (JSONException ignored) {}
            diagnostic("received", "history_prefetch", received);
            if (!scope.equals(response.optString("scope", "")) || !threadId.equals(response.optString("threadId", "")) || response.optBoolean("deleted")
                    || result == null) throw new IOException("history scope mismatch");
            if (!store.applyReadRecord(response, traceId, expectedGeneration)) {
                throw new StaleReadException();
            }
            saveHistoryCursors(threadId, result);
            Set<String> readyTurns = cacheRecentTurnItems(threadId, turns, true, traceId, expectedGeneration,
                    projection.itemPagingSupported, response, projection.readChange, projection.streamVersion);
            if (!expectedGeneration.equals(store.catalogCursor(scope).generation)) throw new StaleReadException();
            boolean fresh = response.optBoolean("nativeOnline", nativeOnline)
                    && !response.optBoolean("stale", false)
                    && !"cloud-cache".equals(response.optString("source", ""));
            if(!store.currentReadIdentities(java.util.Collections.singletonList(readIdentity(response))))throw new StaleReadException();
            for (int index = 0; turns != null && index < turns.length(); index++) {
                JSONObject turn = turns.optJSONObject(index);
                if (turn != null) {
                    String turnId = turn.optString("id", "");
                    boolean bodyReady = readyTurns.contains(turnId) || hasEmbeddedBody(turn);
                    // Text arriving during the read makes a terminal decision
                    // wait for the new snapshot; active history still commits.
                    if(!"inProgress".equals(turn.optString("status"))&&!completionReadUnchanged(threadId,projection.readChange,projection.streamVersion))continue;
                    if ("completed".equals(turn.optString("status")) && confirmedWithoutFinal(threadId,turn,response)) continue;
                    if(index<2 && "completed".equals(turn.optString("status")) && !bodyReady) store.requestPreparation(scope,"completion",threadId,turnId,1,baseline,expectedGeneration+":"+turnId);
                    processTurn(turn, threadId, fresh, baseline, bodyReady);
                }
            }
            if(preparedBodyFence==store.historyBodyFence(scope,threadId))store.markHistoryPrepared(scope,threadId,store.historyPreparationVersion(scope,threadId),response.getString("key"));
            JSONObject committed = newFields(traceId, connectionId, threadId, null);
            try {
                committed.put("durationMs", elapsed(startedAt));
                committed.put("count", turns == null ? 0 : turns.length());
            } catch (JSONException ignored) {}
            diagnostic("committed", "history_committed", committed);
            submitWork(() -> emitState("running", null));
        } catch (AuthException failure) {
            diagnostic("failed", "auth_required", newFields(traceId, connectionId, threadId, null));
            throw failure;
        } catch (IOException | JSONException failure) {
            JSONObject failed = newFields(traceId, connectionId, threadId, null);
            try { failed.put("durationMs", elapsed(startedAt)); failed.put("statusCode", Math.max(0, lastHttpStatusCode.get())); } catch (JSONException ignored) {}
            diagnostic("failed", "history_failed", failed);
            throw failure;
        }
    }

    /** Persist visible message bodies before a notification can open the thread. */
    private Set<String> cacheRecentTurnItems(String threadId, @Nullable JSONArray turns, boolean fresh,
                                             @Nullable String parentTraceId,
                                             @Nullable String expectedGeneration,
                                             boolean itemPagingSupported, JSONObject projectionRecord,long observedChange,String streamVersion) throws StaleReadException {
        Set<String> ready = new HashSet<>();
        if (turns == null) return ready;
        for (int index = 0; index < Math.min(2, turns.length()); index++) {
            JSONObject turn = turns.optJSONObject(index);
            if (turn == null) continue;
            String turnId = turn.optString("id", "");
            if (turnId.isEmpty()) continue;
            // The committed official summary already carries the opening input
            // and final answer. Process pages can exceed the bounded local store;
            // they must not decide whether this completed body is ready.
            if (hasEmbeddedBody(turn)) {
                ready.add(turnId);
                scheduleArtifacts(threadId,turnId,turn.optJSONArray("items"),expectedGeneration);
                continue;
            }
            if ("full".equals(turn.optString("itemsView")) && turn.optJSONArray("items") != null) {
                continue;
            }
            // A legacy summary is the supported Native read for this thread;
            // its missing final answer does not enable thread/items/list.
            // Active/interrupted turns also have no completion body to prepare.
            if (!itemPagingSupported || !"completed".equals(turn.optString("status"))) continue;
            if (confirmedWithoutFinal(threadId,turn,projectionRecord)) continue;
            CompletionBody body = readTurnItems(threadId, turnId, fresh, parentTraceId, expectedGeneration);
            if (body.state == CompletionRead.READY) ready.add(turnId);
            else if (body.state == CompletionRead.NO_FINAL && fresh && freshRecord(projectionRecord))
                rememberWithoutFinal(threadId,turn,projectionRecord,observedChange,streamVersion,body.identities);
        }
        return ready;
    }

    private static boolean hasEmbeddedBody(@Nullable JSONObject turn) {
        return turn != null && "completed".equals(turn.optString("status"))
                && ("full".equals(turn.optString("itemsView", "")) || "summary".equals(turn.optString("itemsView", "")))
                && hasFinalAnswer(turn.optJSONArray("items"));
    }

    static boolean hasFinalAnswer(@Nullable JSONArray items) {
        for (int index = 0; items != null && index < items.length(); index++) {
            JSONObject value = items.optJSONObject(index);
            JSONObject item = value == null ? null : value.optJSONObject("item");
            if (item == null) item = value;
            if (item != null && "agentMessage".equals(item.optString("type"))
                    && "final_answer".equals(item.optString("phase"))
                    && !item.optString("id", "").isEmpty() && item.opt("text") instanceof String
                    && !item.optString("text").trim().isEmpty()) return true;
        }
        return false;
    }

    private static boolean freshRecord(JSONObject record) {
        return !record.optBoolean("stale") && !record.optBoolean("deleted")
                && !"cloud-cache".equals(record.optString("source"));
    }
    private static boolean authoritativeRecord(JSONObject record) {
        return freshRecord(record)&&"native".equals(record.optString("source"));
    }

    private static String completionReadKey(String threadId,String turnId) { return threadId+":"+turnId; }
    private static String completionReadVersion(JSONObject turn,JSONObject record) {
        return record.optString("sourceGeneration")+":"+record.optString("generation")+":"+SyncStore.readPayloadDigest(turn);
    }
    private static String legacyCompletionReadVersion(JSONObject turn,JSONObject record) {
        return record.optString("sourceGeneration")+":"+record.optString("generation")+":"+DeliverableCache.digest(turn.toString());
    }
    private static JSONObject readIdentity(JSONObject record) throws JSONException {
        JSONObject identity=new JSONObject();
        for(String key:new String[]{"scope","key","sourceGeneration","generation","revision"})identity.put(key,record.get(key));
        return identity.put("digestVersion",2).put("payloadDigest",SyncStore.readPayloadDigest(record.get("payload")));
    }
    private long completionReadChange(String threadId) {
        synchronized(completionWithoutFinal) {
            Long change=completionReadChanges.get(threadId);
            if(change==null) {
                change=++completionReadSequence;completionReadChanges.put(threadId,change);
                if(completionReadChanges.size()>256)completionReadChanges.remove(completionReadChanges.keySet().iterator().next());
            }
            return change;
        }
    }
    private boolean completionReadUnchanged(String threadId,long observedChange,String streamVersion) {
        synchronized(completionWithoutFinal) {return Long.valueOf(observedChange).equals(completionReadChanges.get(threadId))
                &&streamVersion.equals(store.streamReadVersion(scope,threadId));}
    }
    private boolean confirmedWithoutFinal(String threadId,JSONObject turn,JSONObject record) {
        // Creating a receipt still requires fresh Native provenance. Reusing
        // that receipt depends on its exact adopted DTO and stream identities,
        // so a same-version cached read can also reuse the verified absence.
        if(record.optBoolean("deleted")||!"completed".equals(turn.optString("status")))return false;
        synchronized(completionWithoutFinal) {
            String key=completionReadKey(threadId,turn.optString("id"));EmptyCompletionRead receipt=completionWithoutFinal.get(key);
            if(receipt==null) {
                JSONObject saved=store.emptyCompletionRead(scope,threadId,turn.optString("id"));
                JSONArray reads=saved==null?null:saved.optJSONArray("identities");
                if(reads!=null) {
                    java.util.List<JSONObject> identities=new java.util.ArrayList<>();
                    for(int i=0;i<reads.length();i++)if(reads.optJSONObject(i)!=null)identities.add(reads.optJSONObject(i));
                    receipt=new EmptyCompletionRead(saved.optString("version"),saved.optString("streamVersion"),identities);
                }
            }
            if(receipt==null||!completionReadVersion(turn,record).equals(receipt.version)
                    &&!legacyCompletionReadVersion(turn,record).equals(receipt.version))return false;
            if(receipt.streamVersion.equals(store.streamReadVersion(scope,threadId))&&store.currentReadIdentities(receipt.identities))return true;
            completionWithoutFinal.remove(key);store.consumeEmptyCompletionReads(scope,threadId,turn.optString("id"));return false;
        }
    }
    private boolean rememberWithoutFinal(String threadId,JSONObject turn,JSONObject record,long observedChange,String streamVersion,java.util.List<JSONObject> bodyIdentities) {
        synchronized(completionWithoutFinal) {
            if(!authoritativeRecord(record)||!"completed".equals(turn.optString("status"))
                    ||!record.optString("sourceGeneration").equals(store.catalogCursor(scope).generation)
                    ||!Long.valueOf(observedChange).equals(completionReadChanges.get(threadId)))return false;
            java.util.List<JSONObject> identities=new java.util.ArrayList<>(bodyIdentities);
            try {identities.add(readIdentity(record));}catch(JSONException invalid){return false;}
            String version=completionReadVersion(turn,record);
            if(!store.saveEmptyCompletionRead(scope,threadId,turn.optString("id"),version,streamVersion,identities))return false;
            completionWithoutFinal.put(completionReadKey(threadId,turn.optString("id")),new EmptyCompletionRead(version,streamVersion,identities));
            if(completionWithoutFinal.size()>256)completionWithoutFinal.remove(completionWithoutFinal.keySet().iterator().next());
            return true;
        }
    }
    private void invalidateCompletionRead(JSONObject event) {
        String threadId=event.optString("threadId"),type=event.optString("type"),key=event.optString("cacheKey");
        if("nativeChanged".equals(type))try{store.observeHistoryBodyEvent(scope,event);}catch(JSONException ignored){}
        if(!isUuid(threadId)||!("turn".equals(type)||"item".equals(type)||"delta".equals(type)||"snapshot".equals(type)
                ||"nativeChanged".equals(type)&&(key.startsWith("invalidate:")||key.startsWith("turn:")||key.startsWith("item:"))))return;
        JSONObject turn=event.optJSONObject("turn");String turnId=turn==null?event.optString("turnId"):turn.optString("id");
        if(!isUuid(turnId)&&(key.startsWith("turn:")||key.startsWith("item:"))) {String[] parts=key.split(":",4);if(parts.length>2&&isUuid(parts[2]))turnId=parts[2];}
        java.util.List<String> invalidated=new java.util.ArrayList<>();
        boolean reopen="item".equals(type)||"delta".equals(type)||"snapshot".equals(type)||"nativeChanged".equals(type);
        synchronized(completionWithoutFinal) {
            if(completionReadChanges.containsKey(threadId))completionReadChanges.put(threadId,++completionReadSequence);
            invalidated.addAll(reopen?store.reopenEmptyCompletionReads(scope,threadId,isUuid(turnId)?turnId:null,event.optString("deliveryVersion"))
                    :store.consumeEmptyCompletionReads(scope,threadId,isUuid(turnId)?turnId:null));
            java.util.Iterator<String> keys=completionWithoutFinal.keySet().iterator();
            while(keys.hasNext()) {String saved=keys.next();if(saved.startsWith(threadId+":")&&(!isUuid(turnId)||saved.equals(completionReadKey(threadId,turnId)))){String target=saved.substring(threadId.length()+1);if(!invalidated.contains(target))invalidated.add(target);keys.remove();}}
        }
        // A late real item must wake its exact completed target even when the
        // prior empty read already removed the preparation. No command replay.
        if(reopen)for(String target:invalidated)
            queuePreparation(store.requestPreparation(scope,"completion",threadId,target,PREFETCH_ACTIVE_PRIORITY,false,event.optString("deliveryVersion")));
    }

    private static final class TurnProjection {
        final JSONObject record;
        final boolean itemPagingSupported;
        final long readChange;
        final String streamVersion;
        TurnProjection(JSONObject record, boolean itemPagingSupported,long readChange,String streamVersion) {
            this.record = record;
            this.itemPagingSupported = itemPagingSupported;
            this.readChange=readChange;
            this.streamVersion=streamVersion;
        }
    }

    private TurnProjection readTurnProjection(String threadId, boolean fresh, String traceId,
                                          String expectedGeneration) throws IOException, JSONException {
        return readTurnProjection(threadId, fresh, traceId, expectedGeneration, false);
    }

    private TurnProjection readTurnProjection(String threadId, boolean fresh, String traceId,
                                          String expectedGeneration, boolean allowInternal) throws IOException, JSONException {
        long readChange=completionReadChange(threadId);
        String streamVersion=store.streamReadVersion(scope,threadId);
        JSONObject head = readAdoptedProjection("thread/read",
                new JSONObject().put("threadId", threadId).put("includeTurns", false), fresh, traceId, expectedGeneration);
        JSONObject hp = head.optJSONObject("payload"), hr = hp == null ? null : hp.optJSONObject("result");
        JSONObject thread = hr == null ? null : hr.optJSONObject("thread");
        if (!scope.equals(head.optString("scope")) || !threadId.equals(head.optString("threadId"))
                || head.optBoolean("deleted") || thread == null || !threadId.equals(thread.optString("id"))) throw new IOException("head scope mismatch");
        // An old pin or event may reach us before the catalog reveals its
        // source. Adopt this head, but stop optional work before any body read.
        if (!allowInternal && CompletionNotificationPolicy.isInternalDirectoryThread(thread)) throw new InternalDirectoryThreadException();
        boolean legacy = "legacy".equals(thread.optString("historyMode"));
        JSONObject record = readTurnPage(threadId,fresh,traceId,expectedGeneration,legacy?2:20,null);
        // Keep the capability from this exact head read with its projection.
        // Do not persist a parallel capability cache or alter the Native DTO.
        return new TurnProjection(record, !legacy, readChange, streamVersion);
    }

    private JSONObject readTurnPage(String threadId,boolean fresh,String traceId,String expectedGeneration,int limit,@Nullable String cursor) throws IOException,JSONException {
        JSONObject params=new JSONObject().put("threadId",threadId).put("limit",limit).put("sortDirection","desc").put("itemsView","summary");
        if(cursor!=null)params.put("cursor",cursor);
        JSONObject record=readAdoptedProjection("thread/turns/list",params,fresh,traceId,expectedGeneration);
        JSONObject payload = record.optJSONObject("payload"), result = payload == null ? null : payload.optJSONObject("result");
        if (!scope.equals(record.optString("scope")) || !threadId.equals(record.optString("threadId"))
                || record.optBoolean("deleted") || result == null || result.optJSONArray("data") == null) throw new IOException("turn scope mismatch");
        return record;
    }

    private void scheduleArchive(String threadId) {
        try {
            if(store.isUnstartedHistory(scope,threadId))return;
            JSONObject catalog=store.catalogRecord(scope,threadId),payload=catalog==null?null:catalog.optJSONObject("payload"),thread=payload==null?null:payload.optJSONObject("nativeThread");
            if(thread==null||CompletionNotificationPolicy.isInternalDirectoryThread(thread))return;
            String desired=store.archiveBodyVersion(scope,threadId);
            if(desired.isEmpty()){if(thread.optLong("updatedAt")<=0)return;store.requestPreparation(scope,"history",threadId,"",PREFETCH_HISTORY_PRIORITY,true,store.historyPreparationVersion(scope,threadId));return;}
            if(store.archivePrepared(scope,threadId,desired))return;
            store.requestPreparation(scope,"archive",threadId,"",4,true,desired);
        }catch(Exception ignored){ }
    }

    /** Bounded resumable, read-only archival; no timer or second command queue. */
    private boolean archiveHistoryBatch(String threadId,String traceId,String desired) throws IOException,JSONException {
        String source=store.catalogCursor(scope).generation;
        JSONObject head=readAdoptedProjection("thread/read",new JSONObject().put("threadId",threadId).put("includeTurns",false),false,traceId,source);
        JSONObject thread=head.getJSONObject("payload").getJSONObject("result").getJSONObject("thread");
        if (CompletionNotificationPolicy.isInternalDirectoryThread(thread)) return true;
        if("active".equals(thread.optJSONObject("status")==null?"":thread.getJSONObject("status").optString("type")))return false;
        String generation=head.getString("generation");JSONObject progress=store.archiveProgress(scope,threadId);
        if(desired.startsWith("body-v1:")&&store.archiveProgressMatchesBody(scope,threadId,progress,desired)){if(!progress.has("bodyVersion"))progress.put("legacyPagesVerified",true);progress.put("bodyVersion",desired).put("desired",desired);store.saveArchiveProgress(scope,threadId,progress);}
        if(desired.startsWith("body-v1:")&&store.archivePrepared(scope,threadId,desired))return true;
        if(!source.equals(progress.optString("sourceGeneration"))||!generation.equals(progress.optString("generation"))||!desired.equals(progress.optString("desired")))
            progress=new JSONObject().put("sourceGeneration",source).put("generation",generation).put("desired",desired).put("complete",false);
        if(desired.startsWith("body-v1:"))progress.put("bodyVersion",desired);
        if(progress.optBoolean("complete"))return true;
        for(int budget=0;budget<2&&!stopped;budget++){
            JSONArray turns=progress.optJSONArray("turns");int index=progress.optInt("turnIndex");
            if(turns==null){
                String cursor=progress.has("turnCursor")?progress.optString("turnCursor",null):null;
                JSONObject record=readTurnPage(threadId,false,traceId,source,20,cursor);
                if(!generation.equals(record.getString("generation")))throw new StaleReadException();
                JSONObject result=record.getJSONObject("payload").getJSONObject("result");
                String next=archivePageCursor(result);
                turns=result.getJSONArray("data");progress.put("turns",turns).put("turnIndex",0).put("nextTurnCursor",next==null?JSONObject.NULL:next);
            }else if(index<turns.length()){
                JSONObject turn=turns.getJSONObject(index);
                if(!"completed".equals(turn.optString("status"))&& !"interrupted".equals(turn.optString("status"))&& !"failed".equals(turn.optString("status")))return false;
                if("legacy".equals(thread.optString("historyMode"))){
                    // Legacy history has no item paging; request each full turn
                    // page instead of treating a final summary as a full body.
                    JSONObject params=new JSONObject().put("threadId",threadId).put("limit",20).put("sortDirection","desc").put("itemsView","full");
                    if(progress.has("turnCursor"))params.put("cursor",progress.getString("turnCursor"));
                    JSONObject full=readAdoptedProjection("thread/turns/list",params,false,traceId,source);
                    if(!generation.equals(full.getString("generation")))throw new StaleReadException();
                    progress.put("turnIndex",turns.length());
                }else{
                    JSONObject params=new JSONObject().put("threadId",threadId).put("turnId",turn.getString("id")).put("limit",12).put("sortDirection","desc");
                    if(progress.has("itemCursor"))params.put("cursor",progress.getString("itemCursor"));
                    JSONObject record=progress.optBoolean("legacyPagesVerified")?store.legacyArchivePage(scope,threadId,turn.getString("id"),params.optString("cursor",null),source,generation):null;
                    if(record==null)record=readAdoptedProjection("thread/items/list",params,false,traceId,source);
                    if(!generation.equals(record.getString("generation")))throw new StaleReadException();
                    String next=archivePageCursor(record.getJSONObject("payload").getJSONObject("result"));
                    if(next!=null&&!next.isEmpty()){if(next.equals(params.optString("cursor")))throw new IOException("archive item cursor did not advance");progress.put("itemCursor",next);}
                    else{progress.remove("itemCursor");progress.put("turnIndex",index+1);}
                }
            }else{
                String next=archivePageCursor(new JSONObject().put("nextCursor",progress.opt("nextTurnCursor")));
                if(next==null||next.isEmpty()){progress.remove("turns");progress.put("complete",true);store.saveArchiveProgress(scope,threadId,progress);return true;}
                if(next.equals(progress.optString("turnCursor")))throw new IOException("archive turn cursor did not advance");
                progress.put("turnCursor",next);progress.remove("turns");progress.remove("turnIndex");progress.remove("nextTurnCursor");
            }
            store.saveArchiveProgress(scope,threadId,progress);
        }
        return false;
    }

    private static String archivePageCursor(JSONObject page) throws IOException {
        if(!page.has("nextCursor"))throw new IOException("archive page has no EOF receipt");
        if(page.isNull("nextCursor"))return null;
        Object cursor=page.opt("nextCursor");
        if(!(cursor instanceof String)||((String)cursor).isEmpty()||((String)cursor).length()>64*1024)throw new IOException("invalid archive cursor");
        return (String)cursor;
    }

    private JSONObject readAdoptedProjection(String method, JSONObject params, boolean fresh,
                                             String traceId, String expectedGeneration) throws IOException, JSONException {
        String threadId=params.getString("threadId");
        for(int validation=0;validation<2;validation++) {
            long bodyFence=store.historyBodyFence(scope,threadId);
            JSONObject record=postJson(DshConfig.nativeReadUrl(scope),new JSONObject().put("method",method)
                    .put("params",params).put("fresh",fresh||validation>0),traceId);
            JSONObject payload=record.optJSONObject("payload"),result=payload==null?null:payload.optJSONObject("result");
            JSONObject thread=result==null?null:result.optJSONObject("thread");
            boolean validShape="thread/read".equals(method)?thread!=null&&threadId.equals(thread.optString("id"))
                    :result!=null&&result.optJSONArray("data")!=null;
            if(!scope.equals(record.optString("scope"))||!threadId.equals(record.optString("threadId"))
                    ||record.optBoolean("deleted")||!validShape)throw new IOException("projection scope mismatch");
            if(!store.applyReadRecord(record,traceId,expectedGeneration))throw new StaleReadException();
            if(fresh||validation>0)store.noteVerifiedBodySummaryRead(record,bodyFence);
            if(store.currentReadIdentities(java.util.Collections.singletonList(readIdentity(record))))return record;
            // A cached head can lag a source read already adopted by this
            // phone. Validate it once at Native instead of selecting the same
            // obsolete cloud value on every catalog refresh. Fresh conflicts
            // and generation changes remain rejected; no stale row is adopted.
            String source=record.optString("source");
            if(fresh||validation>0||!("cloud-cache".equals(source)||"mac-cache".equals(source)))throw new StaleReadException();
        }
        throw new StaleReadException();
    }

    private boolean cacheCompletion(String threadId, String turnId, boolean fresh, String traceId,
                                     String expectedGeneration) throws StaleReadException {
        return prepareCompletion(threadId,turnId,fresh,traceId,expectedGeneration)==CompletionRead.READY;
    }

    private CompletionRead prepareCompletion(String threadId, String turnId, boolean fresh, String traceId,
                                             String expectedGeneration) throws StaleReadException {
        try {
            long observedChange=completionReadChange(threadId);
            String streamVersion=store.streamReadVersion(scope,threadId);
            JSONObject stream=store.readStream(scope,threadId),catalog=store.catalogRecord(scope,threadId);
            if(stream.optBoolean("available")&&!stream.optBoolean("gap")&&expectedGeneration.equals(stream.optString("sourceGeneration"))
                    &&catalog!=null&&expectedGeneration.equals(catalog.optString("generation"))) {
                JSONArray turns=stream.optJSONArray("turns");
                for(int i=0;turns!=null&&i<turns.length();i++) {
                    JSONObject turn=turns.optJSONObject(i);
                    if(turn!=null&&turnId.equals(turn.optString("id"))&&"completed".equals(turn.optString("status"))&&hasFinalAnswer(turn.optJSONArray("items"))) {
                        if(!completionReadUnchanged(threadId,observedChange,streamVersion))return CompletionRead.PENDING;
                        scheduleArtifacts(threadId,turnId,turn.getJSONArray("items"),expectedGeneration);
                        JSONObject proof=newFields(traceId,connectionId,threadId,turnId);proof.put("cacheReady",true).put("localStored",true).put("streamCursor",stream.optLong("seq"));
                        diagnostic("committed","body_ready",proof);return CompletionRead.READY;
                    }
                }
            }
            TurnProjection projection = readTurnProjection(threadId, fresh, traceId, expectedGeneration);
            JSONObject record = projection.record;
            Set<String> cursors=new HashSet<>();
            for(int page=0;page<64;page++) {
                if(!fresh||!freshRecord(record)||!store.currentReadIdentities(java.util.Collections.singletonList(readIdentity(record))))return CompletionRead.PENDING;
                JSONObject result=record.getJSONObject("payload").getJSONObject("result");JSONArray turns=result.getJSONArray("data");
                for (int index = 0; index < turns.length(); index++) {
                    JSONObject turn = turns.optJSONObject(index);
                    if (turn == null || !turnId.equals(turn.optString("id"))) continue;
                    String status=turn.optString("status");
                    if("interrupted".equals(status)||"failed".equals(status)||"cancelled".equals(status)) {
                        return authoritativeRecord(record)&&completionReadUnchanged(threadId,projection.readChange,projection.streamVersion)?CompletionRead.TERMINATED:CompletionRead.PENDING;
                    }
                    if(!"completed".equals(status))return CompletionRead.PENDING;
                    if(hasEmbeddedBody(turn)) {
                        if(!completionReadUnchanged(threadId,projection.readChange,projection.streamVersion))return CompletionRead.PENDING;
                        scheduleArtifacts(threadId,turnId,turn.getJSONArray("items"),expectedGeneration);return CompletionRead.READY;
                    }
                    if(confirmedWithoutFinal(threadId,turn,record))return CompletionRead.NO_FINAL;
                    if(!projection.itemPagingSupported||"full".equals(turn.optString("itemsView")))return CompletionRead.PENDING;
                    CompletionBody body=readTurnItems(threadId,turnId,fresh,traceId,expectedGeneration);
                    if(body.state==CompletionRead.NO_FINAL&&!rememberWithoutFinal(threadId,turn,record,projection.readChange,projection.streamVersion,body.identities))return CompletionRead.PENDING;
                    if(body.state==CompletionRead.READY&&(!completionReadUnchanged(threadId,projection.readChange,projection.streamVersion)
                            ||!store.currentReadIdentities(java.util.Collections.singletonList(readIdentity(record)))))return CompletionRead.PENDING;
                    return body.state;
                }
                String cursor=result.optString("nextCursor","");
                if(cursor.isEmpty()||!cursors.add(cursor))return CompletionRead.PENDING;
                record=readTurnPage(threadId,fresh,traceId,expectedGeneration,projection.itemPagingSupported?20:2,cursor);
            }
            return CompletionRead.PENDING;
        } catch (InternalDirectoryThreadException skipped) { return CompletionRead.NO_FINAL;
        } catch (StaleReadException rejection) { throw rejection;
        } catch (AuthException unavailable) { requireAuthentication(); return CompletionRead.PENDING;
        } catch (Exception unavailable) { return CompletionRead.PENDING; }
    }

    /** Read exact turn pages; exhausted fresh pages can also prove there is no final. */
    private CompletionBody readTurnItems(String threadId,String turnId,boolean fresh,@Nullable String parentTraceId,
                                         @Nullable String expectedGeneration) throws StaleReadException {
        java.util.List<JSONObject> identities=new java.util.ArrayList<>();
        CompletionBody pending=new CompletionBody(CompletionRead.PENDING,identities);
        if (threadId == null || threadId.isEmpty() || turnId == null || turnId.isEmpty()) return pending;
        String traceId = UUID.randomUUID().toString();
        long startedAt = SystemClock.elapsedRealtime();
        JSONObject attempt = newFields(traceId, connectionId, threadId, turnId, parentTraceId);
        try { attempt.put("count", 1); } catch (JSONException ignored) {}
        diagnostic("attempt", "body_ready", attempt);
        try {
            Set<String> cursors=new HashSet<>();String cursor=null;
            for(int page=0;page<64;page++) {
            JSONObject params = new JSONObject();
            params.put("threadId", threadId);
            params.put("turnId", turnId);
            params.put("limit", 48);
            params.put("sortDirection", "desc");
            if(cursor!=null)params.put("cursor",cursor);
            JSONObject record = postJson(DshConfig.nativeReadUrl(scope), new JSONObject()
                    .put("method", "thread/items/list").put("params", params).put("fresh", fresh), parentTraceId);
            JSONObject payload = record.optJSONObject("payload");
            JSONObject result = payload == null ? null : payload.optJSONObject("result");
            JSONArray items = result == null ? null : result.optJSONArray("data");
            JSONObject received = newFields(traceId, connectionId, threadId, turnId, parentTraceId);
            try {
                received.put("statusCode", Math.max(0, lastHttpStatusCode.get()));
                received.put("count", items == null ? 0 : items.length());
            } catch (JSONException ignored) {}
            diagnostic("received", "body_ready", received);
            if (!scope.equals(record.optString("scope", ""))
                    || !threadId.equals(record.optString("threadId", ""))
                    || record.optBoolean("deleted") || result == null || items == null
                    || payload.optJSONObject("params") == null
                    || !threadId.equals(payload.optJSONObject("params").optString("threadId"))
                    || !turnId.equals(payload.optJSONObject("params").optString("turnId"))) {
                throw new IOException("body scope mismatch");
            }
            // Keep the batch identity on the durable store transition while
            // the HTTP child carries its own traceId plus parentTraceId.
            if (!store.applyReadRecord(record,
                    NativeDiagnostics.isUuid(parentTraceId) ? parentTraceId : traceId,
                    expectedGeneration)) {
                throw new StaleReadException();
            }
            identities.add(readIdentity(record));
            if(!store.currentReadIdentities(identities))return pending;
            boolean ready = hasFinalAnswer(items) && !record.optBoolean("stale", false)
                    && !"cloud-cache".equals(record.optString("source"));
            JSONObject committed = newFields(traceId, connectionId, threadId, turnId, parentTraceId);
            try {
                committed.put("durationMs", elapsed(startedAt));
                committed.put("count", items.length());
                committed.put("cacheReady", ready);
                committed.put("textAvailable",items.length()>0);
                committed.put("fresh",!record.optBoolean("stale",false));
            } catch (JSONException ignored) {}
            if(ready)scheduleArtifacts(threadId,turnId,items,expectedGeneration);
            diagnostic("committed", ready ? "body_ready" : items.length()>0 ? "body_partial" : "body_unavailable", committed);
            if(ready)return new CompletionBody(CompletionRead.READY,identities);
            if(!fresh||!authoritativeRecord(record))return pending;
            // Missing cursor metadata is not evidence that the whole turn was read.
            if(result.has("nextCursor")&&result.isNull("nextCursor"))return new CompletionBody(CompletionRead.NO_FINAL,identities);
            cursor=result.optString("nextCursor","");
            if(cursor.isEmpty()||!cursors.add(cursor))return pending;
            }
            return pending;
        } catch (StaleReadException rejection) {
            throw rejection;
        } catch (AuthException failure) {
            requireAuthentication();
            diagnostic("failed", "auth_required", newFields(traceId, connectionId, threadId, turnId, parentTraceId));
            return pending;
        } catch (Exception failure) {
            JSONObject failed = newFields(traceId, connectionId, threadId, turnId, parentTraceId);
            try {
                failed.put("durationMs", elapsed(startedAt));
                failed.put("statusCode", Math.max(0, lastHttpStatusCode.get()));
                failed.put("cacheReady", false);
                failed.put("failureClass", "record too large".equals(failure.getMessage()) ? "storage"
                        : failureClass(failure, lastHttpStatusCode.get(), stopped));
            } catch (JSONException ignored) {}
            diagnostic("failed", "body_unavailable", failed);
            return pending;
        }
    }

    private void processTurn(JSONObject turn, String threadId, boolean fresh, boolean baseline, boolean bodyReady) {
        if (stopped) return;
        String turnId = turn.optString("id", "");
        String status = turn.optString("status", "");
        if (threadId == null || threadId.isEmpty() || turnId.isEmpty() || status.isEmpty()) return;
        if ("completed".equals(status) && fresh && !baseline) {
            JSONObject record = store.catalogRecord(scope, threadId);
            JSONObject payload = record == null ? null : record.optJSONObject("payload");
            JSONObject thread = payload == null ? null : payload.optJSONObject("nativeThread");
            // Leave dedupe untouched until the existing catalog/change refresh can classify it.
            if (thread == null || !threadId.equals(thread.optString("id", ""))) return;
        }
        boolean notify = store.observeTurn(scope, threadId, turnId, status, fresh, baseline, System.currentTimeMillis());
        if (notify && CompletionPushPolicy.allows(context, scope, threadId,
                () -> getJson(DshConfig.ORIGIN + "/sync/v1/w/" + scope + "/push-thread-policy?threadId=" + DshConfig.encodeQuery(threadId)))) {
            listener.onCompletion(scope, threadId, turnId, bodyReady);
        }
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
        return getJson(url, null);
    }

    private JSONObject getJson(String url, @Nullable String parentTraceId) throws IOException, JSONException {
        long startedAt = SystemClock.elapsedRealtime();
        String traceId = UUID.randomUUID().toString();
        String routeClass = routeClassFor(url);
        JSONObject attempt = httpFields(traceId, routeClass, "GET", parentTraceId);
        diagnostic("attempt", "request_start", attempt);
        Request.Builder request = new Request.Builder().url(url).get().header("Origin", DshConfig.ORIGIN)
                .header("X-DSH-Diagnostic-Trace", traceId);
        addCookie(request, DshConfig.ORIGIN);
        int statusCode = 0;
        long cancelGeneration = requestCancelGeneration.get();
        lastHttpStatusCode.set(0);
        try (Response response = http.newCall(request.build()).execute()) {
            if (stopped) throw new IOException("sync stopped");
            statusCode = response.code();
            lastHttpStatusCode.set(statusCode);
            httpProgress("dispatch", "request_received", traceId, routeClass, "GET", parentTraceId, startedAt, statusCode);
            if (response.code() == 401 || response.code() == 303 || response.code() == 302) throw new AuthException();
            if(response.code()==409&&"native_catalog".equals(routeClass)&&response.body()!=null){
                String raw=response.peekBody(65537).string();if(raw.getBytes(StandardCharsets.UTF_8).length<=65536)try{JSONObject error=new JSONObject(raw);if("catalogue_session_changed".equals(error.optString("code"))&&"catalog_session_offset_mismatch".equals(error.optString("failureClass"))&&scope.equals(error.optString("scope")))throw new CatalogSessionChangedException();}catch(JSONException invalid){/* Unknown409 remains a genuine HTTP error. */}
            }
            if (!response.isSuccessful() || response.body() == null) throw new IOException("http " + response.code());
            return readJsonBody(response, traceId, routeClass, "GET", parentTraceId, startedAt);
        } catch (AuthException failure) {
            JSONObject failed = httpFields(traceId, routeClass, "GET", parentTraceId);
            try { failed.put("statusCode", Math.max(0, statusCode)); failed.put("durationMs", elapsed(startedAt)); } catch (JSONException ignored) {}
            putFailureClass(failed, "auth");
            diagnostic("failed", "auth_required", failed);
            throw failure;
        } catch (IOException | JSONException failure) {
            JSONObject failed = httpFields(traceId, routeClass, "GET", parentTraceId);
            try { failed.put("statusCode", Math.max(0, statusCode)); failed.put("durationMs", elapsed(startedAt)); } catch (JSONException ignored) {}
            putFailureClass(failed, failureClass(failure, statusCode,
                    stopped || cancelGeneration != requestCancelGeneration.get()));
            diagnostic("failed", "request_failed", failed);
            throw failure;
        }
    }

    private JSONObject postJson(String url, JSONObject body) throws IOException, JSONException {
        return postJson(url, body, null);
    }

    private JSONObject postJson(String url, JSONObject body, @Nullable String parentTraceId) throws IOException, JSONException {
        long startedAt = SystemClock.elapsedRealtime();
        String traceId = UUID.randomUUID().toString();
        String method = methodFor(body);
        String routeClass = routeClassFor(url);
        JSONObject attempt = httpFields(traceId, routeClass, method, parentTraceId);
        diagnostic("attempt", "request_start", attempt);
        Request.Builder request = new Request.Builder().url(url)
                .post(RequestBody.create(body.toString(), JSON))
                .header("Origin", DshConfig.ORIGIN)
                .header("X-DSH-Diagnostic-Trace", traceId);
        addCookie(request, DshConfig.ORIGIN);
        int statusCode = 0;
        long cancelGeneration = requestCancelGeneration.get();
        lastHttpStatusCode.set(0);
        try (Response response = http.newCall(request.build()).execute()) {
            if (stopped) throw new IOException("sync stopped");
            statusCode = response.code();
            lastHttpStatusCode.set(statusCode);
            httpProgress("dispatch", "request_received", traceId, routeClass, method, parentTraceId, startedAt, statusCode);
            if (response.code() == 401 || response.code() == 303 || response.code() == 302) throw new AuthException();
            if (!response.isSuccessful() || response.body() == null) throw new IOException("http " + response.code());
            return readJsonBody(response, traceId, routeClass, method, parentTraceId, startedAt);
        } catch (AuthException failure) {
            JSONObject failed = httpFields(traceId, routeClass, method, parentTraceId);
            try { failed.put("statusCode", Math.max(0, statusCode)); failed.put("durationMs", elapsed(startedAt)); } catch (JSONException ignored) {}
            putFailureClass(failed, "auth");
            diagnostic("failed", "auth_required", failed);
            throw failure;
        } catch (IOException | JSONException failure) {
            JSONObject failed = httpFields(traceId, routeClass, method, parentTraceId);
            try { failed.put("statusCode", Math.max(0, statusCode)); failed.put("durationMs", elapsed(startedAt)); } catch (JSONException ignored) {}
            putFailureClass(failed, failureClass(failure, statusCode,
                    stopped || cancelGeneration != requestCancelGeneration.get()));
            diagnostic("failed", "request_failed", failed);
            throw failure;
        }
    }

    /** Header, complete decompressed body, and JSON parse are distinct receipts.
     * All durations start before execute(); differences isolate the slow phase.
     * body_ready here means this HTTP body, never an AI reply/cache commit.
     * Do not copy/hash the body merely for telemetry, or change read timeouts. */
    private JSONObject readJsonBody(Response response, String traceId, String routeClass, String method,
                                   @Nullable String parentTraceId, long startedAt) throws IOException, JSONException {
        String raw = response.body().string();
        httpProgress("received", "body_ready", traceId, routeClass, method, parentTraceId, startedAt, response.code());
        JSONObject value = new JSONObject(raw);
        // Keep the old success receipt at its original post-parse boundary.
        httpProgress("received", "request_received", traceId, routeClass, method, parentTraceId, startedAt, response.code());
        return value;
    }

    private void httpProgress(String stage, String reason, String traceId, String routeClass, String method,
                              @Nullable String parentTraceId, long startedAt, int statusCode) {
        JSONObject fields = httpFields(traceId, routeClass, method, parentTraceId);
        try { fields.put("durationMs", elapsed(startedAt)); fields.put("statusCode", Math.max(0, statusCode)); }
        catch (JSONException ignored) {}
        diagnostic(stage, reason, fields);
    }

    private JSONObject httpFields(String traceId, String routeClass, String method) {
        return httpFields(traceId, routeClass, method, null);
    }

    private JSONObject httpFields(String traceId, String routeClass, String method,
                                  @Nullable String parentTraceId) {
        JSONObject fields = newFields(traceId, connectionId, null, null);
        try {
            // NativeDiagnostics applies the final allowlist. These two values
            // are fixed classifications and contain no URL or request body.
            fields.put("routeClass", routeClass);
            fields.put("method", method);
            if (NativeDiagnostics.isUuid(parentTraceId)) fields.put("parentTraceId", parentTraceId);
        } catch (JSONException ignored) {}
        return fields;
    }

    private static void putFailureClass(JSONObject fields, String failureClass) {
        try { fields.put("failureClass", failureClass); } catch (JSONException ignored) {}
    }

    private static String failureClass(Throwable failure, int statusCode, boolean aborted) {
        if (aborted || Thread.currentThread().isInterrupted()) return "aborted";
        if (statusCode >= 300) return "http";
        if (failure instanceof AuthException) return "auth";
        if (failure instanceof JSONException) return "parse";
        if (failure instanceof UnknownHostException) return "dns";
        if (failure instanceof SSLException) return "tls";
        if (failure instanceof SocketTimeoutException) return "timeout";
        if (failure instanceof ConnectException || failure instanceof NoRouteToHostException) return "connection";
        if (failure instanceof InterruptedIOException) return "timeout";
        return "unknown";
    }

    private static String methodFor(@Nullable JSONObject body) {
        String method = body == null ? "" : body.optString("method", "");
        if ("thread/turns/list".equals(method) || "thread/items/list".equals(method)) return method;
        return "unknown";
    }

    private static String routeClassFor(@Nullable String url) {
        if (url == null) return "other";
        if (url.contains("/native-bootstrap")) return "native_bootstrap";
        if (url.contains("/native-catalog")) return "native_catalog";
        if (url.contains("/native-read")) return "native_read";
        if (url.contains("/events")) return "cloud_events";
        return "other";
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

    private void emitState(String state, @Nullable String error) { emitState(state, error, false); }

    private void emitState(String state, @Nullable String error, boolean urgent) {
        if (stopped) return;
        synchronized (statePublishLock) {
            boolean changed = !state.equals(lastPublishedState) || nativeOnline != lastPublishedOnline
                    || socketConnected != lastPublishedTransport;
            if (urgent || error != null || changed) {
                ++statePublishEpoch;
                if (statePublishTask != null) statePublishTask.cancel(false);
                statePublishTask = null;
                publishState(state, error);
            } else if (statePublishTask == null) {
                long epoch = ++statePublishEpoch;
                try { statePublishTask = timers.schedule(() -> {
                    synchronized (statePublishLock) {
                        if (epoch != statePublishEpoch) return;
                        statePublishTask = null;
                        if (!stopped) publishState(state, null);
                    }
                }, appVisible ? 100L : 1_000L, TimeUnit.MILLISECONDS); }
                catch (RejectedExecutionException ignored) {}
            }
        }
    }

    private void publishState(String state, @Nullable String error) {
        if (stopped) return;
        // An older heartbeat/recovery publication cannot clear an outstanding
        // HTTP authentication rejection. Only a changed credential resumes it.
        if (authenticationRequired) { state = "auth_required"; error = "AUTH_REQUIRED"; }
        BackgroundSyncPolicy.Decision policy = energyPolicy();
        String previousMode = energyMode;
        updateHeartbeat(policy);
        if (!previousMode.equals(policy.mode)) {
            JSONObject modeFields = newFields(UUID.randomUUID().toString(), connectionId, null, null);
            try { modeFields.put("syncMode", policy.mode).put("catalogIntervalMs", policy.catalogIntervalMs)
                    .put("heartbeatMs", adaptiveHeartbeat && policy.idle() ? 120_000L : 15_000L)
                    .put("count", runningCount); } catch (JSONException ignored) {}
            diagnostic("committed", "sync_policy", modeFields);
        }
        lastPublishedState = state;
        lastPublishedOnline = nativeOnline;
        lastPublishedTransport = socketConnected;
        JSONObject value = store.getState(scope);
        try {
            value.put("syncMode", policy.mode);
            value.put("catalogIntervalMs", policy.catalogIntervalMs);
            value.put("syncWakeRequired", policy.keepAwake);
            value.put("runningSessionCount", runningCount);
            value.put("runningThreadId", runningThread);
            value.put("catalogComplete", catalogComplete);
            value.put("criticalPending", store.criticalPreparations(scope));
            value.put("adaptiveHeartbeat", adaptiveHeartbeat);
            value.put("state", state);
            value.put("online", !authenticationRequired && nativeOnline && socketConnected);
            value.put("hostOnline", nativeOnline);
            value.put("transportConnected", socketConnected);
            value.put("scope", scope);
            value.put("recordCursor", store.localRecordCursor(scope));
            value.put("streamCursor",store.getMeta(scope,"stream-cursor"));
            String generation = store.catalogCursor(scope).generation;
            value.put("generation", generation.isEmpty() ? "uninitialized" : generation);
            value.put("at", System.currentTimeMillis());
            value.put("connectedAt", connectedAt);
            value.put("lastSuccessfulSyncAt", lastSuccessfulSyncAt);
            value.put("preparation",store.preparationStatus(scope));
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
        requestCancelGeneration.incrementAndGet();
        socketConnected = false;
        if (periodicCatalog != null) periodicCatalog.cancel(true);
        WebSocket current = socket;
        socket = null;
        if (current != null) current.cancel();
        http.dispatcher().cancelAll();
        timers.shutdownNow();
        worker.shutdownNow();
        projectionWorker.shutdownNow();
        streamWorker.shutdownNow();
        synchronized (prefetchLock) {
            for (PrefetchTask task : prefetchByThread.values()) cancelQueuedPrefetchLocked(task);
            prefetchByThread.clear();
            directRefreshThreads.clear();
        }
        prefetchWorkers.shutdownNow();
        focusWorkers.shutdownNow();
        store.clearPreparationFocus(scope);
        http.dispatcher().executorService().shutdown();
        http.connectionPool().evictAll();
    }

    private static final class CatalogSessionChangedException extends IOException {CatalogSessionChangedException(){super("catalogue session changed");}}

    private static final class AuthException extends IOException {
        AuthException() { super("authentication required"); }
    }

    private static final class UnstartedHistoryException extends IOException {
        UnstartedHistoryException(){super("unchanged Native pre-user thread");}
    }

    private static final class StaleReadException extends IOException {
        StaleReadException() { super("read generation changed"); }
    }
    private static final class InternalDirectoryThreadException extends IOException {
        InternalDirectoryThreadException() { super("internal directory thread"); }
    }
}
