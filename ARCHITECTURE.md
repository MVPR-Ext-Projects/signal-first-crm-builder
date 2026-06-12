# Architecture

The system-level view: where data lives, how it flows, what each layer is for. Read this once when onboarding; come back when adding a new integration or rethinking a boundary.

`PHILOSOPHY.md` is the *why*; this is the *how* at a higher altitude than `CLAUDE.md`.

---

## Three storage layers

```
                ┌────────────────────────────┐
                │       Upstash Redis        │
                │   workspace:<id>:config    │ ◀── tenant config, encrypted secrets,
                │                            │     personas, scoring thresholds
                └─────────────┬──────────────┘
                              │ read on most requests
                              │
   ┌──────────────────────────┴─────────────────────────────┐
   │                                                        │
   │                        Next.js                          │
   │              apps/web (the dashboard + APIs)            │
   │                                                        │
   └─────┬──────────────────────┬───────────────────────┬───┘
         │                      │                       │
         │ read/write           │ read/write            │ outbound
         ▼                      ▼                       ▼
   ┌─────────────────┐   ┌─────────────────┐   ┌────────────────┐
   │   Postgres      │   │     HubSpot     │   │  Anthropic /   │
   │ (source of      │   │   (optional     │   │  Resend /      │
   │  truth)         │   │    mirror)      │   │  Unipile / ... │
   │ contacts        │   │ contacts        │   │                │
   │ signals         │   │ companies       │   │ AI + outbound  │
   │ companies       │   │ timeline events │   │ providers      │
   │ outreach_log    │   │ (push at MQL)   │   │ + enrichment   │
   │ style_*         │   │                 │   │                │
   └─────────────────┘   └─────────────────┘   └────────────────┘
```

Postgres is the **source of truth**. The external CRM is an **optional, downstream mirror** (`crmProvider: "none"` runs the whole system with no CRM at all). When connected, it is written at handoff (meeting-booked / MQL), not on every signal. See PHILOSOPHY.md, "Postgres is the system of record."

### Upstash Redis — workspace config

One key per workspace: `workspace:<uuid>:config`. The value is the full `WorkspaceConfig` JSON. Encrypted fields use the `enc:` prefix and round-trip through `encryptIfNeeded` / `decrypt`.

What lives here: tenant name, CRM provider choice (HubSpot only in this template), encrypted CRM access tokens, encrypted webhook secrets, slugs, team-member identifiers, persona library, scoring thresholds, exclusion rules, ICP groups, prospect types.

Cardinality: low (small number of workspaces in most deployments). Read on most dashboard requests; cached in-memory per request where useful.

### Postgres — the projection

The "warehouse" view of the workspace's data. Every row is scoped by `workspace_id`. Indexes assume `workspace_id` as the leading column.

Key tables:
- `contacts` — one per person per workspace. Identifier: `(workspace_id, crm_contact_id)`. Has `gtm_company_id` FK to `companies`.
- `companies` — first-class entity. Dedup waterfall: `linkedin_url > domain > canonical_name`. Unique partial indexes on `(workspace_id, linkedin_url)` and `(workspace_id, domain)` give race-safe upsert. Parent/child via `parent_company_id`.
- `signals` — append-only event log. References contacts. Score-bearing.
- `influencers` — first-class influence-graph entity, separate from contacts. A person (journalist, individual) or organization (publication, news site, podcast) with influence over prospects. Dedup waterfall `mvpr id > linkedin_url > domain > name`. MVPR writes journalists + publications here. See ADR-015.
- `influencer_influences` — many-to-many edge between an influencer and a prospect. Read both ways: `influencer.influences` (-> contacts) and `contact.influenced_by` (-> influencers). The `contacts.influenced_by` JSONB is a denormalized cache of this.
- `outreach_log` — append-only send log. References contacts and the fingerprint version used.
- `style_fingerprints` — voice profiles, three scopes (corporate / channel / channel_persona).
- `company_tags`, `company_enrichments` — company-level side tables, currently keyed on `(workspace_id, company_name)`. Will move to `company_id` in a follow-up migration once contacts backfill is complete.
- `notes`, `linkedin_send_failures`, `usage_log`, `campaigns`, `channels`.
- `mvpr_coverage` / `mvpr_announcements` / `mvpr_threads` / `mvpr_sync_state` — the **MVPR projection**: earned media coverage, the journalist outreach threads behind it, and PR-performance stats (response rate, coverage rate, which pitches land), pulled every 6h by `/api/cron/mvpr-coverage-sync`. This feeds the funnel's earned-coverage signal source. Note on framing: the *differentiator is the signal-first approach*, which is PR-source-agnostic (any agency's coverage can feed it). MVPR is a PR platform with a REST API, and that API is what makes feeding + tracking this automatic rather than manual - a convenience/scale win and MVPR's edge over other agencies, not a dependency of the approach. The `mvpr_` table-name prefix is the historical integration identifier (kept to avoid a column migration); the integration is live, not vestigial. See `docs/PR-LinkedIn-Measurement.md` and ADR-014.

Cardinality: high. Most queries scope by `workspace_id` first, then by time (`occurred_at`, `last_signal_at`, `updated_at`).

### HubSpot — optional downstream mirror

The external CRM is a **secondary, best-effort mirror** of the qualified part of the funnel, not the source of truth. A workspace can set `crmProvider: "none"` and never connect one; everything still works because the dashboard, scoring, drafting, and reporting all read from Postgres. Writes go through the `CrmAdapter` interface (`packages/crm-adapters/src/adapter.ts`); HubSpot is the bundled implementation, and adding another CRM means adding an adapter, not touching the core.

What we write, and when: contact create/update, company create/update, and signal timeline events - **gated at handoff**, not on every signal. The handoff point is the meeting-booked / MQL transition (Discovery Call), when a prospect becomes a real sales object worth carrying in the CRM your closers live in.

What we don't write: top-of-funnel noise. Dripify-sourced signals deliberately stay in Postgres only; only Teamfluence-sourced signals mirror outward, and even those are about keeping the qualified record in sync, not streaming every like and follow. See `docs/adr/003-dripify-teamfluence-asymmetry.md`. If Postgres and the CRM ever disagree, Postgres wins.

---

## Enrichment layer

Enrichment is how a contact or company acquires the attributes the rest of the system reasons over - email, phone, employee count, industry, domain authority. Providers are configured per-workspace under `WorkspaceConfig.enrichment`, with API keys encrypted at rest, and each writes its result back into Postgres (never into the CRM directly).

| Provider | Fills | Trigger |
|---|---|---|
| **Surfe** | email, phone, name, company fields | Asynchronous: the system queues a request, then a poll cron pulls the completed result. The primary enrichment engine. |
| **Moz** | domain authority, backlinks, referring-domain counts on a company | Companies surface, fetched against the company's domain. |
| **Apify** | a company's employees (LinkedIn scraper) and per-contact interests | On-demand actions on the Companies / contact surfaces. |
| **Clay / Apollo** | configurable additional contact attributes | Configured providers; wire to taste. |

Two principles:
- **Enrichment results land in Postgres, scoped by `workspace_id`.** They are inputs to persona matching and company classification, not signals. Don't write an enrichment result to the `signals` table.
- **Enrichment respects the no-CRM path.** With `crmProvider: "none"`, enrichment still works end-to-end against the Postgres contact - it never assumes a CRM round-trip.

---

## End-to-end lifecycle of a signal

The most important data path. Follow it once and the rest of the codebase becomes legible.

### 1. Arrival — webhook handler

A signal arrives at e.g. `apps/web/app/api/webhooks/[workspaceId]/teamfluence/route.ts`. The handler:
- Verifies the webhook signature against `WorkspaceConfig.webhookSecrets.teamfluence` (encrypted, decrypted on read).
- Extracts the actor, the object, the verb, the timestamp, the company.
- Normalises the verb to one of the enumerated values.

### 2. Contact resolution

The handler resolves a contact (`contacts` row):
- Look up by LinkedIn URL → existing row.
- Or by email if present → existing row.
- Or create a new contact, scoping by `workspace_id`.

Companies: derive `company_name` from the payload; the side tables `company_tags` / `company_enrichments` may be touched.

### 3. Postgres write — append the signal

The handler appends a new row to `signals` with `(workspace_id, contact_id, signal_verb, score_delta, signal_actor, signal_object, verb_description, occurred_at)`. The `score_delta` comes from the per-workspace verb-weight config; defaults to 1 if not configured.

The contact's `signal_score`, `signal_count`, and `last_signal_at` are updated by the same transaction.

### 4. Funnel-stage recompute

The new `signal_score` is compared to `WorkspaceConfig.scoring.thresholds` to derive `funnel_stage`. If `manual_stage` is set, it wins for display purposes.

### 5. CRM mirror (optional, gated)

If a CRM is connected (`crmProvider !== "none"`) and the signal is Teamfluence-sourced, the handler calls `createCrmAdapter(config).createSignal(contactId, signal, contact)` to keep the mirrored record in sync. The Postgres write in step 3 already happened and is authoritative; this step is best-effort and must never block it.

For Dripify-sourced signals - and for every workspace running `crmProvider: "none"` - this step is skipped entirely; the signal lives in Postgres only. The qualified contact reaches the CRM later, at the meeting-booked / MQL handoff, not via per-signal streaming. See `docs/adr/003-...`.

### 6. Surface in the dashboard

The SDR page (`apps/web/app/dashboard/[workspaceId]/sdr/page.tsx`) queries contacts ordered by `last_signal_at DESC`. The new contact (or the score-uplifted existing one) appears at the top.

### 7. Outbound draft (when the user composes)

When the user clicks "Draft DM" on a contact, the draft endpoint:
- Loads the contact + most recent signals.
- Matches the contact against the per-workspace persona library (`pickPersona`).
- Resolves the fingerprint at the most-specific scope (`channel_persona` if persona match + channel; otherwise `channel`; otherwise `corporate`).
- Renders the prompt with persona + fingerprint + recent signal context, hits Anthropic, returns the draft.

### 8. Outbound send + outreach log

If the user sends, an `outreach_log` row is appended with `(workspace_id, contact_id, channel, fingerprint_version_id, status, sent_at)`. A `sent_dm` / `sent_email` signal is appended too — the send is itself an engagement event.

### 9. Reply (inbound, future)

Replies arrive via Unipile (LinkedIn) or Resend webhooks (email), are classified by AI (interested / not / DNC), and either trigger a follow-up flow or set DNC. Each is a new signal.

---

## Per-tenant isolation

Multi-tenancy is structural, not a feature flag.

- Every Postgres query begins `WHERE workspace_id = $1`. Indexes assume this prefix.
- Every Redis key is prefixed `workspace:<uuid>:`.
- Every dashboard URL embeds the workspace UUID — there is no shared dashboard surface.
- Every webhook handler is workspace-scoped via its path: `/api/webhooks/[workspaceId]/<source>`.
- Encryption keys are process-level (`ENCRYPTION_KEY`), but the resulting ciphertext is per-workspace (different IVs).

This means: a customisation that "just looks at all contacts in the system" is wrong. Always scope.

---

## Where customisation goes

When you want to change behaviour:

| Want to change | Where it goes |
|---|---|
| What buyers look like | `WorkspaceConfig.messaging.personas` |
| How we sound | `style_fingerprints` rows |
| What counts as a signal | Signal verb enum (three places) |
| How signals score | `WorkspaceConfig.scoring.verbWeights` + thresholds |
| Who to never contact | `WorkspaceConfig.exclusionRules` + DNC + excluded column |
| What CRM to write to | `WorkspaceConfig.crmProvider` (HubSpot built-in; add adapter for others) |
| How outbound looks | Channel config + fingerprint per channel |
| Which crons run | `apps/web/vercel.json` |
| Which webhooks we accept | New route under `apps/web/app/api/webhooks/[workspaceId]/<source>/` |

---

## Where customisation does NOT go

When you're tempted to:

- **Hardcode a constant** for something users vary across workspaces — push it to `WorkspaceConfig`.
- **Add a feature flag in env** for a customer-facing toggle — push it to `WorkspaceConfig`.
- **Mutate a signal** when context changes — append a new signal instead.
- **Skip workspace_id in a query** because "it's a small table" — never. The index assumes it.
- **Write a contact across workspaces** — the multi-tenant boundary is sacred.

---

## Reading order for a new contributor

1. `README.md` — orientation.
2. `PHILOSOPHY.md` — why.
3. `GLOSSARY.md` — domain terms.
4. This file — system view.
5. `CLAUDE.md` — operating manual + caveats.
6. `docs/adr/` — decisions already made.
7. Code, starting from `apps/web/app/api/webhooks/[workspaceId]/teamfluence/route.ts` (the canonical inbound path) and `apps/web/app/dashboard/[workspaceId]/sdr/page.tsx` (the canonical outbound surface).
