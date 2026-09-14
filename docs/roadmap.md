# Roadmap

The public core is intentionally small. Possible follow-up work:

- a reference WebSocket adapter for a self-hosted Harness;
- an encrypted, bounded IndexedDB cache implementation;
- a native Android shell with a foreground-service policy that is explicit per
  provider and operating system;
- a plugin SDK with permission declarations and fixture-based contract tests;
- more Remotion scenes for document linking, queue controls, and reconnects.

Provider compatibility and operating-system background behavior should be
verified against the current provider documentation before implementation.
