# Better Codex

[中文](README.zh-CN.md) · [Installation](docs/open-source-setup.md) · [Plugins](docs/plugins.md)

Run your Codex workbench on your Mac. Open the same conversations from a browser or phone through private Tailscale Serve. No cloud server is required.

The Mac owns execution, approval and command receipts. The local relay carries live events and keeps rebuildable read caches. The web client uses the official conversation renderer, with workspace navigation and configurable project plugins.

## Start on a Mac

Install the official Codex desktop application and sign in. [Download the Mac installer source ZIP](https://github.com/WhyTan00/better-codex/releases/download/v0.2.0-beta.1/Better-Codex-v0.2.0-beta.1-mac.zip), unzip it to a stable location, and double-click `Install.command` to install and start. The first installation downloads dependencies and needs internet access.

Or use a terminal:

```sh
git clone https://github.com/WhyTan00/better-codex.git
cd better-codex
./install.sh --workspace "$HOME/Code"
"$HOME/.better-codex/start"
```

The installer prepares local dependencies and prints the URL. Open `http://127.0.0.1:4173/?workspace=ai`. Keep the host terminal open; Ctrl-C stops its children. Double-click `Install.command` to install and start using the defaults.

For a phone, install and sign in to Tailscale on both devices. Stop Better Codex, then:

```sh
"$HOME/.better-codex/better-codex" tailscale --enable
"$HOME/.better-codex/start"
```

Open the printed HTTPS `ts.net` URL on the phone and add it to the home screen. Serve remains private to your tailnet; an explicit login allowlist also protects the entry. Existing Serve routes are checked before changes. [Detailed setup, custom ports and troubleshooting](docs/open-source-setup.md).

## Configure your workspace

Your installation lives in `~/.better-codex`; `deployment.json` controls workspace roots, display names, enabled plugins, local ports and access. The included `project-overview` plugin reads directory names from the workspace you select. It does not include the maintainer's project integrations.

Plugins can provide a small document or an embedded local page. An adapter reads the project's own data and owns any revision checks or writes. [Create a plugin](docs/plugins.md).

## Scope of this release

This is a macOS portable-host beta. Apple Silicon is the tested host; Intel support is included but not device-verified. The mobile delivery is a PWA; this release does not install an Android APK. Physical phone acceptance and a live Tailscale Serve exercise are tracked separately from local protocol tests. See [release validation](docs/portable-validation.md).

The installer fetches pinned OpenCodex source and official renderer resources, verifies their checksums, and prepares them on your Mac. Official resources, accounts and credentials are not redistributed. This community project is not an official OpenAI product. Official desktop updates may require a compatibility update here.

## Develop

```sh
node --test packages/host-cli/test/*.test.mjs packages/harness-contract/test/*.test.mjs
(cd source/apps/sync-gateway && go test ./...)
python3 scripts/scan-public-tree.py .
"$HOME/.better-codex/better-codex" doctor
```

`source/` contains the maintained portable core, including the current resume-path and automatic-title fixes. `apps/demo`, `docs/media` and `video` remain illustrative material with synthetic data; they are not installation evidence. The earlier reference-only setup is superseded by the installation above.

## License

Better Codex's own code is [MIT](LICENSE). The separately built OpenCodex integration and modifications are [AGPL-3.0-only](integrations/opencodex/LICENSE); its source, exact revision and patches remain available. Official OpenAI resources retain their original terms. See [third-party notices](THIRD_PARTY_NOTICES.md).
