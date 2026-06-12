# Glossary

Canonical definitions for every domain term used in this codebase. When a word is ambiguous in code reviews or product specs, this file resolves it.

Each entry is: **term** — what it is, where it lives in code, what's a common misuse.

---

## Core entities

### Workspace
A multi-tenant boundary. Every row in Postgres is scoped by `workspace_id`. Every `WorkspaceConfig` lives at Redis key `workspace:<uuid>:config`. The dashboard URL embeds the workspace ID (`/dashboard/<workspace-uuid>/...`).
- Code: `apps/web/lib/workspace-config.ts`
- **Don't:** confuse a workspace with a user. A workspace is a tenant; users are not modelled.

### Contact
A person we might engage with. Stored in `contacts`. Identified by `(workspace_id, crm_contact_id)` — meaning a contact is uniquely defined within a workspace by the CRM's native ID. The same human at the same company can exist as two contacts in two different workspaces.
- Code: `apps/web/lib/db/contact-store.ts`
- **Don't:** dedup contacts across workspaces. That breaks the multi-tenant boundary.

### Company
A first-class entity in the `companies` table. Identity resolved by a deterministic dedup waterfall (`linkedin_url > domain > canonical_name`) with race-safe partial unique indexes. `contacts.gtm_company_id` is the FK. Parent/child relationships supported (e.g. "Acme APAC" → "Acme") via `parent_company_id`. See `docs/adr/002-companies-first-class-entity.md`.

Inherited from gtm-os: the side tables `company_tags` and `company_enrichments` still key on `(workspace_id, company_name)` rather than `company_id`. Not load-bearing for fresh installs — they populate alongside `gtm_company_id` correctly. New code should always use `gtm_company_id` as the canonical company key.
- Code: `companies` table in `apps/web/lib/db/schema.sql`; consumers in `apps/web/lib/db/contact-store.ts` and `apps/web/app/dashboard/[workspaceId]/companies/`

### Influencer
A first-class entity in the `influencers` table, SEPARATE from contacts (the same human can be both a prospect and an influencer - two rows, two roles). `kind` is `person` (journalist, an individual a prospect follows) or `organization` (publication, news site, podcast); `type` is the specific label. Many-to-many with contacts via `influencer_influences`, read both ways:
- **`influences`** — the prospects a given influencer influences (by `influencer_id`).
- **`influenced_by`** — the influencers influencing a given prospect (by `contact_id`). `contacts.influenced_by` JSONB is a denormalized cache of this.

MVPR writes each coverage's journalist (`person`/`journalist`) and publication (`organization`/`publication`) in here. See `docs/adr/015-influencers-first-class-entity.md`.
- Code: `influencers` + `influencer_influences` in `schema.sql`; `apps/web/lib/db/influencers.ts`
- **Don't:** model an influencer as a contact, or vice versa. Prospects move through the funnel; influencers don't - they sit beside it and point at the prospects they sway.

### Signal
A scored event attributable to a contact. Examples: "liked our post", "viewed our profile", "replied to our DM", "booked a meeting". Each signal has a `signal_verb`, a `score_delta`, an `occurred_at`, and metadata. Append-only: we never update old signals.
- Code: `signals` table in `apps/web/lib/db/schema.sql`
- **Don't:** model coverage, content artefacts, or seller intent as signals. Signals are engagement events with humans.

### Signal verb
The discrete type of action a signal represents. A code-level enum (TEXT column with an enforced set of allowed values via comment + label-map convention). Adding a new verb means touching three places — see `docs/adr/007-signal-verb-enum-three-places.md`.
- Code: comment block in `apps/web/lib/db/schema.sql` near `signals.signal_verb`, plus the verb model in `apps/web/lib/`, plus the dashboard label map.

### Score (signal_score)
The sum of `score_delta` across all of a contact's active signals, weighted by the per-workspace verb scoring config. Drives the funnel.
- Code: `apps/web/lib/db/contact-store.ts` + `apps/web/lib/workspace-config.ts` (thresholds)

### Funnel stage
There are two kinds:
- **Score-derived** (Prospect, Signal Found, Engaged, High Signal) — computed from `signal_score` using per-workspace thresholds in `WorkspaceConfig.scoring.thresholds`.
- **Manual** (Discovery Call, Requested Information, Sent Information, Follow Up Call, Diligence, Contract Negotiation, Customer Won) — set explicitly by a user or by an automatic stage-transition rule; deal-progress markers.

Stored as `funnel_stage` (score-derived) and `manual_stage` (manual). Manual wins for display when set.

**Stage synonyms (worth knowing):** in this codebase `Discovery Call` = `Meeting Booked` = `MQL` — same stage, three names. Code uses `Discovery Call`; product copy and ADRs may use any of the three. See ADR-012 for the meeting-booked → Discovery Call transition rule.

**People stages vs company stages — different lengths.** The funnel is two-level (see ADR-013):

- **People (5 stages):** `Prospect → Signal Found → Engaged → Highly Engaged → Ambassador`. Score thresholds 0–2 / 3–5 / 6–25 / ≥26. Stops at Ambassador — people don't progress through deal stages.
- **Companies (11 stages):** `Prospect → Signal Found → Engaged → High Signal → Disc Call → Info Request → Sent Info → 2nd Call → Diligence → Negotiation → Won`. Score thresholds 0–4 / 5–19 / 20–49 / ≥50 (higher because the company score aggregates across contacts).

The first 5 stages share storage values; the SDR view applies display-label overrides (`High Signal → Highly Engaged`, `Discovery Call → Ambassador`) so the people view reads naturally. Storage values stay canonical.

Deal progress (`Info Request → Won`) is companies-only. A person at a company that's negotiating still appears as "Ambassador" in the SDR view — the cultivation lens.

### Ambassador
The terminal people-level stage. A contact at `Ambassador` has booked a meeting (the trigger is the `booked_meeting` signal — see ADR-012). They stay at Ambassador whether their company is pre-sale, mid-deal, or won.

Storage value: `Discovery Call`. The SDR view applies a `STAGE_DISPLAY_LABEL` override so it reads as `Ambassador` in marketing-lens views (`apps/web/app/dashboard/[workspaceId]/sdr/stage-select.tsx`). The Companies view shows the same storage value as `Disc Call`.

The label "Ambassador" deliberately double-duties:
- Pre-sale: someone who has booked a meeting → confirm logistics, prep them.
- Post-sale (company at `Won`): someone who continues to engage → feed them content, ask for referrals, consider case studies.

Both states benefit from the same cultivation lens, so they share a stage. See ADR-013.

### Outreach log
One row per outbound send (DM, email, etc.). Append-only. References the contact, the channel, the fingerprint version that drove the draft, the outcome.
- Code: `outreach_log` table; helpers in `apps/web/lib/db/`

---

## Personalisation

### Persona
A buyer archetype defined per-workspace in `WorkspaceConfig.messaging.personas`. Has identity (name, product, headline quote), match rules (job titles + ICP groups + employee bands + countries), description, jobs-to-be-done, value propositions, pain points, desired outcomes, voice notes, selling principles.
- Code: `apps/web/lib/persona-match.ts`
- **Match rule:** first match wins. Declare specific personas before broader ones.
- **Strict matching:** if a persona requires `minEmployees: 50` and the contact has no employee data, no match. Missing data fails, not falls through.
- **Unmatched contacts:** get the default "no persona" state. Still visible in the SDR view, still reachable for outbound. The fingerprint resolver falls back through `channel` to `corporate` scope (no persona-tailored voice, but still workspace-appropriate). Unmatched is a feature — see PHILOSOPHY.md "Strict matching beats permissive matching."

### Style fingerprint (or just "fingerprint")
A writing-voice profile. Three scopes, resolved least-to-most-specific:
- **corporate** — workspace-wide voice baseline.
- **channel** — voice for a specific delivery channel (LinkedIn DM, email, newsletter), persona unset.
- **channel_persona** — voice for a specific channel AND persona combination.

The most-specific row that matches drives the draft. See `docs/adr/004-three-fingerprint-scopes.md`.
- Code: `apps/web/lib/style/fetch-fingerprints.ts`, `style_fingerprints` table
- **Don't:** model voice for voice-only channels (Outbound Calls). Fingerprints are for *written* voice only.

### Action set
The collection of delivery channels enabled for a workspace. Each channel can have its own fingerprint and its own draft pipeline. Action sets are workspace-scoped.
- Code: `apps/web/lib/db/channels.ts`

### Channel
A specific delivery mechanism (LinkedIn DM, Direct Email, Newsletter, Product Updates, Outbound Calls). Channels are DB-driven (`channels` table) and can be created/customised per workspace.

---

## Filtering and segmentation

### ICP group
A discrete bucket within an ICP, like "small payments company" vs "large bank". Defined per-workspace as `icpGroups` on `WorkspaceConfig`. Used in persona match rules (a persona can require certain ICP groups) and dashboard filters.
- Code: `apps/web/lib/workspace-config.ts`

### Prospect type
A higher-level classification — "Customer", "Lead", "Internal", "Partner" (here, "partner" means the contact-side classification, not the partner-workspaces feature which has been removed from this template). Set on the contact row.
- Code: `apps/web/lib/db/contact-store.ts`

### DNC (Do Not Contact)
A time-bounded suppression. When set, outreach is suppressed until `do_not_contact_until` passes. Set on:
- AI-classifier detecting "not interested" in a reply
- Email bounce / complaint
- Manual user action

DNC is *temporal* — it decays automatically. Different from "Exclude" which is permanent.
- Code: columns `do_not_contact`, `do_not_contact_until`, `do_not_contact_reason_*`, `do_not_contact_source` on `contacts`

### Exclude
Permanent suppression of a contact. Used for internal team members, known competitors, anyone who should never be contacted regardless of state.
- Code: `excluded` column on `contacts`
- **Don't:** use Exclude for "they replied no" — that's DNC.

### Lifecycle state
LinkedIn URL lifecycle: `active` / `inactive`, set by Unipile resolution failures or repeated DM send-failures. Drives the Enrichment Candidates page.
- Code: `linkedin_url_status`, `needs_enrichment` columns

---

## Storage layers

### Upstash Redis
Stores `WorkspaceConfig` (one key per workspace at `workspace:<id>:config`). Includes encrypted secrets, slugs, scoring thresholds, personas, team members.
- Env: `KV_REST_API_URL`, `KV_REST_API_TOKEN`

### Postgres (projection)
Stores contacts, signals, companies (via grouping), outreach_log, style_fingerprints, etc. — the "warehouse" view of the workspace's data.
- Env: `POSTGRES_URL`
- Schema: `apps/web/lib/db/schema.sql`

### CRM (HubSpot or Attio)
The external mirror for contacts + companies (Postgres is the system of record; see ADR-010). Read via `findContactByEmail` etc.; written via `createContact` / `updateContact` / `createSignal`. The adapter is pluggable (`packages/crm-adapters/`) and chosen per workspace via `crmProvider`: `"hubspot"`, `"attio"`, or `"none"`.
- Code: `packages/crm-adapters/src/{hubspot,attio}-adapter.ts`; see `docs/CRM-ADAPTERS.md`

---

## Process artefacts

### Wizard
The first-run flow that provisions a workspace. Steps: questionnaire → upload → analyzing → blueprint → connect → provision.
- Code: `apps/web/app/wizard/*`

### Dashboard
The per-workspace UI rooted at `/dashboard/<workspace-uuid>/`. Sub-routes: `sdr` (action list), `companies`, `signals`, `actions` (channels + campaigns), `settings/*`, `reports/*`.
- Code: `apps/web/app/dashboard/[workspaceId]/`

### Blueprint
The schema describing the shape of a workspace's CRM setup (objects, attributes, lists). Lives in `packages/blueprint-schema/`. The wizard outputs a blueprint; the configured CRM adapter consumes it.

---

## PR + earned coverage

The trust-nested loop. The signal-first approach is PR-source-agnostic - any agency's coverage can feed it; MVPR's API is the automated path (see `docs/PR-LinkedIn-Measurement.md`, ADR-014). The differentiator is the approach, not the vendor.

### Coverage
A piece of earned media (article, podcast, award) with `tier`, `topics`, and the `journalist` + `publication` (incl. domain authority). Projected into `mvpr_coverage`. Carries `threadId` linking back to the pitch that won it.
- **Don't:** model coverage as a `signals` row. Coverage is content; the engagement *around* it (via Teamfluence) is the signal.

### Journalist thread
An outreach conversation with a journalist, with an `intent` (`pressRelease`, `outreach`, `newsjacking`, `opEd`, `opportunity`, `customOpportunity`), a `status`, and messages flagged `isFromJournalist`. Projected into `mvpr_threads`. The input side of coverage.

### Response rate / coverage rate
The two headline PR metrics. **Response rate** = threads a journalist replied to / threads sent. **Coverage rate** = threads that produced coverage / threads sent. Computed by `getPrPerformance()`, also split by intent and journalist.
- **Don't:** surface open rate. Inbox proxies make it unreliable; PR surfaces lead with response + coverage.

### PR signal verbs
`pr_pitch_sent`, `pr_journalist_replied`, `pr_coverage_published` - recorded against the **journalist** contact (a journalist is a person, not a prospect). See ADR-014; the emission writer is a documented next-step.
