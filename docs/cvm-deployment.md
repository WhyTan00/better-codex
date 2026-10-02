# CVM deployment

Better Codex supports two access routes to the same Mac host: private Tailscale Serve, or an authenticated HTTPS domain on your CVM. Choose one access mode per installation. Both keep Native execution, approvals, account credentials and project plugins on your Mac.

The portable CVM profile is deliberately small:

```text
Phone/browser → Caddy HTTPS + login on CVM
              → loopback reverse SSH port → Mac entry
                                          → Native front / local sync relay / plugins
```

The CVM needs Caddy 2.8 or newer, SSH access, a domain pointing at it, and inbound HTTPS 443; allow HTTP 80 if using Caddy's HTTP certificate challenge. Your Mac initiates SSH, so it does not need a public inbound port. The Mac must remain awake and connected. Tunnel loss makes the site unavailable; it never creates a replacement Native writer.

## Prepare authentication

Install Caddy using its [official instructions](https://caddyserver.com/docs/install). On the CVM, generate a password hash interactively; the plaintext password is not a command argument or configuration value:

```sh
umask 077
caddy hash-password > better-codex.password.hash
```

On your Mac, after the normal Better Codex installation, stop its running host and copy the hash:

```sh
scp my-cvm:better-codex.password.hash "$HOME/.better-codex/cvm-password.hash"
"$HOME/.better-codex/better-codex" cvm \
  --url https://codex.example.com \
  --user owner \
  --ssh-host my-cvm \
  --password-hash-file "$HOME/.better-codex/cvm-password.hash"
```

Replace the domain, username and SSH alias with yours. `--remote-port 24173` changes the loopback port on the CVM if needed. Use an SSH alias with a key you already trust; the command does not disable host-key checking.

This command changes only your stopped Mac installation's access configuration. It creates a private `cvm-…` directory containing `Caddyfile`, `proxy.key`, `tunnel.sh` and instructions, and saves the previous deployment configuration. It prints their paths without printing credentials. It does not contact or modify the CVM, DNS, firewall or another Tailscale service. Keep the generated directory: the Mac reads its key on startup. Never commit or publish this bundle.

## Install the reviewed CVM site

Set `BUNDLE` to the printed private directory, then copy its Caddyfile:

```sh
BUNDLE="$HOME/.better-codex/cvm-REPLACE-WITH-PRINTED-ID"
scp "$BUNDLE/Caddyfile" my-cvm:better-codex.Caddyfile
```

On a dedicated CVM with no existing Caddy sites, install and validate it:

```sh
sudo install -o root -g caddy -m 640 better-codex.Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

If Caddy already serves other sites, merge only the generated domain block into the existing configuration, then validate and reload. Do not replace unrelated sites. Keep the file readable only by root and the Caddy service account. For a non-systemd installation, follow Caddy's service instructions for your OS.

Start the Mac host and, in a second terminal, its tunnel:

```sh
"$HOME/.better-codex/start"
# In another terminal:
"$BUNDLE/tunnel.sh"
```

The tunnel binds `127.0.0.1:24173` on the CVM by default. Check it with `ss -ltn` on the CVM before use. Keep SSH `GatewayPorts` disabled and allow remote forwarding for this account; do not expose the tunnel port through the firewall. SSH exits if it cannot obtain its requested forwarding port.

Open the printed HTTPS domain on the phone and sign in with the configured username and the password used to generate the hash. You can add the page to the home screen. [Caddy Basic Authentication](https://caddyserver.com/docs/caddyfile/directives/basic_auth) protects every resource and WebSocket handshake. Caddy replaces the proxy identity and proof headers; the Mac verifies both, allowed users, host and Origin before forwarding. The password and proxy proof are stripped before Native. Plugin capabilities use a separate header so they do not replace browser login credentials.

## Switching back and troubleshooting

Stop the host and tunnel before changing modes. Restore the printed `deployment.json.before-cvm-…` backup to `deployment.json`, or run `better-codex tailscale --enable` to select private Serve again. The CVM site can be disabled separately when no longer needed; the CLI does not remove shared infrastructure.

- `401` on the domain: check the username/password and generated Caddy block. The Mac rejects a missing/wrong proxy proof even if the request arrives over loopback.
- `502/503`: confirm the Mac host and tunnel terminals are running, the SSH account allows remote forwarding, and the CVM loopback port matches the generated file.
- TLS failure: check DNS, Caddy's certificate logs and ports 80/443. Do not disable browser certificate checks.
- Plugin authentication failure after an older UI was cached: reload to obtain the current portable plugin client; it uses `X-Better-Codex-Capability` rather than replacing HTTP Basic authentication.

The portable CVM profile stores its rebuildable sync cache on the Mac. A separately operated cloud cache/relay topology can use the exported gateway source, but is not installed by this command. This distinction does not change where Native owns execution.

## Validation boundary

The release includes local tests with a real Caddy process, certificate-verified HTTPS, authenticated WebSocket streams, plugin capabilities and failed-auth/origin cases. To repeat the isolated proxy tests with Caddy and OpenSSL installed:

```sh
node scripts/test-cvm-proxy.mjs
# Or set CADDY_BIN=/absolute/path/to/caddy
```

The tests use temporary loopback services and fixture credentials, and stop their own processes. They do not modify system trust or a cloud server. Real external DNS/certificate issuance, a sustained reverse SSH connection and physical phone/PWA login remain deployment-specific checks; local tests do not claim those have passed on your CVM.
