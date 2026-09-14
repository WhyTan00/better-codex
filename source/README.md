# Sanitized source snapshot

This directory is an allow-listed reference snapshot of the integration
layers behind Better Codex:

- `apps/native-codex-web` — the web-facing shell, cache, queue, and event
  reconciliation boundary;
- `apps/sync-gateway` — a small durable event and reconnect gateway;
- `apps/official-ui-bridge` — workspace-scoped native RPC forwarding;
- `apps/android-client` — credential-free UI cache and explicit sync controls;
- `plugins/native-harness` — the single execution-owner adapter boundary;
- `plugins/workbench-shell` and `plugins/shared` — shell and contract helpers.

The snapshot contains no provider credentials, private hostnames, user paths,
session exports, signing material, or production runtime state. Placeholder
roots such as `${BETTER_CODEX_WORKSPACE}` must be replaced by an adopter's
reviewed workspace registry. Host-specific native client packages are also
intentionally outside this repository.

Use `apps/demo` for the immediate zero-login experience. Treat this directory
as integration source: review every adapter, authentication check, provider
protocol, and deployment permission before connecting it to a real account.
