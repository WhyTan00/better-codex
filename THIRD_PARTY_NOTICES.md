# Third-party components

Better Codex's own source is MIT licensed, except where a file states otherwise.

The installer obtains [OpenCodex](https://github.com/RyensX/OpenCodex) 2.1.0 at the exact commit in `dependencies.lock.json`, under AGPL-3.0-only. The modifications in `integrations/opencodex/` use that license; its full license text is included there. They select a pinned HTTP renderer and prepare the generated Mac runner with valid integrity metadata and contained framework symlinks. The generated runner, framework and helper copies use local ad-hoc development signatures, preserve entitlements and ASAR validation, and omit publisher hardened-runtime flags that require a publisher Team ID. They do not modify the installed official application. The installed source and build instructions remain in the installation's dependency directory. Redistribution or network use of this modified component must retain its corresponding source and AGPL notices; MIT does not relicense it.

The relay uses Gorilla WebSocket (BSD-2-Clause) and modernc SQLite components; the Node front uses ws (MIT) and Cap'n Web (MIT). Exact dependency versions and integrity records are in the Go and npm lockfiles. The installer fetches Node and Go from their official distribution hosts; their bundled licenses remain in the local distributions.

The complete modified OpenCodex [corresponding source archive](https://github.com/WhyTan00/better-codex/releases/download/v0.2.0-beta.1/opencodex-2.1.0-better-codex-source.tar.gz) includes its source, license, dependency lockfile and build instructions. This offer also appears under **Settings → Open-source components** in the portable UI. `scripts/package-opencodex-source.py` reproduces the archive from the verified upstream tarball and installed modifications, without copying generated runtime data.

The official Codex desktop application, CLI and renderer are separate third-party resources under their original terms. They are not included in this repository or redistributed as Better Codex source. The installer verifies a fixed official archive before extracting renderer resources locally. The user supplies the installed desktop application and existing account.

Electron's integrity format is documented by [Electron](https://www.electronjs.org/docs/latest/tutorial/asar-integrity) and its [integrity digest implementation](https://github.com/electron/electron/blob/main/shell/common/asar/integrity_digest.mm). The integration retains validation for generated local runner resources.
