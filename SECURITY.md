# Security

Better Codex is a public reference implementation. It does not include a
provider credential, a session database, a private gateway, or a production
deployment configuration.

When adding a provider adapter:

- keep credentials in the host environment or a platform credential store;
- never commit conversation exports, access tokens, cookies, device logs, or
  private URLs;
- make the adapter explicit about the authority and data scope it receives;
- keep local cache data separate from the provider's source of truth;
- add a redaction test before sharing diagnostic output.

If you find a security issue, please avoid opening a public issue with a live
credential or private trace. Contact the repository maintainer first.
