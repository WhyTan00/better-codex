# Maintained portable core

This is the allow-listed core used by the runnable Mac host, official web front, Go synchronization relay and Android source build. `export-manifest.json` identifies the exact maintained source bytes; it contains no provider binaries, accounts, official renderer files or deployment data.

Use the repository installer and `scripts/better-codex.mjs` for the host. The host requires your generated `WORKBENCH_CONFIG` and has no maintainer runtime fallback. [Android](../docs/android.md) uses a separate application ID and your explicit HTTPS origin and locally generated UI bundle. Official resources are acquired separately by the adopter and are not redistributed.

The local read store and Android archive persist data independently of UI documents. Foreground reads, history archiving and execution preparation have separate scheduling/transport paths. Repository tests exercise their real producers and consumers with synthetic records; a physical phone or signed-in model run is a separate acceptance layer.
