package top.whytan.dsh;

import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/** Latest selection only; uses the bridge's existing storage worker. */
final class FocusRequestQueue {
    private final Executor worker;
    private final AtomicLong revision = new AtomicLong();
    private volatile boolean closed;
    FocusRequestQueue(Executor worker) { this.worker = worker; }
    void submit(BooleanSupplier work, Consumer<Boolean> receipt, Consumer<RuntimeException> failure) {
        long expected = revision.incrementAndGet();
        if (closed) { receipt.accept(false); return; }
        try {
            worker.execute(() -> {
                boolean accepted = false;
                try {
                    if (!closed && revision.get() == expected) accepted = work.getAsBoolean();
                } catch (RuntimeException error) { failure.accept(error); return; }
                receipt.accept(accepted);
            });
        } catch (RejectedExecutionException stopped) { receipt.accept(false); }
    }
    void cancelPending() { revision.incrementAndGet(); }
    void close() { closed = true; cancelPending(); }
}
