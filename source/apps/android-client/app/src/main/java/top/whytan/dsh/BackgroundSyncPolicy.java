package top.whytan.dsh;

/** Derived scheduling policy only. Native events/catalog remain execution authority. */
final class BackgroundSyncPolicy {
    static final long ACTIVE_MS = 30_000L;
    static final long IDLE_MS = 300_000L;
    static final long SETTLE_MS = 30_000L;
    static final long CATALOG_VALID_MS = 2 * IDLE_MS;

    static final class Decision {
        final String mode;
        final long catalogIntervalMs;
        final boolean keepAwake;
        Decision(String mode, long interval, boolean awake) {
            this.mode = mode; catalogIntervalMs = interval; keepAwake = awake;
        }
        boolean idle() { return "idle".equals(mode) || "foreground".equals(mode) && catalogIntervalMs >= 120_000L; }
    }

    static Decision decide(boolean visible, boolean online, boolean catalogComplete,
            long catalogAge, int running, int criticalPending, long quietFor, long hiddenFor) {
        if (visible) {
            if (online && catalogComplete && catalogAge >= 0 && catalogAge < CATALOG_VALID_MS
                    && running == 0 && criticalPending == 0 && quietFor >= SETTLE_MS)
                return new Decision("foreground", 120_000L, false);
            return new Decision("foreground", ACTIVE_MS, false);
        }
        if (!online) return new Decision("offline", 60_000L, false);
        if (running > 0 || quietFor < SETTLE_MS)
            return new Decision("active", ACTIVE_MS, true);
        if (criticalPending > 0)
            return new Decision("settling", ACTIVE_MS, quietFor < 180_000L);
        if (!catalogComplete || catalogAge < 0 || catalogAge > CATALOG_VALID_MS || hiddenFor < SETTLE_MS)
            return new Decision("checking", ACTIVE_MS, false);
        return new Decision("idle", IDLE_MS, false);
    }
}
