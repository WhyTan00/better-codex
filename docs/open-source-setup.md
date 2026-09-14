# Open-source setup

There are two ways to start. The demo is the only path that is intentionally
zero-configuration. The `source/` tree is a sanitized integration reference:
it shows the production call boundaries, but a real provider adapter, native
host, and deployment policy still belong to the person adopting it.

## 1. See the workbench immediately

This path needs only Python:

```bash
git clone https://github.com/TonyandWei/better-codex.git
cd better-codex
python3 -m http.server 4173 --directory apps/demo
```

Visit <http://localhost:4173>. The demo has synthetic conversations and a
mock Harness, so it is safe to run without an account.

The source snapshot uses `${BETTER_CODEX_*}` placeholders and generic host
package names. Review `source/README.md` before wiring it to a real client.

## 2. Connect a real Harness

Implement the adapter described in
`packages/harness-contract/src/index.mjs`. At minimum it should provide:

```js
{
  connect,
  listThreads,
  readThread,
  send,
  queue,
  stop,
  subscribe,
  getCacheSnapshot,
}
```

Keep the provider's authentication and transport inside the adapter. The
shell should receive bounded thread summaries, message pages, explicit event
versions, and connection state. It should never receive a provider token in a
rendered component.

## 3. Add a plugin

A plugin should declare:

- an id and display name;
- the workspace scopes it can read;
- the adapter methods it needs;
- whether it is read-only or can write project data;
- a route and a compact loading state.

Start with a read-only document plugin. Add writes only after defining a
revision or version check, so a cached projection cannot overwrite newer
source content.

## 4. Optional Android/PWA clients

The source snapshot includes the Android and PWA integration patterns, but the
provider endpoint, package signing, notification policy, and foreground
service behavior are deployment decisions. Replace the sanitized defaults with
your own values and review the operating-system rules for the version you
target. Do not copy a personal production endpoint into a public release.

## 5. Run the public checks

```bash
pnpm install
pnpm test
python3 scripts/scan-public-tree.py .
```

If you regenerate a source snapshot from a private workbench, use the
allow-listed scrubber first:

```bash
python3 scripts/prepare-public-source.py \
  --source /path/to/private-workbench \
  --destination source
python3 scripts/scan-public-tree.py source
```

Pass each private hostname, path, or product marker as a local-only
`--replacement OLD=NEW` argument when needed; the scrubber intentionally has
no workspace-specific names built into the public repository. The scrubber is
a convenience and an audit trail. Human review is still required before a
public push.
