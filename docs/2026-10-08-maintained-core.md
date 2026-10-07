# Maintained core release · v0.2.0-beta.3

This release carries the maintained Android/local-first and portable host changes. The public consumer is rebuilt from source; generated official application resources are not redistributed.

| Capability | Public consumer | Acceptance |
|---|---|---|
| Current conversation before pinned before recent 20; deep archives outside foreground work | `SyncClient`, `SyncStore`, `native-local-cache.js` | Actual workers, SQLite cold readers and queued priorities with synthetic producer records |
| Unchanged complete bodies avoid rearchiving after a view-only timestamp update | `SyncStore` body witnesses, archive EOF pages | Nine-turn complete archive, changed/missing pages, source replacement and cold reopen |
| Intermediate steps and prompt state remain scoped and persistent | `SyncStore`, `StreamProjection`, `android-native-adapter.js`, Android UI transforms | Actual store reopen and generated composer/late-callback probes |
| Execution preparation, history reads, queue acceptance and reconnect recovery stay independent | `official-boundary`, `official-scope-bootstrap`, `native-local-cache`, submission and post-ACK patches | Delayed-body/ACK and reconnect producer-consumer tests; real Android WebView |
| First accepted creation navigation and late send callbacks retain their captured destination | `official-send-target`, `android-ui-transform`, `native-navigation` | Generated renderer functions; actual Native-shaped local environment descriptor is normalized without remote or cross-workspace permission |
| Fast preference survives restoration | Model-setting patch and local thread read model | Generated renderer and persisted local snapshot tests |
| Image previews use protected full images; binary file batches retain their receipt | Image patches, preview navigation, `OfficialFiles` | Generated image loader and binary batch byte/ownership probes |
| Idle/background work backs off and completion state is reconciled | `BackgroundSyncPolicy`, `BackgroundConnection`, completion policies and scoped projection | Android policy/worker tests; physical-device battery impact remains unmeasured |
| Bounded metadata-only diagnostics attribute queue, HTTP headers, body, parsing and wire state | `SyncClient`, `NativeDiagnostics`, client/front/relay collectors | Shared safe-method parity, durable outbox and phase tests |
| Agent details remain readable without entering the main directory or warming set | `native-local-cache`, `native-read-cache`, scoped explicit-ID entries | 27 directory/by-ID/source and adjacent producer checks |
| Independent project plugins | Portable plugin loader, registry and example project plugin | Principal/workspace capability and asset-containment tests |
| Mac/Tailscale and optional authenticated CVM | Portable installer/entry and Go relay | Actual empty-account host entry and HTTP/IPC/AppHost; real local Caddy HTTPS/WS |

The Android package ID is `org.bettercodex.android`; its address is an explicit build-time HTTPS origin. This release provides source and build instructions, not a reusable public production APK. Official resource acquisition, account login and signing remain with the adopter. The Tailscale cache hint cookie is not an authentication credential; every network request still passes the entry's identity and origin checks.

The optional upstream optimization compatibility rule is limited to the observed official desktop version/build pairs `26.928.20755/12246` and `26.1002.52244/13536`, the same four named optional locators, and two exact unsupported diagnostics. Required Native, IPC, bundle and host checks remain mandatory; unknown builds and additional failures remain rejected.

A local test run does not establish physical-phone, OEM/VPN, natural model-send latency or long-duration battery acceptance. Recent private reports of list/new-conversation behavior are not a claim that every UI regression is solved by this public release. Exact current validation is in [portable-validation](portable-validation.md); [Android](android.md) explains the source build.
