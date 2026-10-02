# Portable release validation

Host: macOS Apple Silicon, Node 24.3.0, official desktop 26.928.20755 build 12246. The HTTP renderer is pinned to 26.901.51231 build 8109. OpenCodex source is pinned to 2.1.0. Tests use separate ports, state and an empty Native account directory.

- The real `install.sh` completes in a fresh installation directory using checksum-verified downloads; startup uses the generated launcher.
- With only macOS system tools in PATH, the installer also bootstraps its own Node and Go. Its generated command and launcher then pass the same 43 protocol checks and six running-installation checks without a global Node/npm/Go dependency. Source ZIP builds do not require Git metadata.
- `verify-portable.mjs` exercises the local entry, Native directory, complete initial resource list, PWA icon, configured plugins, live observer/relay link, actual HTTP/WS AppHost, reconnect identity and peer cleanup. It sends no model turn and modifies no conversation history.
- Node tests cover workspace roots, tailnet login and origin checks, scope/principal capabilities, read-only plugins, source revisions, symlink containment, existing Serve route protection, and exact compatibility diagnostics.
- The exported Go suite includes its real Node producer fixtures. Cache-unavailable, source-page delivery, live events and replay contracts run from the public tree.
- An update while the host is running is rejected and leaves the deployment unchanged. Stopping the supervisor closes only its owned children. The installed official application's code signature remains valid.

## CVM and client continuity follow-up

The complete portable host also passes 43 read-only protocol/resource checks through a real Caddy HTTPS proxy using isolated ports and an empty Native account directory. This covers actual Native directory access, AppHost, WebSocket reconnect, renderer resources, local relay and plugins; no model turn was sent. An initial full-host failure exposed a loopback-only front-origin guard; it now accepts exactly the validated portable deployment origin while retaining the private development guard.

The CVM profile generates a private Caddy configuration, a loopback reverse-SSH command and Mac proxy authentication settings. Tests cover rejected forged identities, same-origin enforcement, principal-scoped plugin capabilities and credential stripping. The real Caddy HTTPS integration test passes authenticated reads and WebSocket streams; it does not change system trust or a live cloud service.

The renderer patches also bind late send/create callbacks to their original conversation and prepare cached projects/pins before the first sidebar. Final private PWA/Android bundles passed the targeted old-failure and adjacent-success cases, including 14 actual Android WebView cases. This is function-level WebView evidence, not full logged-in phone UI acceptance. The portable source carries the same patches; its generated renderer also passes 14 focused send/cache/startup checks. Import maps now normalize every official resource prefix to one module identity. A real Android WebView fixture reproduced the previous duplicate-module initialization failure with frozen renderer bytes, then passed with the normalized map.

## Recorded compatibility limits

For official desktop 26.928.20755 build 12246, OpenCodex reports unsupported optional optimization locators for hidden macOS push registration, pet prewarm, pet restoration, and worktree-shell caching. The portable front implements its own required worktree metadata and notification interfaces, which are exercised by the protocol probe. Its readiness policy accepts only those exact points on that exact build, with the observed cold-start diagnostic `Expected 1 candidates but found 0` or cached-start diagnostic `Cached locator did not resolve`, while still requiring the Native connection, official IPC, bundle and all required host hooks. Missing required IPC, an unknown diagnostic or another degraded app build remains a startup failure. Upstream's degraded report is retained.

The generated development runner uses contained framework/helper copies and local ad-hoc signatures; official application files and OS settings are unchanged. ASAR validation remains enabled.

## Not yet verified

- Physical phone/PWA rendering and natural background/resume behavior.
- A real Tailscale Serve session between devices; identity and routing decisions have local contract coverage only.
- Real CVM DNS/certificate issuance, a sustained external reverse SSH tunnel and phone HTTP Basic login.
- Intel Mac startup.
- A signed-in model execution through the clean portable installation; the protocol test deliberately uses no account credentials or paid model request.

This is a beta release. Local protocol acceptance does not stand in for these device/account checks. Private deployment records and raw logs are not included in the public package.
