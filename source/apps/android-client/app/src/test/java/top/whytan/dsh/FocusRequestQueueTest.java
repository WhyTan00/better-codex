package top.whytan.dsh;
import org.junit.Test;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import static org.junit.Assert.*;

public class FocusRequestQueueTest {
    @Test public void blockedStorageDoesNotBlockTheSubmittingUiCaller()throws Exception {
        ExecutorService worker=Executors.newSingleThreadExecutor();CountDownLatch began=new CountDownLatch(1),release=new CountDownLatch(1),done=new CountDownLatch(1);
        try {FocusRequestQueue q=new FocusRequestQueue(worker);q.submit(()->{began.countDown();try{release.await();}catch(InterruptedException e){throw new RuntimeException(e);}return true;}, accepted->done.countDown(),error->fail());assertTrue(began.await(2,TimeUnit.SECONDS));assertEquals(1,done.getCount());release.countDown();assertTrue(done.await(2,TimeUnit.SECONDS));}finally{release.countDown();worker.shutdownNow();}
    }
    @Test public void onlyNewestQueuedSelectionCanPromoteStorage() {
        List<Runnable> tasks=new ArrayList<>();List<String> calls=new ArrayList<>();List<Boolean> receipts=new ArrayList<>();FocusRequestQueue q=new FocusRequestQueue(tasks::add);
        q.submit(()->{calls.add("A");return true;},receipts::add,e->fail());q.submit(()->{calls.add("B");return true;},receipts::add,e->fail());tasks.forEach(Runnable::run);
        assertEquals(Collections.singletonList("B"),calls);assertEquals(Arrays.asList(false,true),receipts);
    }
    @Test public void pageChangeAndCloseCancelPendingStorageAndExceptionsHaveAReceipt() {
        List<Runnable> tasks=new ArrayList<>();AtomicInteger calls=new AtomicInteger(),failures=new AtomicInteger();FocusRequestQueue q=new FocusRequestQueue(tasks::add);
        q.submit(()->{calls.incrementAndGet();return true;},v->{},e->fail());q.cancelPending();tasks.remove(0).run();assertEquals(0,calls.get());
        q.submit(()->{throw new IllegalStateException();},v->fail(),e->failures.incrementAndGet());tasks.remove(0).run();assertEquals(1,failures.get());
        q.submit(()->{calls.incrementAndGet();return true;},v->{},e->fail());q.close();tasks.remove(0).run();assertEquals(0,calls.get());
    }
}
