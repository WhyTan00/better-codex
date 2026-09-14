# Public boundary

This repository intentionally contains patterns and a mock implementation.
It does not contain:

- real conversation transcripts or session IDs;
- OAuth tokens, API keys, cookies, passkeys, or device identifiers;
- private SSO, gateway, tunnel, NAS, or internal hostnames;
- Android signing material or production APKs;
- private project data, user names, personal files, or diagnostic logs;
- scripts that restart a personal desktop runtime or alter local routing.

When publishing a real adapter, keep the provider implementation in a separate
private package if it needs secrets or private infrastructure. Use environment
variables and a local `.env` file excluded from Git. Redact diagnostics before
sharing them.

The demo data in `apps/demo` is synthetic. Its “AI” and “Secondary” workspaces are
labels used to demonstrate workspace switching, not a copy of a real account.

The `source/` tree is an allow-listed, sanitized reference snapshot. It is not
a claim that a provider adapter or native host can be reconstructed without
reviewing the placeholder roots, host packages, authentication boundary, and
provider terms for the adopter's environment.
