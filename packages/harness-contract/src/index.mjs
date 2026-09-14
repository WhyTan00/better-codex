/**
 * Provider-neutral shapes used by the Better Codex shell.
 *
 * These are runtime helpers rather than a provider SDK. A real adapter should
 * validate its own transport and map it into these bounded projections.
 */

export const CONNECTION_STATES = Object.freeze([
  "disconnected",
  "connecting",
  "connected",
  "reconnecting",
  "degraded",
]);

export const MESSAGE_STATES = Object.freeze([
  "local",
  "accepted",
  "confirmed",
  "failed",
]);

export function createCacheSnapshot({
  source = "mock",
  version = 0,
  observedAt = new Date().toISOString(),
  pinnedCount = 0,
  warmCount = 0,
  pendingCount = 0,
} = {}) {
  return Object.freeze({
    source,
    version,
    observedAt,
    pinnedCount,
    warmCount,
    pendingCount,
  });
}

export function isNewerVersion(next, current) {
  return Number(next ?? 0) > Number(current ?? 0);
}

export function assertConnectionState(value) {
  if (!CONNECTION_STATES.includes(value)) {
    throw new TypeError(`Unknown connection state: ${value}`);
  }
  return value;
}
