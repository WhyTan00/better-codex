# Portable Mac installation

The supported path is a Mac running the official Codex application, a local Better Codex host, and optionally private Tailscale Serve. A CVM, DNS change, reverse-proxy account, or public ingress is not needed.

## Install

Prerequisites: macOS, the official desktop application with an existing login, enough disk space for local dependencies, and internet access to the first-party download and package hosts. Setup can bootstrap Node and Go into its own directory. It does not install a launch agent or require sudo.

Run `./install.sh --workspace "$HOME/Code"`, followed by `"$HOME/.better-codex/start"`. The double-click `Install.command` performs both steps. Keep the repository at its installed location: the generated launcher refers to this checkout.

The generated `better-codex` command uses the installed Node runtime, so a global Node/npm installation is not required. For a custom installation home, use that directory's `better-codex` and `start` commands.

The default listeners are loopback-only: entry 4173, desktop IPC host 4174, Native app server 4175, official front 4176, and sync relay 4177. `--port 42800` selects a different consecutive set on first installation. `--home /absolute/path` selects a different installation; with the shell installer set `BETTER_CODEX_HOME=/absolute/path` instead. The workspace directory must exist or be creatable.

`--app /Applications/ChatGPT.app` selects the installed official app. `--native-url ws://127.0.0.1:PORT` attaches to an existing Native owner; that process is never stopped by Better Codex. Otherwise the host starts its own app server with the official CLI and your existing Codex home. Native owns account state and writer locking; Better Codex does not copy or modify authentication files. `--codex-home /absolute/path` is useful for an explicitly separate test account directory.

## Tailscale

Install Tailscale on the Mac and phone, sign both into your tailnet, and make its `tailscale` CLI available in PATH. Stop Better Codex before changing deployment access.

```sh
"$HOME/.better-codex/better-codex" tailscale --enable
"$HOME/.better-codex/start"
```

The command reads this Mac's Tailscale DNS name and login, checks existing Serve routes, writes a backup of deployment.json, and enables HTTPS Serve forwarding to the local entry. It never enables public Funnel. For an explicit allowlist use repeated `--user your-login@example.com`. `--tailscale-bin /absolute/path` selects a CLI. Without `--enable` it only prepares the deployment file and prints the Serve command.

The allowlist applies to the installation as a whole. Listed people must be trusted to operate its Codex account and allowed workspaces. Workspace scoping prevents accidental cross-workspace API access; it is not an OS sandbox or a separate tenant account. Plugins are trusted local code.

If Tailscale asks to enable HTTPS in the admin console, complete that setup and rerun the command. Conflicting Serve routes or an existing Funnel configuration are left untouched. The Mac must be awake and the foreground host running for remote execution.

## Configuration and updates

`~/.better-codex/deployment.json` is the only portable workspace/plugin registry. Stop the host, edit it, run `doctor`, and restart. Names are configurable. For compatibility the primary wire slot is `ai` and the optional secondary slot is `zyy`; these IDs do not select personal folders. Workspace roots cannot overlap. Set `readOnly: true` to block mutating workbench operations in a workspace.

Project bindings are optional children of a workspace root, for example `"projectBindings":[{"id":"website","name":"Website","root":"website"}]`. The project API derives its navigation from these bindings; project plugins remain the owners of content and writes.

To update, stop the host, update this checkout, then run `"$HOME/.better-codex/better-codex" update`. Setup preserves existing roots, plugins, access policy and Native ownership. It writes `deployment.before-*.json` before replacing a configuration. A setup retry retains incomplete dependency staging directories for inspection; it does not replace a running installation. Old dependency versions remain available for rollback. Restore a previous deployment file only while stopped and with the matching source revision checked out.

For a ZIP installation, keep a backup of the old source folder and place the new release's source at the same stable location before running `./install.sh` again. Keep your deployment and personal plugins outside the source folder. For a Git checkout, update the source with a normal fast-forward pull before running the update command.

`"$HOME/.better-codex/better-codex" doctor` validates config, local dependencies, pinned renderer files and plugins without sending a model turn. Local logs are under the installation's `state/` directory. Never post those logs, deployment files, downloads, sessions, or account directories publicly without reviewing their contents.

## Troubleshooting

- Port in use: keep the existing service; choose another base port on a separate first installation.
- `host.lock` exists: determine whether its recorded PID still owns the running installation. Setup refuses a live owner and preserves a dead lock under a timestamped name. Do not remove a lock belonging to a live process.
- Official app update breaks startup: keep the account and installed app intact; retain local logs and use a compatible Better Codex update. No global model, retry or routing settings are required.
- Renderer checksum differs: retain the changed cache for inspection. Fetch verified dependencies again into a separate installation; do not disable integrity checks.
- Phone cannot connect: confirm Tailscale identity, Serve status, allowed login, Mac wake state, and the foreground host. Local HTTP success alone does not prove tailnet or phone access.

The renderer pin and dependency hashes are in `dependencies.lock.json`. Official resources are downloaded from the original host and extracted locally; they are not included in this repository or its release archives.

## Development tests

Install only the test transport dependencies with `npm ci --prefix packages/host-cli --ignore-scripts`. Then run the Node tests and `go test ./...` from `source/apps/sync-gateway`. The Go-to-Node contract fixtures create an isolated temporary deployment and never connect to an account or start a model turn.

## CVM alternative

Use `better-codex cvm` instead of Tailscale Serve for an authenticated HTTPS domain and reverse SSH tunnel. Follow [CVM deployment](cvm-deployment.md); the generated private bundle is not published or installed remotely by the CLI.
