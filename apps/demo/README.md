# whytan / Better Codex demo

This is a zero-login synthetic workbench. It demonstrates the public product
ideas without connecting to a provider:

- cached conversation projections render before a fresh read;
- a send moves from local paint to Harness acknowledgement to confirmation;
- connection, cache version, workspace, and plugin state stay visible;
- the public shell presents synthetic Quant Research and Video Production
  project views without live accounts or media;
- the shell owns navigation while the Harness remains the execution owner.

For static screenshots and the bilingual visual explanation, see
[`docs/visual-showcase.md`](../../docs/visual-showcase.md).

Run it from the repository root with:

```bash
python3 -m http.server 4173 --directory apps/demo
```
