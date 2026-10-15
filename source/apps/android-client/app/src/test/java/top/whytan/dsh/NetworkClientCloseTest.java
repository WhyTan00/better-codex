package top.whytan.dsh;

import static org.junit.Assert.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import okhttp3.OkHttpClient;
import org.junit.Test;

public class NetworkClientCloseTest {
    @Test public void lifecycleCallerNeverRunsNetworkCleanupAndWorkerTerminates() throws Exception {
        OkHttpClient client = new OkHttpClient();
        Thread lifecycle = Thread.currentThread();
        AtomicReference<Thread> cleanup = new AtomicReference<>();
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        NetworkClientClose.close(client, () -> {
            cleanup.set(Thread.currentThread()); entered.countDown();
            try { release.await(2, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        });
        assertTrue(entered.await(2, TimeUnit.SECONDS));
        assertNotSame(lifecycle, cleanup.get());
        assertFalse(client.dispatcher().executorService().isShutdown());
        release.countDown();
        assertTrue(client.dispatcher().executorService().awaitTermination(3, TimeUnit.SECONDS));
        assertEquals(0, client.connectionPool().connectionCount());
        NetworkClientClose.close(client); // A duplicate lifecycle callback cannot fall back to main.
    }
}
