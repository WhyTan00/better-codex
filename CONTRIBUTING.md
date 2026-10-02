# Contributing

The project is intentionally split into a small public core and provider
adapters. Keep provider-specific credentials, deployment paths, and private
workbench data outside the repository.

Validate changes from this public checkout:

```bash
npm ci --prefix packages/host-cli --ignore-scripts
npm test
(cd source/apps/sync-gateway && go test ./...)
python3 scripts/scan-public-tree.py .
```

Keep the portable deployment boundary intact: a private installation can supply
its own registry, while the public host takes roots, plugins and ownership from
deployment.json. Changes to shared source must reach this public tree and its
export manifest in the same release. Do not copy private deployments or official
application assets into a patch. Keep tests independent of account credentials.

Use the real installer and `scripts/verify-portable.mjs` for host changes, with a
separate installation, state directory and ports. Report device, login and
network checks separately from local contract coverage.
