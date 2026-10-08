# Validation · v0.2.0-beta.8

Beta.8 starts the exact SDK codex-home metadata query alongside the current-attempt Native head and joins it at the original Vls/Hls node. Matching local identity/head and message ownership are required; active, queued, nonlocal and ineligible contexts retain the original query path. The original error precedence, worktree denial, authentication, sandbox, writer and Fast checks remain. The actual `jan` Fast checker is byte-identical to beta.7; rejected Fast-early experiments are excluded.

The actual Runtime invoke and hello-ack paths now report their outer WS/HTTP lane through the existing privacy logger. Only the existing method/id hashes, numeric/boolean and generation fields are recorded. This does not change dispatch, retry, queue, result/error behavior or record raw prompt, credentials or URLs. The existing public post-ACK queue adapter and privacy contract are retained.

The generated public UI has 194 resources and 443 required dependency edges, with unchanged budgets and optional routes demand-loaded. Actual generated-SDK verification passes309 checks with no skips, including Home10, Runtime/privacy7, current-attempt producer/config29 including late Fast rejection and startup/profile/reading gates24. Core passes234 with41 explicitly skipped actual-SDK-required cases when no SDK is supplied; host contracts13 and the full Go suite pass. Android release compilation is bound to this exact locally generated UI. Source SHA manifest binds319 files, with frozen source/fixture mappings.

The previous public beta.7 SDK and queue reproduce the missing early-home query assertion. A controlled comparison injects a1.4-second head delay and1.6-second original home query: old serial3000ms versus new overlap1600ms, one producer each. These are virtual injected delays through actual SDK callbacks, not natural phone latency or a claim that all slow sends are fixed.

Separately, the private maintenance owner verified UI-only normal Android Settings adoption,63 actual WebView checks, seven formal complete-resource SHAs and a194-resource closure. The first Settings attempt parsed the manifest but failed in the asset stage after45seconds; a second explicit ordinary update succeeded without pinning or clearing data. That failure is retained and the updater is not declared fully repaired. Fixed-conversation offline restart reached the metadata gate at5.814seconds and body/tool process/input were visible in the10-second screenshot; body updates continued after restoring the network. No real prompt or model turn was submitted. Native, Front, APK and PWA remained unchanged.

The natural9.732-second ACK with7.101seconds of preparation round trips belongs to the prior private UI, not this version. Runtime lane diagnostics support future attribution; the historical30-second case still lacks its hop logs. Physical-phone/OEM lifecycle, sustained power, natural send/upload latency, signed-in public clean installation and complete all-route offline behavior remain unverified. Private production OTA/coordinator/CLI release services, official renderer resources, production APKs/signatures and user data are not distributed. README product content remains unchanged.

Public entry verification passes43 actual HTTP/IPC/AppHost checks using an independently owned empty account/workspace, with no production Native connection or model turns. Prior results below are historical and are not silently promoted to beta.8 phone or universal performance acceptance.

# Previous beta.7 acceptance

Beta.7 synchronizes the Android Native-local startup gates and same-attempt submission configuration. Optional cloud identity loading cannot hold the local Native route at the loading screen; the local reading gate bypass applies only to loading at `/` or `/local/<UUID>`. Queries, authentication, login, settled denial/error and sandbox/writer checks remain intact. Startup diagnostics expose the gate and route stages without storing prompt or credential content.

A complete current-attempt cached configuration can be reused once only when its authenticated workspace, front epoch, Native generation, thread, cwd, request and head identity match. The portable producer already reads its fixed host-global Native configuration (without a cwd) and applies saved preference overrides; only that measured producer advertises `dsh-scope-global-config-v1`. Changed, missing or undeclared identities use the original read path. Projection metadata does not grant execution permissions.

The locally generated public UI has 194 declared resources and 443 checked required dependency edges; optional routes remain demand-loaded and the existing 600-file/100MiB limits remain unchanged. Actual generated-SDK verification passes 292 checks with no skips, including 29 cases through installed queue → SDK coordinator → submission callbacks → real public config producer, and 24 startup/profile/reading-gate cases. Core passes 234 checks and explicitly skips 24 actual-SDK-required cases when no SDK is supplied; a supplied invalid SDK fails. Host/config/authentication contracts pass 13 checks, the full Go suite passes, and Android release compilation succeeds while bound to that exact generated UI. The source manifest binds 315 files. Official renderer bytes remain local and are not distributed.

The private maintenance owner separately verified normal Android APK72 update adoption, complete deployed resource hashes, 47 actual Android WebView checks and the formal Web entry with conversation body, attachment thumbnail and focusable input. For one fixed historical conversation, an actual emulator offline cold start restored body, previously observed tool process and input around six seconds; metadata gate completion was observed at 5.946 seconds and the screenshot confirmed content at ten seconds. This scoped result is not a zero-delay, physical-phone, arbitrary-conversation or fully offline application guarantee. It is not substituted for the public adopter's own setup acceptance.

Natural phone sends of 2.1/2.5 seconds were observed on the previous UI, not beta.7, and cannot establish this version's phone latency. The older 30-second natural failure lacks the required stage log and remains unexplained. Physical-phone/OEM lifecycle, mobile upload latency, sustained power, signed-in model execution, clean-machine installation and complete all-route offline behavior remain unverified. Private deployment coordinators, production OTA services, official renderer binaries, signing keys and conversation data are outside the public installer.

The public independently owned empty-account host passes 43 checks through its actual HTTP/IPC/AppHost entry before release. No production Native process, business conversation, model turn or emulator is used for this release check. Earlier acceptance below is historical; it is not silently relabeled as beta.7 phone or startup evidence.

# Previous beta.6 acceptance

Beta.6 collects static ESM/CSS dependencies plus the specifically required literal work-mode-access-splash startup branch and its static access-splash dependency. The generator refuses a missing required dynamic/static target. Optional routes remain demand-loaded; this is not all-route/all-dynamic offline closure, and the 600-file/100MiB limits remain unchanged.

Four focused checks pass. The actual prior 192-file public bundle is rejected for its missing work-mode-access-splash target; the new declared bundle has 194 resources and 443 required edges. Only two small modules (1938 and 1806 bytes) are added, each with SHA/bytes equal to the locally acquired pinned source; initial and scope SDK bytes remain beta.5's values. Core has 231 passes and three SDK-required skips; actual generated-module checks239 pass with no skips.

The private maintenance owner reports canonical UI-only deployment983097bedb07daf1, normal app update adoption,13 formal resource hashes, unchanged APK72/SDK1167/cache code, and two local process turns totaling17 items still present after forced restart. In real 35-second offline comparisons, the old192 bundle produced a specific dynamic-import/ChatGPT error page; the new194 bundle produced no new instance of that import failure but still waited for connection and did not show a complete conversation. This demonstrates a missing startup-branch repair, not full offline first-screen or startup-speed acceptance. Connection waiting, physical-phone behavior and natural long-send latency remain unresolved.

Beta.5 previously fixed a real SDK argument contract: `getLoadedConversationHistoryTurns` accepts `conversation.turnHistory.history`, not the conversation object. The old cache reproduces `TypeError(flatMap)` with the actual SDK reader. The corrected public cache persists and restores observed process items across documents. An empty local-body adoption can retain a newer live metadata head; a live body, cancellation or stale normal snapshot still prevents replacement.

Public candidate acceptance separately records 16 no-SDK contract checks with three actual-SDK cases explicitly skipped, 19 direct checks against the locally acquired private SDK, and 239 checks against the exact public-generated initial/scope/import-map modules with no skips. Full core is 227 passed plus those three SDK-required skips. Providing a bad SDK path fails instead of silently using a contract fixture.

The private maintenance owner reports real Android APK72/UI ee166 execution with visible tool/image process items, two locally saved turns (7 and 10 items) retained after forced termination, 50 actual WebView checks and 11 formal resource checks. This demonstrates the SDK/persistence loop; it is not an offline startup acceptance. An eight-second offline cold open still waits for connection and is under investigation. Beta.5 does not claim complete offline cold-start, physical-phone, natural long-send or sustained power acceptance. Public resources are generated locally and are not redistributed.

Beta.4 previously added one server-cache migration correction. An existing committed `user-directory-source-v1` marker no longer suppresses the once-only retirement of newly recognized lowercase/serialized/parent-bound noninteractive child directory projections. The regression creates a real legacy SQLite schema with v1 present, child catalogs and original bodies, plus a real accepted command Journal. Beta.3 failed with the child catalog still visible; v2 passes while preserving original body/parent rows, source/thread generations, receipt/binding/ownership, and no new revision on the second cold reopen. No marker is cleared as a substitute for an upgrade test.

The v2 change affects the server read replica only. Android source/renderer bytes and their prior acceptance remain the beta.3 baseline; this patch does not rerun or claim new physical-phone, model or power acceptance. The public beta.2 implementation itself had no v1 marker; the corrected case is a legacy/intermediate cache where v1 has already been recorded.

The maintained beta.3 baseline was checked on an Apple Silicon Mac and an isolated Android 16/API 36 emulator (WebView 133). No production Native connection, real business thread, account credential or paid model request was used by the public test run.

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
