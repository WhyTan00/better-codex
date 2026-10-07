package top.whytan.dsh;

import android.content.Context;
import java.io.IOException;
import java.util.concurrent.TimeUnit;
import okhttp3.*;
import org.json.JSONObject;

/** Fixed, read-only control bootstrap; never queued behind WebView or history I/O. */
final class ScopeSessionClient implements AutoCloseable {
    interface Completion { void finish(JSONObject result, String failure); }
    interface Trace {
        void event(String stage, String reason, int status, long elapsed);
        default void failure(String reason, int status, long elapsed, String failureClass) { event("failed",reason,status,elapsed); }
    }
    private final OkHttpClient client;
    private final String origin;
    ScopeSessionClient(Context context) { this(DshNetwork.builder(context), DshConfig.ORIGIN); }
    ScopeSessionClient(OkHttpClient.Builder builder, String origin) {
        this.origin = origin;
        Dispatcher dispatcher = new Dispatcher();
        dispatcher.setMaxRequests(2); dispatcher.setMaxRequestsPerHost(2);
        client = builder.dispatcher(dispatcher).connectionPool(new ConnectionPool(1, 2, TimeUnit.MINUTES))
                .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
                .callTimeout(15, TimeUnit.SECONDS).connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(15, TimeUnit.SECONDS).build();
    }
    void read(String scope, String cookie, String traceId, Trace trace, Completion completion) {
        if (!DshConfig.isScope(scope)) { completion.finish(null, "SCOPE_MISMATCH"); return; }
        long started = System.nanoTime();
        Request.Builder request = new Request.Builder().url(origin + "/dsh-scope-session?workspace=" + scope)
                .header("Cache-Control", "no-store").header("X-DSH-Diagnostic-Trace", traceId);
        if (cookie != null && !cookie.isEmpty()) request.header("Cookie", cookie);
        trace.event("attempt", "request_start", 0, 0);
        client.newCall(request.build()).enqueue(new Callback() {
            long elapsed() { return TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-started); }
            @Override public void onFailure(Call call, IOException error) {
                trace.failure(call.isCanceled()?"cancelled":"request_failed", 0, elapsed(),call.isCanceled()?"aborted":failureClass(error));
                completion.finish(null, call.isCanceled()?"CONTROL_CANCELLED":"CONTROL_UNAVAILABLE");
            }
            @Override public void onResponse(Call call, Response response) {
                try (Response r = response) {
                    int status = r.code();
                    trace.event("received", "request_received", status, elapsed());
                    JSONObject result = new JSONObject().put("status", status);
                    if (status == 200) {
                        if (r.body() == null || r.body().contentLength() > 16384) throw new IOException("Invalid control response");
                        r.body().source().request(16385);
                        byte[] bytes = r.body().source().buffer().readByteArray();
                        if (bytes.length > 16384) throw new IOException("Control response too large");
                        JSONObject body = new JSONObject(new String(bytes, java.nio.charset.StandardCharsets.UTF_8));
                        String token = body.optString("token", "");
                        if (!scope.equals(body.optString("id")) || token.isEmpty() || token.length()>8192) throw new IOException("Invalid control identity");
                        result.put("data", new JSONObject().put("id",scope).put("token",token));
                    }
                    trace.event("committed", "body_ready", status, elapsed());
                    completion.finish(result, null);
                } catch (Exception failure) {
                    trace.failure("request_failed", response.code(), elapsed(),"parse");
                    completion.finish(null,"CONTROL_INVALID_RESPONSE");
                }
            }
        });
    }
    static String failureClass(IOException error) {
        if(error instanceof java.net.UnknownHostException)return "dns";
        if(error instanceof javax.net.ssl.SSLException)return "tls";
        if(error instanceof java.net.SocketTimeoutException||error instanceof java.io.InterruptedIOException)return "timeout";
        return "connection";
    }
    void cancel() { client.dispatcher().cancelAll(); }
    @Override public void close() { cancel();client.connectionPool().evictAll();client.dispatcher().executorService().shutdown(); }
}
