package top.whytan.dsh;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.LongSupplier;
import okhttp3.Dns;

/** Only the explicitly owned origins receive bounded, expiring address fallback. */
final class OriginDns implements Dns {
    interface Store { String read(String host); void write(String host, String value); }
    private static final long GOOD_MS = TimeUnit.DAYS.toMillis(7), CACHE_MS = 60_000;
    private final Set<String> hosts;
    private final List<InetAddress> bootstrap;
    private final long bootstrapUntil, budgetMs;
    private final Dns system;
    private final Store store;
    private final LongSupplier clock;
    private final ThreadPoolExecutor workers = new ThreadPoolExecutor(0, 2, 30, TimeUnit.SECONDS,
            new SynchronousQueue<>(), r -> { Thread t = new Thread(r, "dsh-origin-dns"); t.setDaemon(true); return t; });
    private final Map<String, Pending> pending = new HashMap<>();
    private final Map<String, Cached> cache = new HashMap<>();
    private long generation;
    private static final class Pending { final long generation, retryAfter; final Future<List<InetAddress>> future;
        Pending(long g, long until, Future<List<InetAddress>> f) { generation=g; retryAfter=until; future=f; } }
    private static final class Cached { final long generation, until; final List<InetAddress> addresses;
        Cached(long g,long u,List<InetAddress> a){generation=g;until=u;addresses=new ArrayList<>(a);} }
    OriginDns(Set<String> hosts, List<InetAddress> bootstrap, long until, Dns system, Store store, LongSupplier clock, long budgetMs) {
        this.hosts=new HashSet<>(hosts);this.bootstrap=new ArrayList<>(bootstrap);bootstrapUntil=until;
        this.system=system;this.store=store;this.clock=clock;this.budgetMs=budgetMs;
    }
    boolean owns(String host) { return hosts.contains(host); }
    synchronized void networkChanged() { generation++; cache.clear(); /* old lookups cannot populate a new network */ }
    @Override public List<InetAddress> lookup(String host) throws UnknownHostException {
        if (!owns(host)) return system.lookup(host);
        Pending task=null; long stamp; List<InetAddress> result=new ArrayList<>();
        // Approved fixed/last TLS-verified addresses are usable immediately.
        // DNS refresh is demand-triggered in the background, never ahead of sending.
        addFallback(host,result);
        synchronized(this) {
            stamp=generation; Cached hit=cache.get(host);
            if(hit!=null && hit.generation==stamp && hit.until>clock.getAsLong()) result.addAll(hit.addresses);
            else {
                task=pending.get(host);
                if(task==null || task.generation!=stamp || (task.future.isDone() && clock.getAsLong()>=task.retryAfter)) {
                    try { final long network=stamp;
                        task=new Pending(stamp,clock.getAsLong()+10_000,workers.submit(()->{
                            List<InetAddress> resolved=system.lookup(host);
                            synchronized(OriginDns.this){if(network==generation && resolved!=null && !resolved.isEmpty())
                                cache.put(host,new Cached(network,clock.getAsLong()+CACHE_MS,resolved));}
                            return resolved;
                        }));pending.put(host,task);
                    } catch(RejectedExecutionException busy) { task=null; }
                }
            }
        }
        if(result.isEmpty() && task!=null) try {
            List<InetAddress> resolved=task.future.get(budgetMs,TimeUnit.MILLISECONDS);
            synchronized(this) { if(stamp==generation && resolved!=null)result.addAll(resolved); }
        } catch(InterruptedException interrupted) { Thread.currentThread().interrupt();throw new UnknownHostException("Resolution cancelled"); }
          catch(ExecutionException|TimeoutException unavailable) { /* No application request has been sent. */ }
        if(result.isEmpty()) throw new UnknownHostException("Owned origin has no current address");
        return new ArrayList<>(new LinkedHashSet<>(result));
    }
    private void addFallback(String host,List<InetAddress> out) {
        String value=store.read(host); String[] parts=value==null?new String[0]:value.split("\\|",-1);
        if(parts.length==2) try {
            long at=Long.parseLong(parts[0]),now=clock.getAsLong();InetAddress address=ipv4(parts[1]);
            if(at<=now && now-at<GOOD_MS && isPublic(address))out.add(address);
        } catch(Exception ignored) {}
        if(clock.getAsLong()<bootstrapUntil)out.addAll(bootstrap);
    }
    // Called only after OkHttp has verified TLS and acquired the connection.
    synchronized void verified(String host,InetAddress address) {
        if(!owns(host)||address==null||!isPublic(address))return;
        long now=clock.getAsLong();String ip=address.getHostAddress(),old=store.read(host);
        if(old!=null){String[] parts=old.split("\\|",-1);if(parts.length==2&&parts[1].equals(ip))try{
            long at=Long.parseLong(parts[0]);if(at<=now&&now-at<TimeUnit.HOURS.toMillis(1))return;
        }catch(NumberFormatException ignored){}}
        store.write(host,now+"|"+ip);
    }
    static boolean isPublic(InetAddress address) {
        byte[] b=address.getAddress();if(b.length!=4)return false;
        int a=b[0]&255,c=b[1]&255;
        return !address.isAnyLocalAddress()&&!address.isLoopbackAddress()&&!address.isLinkLocalAddress()&&!address.isSiteLocalAddress()
                &&!address.isMulticastAddress()&&a!=0&&a<224&&!(a==100&&c>=64&&c<=127)&&!(a==198&&(c==18||c==19));
    }
    static InetAddress ipv4(String value) throws UnknownHostException {
        String[] parts=value.split("\\.",-1);if(parts.length!=4)throw new UnknownHostException("Invalid address");byte[] raw=new byte[4];
        try{for(int i=0;i<4;i++){if(!parts[i].matches("[0-9]{1,3}"))throw new NumberFormatException();int n=Integer.parseInt(parts[i]);if(n>255)throw new NumberFormatException();raw[i]=(byte)n;}}
        catch(NumberFormatException e){throw new UnknownHostException("Invalid address");}return InetAddress.getByAddress(raw);
    }
}
