# Contributing

The project is intentionally split into a small public core and provider
adapters. Keep provider-specific credentials, deployment paths, and private
workbench data outside the repository.

Useful commands:

```bash
pnpm install
pnpm demo
pnpm video:render
```

Before a pull request, run the public contract test and make sure generated
files do not contain host paths, tokens, or conversation text.
