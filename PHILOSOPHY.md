# Philosophy

> Why this CRM is shaped the way it is. Read this before "fixing" anything that looks weird — most weirdness is deliberate, and removing it breaks the design.

This document is the load-bearing "why" layer. `CLAUDE.md` tells you *how* the code is organised; this tells you *what it's trying to be*. When you make customization decisions, check here first.

---

## The core bet: signals, not opportunities

Most CRMs are **opportunity-first**: you create a "deal" or "opportunity" record, assign it a stage, and update the stage as the deal progresses. The data model assumes the seller knows the deal exists.

This CRM is **signal-first**: the unit of truth is a *signal* — something a real human did (followed, liked, commented, viewed, replied, booked, published). Signals arrive from inbound integrations (Teamfluence, Dripify, Unipile, Calendly, Stripe, Resend) and from earned coverage + journalist responses (the trust-nested loop - see the "Earned coverage is the highest-trust top-of-funnel signal" tenet below; MVPR's API is the automated way to feed it, but any PR source works). The score derived from signals drives the funnel; the human's behaviour is the source of truth, not the seller's intuition.

**Why this matters when you customize:**
- Don't add an "Opportunity" or "Deal" object as a peer to `signals`. It re-introduces the bet you didn't make.
- Don't let users manually set `signal_score` without a signal-emitting event. The score must be derivable from `signals` so it's auditable.
- Manual stages (`manual_stage` like "Discovery Call", "Customer Won") are an *override layer* on top of the score-derived funnel, not a parallel system. Use them only for deal-progress markers a human asserts, not for signals.

**The footgun:** seductive product asks like "let me drag a contact into 'Engaged' manually" or "let me bulk-edit a hundred contacts to stage X." If you grant them, you've turned a signal-first CRM into a stage-first CRM and the auditability collapses.

---

## Earned coverage is the highest-trust top-of-funnel signal (and it's PR-source-agnostic)

Most outbound tools start from firmographics: pick an ICP, buy a list, spray. This one starts from *trust*. The differentiator is the **approach**, not any one vendor: react to whoever engages with your high-trust earned coverage, rather than to a firmographic filter.

The loop ("trust-nesting"): earned coverage gets promoted via LinkedIn to a matched ICP audience, the resulting engagement comes back as Teamfluence signals, and the funnel surfaces the named humans who engaged with a specific high-trust asset. Wrap credibility you earned inside reach you control. Full walkthrough in `docs/PR-LinkedIn-Measurement.md`.

**This is vendor-neutral.** Any PR agency's coverage can feed the loop. The signal-first approach doesn't depend on where the coverage came from. The only difference with a traditional agency relationship is operational: you feed coverage in by hand and track response/coverage rates in a spreadsheet - it works, it just scales poorly and is hard to measure.

**Where MVPR fits.** MVPR is a PR platform with a REST API for your coverage, the journalist outreach threads behind it, and PR-performance data. That API turns the manual parts automatic - the sync pulls coverage + threads, and response/coverage rates compute themselves. That's a convenience-and-scale win, and it's MVPR's edge *over other agencies*; it is not what makes the signal-first approach work. Don't conflate the two: the approach is the moat, the API is a better on-ramp to it.

**Why this matters when you customize:**
- Treat earned coverage + journalist responses as a first-class **signal source**, peer to the LinkedIn/email sources - not a reporting afterthought. PR events flow through the same `signals` lens (the `pr_*` verbs), whatever the coverage source.
- Keep MVPR optional. `crmProvider: "none"` and an absent MVPR key must both still work; without the API a workspace feeds coverage manually, and the loop is unchanged. Never make the approach depend on MVPR being present.
- Don't bury the PR-performance numbers (response rate, coverage rate, message-landing). They're how a PR-led GTM team proves the top of the funnel is working - and the thing the MVPR API makes cheap to compute.

---

## Model influence, so trust-nesting is targeted, not sprayed

This is *why* influencers are a first-class entity (the relational influence graph: `influencers` + `influenced_by`), not just a field on a contact.

Knowing **who influences the people you sell to** is the upfront analysis that turns PR, comms, speaking, and events from a broad bet into an engineered one. Your prospects already trust certain people and sources - some are peers (individuals), some are third parties (publications, podcasts, companies). That trust is a map. Without it, "do PR" means chasing an enormous, undifferentiated landscape and hoping the right people happen to see it. With it, you can see that the buyers you care about cluster around a specific, much smaller set of high-trust sources, and aim there.

That is trust-nesting run deliberately:

1. **Analyse first.** Know who your prospects are *and* who they trust (the influence graph).
2. **Narrow to the highest-trust sources for *those* prospects**, not the broad market. A mid-tier outlet your buyers actually read beats a famous one they don't.
3. **Earn coverage from those sources.** Get the people and publications your prospects already trust to talk about you.
4. **Don't leave the reach to chance.** Take that earned content, wrap it in your own channels (a LinkedIn post, an ad), and put it specifically in front of the prospects you know trust that source.
5. **Trust transfers.** The prospect meets content they already trust, and it contains you. The inference ("if that source vouches for them, they're credible") happens - but engineered, not hoped for.

The influence graph is what makes steps 2 and 4 *targetable*. It's the difference between "we got written about" and "we got written about by the exact source these buyers trust, then served it back to them."

**When you customize:**
- Treat the influence graph as decision-support for *where to spend PR/comms effort*, not a CRM curiosity. Its value is narrowing the landscape before you spend a penny on outreach or ads.
- An influencer can be a peer or a third party (person or organization). Model both; don't collapse it to "journalists only."
- Populate it from every angle you can - who prospects follow, who engages with whose coverage, who follows a publication. The denser the graph, the sharper the targeting.

---

## Postgres is the system of record; the external CRM is optional

This is the load-bearing inversion of how most outbound tools are built. Here, **Postgres is the system of record** - contacts, signals, companies, scores, funnel stage, and the outreach log all live there and are complete from day one. An external CRM (the template bundles HubSpot and Attio adapters) is an **optional, downstream mirror**, not the source of truth.

A workspace can run fully native with `crmProvider: "none"` - no external CRM at all - and lose nothing. The dashboard, scoring, drafting, and reporting all read from Postgres. This is why a fresh install is useful the moment the first signal lands, before any CRM is connected.

When a CRM *is* connected, the write is **gated, not continuous**. The system does not mirror every signal outward:

- **Top-of-funnel signal capture stays native.** Early engagement (likes, comments, follows, profile views) accumulates in Postgres only. Dripify-sourced signals in particular never push outward at signal-write time.
- **The external CRM receives a contact at handoff.** The natural handoff point is the meeting-booked / MQL transition (Discovery Call) - the moment a prospect becomes a real sales object worth carrying in the CRM your closers live in. Syncing every cold follow before that just fills the CRM with noise.

**When you customize:**
- Don't treat the external CRM as authoritative. If Postgres and the CRM disagree, Postgres wins; the CRM is downstream.
- Don't add a "sync everything, always" path. Gating at handoff is what keeps the CRM clean - only qualified contacts cross over.
- Adding a second CRM means adding a `CrmAdapter` implementation, not rewriting the core. The core never assumed a specific CRM, or any CRM.
- `crmProvider: "none"` is a first-class mode, not a degraded one. Anything you build must still work with no CRM connected.

---

## Per-workspace, by default

Every read and write scopes by `workspace_id` as the leading key. Indexes are designed for it. The wizard provisions a workspace; the dashboard URL embeds it; `WorkspaceConfig` carries every per-tenant setting.

This is multi-tenant from day one, not bolted on. Even if you're going to run a single workspace forever, leave the scoping in. The cost of keeping it is zero; the cost of removing and later re-adding it is catastrophic.

**When you customize:**
- Every new Postgres query scopes by `workspace_id` first. Indexes assume it.
- Every new field on `WorkspaceConfig` goes through the same encryption / decryption / seed / wizard / dashboard plumbing the existing fields use. Skipping any step breaks one of the round-trip flows.
- Don't add "global" config (process env var, hardcoded constant, build-time flag) for something that should be per-workspace. Adding workspace-scoping later requires a backfill.

---

## Three personalisation layers, stacked

For any outbound message, the system layers three sources of "who this contact is and how we should talk to them":

1. **Persona** — a match against ICP + job title + company size + country. Encodes the *buyer*. Defined per-workspace in `WorkspaceConfig.messaging.personas`. First-match-wins; declare specific personas first.

2. **Style fingerprint** — a written-voice profile that controls *how* to write to them. Three scopes resolved least-to-most-specific: `corporate` (workspace-wide), `channel` (per delivery channel), `channel_persona` (per channel + persona). The most-specific row that matches drives the draft.

3. **Workspace config** — slugs, scoring thresholds, exclusion rules. Sets the workspace-wide defaults the other two layers sit on top of.

When a draft is generated, the system resolves layer 1 (persona), then layer 2 (fingerprint at the most-specific resolved scope), then renders with layer 3 (workspace config) as the surrounding context.

**When you customize:**
- Don't merge personas + fingerprints into one concept. They answer different questions: "who is this person?" vs "how do we sound when we write?"
- Don't extend `StyleChannel` with voice-modelled channels (e.g. `outbound_call`). Fingerprints model *written* voice. Voice-only channels live elsewhere.
- When you add a new draft endpoint, *always* fetch the `channel` layer too, not just `channel_persona`. A contact without a persona match still gets a channel-level voice. Hard-coding `scope='channel_persona'` re-introduces a bug we already fixed.

## Why writing-style fingerprints exist

The fingerprint system is the product's single most differentiated concept. Most LLM-driven outbound tools rely on prompt engineering: instruct the model to "be conversational and concise" and hope for the best. Fingerprints exist because that approach is structurally insufficient.

**The problem with prompt-engineered voice:**

- **Drift.** Sellers can't paste 20 examples into every prompt. They paste 2, the model regresses to generic, and every contact gets the same GPT-sounding draft.
- **Inconsistency.** The same buyer receives different voices across different sends because "be conversational" is interpreted differently each time.
- **Brand damage at scale.** When 500 prospects in a week all receive openings like "I noticed you recently engaged with..." or "I hope this finds you well," the inbox-level signal is unmistakable: this is automation. Open rates and reply rates collapse. The brand pays the cost.
- **No attribution.** When a draft gets a reply, you can't measure *which voice instruction* worked. There's no version, no scope, no A/B handle.
- **No reuse.** A marketing team can't share a voice across SDRs. New hires can't inherit a fingerprint. Every seller reinvents.

**What fingerprints solve:**

A fingerprint is a *structured, corpus-derived voice profile*, not a free-text prompt instruction. It captures:

- **Vocabulary preferences** — words to use, words to avoid (e.g. forbidden: "circling back," "touching base").
- **Sentence patterns** — average length, complexity, punctuation rules (e.g. no em dashes — see Conventions).
- **Paragraph shape** — opener style, body structure, closer style.
- **Tone axes** — formality, warmth, directness, scaled.
- **Forbidden patterns** — things never to do, regardless of channel or persona.

Critically, a fingerprint is a *constraint on the LLM, not a hint*. The drafter loads the right fingerprint and renders the prompt against it; the LLM has measurably less latitude to drift.

**Why three scopes (corporate / channel / channel_persona):**

- The workspace has a default voice baseline (corporate). Everything inherits from it.
- Different channels have legitimately different voices — a LinkedIn DM is shorter and warmer than a newsletter; an email is more formal than a DM. The channel scope captures this without rewriting the baseline.
- Different personas need different voices for the same channel — a CFO email reads differently than a Head of Product email. The channel_persona scope captures this without rewriting the channel default.

The three-layer stack means a new workspace can ship with ONE fingerprint (corporate) and get reasonable drafts immediately. Power users opt into channel-level overrides only where they matter, and channel_persona overrides only for the personas they care most about. Setup cost scales with desired customization, not with completeness.

**Why fingerprints are versioned + attributed:**

`outreach_log.fingerprint_version_id` records exactly which fingerprint row drove each send. This means:

- You can A/B test fingerprints by cloning, modifying, and watching outcomes.
- A regression ("replies dropped after we updated the LinkedIn DM voice") becomes findable in the data.
- The drafter is decoupled from prompt code — voice changes don't require deploys.

**The marketing-perspective insight:**

A fingerprint is the voice equivalent of a brand guideline. Brand guidelines exist because consistent typography and colour produce trust at scale. Fingerprints exist because consistent *voice* produces trust at scale. Prompt engineering is the equivalent of "match this Figma file by eyeballing it" — it works for one designer on one screen, not for a team running thousands of sends a week.

If a workspace tries to skip the fingerprint system and just prompt-engineer voice, they end up with the same brand damage that drove the design in the first place. The system architecture (three scopes, version attribution, decoupling from prompts) is the encoding of that lesson in code.

---

## People are short, companies are long

The funnel has two levels with different lengths (see ADR-013):

- **People** progress through 5 stages: `Prospect → Signal Found → Engaged → Highly Engaged → Ambassador`. They stop at Ambassador.
- **Companies** progress through 11 stages: `Prospect → Signal Found → Engaged → High Signal → Disc Call → Info Request → Sent Info → 2nd Call → Diligence → Negotiation → Won`. They run all the way to a closed deal.

The first 5 stages are storage-shared but display-different. Both contacts and companies hold canonical values like `High Signal` and `Discovery Call` in their `manual_stage` column. The SDR view applies `STAGE_DISPLAY_LABEL` overrides so people see `Highly Engaged` and `Ambassador`; the Companies view keeps the canonical labels.

After stage 5, **only companies continue**. People don't progress through Info Request, Diligence, Negotiation. A person doesn't negotiate a contract — the company does.

The score thresholds also differ between levels. People are calibrated against contact-level `signal_score`; companies against an aggregate company score. People hit `Highly Engaged` at ≥26 points; companies hit `High Signal` at ≥50 because the company score sums across all contacts.

**Why this matters when you customize:**

- Don't add a people-level deal-progress stage like "People at Negotiation." Deal progress is a company concept; a person at a negotiating company stays at "Ambassador."
- Don't hardcode the company stage list — the seeded 11 stages reflect one opinionated B2B sales motion. Other motions may differ.
- An Ambassador whose company is at `Won` is still an Ambassador — the same stage doubles as the post-sale cultivation state. The cultivation lens kicks in automatically because the contact's stage doesn't try to track the deal.
- Pre-MQL transitions (signal-driven) and the meeting-booked transition (ADR-012) mirror naturally from contact to company. The only nuance: if the company is already past Discovery Call (e.g. at Info Request), the company stays; the contact still moves to Discovery Call / Ambassador.

See ADR-013 for the full stage tables, threshold bands, and rollup rules.

## Per-workspace thresholds, not global scoring

Funnel stage (Prospect, Signal Found, Engaged, High Signal) is computed from `signal_score` using **per-workspace thresholds** stored in `WorkspaceConfig.scoring.thresholds`. The same `signal_score = 25` can be "Signal Found" in one workspace and "Engaged" in another.

The same applies to per-verb score weights: workspace A might weight `commented_post` heavily, workspace B might not. Both are valid.

**When you customize:**
- Score thresholds are user-tunable. Bake them into UI, not into code.
- Don't compute a stage label as a stored column and trust it across workspaces — the label is a *projection* of the score plus the workspace's thresholds. Always re-derive at the destination.
- Recomputing all funnel stages after a threshold change is a workspace-scoped operation: schema-migrate-safe but operationally noisy. Provide it as an explicit "Recalculate" action, not as automatic.

---

## Signals are append-only; mutations are explicit

The `signals` table is conceptually a log: every event is a new row. We don't update old signals when context changes — we add a new signal that supersedes.

The `outreach_log` is the same: every send is a new row, even retries.

This append-only discipline is what makes the funnel auditable ("why is this contact at 47 points? show me the rows"). It's also what makes the score recomputable after a threshold change.

**When you customize:**
- Don't add an `UPDATE signals SET score_delta = ...` pattern when context changes upstream. Append a new signal that adjusts.
- Don't reuse `outreach_log` rows on retry. Each attempt is a new row.
- DELETE is allowed for retraction (a deal share is recalled, an email is recalled), but it's the exception, and it should always be paired with a `_at` timestamp or a `status` field — not silent removal.

---

## Encrypted at rest for tenant secrets

Every tenant secret (CRM access tokens, webhook signing secrets, third-party API keys) is AES-encrypted at rest in `WorkspaceConfig` before being written to Upstash. The encryption key is a process-level env var (`ENCRYPTION_KEY`); rotating it is a multi-step operation that can lock workspaces out if done carelessly.

**When you customize:**
- Any new tenant secret field goes through `encryptIfNeeded` on write and `decrypt` on read. There is no exception.
- The dashboard password (`accessToken` on `WorkspaceConfig`) is encrypted with the same scheme — rotating `ENCRYPTION_KEY` without a re-encryption pass *will* lock users out of their own dashboard. There's a recovery script for this; use it before rotating.
- Process env vars (`ANTHROPIC_API_KEY`, `RESEND_API_KEY`) are *workspace-agnostic* and live in `.env.local` / Vercel env vars. Tenant secrets are *per-workspace* and live in encrypted `WorkspaceConfig`. Don't confuse the two.

---

## Strict matching beats permissive matching

Several places in the system use strict matching where a permissive one would surface more results:

- **Persona match patterns:** if the persona requires `minEmployees: 50`, a contact with no employee data does NOT match. (Missing data fails, not falls through.)
- **DNC and exclusion rules:** if a contact's email isn't in the exclude list but is on a permanent-block list, exclude wins.
- **Fingerprint scope resolution:** the most-specific row matters; you can't "blend" two fingerprints to get a hybrid.

This is deliberate. The cost of an incorrectly-routed message (wrong persona, wrong voice, contacting an excluded person) is much higher than the cost of an unmatched contact sitting in the "no persona" bucket.

**When you customize:**
- Resist the temptation to "loosen" classifiers to maximise coverage. Strict matching is the design; unmatched contacts are a feature, not a bug.
- If you must broaden, do it by adding a more-permissive *additional* persona, not by softening an existing one.

**What unmatched contacts get:** the default "no persona" state. They appear in the SDR view and the rest of the dashboard normally — they're not hidden. For outbound drafting, the fingerprint resolver (ADR-004) falls back through `channel` to `corporate` scope (skipping `channel_persona`, which can't apply without a persona). So the contact still gets a workspace-appropriate voice, just not a persona-tailored one.

---

## What would break this design

A short list of changes that, if made, would invalidate the core bet:

1. **A "deals" table that's not derived from signals.** Opportunity-first creeping in.
2. **Treating the external CRM as the system of record.** Postgres is authoritative; the CRM is a downstream mirror. A "sync everything, always" path that lets the CRM drive state inverts the design.
3. **Score thresholds as constants in code.** Per-workspace customisation gone.
4. **Workspace-scoped data leaking across workspaces.** Multi-tenancy compromised.
5. **Fingerprint resolution that doesn't honor the three-scope precedence.** Personalisation collapses.
6. **Tenant secrets stored unencrypted in any persistent layer.** Security regression.
7. **Manual stage overrides being writeable without an audit trail.** Auditability gone.
8. **Signal verbs being free-text strings instead of an enum.** Reporting + UI label maps + adapter routing break silently.

If a proposed change touches any of these, treat it as load-bearing. The right answer might still be to make the change, but it deserves an architectural decision record (`docs/adr/`) and a discussion, not a one-line PR.

---

## How to read the rest of the docs

- **`CLAUDE.md`** — the operating manual. Read every session.
- **`GLOSSARY.md`** — canonical product terms. Read when you see a word you don't know.
- **`ARCHITECTURE.md`** — system-level data flow. Read once when onboarding.
- **`docs/adr/`** — decisions we've already made. Read the one that matches your area before suggesting changes.
- **`SETUP.md`** — how to wire it up the first time.
- **`README.md`** — orientation only.

If a design decision in code looks weird, the answer is almost always in one of these. Look before refactoring.
