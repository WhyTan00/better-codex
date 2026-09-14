# Product story

## The problem

Native AI clients are good at execution, while custom workbenches are good at
context. Combining them often creates a second chat database, slow navigation,
stale mobile screens, or two clients competing for the same conversation.

## The Better Codex answer

Better Codex places a small, fast workbench around a native execution Harness:

- open the document, project, or conversation from one place;
- paint the last known state immediately from a bounded local projection;
- keep the official conversation and queue as the authority;
- add custom plugins without replacing the native renderer;
- give project-specific views to quant research and video production without
  making either one a second conversation owner;
- show the connection and cache state so “fast” is observable, not magical.

## A 32-second video

The explainer follows one message across the system:

1. A user opens a pinned conversation from the workbench.
2. The shell paints the cached projection immediately.
3. The web and mobile clients connect to the same native Harness.
4. A local send becomes an acknowledged event and then a canonical message.
5. Project adapters show synthetic quant research and Remotion video views
   without taking over execution.
6. The user sees a workbench that feels custom while the underlying Harness
   remains native.

See the static bilingual gallery in
[docs/visual-showcase.md](visual-showcase.md). The quant and video examples are
synthetic public demos, not live accounts or private media captures.
