# Validation · v0.2.0-beta.3

The maintained candidate was checked on an Apple Silicon Mac and an isolated Android 16/API 36 emulator (WebView 133). No production Native connection, real business thread, account credential or paid model request was used by the public test run.

- **Android source:** 224 Java tests, zero failures/errors, two pre-existing conditional skips. The origin-pinned release APK built successfully with a locally generated 192-file, hash-verified renderer bundle. Native-shaped fixture data is synthetic, including a body over 1 MiB, 28 items, nine-turn EOF history, and a view-only timestamp update; private conversation fixtures are not distributed.
- **Generated renderer:** 230 behavioral assertions run against the actual Android initial, primary, scope and import-map targets. They cover execution/history preparation, same-attempt configuration, post-ACK queue behavior, captured send destinations and late callback ownership, Fast restoration, full image handling and cached state.
- **Real Android WebView:** send, slow-read and reconnect scenarios passed with the exact generated transport/cache modules. Tests used an isolated TLS/protocol fixture, not a logged-in public APK or a real model. The lab app, server and owned emulator stopped afterward; existing private application data and emulator userdata were not cleared.
- **Portable core:** 220 behavior assertions cover cache/body witnesses, priority, persistent prewarm, source replacement, foreground control, loader and transport lifecycle, queue/attachment isolation, metadata collector parity, local-environment normalization, and child details excluded from lists/warming but available by scoped explicit ID. Thirteen host/config/plugin/authentication tests passed.
- **Go relay:** the full Go suite passed, including actual JavaScript producer output delivered to Go consumers while an ACK/body path is blocked, Native catalogue conflict classification and notification commit behavior.
- **Actual local entry:** a separate empty account home, empty workspace, independently owned Native daemon and official host passed 43 HTTP resource, directory, IPC, AppHost, plugin, reconnect and invalid-target checks. No `thread/start` or `turn/start` was sent to a real Native service. The supervisor and its exact child processes stopped afterward. This reused the installer’s previously verified dependency cache; it is not a new clean-machine download test.
- **Authenticated CVM shape:** real local Caddy passed nine HTTPS and TLS WebSocket checks, including anonymous/forged identity rejection, credential stripping, same-origin policy and plugin capability coexistence. The test changed no cloud service, DNS or system trust and stopped its services afterward.

The installed official desktop build `26.1002.52244/13536` had the same four unsupported optional optimization locators observed on `26.928.20755/12246`; all required checks passed. The portable readiness rule now recognizes only those exact version/build pairs and exact optional diagnostics. It keeps unknown builds, missing required hooks and additional failures closed.

Ten first-paint process checks verify that the newest two local observed turns are read before hydration, without network or other-conversation preload; rewrite/source retirement cannot borrow old process state.

Twenty-seven agent directory/detail checks cover cached child headers, single-ID Native metadata fallback, explicit scope rejection, and keeping child threads out of readPage, pins, bootstrap and warm sets.

The first-turn environment probe uses the actual Native reply shape: one `local` descriptor with the configured cwd and roots. The boundary converts it into the already permitted top-level parameters, retains the same request/receipt identity, and still rejects cross-workspace, remote, extra-field, conflicting-root and multi-environment requests. This probe is synthetic and does not launch a model turn.

## Reproduce

```sh
npm ci --prefix packages/host-cli --ignore-scripts --no-audit --no-fund
npm test
npm run test:core
(cd source/apps/sync-gateway && go test ./...)
```

After generating your own Android UI as described in [Android build](android.md):

```sh
node scripts/test-renderer.mjs \
  --ui "$HOME/.better-codex/android-ui" \
  --upstream http://127.0.0.1:4174
```

The renderer test verifies the supplied manifest and module bytes before running its probes. Official bytes remain in the adopter's local UI and temporary test directory; they are not part of this repository or release assets.

## Unverified

Physical-phone/OEM background lifecycle, real Tailscale device pairing, Android HTTP Basic credential handoff, real CVM DNS/certificate/tunnel deployment, Intel Mac startup, a signed-in model run, natural send latency, upload latency on mobile networks, and sustained battery/thermal behavior remain unverified. A local fixture, successful build or source snapshot does not replace these acceptance layers.

The private app’s latest list/new-conversation complaints are not an assertion that all product regressions are fixed. This release publishes the bounded tested changes and records the remaining validation limits. No production signing material, official renderer resource archive or raw private diagnostic log is published.
