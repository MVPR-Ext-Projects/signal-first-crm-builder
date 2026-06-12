# PR + LinkedIn + measurement: the closed loop

How earned PR coverage, LinkedIn matched-audience advertising, and Teamfluence engagement signals fit together inside the signal-first funnel.

Read [`PHILOSOPHY.md`](../PHILOSOPHY.md) first if you haven't - this doc assumes you already accept the "signal-first, not opportunity-first" framing.

---

## The theory in one paragraph

Cold outbound is decaying because the channels themselves carry no trust by default. **Trust-nesting** is the antidote: wrap high-trust content (earned media coverage, podcast clips, conference talks) inside high-reach, highly trackable channels (LinkedIn organic posts, LinkedIn Ads, email). The outer layer determines reach and attribution. The inner layer carries the credibility you can't manufacture yourself. The same Forbes article that lives anonymously on Forbes.com becomes a different asset when it sits inside a targeted LinkedIn Ad served to 1,200 named people in your ICP - because now you know who saw it, who engaged with it, and which of them is worth a follow-up. The signal-first funnel exists to capture exactly those engagement signals and turn them into pipeline.

Full theory + the data behind it: `Trust-Nested Selling` whitepaper (MVPR, Feb 2026).

---

## The loop, in five hops

```
   [1] MVPR Coverage API
        ↓ syncs hourly into mvpr_coverage
   [2] Build LinkedIn matched audience from your ICP CSV
        ↓ upload to LinkedIn Campaign Manager
   [3] Publish + sponsor the coverage on LinkedIn
        ↓ organic post + paid ad targeted at the matched audience
   [4] Teamfluence detects engagement
        ↓ webhook fires liked_post / commented_post / viewed_profile / followed_*
   [5] Signal-first funnel scores + surfaces
        ↓ SDR sees engaged contacts at the top of the action list,
          referencing the exact piece of high-trust content they engaged with
```

Every hop is wired into this template. The integration points are documented in the rest of this file.

---

## Hop 1: MVPR Coverage API (the slow layer)

**What:** Earned media coverage your PR team secured - articles, podcast appearances, awards, speaking slots - pulled from the MVPR PR platform via REST.

**Where in the codebase:**

- `apps/web/lib/mvpr.ts` - REST adapter: `listCoverages()`, `listAnnouncements()`, `getAnnouncement()`.
- `apps/web/lib/mvpr-sync.ts` - upserts into the `mvpr_coverage` and `mvpr_announcements` projection tables. Watermark in `mvpr_sync_state`.
- `apps/web/app/api/cron/mvpr-coverage-sync/route.ts` - runs every 6h (`apps/web/vercel.json`). Pulls coverages from `lastCoverageSyncAt - 1 day` to catch late edits.
- `apps/web/app/dashboard/[workspaceId]/settings/pr/page.tsx` - per-workspace config UI. Paste MVPR API key + per-tenant `baseUrl` (the URL embeds your MVPR company id).
- `apps/web/app/dashboard/[workspaceId]/reports/pr/page.tsx` - reports surface for coverage volume, domain authority, journalist mix.

**Coverage shape** (from `MvprCoverage` in `lib/mvpr.ts`):

```
title, link, summary, publishedAt, tier, topics, isOrganic, image,
journalist { name, publication { name, domainAuthority } }
```

`tier` and `publication.domainAuthority` are the two fields you'll lean on most when deciding which piece of coverage is worth promoting via LinkedIn Ads - the higher the DA, the stronger the trust payload.

**Setup:**

1. In MVPR, generate an API key scoped to your company.
2. Copy the per-tenant base URL from MVPR's API docs (ends in `/api/v1/companies/<your-company-id>/`).
3. Paste both into `/dashboard/<workspace>/settings/pr` and hit "Test". Then "Sync now" to backfill.
4. The 6-hourly cron keeps it warm from then on. `mvpr_sync_state` tracks watermarks per workspace.

**Why this is the slow layer:** you don't control when coverage gets published, you don't control the headline, and you can't A/B test it. What you do control is what happens AFTER it goes live - which is the rest of this doc.

---

## Hop 1b: Journalist outreach + PR performance (the input side)

Coverage is the output. The **input** is the outreach that won it - the pitches, who replied, what converted. With a traditional agency this lives in someone's inbox and a spreadsheet. MVPR's API exposes it as journalist threads, which is what lets the system track the input side automatically rather than by hand. (The trust-nested approach doesn't require this - it just makes it measurable and scalable.)

**What:** every pitch is a thread with an `intent` (`pressRelease`, `outreach`, `newsjacking`, `opEd`, `opportunity`, `customOpportunity`), a `status` (`DRAFT → OPENED → …`), and messages flagged `isFromJournalist`. A published coverage carries the `threadId` it came from. So per pitch we know: did the journalist reply, and did it convert to coverage.

**Where in the codebase:**
- `apps/web/lib/mvpr.ts` - `listThreads()`, `MvprThread`, `threadHasJournalistReply()`.
- `apps/web/lib/mvpr-sync.ts` - pages threads into `mvpr_threads` alongside coverage; watermark in `mvpr_sync_state.last_thread_sync_at`.
- `apps/web/lib/db/coverage.ts` - `getPrPerformance()` computes the two headline rates + breakdowns.
- `apps/web/app/dashboard/[workspaceId]/reports/pr/page.tsx` - the "Journalist outreach performance" panel.

**The two rates that matter (and the one that doesn't):**

| Metric | Definition | Why |
|---|---|---|
| **Response rate** | threads a journalist replied to / threads sent | Did the pitch land at all? |
| **Coverage rate** | threads that produced coverage / threads sent | Did it convert to earned media? |
| ~~Open rate~~ | *deliberately not surfaced* | Inbox privacy/proxy rules make opens unreliable - MVPR leads with response + coverage instead. |

Both are also broken down **by intent** ("which kinds of message land") and **by journalist** ("who actually engages"). Drafts (`status = 'DRAFT'`) are excluded from the denominator so unsent pitches don't depress the rate.

**PR events as signals:** coverage + journalist responses flow through the same signal lens as everything else, via three verbs (recorded against the *journalist* contact, not the prospect):
- `pr_pitch_sent` - we pitched a journalist (outbound; weight 0, like `sent_dm`)
- `pr_journalist_replied` - a journalist replied (a real response)
- `pr_coverage_published` - coverage went live (the PR "win"; scores like a booked meeting)

Per **ADR-014**, the projection, the tracking, and the verb enum ship in the template; the signal-*emission* writer (find-or-create the journalist as a contact, then append the verb) is a documented next-step in `lib/db/contact-store.ts`. Segment journalist contacts (e.g. `prospect_type = "Journalist"`) so PR relationship-building doesn't clutter the prospect SDR queue.

**Coverage also builds the influence graph (ADR-015).** Each coverage's journalist + publication is registered as a first-class *influencer*, and when a prospect is exposed to that coverage through a campaign (the LinkedIn/Resend wrapper), `lib/influence/edge-population.ts` draws the `influenced_by` edge. So "who influenced this prospect" is answerable from the same loop: the trusted source that carried your message becomes a node pointing at the people who engaged. Social-follow scrapes (LinkedIn topVoices, X) and publication-audience scrapes feed the same graph.

---

## Hop 2: Build a LinkedIn matched audience from your CRM

**What:** LinkedIn Campaign Manager accepts a CSV of contacts and matches them to LinkedIn profiles. You upload your ICP, LinkedIn builds an audience, and you can then run ads exclusively against that audience.

**Where in the codebase:**

- Today: no scripted export from `contacts` to the LinkedIn CSV format. Run an ad-hoc SQL export (see "CSV format" below) or use the dashboard's CSV export from the SDR action list.
- Roadmap: a `/dashboard/<workspace>/audiences` page that produces a LinkedIn-ready CSV per persona + per funnel stage. Not built yet - flag if you'd like to scope it.

**CSV format that LinkedIn Campaign Manager accepts:**

```
email,firstname,lastname,jobtitle,employeecompany,country,googleaid
```

All columns optional except at least one matchable field (email or first+last+company). LinkedIn matches probabilistically: a 5,000-row upload typically resolves to 60-85% matched profiles. Below ~300 matched profiles LinkedIn refuses to serve ads (privacy floor), so target ≥500 rows per audience.

**Which contacts to upload (signal-first, not firmographic-first):**

The whole point of this template is to start with behaviour, not filters. Three audiences worth building:

| Audience | SQL outline | Use it for |
|---|---|---|
| **Recent engagers** | contacts with `last_signal_at > now() - interval '30 days'` and `signal_score >= threshold.signalFound` | Retargeting: serve them the next piece of coverage |
| **Persona-matched cold** | contacts with `persona_id IS NOT NULL` and `signal_count = 0` | Top-of-funnel ABM: warm them up via paid distribution of high-trust content |
| **Company peers of MQLs** | contacts at companies where another contact is `manual_stage = 'Discovery Call'` | Multi-thread inside accounts already in the funnel |

Each audience corresponds to a different layer of the trust-nesting model (layers 1-3 vs 4 vs 5 in the whitepaper).

**Hygiene:** strip DNC contacts (`do_not_contact = true`) before upload. LinkedIn doesn't know about your DNC list, so it'll happily serve ads to people you've classified as not-interested. Filter at export time.

---

## Hop 3: Publish + sponsor the coverage on LinkedIn

This is where you do the trust-nesting. The pattern:

1. **Organic post first.** A team member (usually the named author of the coverage, or the CEO) posts a screenshot of the article + 2-3 paragraphs of their own framing + a link. The organic post collects the first wave of engagement from your existing network and gives Teamfluence something to track.
2. **Boost OR re-post as a Sponsored Content ad** in LinkedIn Campaign Manager, targeted at the matched audience from Hop 2. The ad creative shows the coverage's outer layer (publication logo, headline) - that's the credibility payload. The inner layer is the click-through to the article itself, or a landing page that nests the article.
3. **Peer endorsement (optional, high-leverage):** tag 1-3 named commentators in the organic post. When they re-share with their own framing, that's the third trust layer in the whitepaper - their network sees the coverage validated twice.

**Where in the codebase:** there is no LinkedIn Ads API integration in this template. Campaign creation, audience upload, and budget are done manually in LinkedIn Campaign Manager. The template's job is to (a) tell you which coverage to promote (Hop 1) and (b) measure the result (Hops 4-5).

**Which coverage is worth sponsoring** - rule of thumb:

- Publication's `domainAuthority` ≥ 60, OR
- `tier` set to "Top tier" in MVPR, OR
- Coverage's `topics` overlap with a named ICP problem you already have a campaign for.

Below those thresholds, the trust payload usually isn't strong enough to justify the paid spend - run it through the newsletter instead.

---

## Hop 4: Teamfluence detects who engaged

**What:** Teamfluence monitors LinkedIn engagement against your team's profiles + your company page and fires a webhook on every event (like, comment, profile view, follow, accepted connection).

**Where in the codebase:**

- `apps/web/app/api/webhooks/[workspaceId]/teamfluence/route.ts` - inbound handler. Per `docs/WEBHOOKS.md`, auth is by the workspace UUID in the URL path; idempotency is `teamfluence:<event-id>`.
- Verbs written that close this loop:
  - `liked_post` - engaged with your organic post or paid ad
  - `commented_post` - higher-intent engagement
  - `viewed_profile` - implicit interest, often follows an ad impression
  - `followed_our_team_member` / `followed_our_company` - strongest mid-funnel signal
- Each verb has a per-workspace score weight in `WorkspaceConfig.scoring.verbWeights`. Tune these higher for the verbs that correlate with pipeline in your data (typically `commented_post` and `followed_our_*`).

**Attribution to the coverage:** Teamfluence's payload includes `post_url`. When the engagement is on a sponsored post, that URL resolves back to the LinkedIn post you boosted - which you can match to the underlying `mvpr_coverage.id` if you keep a manual mapping table. (Not automated today; on the roadmap.) For now, treat the temporal correlation as enough: spike in `liked_post` signals + spike in `mvpr_coverage` rows from the same campaign window = the loop is closing.

**Implicit closure of the loop:** even without a hard FK between coverage and signal, the SDR sees on the action list "Sam at Acme - liked your post 2h ago" - and knows the post was about your CEO's Forbes piece. That's enough for the human-in-the-loop step. The data infrastructure exists primarily to surface the right person at the right moment, not to produce a closed-form attribution report.

---

## Hop 5: The signal-first funnel scores + surfaces

This is the system this template was built around. The signals from Hop 4 flow through:

1. **Score derivation** (`apps/web/lib/db/contact-store.ts`): each verb adds its workspace-specific weight to the contact's `signal_score`.
2. **Funnel stage** is recomputed against `WorkspaceConfig.scoring.thresholds`. A contact at score 24 moves from "Engaged" to "High Signal".
3. **Persona match** is re-run if the contact is now in scope (`pickPersona()`).
4. **Surfacing**: the contact rises on the SDR action list (`/dashboard/<workspace>/sdr`), reorderable by `last_signal_at DESC`. The contact's most-recent signal is rendered next to their name - the SDR sees "liked your post about the new EU AI Act compliance changes" before they draft anything.
5. **Drafting**: when the SDR clicks "Draft DM", the drafter pulls recent signals into the prompt context. The draft references the specific piece of coverage they engaged with, not a generic product pitch. See `docs/DRAFTER.md` and ADR-004 on fingerprint scopes for how the voice is resolved.

**The outreach message is "earned-first", not cold:**

> "Saw you engaged with [CEO]'s piece in [publication] on [topic]. We've been tracking how teams like yours handle [problem the article addresses] - worth a 15-minute conversation?"

That's the message the whitepaper calls layer 5 - direct outreach based on evidence of engagement with high-trust sources.

---

## How you know the loop is closing

Read these surfaces in this order:

1. **`/dashboard/<workspace>/reports/pr`** - coverage volume, DA distribution, top journalists. If this is empty, fix Hop 1 first.
2. **Teamfluence signals per day** (`SELECT date_trunc('day', created_at), signal_verb, count(*) FROM signals WHERE workspace_id = $1 AND signal_verb IN ('liked_post','commented_post','viewed_profile','followed_our_company','followed_our_team_member') GROUP BY 1, 2 ORDER BY 1 DESC`). Spike in the days following a sponsored campaign = trust-nesting working.
3. **SDR action list** - are engaged contacts actually getting reached out to? `outreach_log` row count vs `last_signal_at` recency on the same contact.
4. **Booked meetings** (`signals WHERE signal_verb = 'booked_meeting'`) where the same contact has a `liked_post` or `followed_our_company` signal in the prior 14 days. That's the attribution chain in this codebase, even without a hard FK between coverage and signal.

If you see (1) but not (2), Teamfluence isn't wired up or the matched audience is too narrow. If you see (1) + (2) but not (3), the SDR action list isn't being worked - that's a sales operations problem, not a tooling one. If you see (1) + (2) + (3) but not (4), the script the SDRs are using isn't referencing the trust source.

---

## What this template doesn't automate (yet)

The integration is end-to-end except for two manual steps:

1. **LinkedIn audience export** - you generate the CSV by hand from a SQL export or the dashboard CSV button. No `/audiences` page yet.
2. **LinkedIn Ads campaign creation** - all done in LinkedIn Campaign Manager directly. No LinkedIn Ads API integration.

Both are deliberate scope cuts - the template's primary value is the funnel + the signal capture, not the ad-buying mechanics. You can wire these up if you want to fully automate, but the closed loop works without them.

---

## Companion reading

- [`PHILOSOPHY.md`](../PHILOSOPHY.md) - why this codebase starts from signals, not firmographics.
- [`docs/WEBHOOKS.md`](./WEBHOOKS.md) - Teamfluence webhook contract in full.
- [`docs/CAMPAIGNS.md`](./CAMPAIGNS.md) - what a campaign is in this system, and how delivery flows.
- [`docs/DRAFTER.md`](./DRAFTER.md) - how the LLM-backed drafter consumes signal context.
- [`docs/adr/004-three-fingerprint-scopes.md`](./adr/004-three-fingerprint-scopes.md) - how the voice for these "earned-first" messages gets resolved.
- `Trust-Nested Selling` whitepaper (MVPR, Feb 2026) - the theory and the data behind why this works.
