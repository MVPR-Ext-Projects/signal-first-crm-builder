# 014 — MVPR is a first-class signal source, with PR-performance tracking

**Status:** Accepted (intent); signal-emission wiring incomplete

## Context

The differentiator of this product is the signal-first / trust-nested *approach*, which is PR-source-agnostic - any agency's earned coverage can feed it (see `PHILOSOPHY.md`, "Earned coverage is the highest-trust top-of-funnel signal"). MVPR is the PR platform this product integrates with, and its REST API is what makes feeding that loop automatic rather than manual (the API is MVPR's edge over other agencies, not a dependency of the approach). Until now the integration was framed narrowly: pull published coverage into `mvpr_coverage` for a reports page. That undersold it on two fronts.

1. **Earned coverage is a signal source, not just a report feed - and MVPR's API exposes the input side.** Its REST API exposes the journalist outreach behind coverage — pitch threads with an `intent` (`pressRelease`, `outreach`, `newsjacking`, `opEd`, `opportunity`, `customOpportunity`), a `status` (`DRAFT → OPENED → …`), and messages flagged `isFromJournalist`. A published `coverage` row carries the `threadId` it came from. So the platform knows, per pitch: did the journalist reply, and did it convert to coverage. That is behavioural signal of exactly the kind this CRM is built around — it just happens to be about journalists rather than prospects.

2. **The two numbers a PR-led GTM team lives by are response rate and coverage rate** — not open rate. Inbox privacy/proxy rules make opens unreliable, so MVPR surfaces lead with response and coverage. The old reports page even showed an "open ratio" column, which contradicts this.

The alternatives considered:
- *Leave MVPR as a coverage feed only.* Rejected - it throws away the thread-level signal (the input side) that makes "which messages land" answerable, which is the whole reason an API beats a manual agency relationship here.
- *Force PR events into the per-prospect `signals` table directly.* Rejected as the whole design — `signals.contact_id` is NOT NULL and the prospect funnel is about buyers, not journalists. PR signals belong to the **journalist contact** (a journalist is a person and dedups/companies the same way), and PR-performance aggregates belong in their own projection, not smeared across prospect scores.

## Decision

1. **Project journalist threads.** Add `mvpr_threads` (one row per MVPR thread, with `has_journalist_reply` derived at sync time and `intent`/`status` carried through) and link coverage back to its thread via `mvpr_coverage.thread_id`. The sync cron (`/api/cron/mvpr-coverage-sync`) pulls threads alongside coverage + announcements; watermark in `mvpr_sync_state.last_thread_sync_at`.

2. **Track PR performance on response + coverage rate.** `getPrPerformance(workspaceId)` (in `lib/db/coverage.ts`) computes, over non-draft threads:
   - `responseRate` = threads with a journalist reply / threads sent
   - `coverageRate` = threads that produced coverage / threads sent
   - the same two broken down by `intent` ("which messages land")
   - the most responsive journalists.
   The PR reports page surfaces this. **No open rate** anywhere in the PR surfaces.

3. **Add PR signal verbs.** `pr_pitch_sent`, `pr_journalist_replied`, `pr_coverage_published` join the signal-verb enum through the three places (ADR-007): the `schema.sql` comment, `DEFAULT_VERB_WEIGHTS` (lib verb model), and the dashboard label maps. They are recorded against the **journalist contact**. Default weights: pitch sent 0 (outbound, like `sent_dm`), journalist replied 5 (a real response), coverage published 15 (the PR "win", like a booked meeting). The canonical mapping lives next to the data in `lib/mvpr.ts` (`MvprSignalVerb`).

## Implementation status

**The template ships the projection, the tracking, and the verb enum, but not the signal-emission writer.**

What's there:
- `lib/mvpr.ts`: `MvprThread` types, `listThreads()`, `threadHasJournalistReply()`, `MvprSignalVerb`, and `MvprCoverage.threadId`.
- `mvpr_threads` table + `mvpr_coverage.thread_id` + `mvpr_sync_state.last_thread_sync_at` (in `schema.sql` and `scripts/migrate-add-mvpr-threads.mjs`).
- `lib/db/coverage.ts`: `upsertThread()`, `getPrPerformance()`, sync-state read/write extended.
- `lib/mvpr-sync.ts`: threads sync block.
- Reports surface: the "Journalist outreach performance" panel; the announcements "open ratio" column swapped to response rate.
- The three `pr_*` verbs in all three places with default weights.

What's missing (the deliberate gap, matching how ADR-012/013 ship):
- Nothing yet **writes** `pr_*` rows into `signals`. Emission needs a journalist-as-contact upsert: on thread/coverage sync, find-or-create the journalist contact (the dedup waterfall keys on the journalist's identity; the publication becomes the company), then append the verb. The helper belongs in `lib/db/contact-store.ts` (e.g. `recordPrSignal(workspaceId, { journalist, publication, verb, occurredAt })`) so the sync can call it per thread/coverage.
- Decision left open: whether journalist contacts share the prospect funnel or sit in a separate segment. Recommended — tag them (`prospect_type` = "Journalist" or an `is_journalist` flag) so PR relationship-building doesn't pollute the prospect SDR queue, while still being queryable.

Closing the gap is additive: the verbs, weights, labels, projection, and tracking are all in place; only the writer + the journalist-contact segmentation decision remain.

## Consequences

**Upsides:**
- Earned coverage and journalist relationships are first-class signals, not a side report - the trust-nested approach is structurally central to the funnel (and works with any PR source; MVPR's API just automates the feeding).
- "Which pitch angles land" and "which journalists actually engage" become queryable from `mvpr_threads` + `mvpr_coverage`, keyed by `intent` and `journalist_id`.
- Response/coverage rate are the headline PR metrics everywhere; open rate is gone.
- PR signals reuse the existing verb/weight/scoring plumbing — no parallel system.

**Downsides:**
- Journalist contacts entering the `contacts` table need segmentation or they clutter the prospect SDR view (flagged above as an open decision).
- The thread list endpoint has no incremental date filter, so the sync pages newest-first each run (capped). Fine at journalist-outreach volumes; revisit if a tenant's thread count ever rivals coverage volume.
- `coverage_rate` depends on MVPR populating `coverage.threadId`. Organic/unsourced coverage has a null `thread_id` and correctly doesn't count toward any thread's conversion.

## What would invalidate this decision

- MVPR exposing a dedicated per-journalist or per-thread stats endpoint that supersedes deriving rates from the projection — then prefer the platform's numbers (as the announcements panel already does for `coverageRatio`).
- A workspace that genuinely wants journalists in the prospect funnel (e.g. a media-sales motion) — then the segmentation flag flips to opt-out.
