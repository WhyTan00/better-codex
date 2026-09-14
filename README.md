# Better Codex

Better Codex is a community workbench pattern for people who want a faster
connection between documents, conversations, projects, and the tools that act
on them — while keeping the native Harness experience underneath.

It grew out of a real workbench built around three ideas:

1. **One execution owner.** Desktop, web, and mobile clients connect to the
   same native Harness/App Server instead of creating competing conversation
   owners.
2. **Local-first interaction.** The UI paints a confirmed local intent first,
   then reconciles it with the provider's event stream. Cached summaries make
   pinned and recently used conversations open immediately.
3. **A thin custom shell.** Workspaces, plugins, document links, cache status,
   queue controls, and notifications live around the native conversation
   renderer. The shell does not become a second conversation database.

The repository is a public reference implementation and demo. It is not an
official OpenAI product and does not ship a provider connector or credentials.

## What is here

- `packages/harness-contract` — provider-neutral contracts for a native
  Harness adapter, thread summaries, events, queue controls, and cache
  snapshots.
- `apps/demo` — a zero-login browser demo showing the workbench shell,
  local-first send, workspace switching, plugin cards, and cache health.
- `source/` — an allow-listed, sanitized source snapshot of the native web,
  sync, plugin, and Android integration layers. It is a reference tree: plug
  in your own Harness and deployment values before using it in production.
- `docs` — the architecture and product story extracted from the private
  workbench experience.
- `video` — a Remotion source project for the Better Codex explainer video.
- [`video/out/better-codex-explainer.mp4`](video/out/better-codex-explainer.mp4)
  — the rendered 32-second explainer.

## Run the demo

```bash
pnpm install
pnpm demo
```

Open <http://localhost:4173>. The demo uses an in-memory mock Harness. No
network request or account is required.

For a complete setup guide, including how to replace the mock Harness and add
a plugin, read [docs/open-source-setup.md](docs/open-source-setup.md).

## Render the explainer

The video uses deterministic React/Remotion scenes for all product facts,
labels, architecture, and UI. This keeps the technical story readable and
repeatable.

```bash
pnpm video:install
pnpm video:typecheck
pnpm video:render
```

The generated MP4 is written to `video/out/better-codex-explainer.mp4` and is
kept as the small release artifact in this repository.

## Public boundary

The private implementation contains real sessions, runtime state, credentials,
device release files, and protected service routes. Those are deliberately
not copied here. See [docs/public-boundary.md](docs/public-boundary.md) before
adding an adapter or a deployment example.

## License

MIT. See [LICENSE](LICENSE).
