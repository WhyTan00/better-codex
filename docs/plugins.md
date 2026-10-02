# Project plugins

A plugin is a trusted local package registered in `deployment.json`. The workspace's `plugins` list determines where it is available. Start with `examples/plugins/project-overview`.

```json
{
  "schema": "workbench.plugin.v1",
  "id": "project-overview",
  "label": "Project overview",
  "entry": "adapter.mjs",
  "readOnly": true,
  "config": {}
}
```

`entry` must resolve inside the package. It exports `async read(context)` and returns a bounded JSON object. `context.workspace` contains the configured ID, label, root and read policy; `context.config` is the manifest's config. A document can return `summary`, `updatedAt`, and `sections: [{title, text, items}]`. Use source timestamps and source revisions, rather than making a copied editable project database.

A local page can be declared as `"ui":{"directory":"public","entry":"index.html"}`. Assets must stay inside that directory, including after symlink resolution. The workbench embeds the page with a return-to-conversation control. Only same-origin assets and requests are permitted by the plugin page policy. Modules and pages are trusted code with the host's permissions; this is not a hostile-plugin sandbox.

For writes, declare `"readOnly":false` and an `actions` list. Export `async invoke(context, request)` and implement the actual authorization, revision check and idempotent transaction in the source system. Requests have `operation`, a stable UUID `requestId`, a nonempty `expectedRevision`, and `data`. The workbench forwards one invocation and never retries a mutation automatically. A read-only workspace always rejects writes regardless of the manifest.

An embedded UI obtains a short-lived capability with a same-origin POST to `/api/context` and JSON `{"workspace":"ai"}`. Send the returned token as `Authorization: Bearer TOKEN` to `/api/w/ai/plugins/PLUGIN/invoke`. The token is bound to both workspace and Tailscale login. Keep the same request ID when checking an uncertain source result; do not create another transaction merely because the browser reconnected.

Plugins own their data, secrets and source revisions. Installations can read an existing local project service through an adapter; that service remains the source of truth. Better Codex's sample plugin contains no finance, media, publishing or other private project integration.
