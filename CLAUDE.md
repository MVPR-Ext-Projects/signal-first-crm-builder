# Signal-First CRM Template

> This is a template forked from gtm-os, an opinionated signal-first CRM
> built for B2B outbound. It's PR-shaped (the workflow is "signal arrives -> qualify -> draft personalised reach-out"), seeded with an example workspace ("Acme Demo", a B2B platform-observability shape)
> personas and ICP. Postgres is the system of record; an external CRM is
> optional - the bundled HubSpot adapter is one write target, and
> `crmProvider: "none"` runs the whole system natively with no CRM at all.
>
> Customize freely. The architecture below survives most changes; the
> seed data is meant to be replaced.

## Pre-work checklist

Run through this before designing or coding any non-trivial change. Each item is "have I thought about X" — you don't need to act on each, but you do need to have considered it.

1. **Sync the repo.** `git fetch && git status`. Pull before claiming what does or doesn't exist; on shared repos local checkouts go stale fast.
2. **Read "Architectural caveats" below.** Postgres is the system of record and the external CRM is an optional mirror, Dripify and Teamfluence ingest paths are asymmetric, fingerprints stack three layers — none of these show up in the file you're touching.
3. **Multi-tenancy.** Every read/write scopes by `workspace_id` as the leading key. Indexes assume it.
4. **Cross-source consistency.** Touching signal logic? Will the change need to apply to both the Dripify and Teamfluence webhooks? Decide upfront.
5. **Reporting impact.** Will users see different numbers in `reports/` or `costs/` after this change? Audit and update in the same commit.
6. **Postgres migration.** Schema change? Plan a `scripts/migrate-*.mjs` script — `schema.sql` is for fresh installs only.

## Where things live

| Concern | Path |
| --- | --- |
| Inbound webhook handlers | `apps/web/app/api/webhooks/[workspaceId]/{calendly,dripify,hubspot,teamfluence,unipile,stripe}/route.ts` — see `docs/WEBHOOKS.md` for per-provider auth model, idempotency, CRM-push decisions |
| CRM adapter abstraction | `packages/crm-adapters/` (HubSpot + Attio), with thin app-side wrapper + factory in `apps/web/lib/crm/`. Pick per workspace via `crmProvider`. See `docs/CRM-ADAPTERS.md` |
| Postgres projection schema | `apps/web/lib/db/schema.sql` |
| Postgres write helpers | `apps/web/lib/db/contact-store.ts` |
| Influence graph (influencers + M2M) | `apps/web/lib/db/influencers.ts` (`influences` / `influenced_by`); tables in `schema.sql`; MVPR populates it. See ADR-015 |
| Workspace config (encrypted secrets, team members, slugs) | `apps/web/lib/workspace-config.ts` |
| Wizard flow | `apps/web/app/wizard/{questionnaire,upload,analyzing,blueprint,connect,provision}/` |
| Dashboard | `apps/web/app/dashboard/[workspaceId]/` |
| Cron declarations | `apps/web/vercel.json` |
| Admin / backfill scripts | `apps/web/app/api/admin/`, `scripts/` |
| Example seed | `seed/example-workspace.json` |

## Architectural caveats

Read these before suggesting changes. They trip up agents who reason from filenames alone.

### Companies are a first-class table, populated at runtime

The `companies` table is the first-class entity (see `apps/web/lib/db/schema.sql` around line 447). It ships **empty** - the template is architecture, not data - and self-populates as signals arrive. Identity is resolved by a deterministic dedup waterfall: `linkedin_url > domain > canonical_name`. Unique partial indexes on `(workspace_id, linkedin_url)` and `(workspace_id, domain)` give race-safe upsert. `contacts.gtm_company_id` is the FK. See ADR-002.

In a fresh install, every contact gets `gtm_company_id` populated from day one (the webhook handlers run the waterfall on every write). You won't be in any "transitional state" — unless you import legacy data from another CRM, in which case run the waterfall against the import as part of the seed.

The side tables `company_tags` and `company_enrichments` still key on `(workspace_id, company_name)` for now (inherited from gtm-os). They're not load-bearing — in a fresh install they get populated alongside `gtm_company_id` correctly. New code should always use `gtm_company_id` as the canonical company key. If you must reference a side table by `company_name`, leave a `// TODO(companies-side-tables)` comment.

### Dripify vs Teamfluence ingest asymmetry

Both write LinkedIn-follow signals to Postgres (the system of record). They differ in payload and in whether they also mirror to an external CRM:

- **Teamfluence** sends `company.linkedin_url`, `domain`, `name`. Stores `company_linkedin_url` on the contact. When a CRM is connected (`crmProvider !== "none"`), it also mirrors to it — find-or-create company by domain → name. With `crmProvider: "none"` the mirror step is simply a no-op; the signal still lands in Postgres.
- **Dripify** sends `company` (name string), `companyWebsite`, `numberOfCompanyEmployees`. Does **not** send the company's LinkedIn URL. Writes to Postgres only — Dripify signals deliberately do not push to the external CRM at signal-write time. A Dripify-tracked contact ends up in HubSpot via the general stage-transition path (e.g. when they hit Discovery Call via the meeting-booked trigger in ADR-012; Discovery Call = Meeting Booked = MQL in this codebase) — not via a Dripify-specific graduation rule.

### Funnel-stage thresholds are per-workspace

Score-derived funnel stage (Prospect, Signal Found, Engaged, High Signal) is computed from `signal_score` using per-workspace thresholds in `WorkspaceConfig.scoring.thresholds`. Manual / deal stages (Discovery Call, Sent Information, Customer Won, etc.) are set directly by the user and are not score-derived.

### Writing-style fingerprints stack three layers; do not skip the channel-only scope

The `style_fingerprints` table has three scopes: `corporate` (workspace-wide), `channel` (Action-Set-level voice for a channel, persona unset), and `channel_persona` (per channel + persona). At draft time, `apps/web/lib/style/fetch-fingerprints.ts` resolves least-to-most specific: corporate < channel < channel_persona, and `outreach_log.fingerprint_version_id` records the most-specific row that drove the draft.

Common footguns:
- When adding a new draft endpoint, always fetch the **channel** layer too, not just `channel_persona`. A contact without a persona match still gets an Action-Set voice from the channel layer.
- Hard-coding `scope='channel_persona'` re-introduces the bug the channel scope was added to fix.
- Outbound Calls is intentionally **not** a fingerprint channel — fingerprints model written voice only. Do not extend `StyleChannel` with `outbound_call`.

### Signal verbs are a code-level enum

Maintained in:
1. The comment block in `apps/web/lib/db/schema.sql` around the `signals.signal_verb` column
2. The verb model in `apps/web/lib/`
3. The dashboard label map

Adding a new verb means touching all three. Current verbs include `liked_post`, `commented_post`, `viewed_profile`, `followed_our_team_member`, `followed_our_company`, `followed_prospect`, `accepted_our_connection`, `sent_connection_request`, `connected`, `sent_dm`, `replied_dm_initial`, `replied_dm_subsequent`, `sent_email`, `replied_email`, `booked_meeting`, `ai_search`, the MVPR PR verbs (`pr_pitch_sent`, `pr_journalist_replied`, `pr_coverage_published` — see ADR-014), plus Resend lifecycle verbs (`email_sent`, `email_delivered`, `email_opened`, `email_clicked`, `email_bounced`, etc.).

### Earned coverage is a first-class signal source; MVPR is the automated way to feed it

The differentiator is the signal-first / trust-nested *approach*, which is PR-source-agnostic - any agency's coverage can feed the loop (manually). MVPR is a PR platform whose REST API (`lib/mvpr.ts`) makes that automatic: published **coverage** (`mvpr_coverage`), the journalist outreach **threads** behind it (`mvpr_threads`, with `intent` + `status` + `has_journalist_reply`), and PR-performance derived from both. Coverage links to its originating pitch via `mvpr_coverage.thread_id`. The API is MVPR's edge over other agencies, not a dependency of the approach - never make the funnel require MVPR to be present.

- **Lead with response rate + coverage rate, never open rate.** Inbox proxies make opens unreliable. `getPrPerformance()` computes response/coverage rate (overall, by intent, by journalist); PR surfaces must not reintroduce an open-rate column.
- **PR events are signals.** `pr_pitch_sent` / `pr_journalist_replied` / `pr_coverage_published` are real verbs, recorded against the **journalist contact** (not prospects). Per ADR-014 the projection + tracking + verbs ship, but the signal-emission *writer* (journalist-as-contact upsert) is a documented gap - wire it in `lib/db/contact-store.ts`, and segment journalist contacts so they don't pollute the prospect SDR queue.
- Don't reframe the `mvpr_*` tables as "legacy / future integration" - that was stale anonymisation wording. The integration is live; see ADR-014 and `docs/PR-LinkedIn-Measurement.md`.
- **MVPR also feeds the influence graph (ADR-015).** Each coverage's journalist + publication is upserted into the first-class `influencers` entity (separate from contacts), M2M with prospects via `influences` / `influenced_by`. Prospect *edges* are drawn by `lib/influence/edge-population.ts` from three sources: coverage engagement wrapped in a campaign (wired into `enrollContact`), social-follow scrapes (wired into the LinkedIn + X interest routes), and publication-audience batches (helper ready). Don't model an influencer as a contact. Adding an IG/FB follow source = map its accounts and call `linkFollowedInfluencers`.

## Pre-commit eval

1. **`git fetch`.** Conflicting work landed? Rebase before committing.
2. **Multi-tenancy.** Every new Postgres query scopes by `workspace_id`?
3. **Cross-source consistency.** If signal logic changed in one webhook, did the other one need the same change?
5. **Schema migrations.** If `schema.sql` changed, is there a matching `scripts/migrate-*.mjs` script?
6. **WorkspaceConfig.** If you added a field: type ✓, `encryptIfNeeded` / `decrypt` round-trip ✓, `scripts/seed-workspaces.mjs` ✓, getter ✓, wizard step ✓?
7. **Reports + costs pages.** If verbs/scores/source types/personas/usage_log instrumentation changed, are the reports and costs pages still showing the right numbers?
8. **No em dashes.** Final scan of code, copy, doc, and commit message — all use plain hyphens.

## Conventions

- **No em dashes** in any UI copy, doc, or commit message. Use plain hyphens.
- Webhook secrets are AES-encrypted at rest in `webhookSecrets.{teamfluence,dripify,unipile,calendly}` on `WorkspaceConfig`.
- Crons declared in `apps/web/vercel.json` execute via the Next.js routes they point at.
- **Funnel stage ordering** for don't-regress rules lives in `apps/web/lib/funnel-order.ts` (`FUNNEL_ORDER` constant), separate from the display-order arrays in `stage-select.tsx`. Don't use `SDR_STAGES.indexOf(...)` for stage comparisons; always go through `FUNNEL_ORDER`. See ADR-013 + ADR-012.
- **`vercel.json` placement:** lives in the project's Root Directory, not the repo root. Don't add a `vercel.json` at the monorepo root.
- **Verify Vercel deploys by content, not status.** Run `scripts/verify-vercel-deploy.mjs --url <prod-url> --expect <marker>` after settings changes or first deploys. The Vercel "● Ready" badge means "the build process completed", not "the right thing was built".
- **Pre-flight inspect before any destructive Redis op.** Run `scripts/inspect-workspace-encrypted-fields.mjs` (read-only) before rotating `ENCRYPTION_KEY` or running `clear-encrypted-workspace-fields.mjs` / `delete-workspace-config.mjs`. Backups land in `/tmp/` on destructive scripts; keep them until verified recovered.

## Notes for Claude Code sessions

- This file is the operating manual. `AGENTS.md` is a stub pointing here.
- Start of any non-trivial work: read this file, run the pre-work checklist, then start.
- This is a fork - gtm-os upstream may have evolved. There's no automatic upstream sync; you can `git remote add upstream <gtm-os-url>` if you want to cherry-pick fixes manually.
- The seed at `seed/example-workspace.json` is an example workspace ("Acme Demo") shaped as a B2B platform-observability company. It's there to demonstrate what a populated workspace looks like — replace freely as you customize the workspace for your needs.
- Attio is a first-class CRM adapter again (`packages/crm-adapters/src/attio-adapter.ts`), selected via `crmProvider: "attio"`. The Attio-style `api_slug` machinery (`slugs`, `resolveSlug`, `ResolvedSlugs`) is what the adapter consumes — load-bearing for Attio workspaces, ignored by HubSpot ones. Older comments in `contact-store.ts` / `enrichment.ts` / `apps/attribution/` that imply "Attio is legacy / everything routes to HubSpot" predate this and are stale — both adapters are live. See `docs/CRM-ADAPTERS.md`.

## Companion docs

This file is the operating manual. For deeper context, read:

- [MAP.md](./MAP.md) - visual knowledge map (Mermaid diagram + lifecycle prose). Bird's-eye view with clickable links to every other doc. A standalone [MAP.html](./MAP.html) renders the same diagram in any browser.
- [PHILOSOPHY.md](./PHILOSOPHY.md) - design tenets and what would break the design. Read once when onboarding.
- [GLOSSARY.md](./GLOSSARY.md) - canonical product terms.
- [ARCHITECTURE.md](./ARCHITECTURE.md) - storage layers + end-to-end signal lifecycle.
- [docs/adr/](./docs/adr/) - architectural decision records. Read the relevant ADR BEFORE proposing changes in that area; chances are the alternative you're suggesting was considered and rejected for a load-bearing reason.
- [docs/CRM-ADAPTERS.md](./docs/CRM-ADAPTERS.md) - choosing + configuring the CRM mirror (HubSpot vs Attio vs none).
- [docs/WEBHOOKS.md](./docs/WEBHOOKS.md) - per-provider cookbook (Teamfluence / Dripify / Calendly / Stripe / Unipile / HubSpot / Resend).
- [docs/CAMPAIGNS.md](./docs/CAMPAIGNS.md) - campaigns, templates, delivery flow, click attribution.
- [docs/CONTACTS.md](./docs/CONTACTS.md) - the five ways people enter the system + dedup behaviour.
- [docs/DRAFTER.md](./docs/DRAFTER.md) - how the LLM-backed drafter consumes persona + fingerprint + signal context.
- [docs/PR-LinkedIn-Measurement.md](./docs/PR-LinkedIn-Measurement.md) - the closed loop: PR coverage + LinkedIn matched-audience ads + Teamfluence engagement signals + the signal-first funnel.

## Slash commands available

- `/add-signal-verb` - guides through the three-places update
- `/audit-personas` - flags persona overlaps + gaps + sparse fields
- `/review-fingerprint` - sanity-check a writing-style fingerprint
- `/add-webhook` - scaffold a new inbound webhook handler
- `/migrate-schema` - scaffold a new Postgres migration script

## Sub-agents to spawn proactively

- `multi-tenancy-reviewer` - after editing any DB or workspace-config code
- `persona-coverage-auditor` - after editing personas
- `signal-verb-consistency-checker` - after adding/renaming a signal verb
- `fingerprint-scope-checker` - after editing a draft endpoint or fingerprint logic
