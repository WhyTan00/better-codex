package top.whytan.dsh;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import okhttp3.OkHttpClient;

/** TLS socket close can write a close-notify; lifecycle callbacks must not do it on main. */
final class NetworkClientClose {
    static void close(OkHttpClient client) { close(client, () -> {}); }
    static void close(OkHttpClient client, Runnable cancelOwnedTransport) {
        ExecutorService executor = client.dispatcher().executorService();
        try {
            executor.execute(() -> {
                try {
                    cancelOwnedTransport.run();
                    client.dispatcher().cancelAll();
                    client.connectionPool().evictAll();
                } finally { executor.shutdown(); }
            });
        } catch (RejectedExecutionException alreadyClosing) {
            // The first cleanup has already scheduled shutdown; never fall back to main I/O.
        }
    }
    private NetworkClientClose() {}
}
