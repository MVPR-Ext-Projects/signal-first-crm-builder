# Webhooks cookbook

One section per inbound webhook handler, covering: what it ingests, how it's authenticated, what idempotency key it uses, what signals it writes, whether it pushes to the CRM.

The shared contract for all of these lives in `docs/adr/011-webhook-contract.md`. Read that first if you're adding a new handler.

The route pattern is always: `apps/web/app/api/webhooks/[workspaceId]/<provider>/route.ts`. The workspace UUID in the URL is the tenant boundary.

---

## Teamfluence

**Purpose:** LinkedIn engagement signals (likes, comments, profile views, follows, accepted connections).

**Auth model:** None at the inbound layer — this is the durable design, not a temporary gap. Teamfluence as a product does not issue signing secrets for outbound webhooks. The webhook is authenticated solely by the workspace UUID in the URL path. The `webhookSecrets.teamfluence` field on `WorkspaceConfig` actually stores the API key used for our OUTBOUND calls TO Teamfluence (feed-poll, profile lookups), not inbound verification — misnamed for historical reasons.

**Implication:** anyone who knows a workspace UUID can submit forged Teamfluence payloads. Workspace UUIDs are not secrets per se, but they're not exposed in user-facing URLs to non-tenants either. Treat the UUID as a low-strength credential. Rate-limit at the edge if exposure is a concern.

**Idempotency:** `(workspace_id, crm_signal_id)` where `crm_signal_id = "teamfluence:<event-id>"`. The Teamfluence event ID is stable.

**Verbs written:** `liked_post`, `commented_post`, `viewed_profile`, `followed_our_team_member`, `followed_our_company`, `followed_prospect`, `accepted_our_connection`, `sent_connection_request`, `connected`.

**CRM push:** YES. Pushes contact create/update + a timeline event for each signal via `createCrmAdapter(config)`. Best-effort per ADR-011.

**Provider docs:** https://api.teamfluence.io/docs (Tom's reference)

---

## Dripify

**Purpose:** LinkedIn outbound automation events (connection-request sent, accepted, DM sent).

**Auth model:** Shared-secret header. The handler reads `x-dripify-secret` and compares to `WorkspaceConfig.webhookSecrets.dripify`. Comparison currently uses `!==` which is a small timing-attack risk; switch to `crypto.timingSafeEqual` when next touched.

**Idempotency:** Currently weak (Dripify's payload doesn't include a stable event ID). Hash of `(actor + object + verb + timestamp_minute)` is used as a derived idempotency key. The `_minute` truncation prevents duplicate inserts when retries arrive within 60s of each other but allows genuine repeat events later.

**Verbs written:** `sent_connection_request`, `accepted_our_connection`, `sent_dm`, `connected`.

**CRM push:** NO. Per ADR-003, Dripify signals stay in Postgres. A Dripify-tracked contact appears in HubSpot when they hit a CRM-pushed stage (e.g. Discovery Call via the meeting-booked path in ADR-012; Discovery Call = Meeting Booked = MQL in this codebase), not via the Dripify webhook itself.

**Provider docs:** https://help.dripify.io/

---

## Calendly

**Purpose:** Meeting bookings and cancellations (invitee.created, invitee.canceled).

**Auth model:** HMAC-SHA-256 of `<unix-timestamp>.<rawBody>` signed with `WorkspaceConfig.webhookSecrets.calendly`. The signature arrives as `Calendly-Webhook-Signature: t=<unix>,v1=<hex>`. Verified with `crypto.timingSafeEqual`.

**Setup:** A workspace admin registers the webhook via Calendly's API at the URL `/api/webhooks/[workspaceId]/calendly`. Calendly returns a `signing_key` which is stored encrypted on `webhookSecrets.calendly`.

**Idempotency:** `(workspace_id, crm_signal_id)` where `crm_signal_id = "calendly:<event-uri>"`. Calendly's event URI is stable.

**Verbs written:** `booked_meeting`. Cancellations update `calendly_bookings.cancelled_at` rather than writing a signal. Per ADR-012, cancellation also clears `manual_stage = 'Discovery Call'` on the contact and company (when no other active bookings remain), letting the score-derived stage take over. The `booked_meeting` signal itself is NOT retracted on cancellation — append-only per ADR-009.

**CRM push:** NO in the template (implementation gap). The intent (ADR-012) is that this handler triggers an automatic `Discovery Call` stage transition for the contact AND the contact's company, regardless of signal source. In this codebase, Discovery Call = Meeting Booked = MQL — same stage, three names. The stage transition then drives the CRM push as a side-effect (ADR-010 best-effort semantics). Enabling this requires wiring the contact + company `manual_stage` UPDATEs (no new stage value needed — `Discovery Call` already exists in the `SDRStage` union). See ADR-012 for the steps.

**Event-type slug mapping:** Calendly's webhook payload includes event_type as an opaque URI, not the URL slug. The handler maintains a small URI → slug map so the bookings table is searchable by slug; unknown URIs leave slug null and the raw payload still preserves everything for later backfill.

**Provider docs:** https://developer.calendly.com/api-docs/

---

## Stripe

**Purpose:** Revenue events — `customer.subscription.created/updated/deleted`, `invoice.payment_succeeded`, etc.

**Auth model:** HMAC-SHA-256 via the `Stripe-Signature` header, verified against `WorkspaceConfig.stripe.webhookSecret` (note: under `stripe.*`, not `webhookSecrets.*` — Stripe is special-cased because of its multi-account model). Uses Stripe SDK's `constructEvent` for verification.

**Setup:** A workspace admin connects their Stripe account in `/settings/stripe`. The dashboard provisions a webhook on their Stripe account pointing at `/api/webhooks/[workspaceId]/stripe` and captures the signing secret.

**Idempotency:** Stripe's event ID (`evt_...`) is the natural key. `(workspace_id, stripe_event_id)`.

**Verbs written:** None directly; Stripe events update `stripe_subscriptions`, `stripe_revenue_events`, and `stripe_customer_types` projections rather than the generic `signals` table. The dashboard reports off these tables separately.

**CRM push:** NO. Revenue is reported in the dashboard. HubSpot does not get a copy.

**Provider docs:** https://docs.stripe.com/webhooks

---

## Unipile

**Purpose:** Inbound LinkedIn DM replies + send/delivery status. Plus the outbound counterpart (we use the same Unipile account to SEND DMs and connection requests).

### Inbound (webhook)

**Auth model:** HMAC-SHA-256 via a Unipile-specific signature header. Verified against `WorkspaceConfig.webhookSecrets.unipile` with `crypto.timingSafeEqual`.

**Idempotency:** `(workspace_id, crm_signal_id)` where `crm_signal_id = "unipile:<message-id>"`. Unipile assigns stable message IDs.

**Verbs written:** `sent_dm`, `replied_dm_initial`, `replied_dm_subsequent`. Replies trigger an AI classification pipeline that may set DNC on the contact if the reply is "not interested."

**CRM push:** NO. Replies are surfaced in the dashboard's SDR view.

### Outbound (we call Unipile)

There are two outbound modes:

**1. Direct DM send** — `apps/web/app/api/dashboard/[workspaceId]/send-dm/route.ts`. Used when a seller clicks "Send DM" on a contact in the SDR view. Calls `sendLinkedInDm` (in `apps/web/lib/unipile.ts`), records a `sent_dm` signal + an `outreach_log` row on success, and writes to `linkedin_send_failures` on failure. Synchronous from the user's perspective (the dashboard waits for the result).

**2. Connection request queue** — `apps/web/app/api/cron/linkedin-invite-queue/route.ts` (cron-driven, plus `/api/dashboard/[workspaceId]/linkedin-invite-queue/enqueue/route.ts` to enqueue). LinkedIn rate-limits connection requests heavily (~80/day per account); the queue spreads sends over time. Each cron tick pulls a batch and fires them via Unipile.

**Failure handling — the lifecycle hook:** when a DM hard-fails twice within 48h for the same contact (typically because the contact's LinkedIn URL became invalid — they changed handle, deleted account, blocked us), the contact's `linkedin_url_status` is flipped to `inactive` and `needs_enrichment` is set to `true`. The contact appears on the Enrichment Candidates page where a seller can find their new profile. The `linkedin_send_failures` table is the trace.

**Cost tracking:** `UNIPILE_CENTS_PER_MESSAGE` (in `apps/web/lib/pricing.ts`) drives the per-send cost entry in `usage_log`. The Costs page aggregates these.

**Provider docs:** https://developer.unipile.com/

---

## Resend

**Purpose:** Outbound email (we call Resend) + inbound delivery/engagement lifecycle events (Resend calls us). Unlike the other webhooks in this cookbook, the Resend inbound webhook lands in the ATTRIBUTION app, not the main web app — because Resend lifecycle events are click-tracking events, and click tracking is the attribution app's domain.

### Outbound (we call Resend)

Wired via `apps/web/lib/email/send-outbound.ts`. Used when a seller sends an email from the SDR or Companies pages. The sender (`from` address) resolves from `WorkspaceConfig.messaging` if a role-tagged sender is configured (e.g. "default" or formerly "deal_handoff"); otherwise falls back to `RESEND_FROM_EMAIL` env var.

Returns a discriminated result so the caller can stamp `outreach_log` on success and skip the signal write on failure. The send fires a `sent_email` signal + an `outreach_log` row.

**Workspace credentials:** `WorkspaceConfig.resend.apiKey` (encrypted at rest). Configured via `/api/dashboard/[workspaceId]/settings/resend-creds/route.ts`.

### Inbound lifecycle webhook (Resend calls us)

**Auth model:** Svix signature (Resend uses Svix for webhook delivery). Headers: `svix-id`, `svix-timestamp`, `svix-signature`. Verified with HMAC-SHA-256 against the workspace's Resend webhook signing secret.

**Route location:** `apps/attribution/api/resend-inbound.ts` — in the attribution sub-app. The attribution app deploys separately from the main web app and uses its own URL.

**Idempotency:** `(workspace_id, crm_signal_id)` where `crm_signal_id = "resend:<event-id>"`. Resend / Svix event IDs are stable across retries.

**Verbs written:**
- `email_sent` (rare — most outbound paths write this themselves at send time; the webhook is the redundancy).
- `email_delivered` — accepted by the recipient's mail server.
- `email_delivery_delayed` — temporary failure, will retry.
- `email_opened` — image-pixel load. Imperfect signal (many clients block images).
- `email_clicked` — link click. Often the strongest signal in the email lifecycle.
- `email_bounced` — permanent delivery failure. Hard-bounces trigger DNC.
- `email_complained` — recipient marked as spam. Always triggers DNC.

**DNC triggers:** `email_bounced` and `email_complained` BOTH set DNC on the contact (`do_not_contact = true`, `do_not_contact_reason_classification = 'bounced'` or `'complained'`, `do_not_contact_source = 'resend'`). The temporal-decay rule for DNC (per ADR / business logic) applies — see the DNC section in GLOSSARY.

**CRM push:** NO. Email lifecycle events stay in Postgres + the workspace dashboard.

**Provider docs:** https://resend.com/docs/dashboard/webhooks/introduction

---

## HubSpot

**Purpose:** Inbound updates from HubSpot — contact email changed, lifecycle stage updated, contact deleted. Keeps the local projection fresh when changes happen in the CRM.

**Auth model:** HMAC-SHA-256 v3 via `x-hubspot-signature-v3` header, verified against the HubSpot app's `clientSecret`. Uses `crypto.timingSafeEqual`.

**Setup:** Configured in the HubSpot app's webhook subscription settings; one app serves all workspaces, with the signing secret being app-level (not workspace-level).

**Idempotency:** HubSpot's `eventId` is the natural key. Note: HubSpot batches multiple events per webhook delivery, so the handler iterates and idempotency-checks each event individually.

**Verbs written:** None typically — this handler updates contact fields in the local projection rather than writing signals. A contact deletion in HubSpot does NOT cascade to Postgres delete; it sets a `deleted_in_crm_at` timestamp.

**CRM push:** N/A — this is the inbound CRM → us direction.

**Provider docs:** https://developers.hubspot.com/docs/api/webhooks

---

## Adding a new webhook

See `docs/adr/011-webhook-contract.md` for the shared contract every handler must honour:

- Signature verification with constant-time comparison.
- Workspace-scoped secrets, encrypted at rest in `WorkspaceConfig.webhookSecrets.<provider>`.
- Idempotency via `(workspace_id, crm_signal_id)` or hashed-canonical-payload fallback.
- CRM push is best-effort, not sync-blocking.
- Response codes per the table in ADR-011.

The `/add-webhook` slash command scaffolds a new handler that follows this contract.

## Verb routing summary

Quick reference for which webhook writes which verbs:

| Verb | Webhook |
|---|---|
| `liked_post` | Teamfluence |
| `commented_post` | Teamfluence |
| `viewed_profile` | Teamfluence |
| `followed_our_team_member` | Teamfluence |
| `followed_our_company` | Teamfluence |
| `followed_prospect` | Teamfluence |
| `sent_connection_request` | Teamfluence, Dripify |
| `accepted_our_connection` | Teamfluence, Dripify |
| `connected` | Teamfluence, Dripify |
| `sent_dm` | Dripify, Unipile |
| `replied_dm_initial` | Unipile |
| `replied_dm_subsequent` | Unipile |
| `sent_email` | (outbound code, not a webhook) |
| `replied_email` | (Resend inbound, separate handler) |
| `email_sent` / `email_delivered` / `email_opened` / `email_clicked` / `email_bounced` / `email_complained` | Resend |
| `booked_meeting` | Calendly |
| `clicked_link` | Attribution app (`apps/attribution/`) |

If a verb is emitted by multiple webhooks (e.g. `connected`), the idempotency key prevents double-counting — the same connection event from both sources collapses to one signal row.
