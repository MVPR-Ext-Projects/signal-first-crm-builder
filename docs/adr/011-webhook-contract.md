# 011 — Webhook contract (signature, idempotency, retries, response codes)

**Status:** Accepted

## Context

The system has six inbound webhook handlers, each routing through `/api/webhooks/[workspaceId]/<source>/route.ts`. Each provider has different conventions for authentication, retry behaviour, and idempotency. Without an explicit contract for our own handlers, behaviour drifts: one handler 500s on a CRM-push failure, another swallows it; one verifies signatures strictly, another not at all.

This ADR pins the contract every inbound webhook handler must honour.

## Decision

### 1. Authentication is workspace-scoped

Webhook secrets live in `WorkspaceConfig.webhookSecrets.<provider>`, encrypted at rest. The URL path embeds `[workspaceId]`, which is the tenant boundary — there is no global webhook URL.

Exception: Teamfluence has no inbound signature, and this is the durable design — not a temporary gap. Teamfluence as a product does not issue signing secrets for outbound webhooks; there is nothing to ask the vendor to ship. The webhook is authenticated by the workspace UUID in the URL path alone. The `webhookSecrets.teamfluence` field on `WorkspaceConfig` is misnamed — it actually stores the Teamfluence API key used for our OUTBOUND calls to Teamfluence, not for inbound verification.

For every other provider, the handler MUST verify the signature using a constant-time comparison (`crypto.timingSafeEqual`), not `===` or `!==`. The Dripify handler currently uses `!==` for a header-secret check; that's a small but real timing-attack risk and should be fixed when next touched.

### 2. Signature failure = 401, never 200

A signature mismatch returns `401 Unauthorized` with no body details. Never log the expected signature; never 200 a bad request "to be lenient." Providers that send malformed retries should fail loudly so we notice.

### 3. Idempotency

Signals are append-only (ADR-009), so naive ingest creates duplicates on webhook retries. Every signal write carries a `crm_signal_id` derived from a provider-specific stable identifier (e.g. `calendly:<event-uri>`, `dripify:<event-id>`, `teamfluence:<id>`). A unique constraint on `(workspace_id, crm_signal_id)` prevents duplicate inserts; on conflict we no-op the signal write but still 200 the response.

For providers that don't supply a stable event ID, hash the canonical payload fields (actor + object + verb + timestamp) and use that as the idempotency key. Don't hash the entire raw payload — providers add fields over time and you'll lose dedup as the schema evolves.

### 4. CRM push is best-effort

The webhook response code reflects the Postgres write status, NOT the CRM write status. If `createCrmAdapter(config).createSignal(...)` fails (HubSpot rate-limited, transient 5xx, network error), the handler logs the failure and still returns 2xx. The user's mirror falls behind; the next retry from the provider may or may not catch up depending on idempotency.

A failed CRM push is observable via:
- `outreach_log.crm_push_status` (when applicable)
- Console logs with a consistent `[crm-push]` prefix

We do not currently have a retry queue for failed CRM pushes — adding one is a known follow-up.

### 5. Response codes

- `200` — successfully written to Postgres (CRM push may or may not have succeeded).
- `204` — idempotent no-op (duplicate signal).
- `400` — payload doesn't match expected shape. Provider should not retry; this is our schema's problem with their payload.
- `401` — signature verification failed.
- `404` — workspace ID in URL doesn't match a known workspace.
- `5xx` — Postgres write failed. Provider WILL retry. This is the only case where we let them retry.

### 6. Provider replays are silent

If a provider replays an event we've already seen (idempotent dedup catches it), we return 204 and log at debug level. No alerting; replays are normal.

## Consequences

**Upsides:**
- Predictable behaviour under failure. A flaky HubSpot doesn't 5xx our webhook endpoints, which would cascade into retry storms from providers.
- Signature verification is consistent. Bad payloads fail loudly.
- Idempotent ingest means we can tolerate provider retries without contaminating the score.

**Downsides:**
- The "best-effort CRM push" pattern means HubSpot can quietly fall behind without anyone noticing. The dashboard is the canonical view (per ADR-010), but users may notice the lag and ask why.
- Per-provider idempotency-key strategy is bespoke. Adding a new provider means thinking about what their stable identifier is.
- No central retry queue today. Failed CRM pushes stay failed until someone re-runs the relevant backfill.

## When you violate this contract

If you find yourself:
- Adding a `throw` on a CRM-push failure inside a webhook handler — back up. The contract says best-effort.
- Skipping signature verification "for testing" — use a curl with a valid signature instead. Don't ship code that bypasses the check.
- Hashing the entire raw payload for idempotency — narrow it to canonical fields the provider commits to keeping stable.
- Returning 200 on signature failure — never. 401 every time.

When in doubt, re-read this ADR and the relevant section of `docs/WEBHOOKS.md`.
