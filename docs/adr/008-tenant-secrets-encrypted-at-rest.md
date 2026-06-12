# 008 — Tenant secrets are AES-encrypted at rest in WorkspaceConfig

**Status:** Accepted

## Context

A workspace's CRM access tokens, webhook signing secrets, third-party API keys, and dashboard password all live inside `WorkspaceConfig` in Upstash Redis. The question was: how do we store them?

Plaintext was obviously wrong — Upstash is a managed service, and the principle of "treat secrets at rest as if the storage layer might be breached" applies.

Storing in a dedicated secret-vault (Vault, AWS Secrets Manager) was rejected as overkill for the deployment model — most adopters are running a single Vercel + Upstash + Neon stack and don't want to add an external dependency for one piece of crypto.

## Decision

Use a process-level `ENCRYPTION_KEY` (32 bytes, hex-encoded, in env var) to AES-256-GCM encrypt sensitive fields before writing to Upstash. Ciphertext is prefixed `enc:` and includes IV + auth tag.

Round-trip helpers:
- `encryptIfNeeded(value: string)` — idempotent; if already `enc:`-prefixed, returns as-is.
- `decrypt(value: string)` — reverses; if not `enc:`-prefixed, returns as-is (back-compat).

Fields encrypted: `accessToken` (dashboard password), `webhookSecrets.*`, `enrichment.*.apiKey`, `hubspot.accessToken`, `resend.apiKey`, `mvpr.apiKey` (the workspace's MVPR PR-platform API key — the MVPR coverage integration is optional but supported per workspace; the field round-trips through the same encryption helper), and any other tenant secret added later.

Process-level env vars (`ANTHROPIC_API_KEY`, `RESEND_API_KEY`) are NOT encrypted — they're workspace-agnostic and Vercel-managed.

## Consequences

**Upsides:**
- One env var to manage (`ENCRYPTION_KEY`), simple to set up.
- Ciphertext-at-rest property holds without external dependencies.
- The `enc:` prefix convention lets the system idempotently encrypt — write the same code path for new and existing fields.

**Downsides:**
- `ENCRYPTION_KEY` is now load-bearing. Rotating it requires re-encrypting every encrypted field in every workspace's config. There's a recovery script (`scripts/clear-encrypted-workspace-fields.mjs`) but it's destructive and needs care.
- A bug that writes a secret to a non-encrypted field silently exposes it. The `encryptIfNeeded` helper has to be threaded everywhere — no enforcement at the type level.
- Inspecting workspace configs in Upstash directly shows `enc:`-prefixed garbage, which is the right answer but requires the inspect script (`scripts/inspect-workspace-encrypted-fields.mjs`) to be useful.

**What would invalidate this decision:**
- A managed-Vault offering on Vercel Marketplace that has the same operational simplicity. Could switch then.
- A compliance requirement (FedRAMP, HIPAA) that requires a specific KMS. Would need a different design.

## Guardrails

- Run `scripts/inspect-workspace-encrypted-fields.mjs` (read-only) BEFORE any destructive Redis op or `ENCRYPTION_KEY` rotation.
- Backups land in `/tmp/` automatically on destructive scripts; keep them until the workspace is verified recovered.
- New fields holding tenant secrets MUST go through `encryptIfNeeded` on write and `decrypt` on read. No exceptions.
