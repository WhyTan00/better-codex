# Product story

Better Codex gives native Codex a workbench shaped around your projects. The conversation interface remains familiar; execution, tools, approvals, account capabilities and history remain in the official Native Harness. The surrounding workbench connects project context, saved reading state and tools that belong to your workflow.

## The experience we are building

The project grew from remote work in China: a conversation was available on the Mac, but the phone could still spend time reconnecting or loading content it had already shown. Project tools lived elsewhere. Improving that daily experience means making saved work available first, reconciling new state without blocking the active task, and keeping project tools close to the conversation.

The current product presentation follows these points:

1. Open an important conversation from a pinned list and continue the same work.
2. Return to locally saved conversation content and observed progress, then receive current updates.
3. Use the official Codex account and Native Harness rather than a separate model service or execution loop.
4. Add your own plugins and workbenches for project-specific context and results.
5. Continue work between desktop and phone while preserving the same Native authority.

The author's private deployment experience includes better remote responsiveness and stability. This is scoped experience, not a controlled benchmark against official Remote or every other Harness. The public project does not promise a latency number, universal network advantage, unlimited account quota or stronger model intelligence than native Codex itself.

## How the public implementation supports the story

| Product point | Public implementation | Boundary |
| --- | --- | --- |
| Native execution with a familiar interface | Locally prepared official renderer, Native App Server and source-built IPC host | Official resources are acquired locally and retain their own terms. Account capabilities come from Codex. |
| Saved content before reconciliation | Client persistence, versioned read cache and observer/relay contracts | Saved reading state is not a command acknowledgment or a finished task. Browser quota and native-device storage differ. |
| Active work before bulk preparation | Foreground/control and history paths, scoped caches and priority handling | Paths still share machine and network resources; no universal timing guarantee. |
| Same conversation across devices | Mac host with Tailscale Serve or authenticated CVM entry | Mac must be available; access is trusted installation access, not multi-tenant hosting. |
| Your own project workbench | Configured adapters, document views and embedded local pages | Project data, permissions, revisions and writes remain owned by the source system. |
| Observable state | Connection/cache status and bounded diagnostics | Protocol and emulator evidence do not replace physical-device and natural-network acceptance. |

Agenda, travel, investment research and video production are examples of how projects can grow around a conversation. Those private systems are not shipped as ready-to-use public plugins. The included `project-overview` is a small configurable example.

## Presentation material and runtime evidence

The static [gallery](visual-showcase.md), synthetic demo and deterministic video sources explain the concept. Their data and UI annotations are illustrative. Older shot lists describe earlier presentation cuts; they are not release support matrices or evidence of a current installed deployment.

The repository's actual supported entry, downloadable artifacts and validation gaps are described in [the README](../README.md), [installation](open-source-setup.md) and [release validation](portable-validation.md). The [public boundary](public-boundary.md) applies to all screenshots, sample data and release archives.
