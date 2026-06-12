# 013 — Two-level funnel: people are short, companies are long

**Status:** Accepted (principle); implementation partial

## Context

Earlier drafts of this ADR over-engineered the contact-vs-company stage relationship. The actual MVPR model is simpler and tighter.

The funnel has **two levels**, with different lengths:

- **People** have a 5-stage funnel that ends at Ambassador.
- **Companies** have an 11-stage funnel that runs all the way to Won.

The first 5 stages are shared in storage; the dashboard displays them with different labels per level. After stage 5, people stop and companies continue.

## The two funnels (MVPR's actual stage model)

### People — 5 stages

Score-derived thresholds (per-workspace, on contact `signal_score`):

| Stage (storage) | Display label (SDR view) | Score band | Meaning |
|---|---|---|---|
| `Prospect` | `Prospect` | 0–2 | Just appearing — monitor only |
| `Signal Found` | `Signal Found` | 3–5 | Nurture, no pitch |
| `Engaged` | `Engaged` | 6–25 | LinkedIn touchpoint |
| `High Signal` | `Highly Engaged` | ≥26 | Contact today |
| `Discovery Call` | `Ambassadors` | (manual, set by booked-meeting) | Meeting booked → confirm logistics |

People DO NOT progress past Ambassador in the funnel. Even when their company moves through Information Request, Diligence, Negotiation, Won — the PEOPLE involved stay at "Ambassador." Deal-progress is a company-level concept.

The display labels `Highly Engaged` and `Ambassadors` are implemented via `STAGE_DISPLAY_LABEL` in `apps/web/app/dashboard/[workspaceId]/sdr/{stage-select,pre-enrichment-tab}.tsx`. Storage values stay as the canonical `High Signal` and `Discovery Call`; the SDR-view labels overlay on read.

### Companies — 11 stages

Score-derived thresholds (per-workspace, on aggregate company score):

| Stage (storage) | Display label | Score band | Meaning |
|---|---|---|---|
| `Prospect` | `Prospect` | 0–4 | Just appearing |
| `Signal Found` | `Signal Found` | 5–19 | Early engagement |
| `Engaged` | `Engaged` | 20–49 | Multi-person interest |
| `High Signal` | `High Signal` | ≥50 | Ready to outreach |
| `Discovery Call` | `Disc Call` | (manual, set by booked-meeting) | Meeting booked |
| `Requested Information` | `Info Request` | (manual) | Asked for info |
| `Sent Information` | `Sent Info` | (manual) | Awaiting their review |
| `Follow Up Call` | `2nd Call` | (manual) | Second meeting booked |
| `Diligence` | `Diligence` | (manual) | Commercial review |
| `Contract Negotiation` | `Negotiation` | (manual) | Terms being agreed |
| `Customer Won` | `Won` | (manual) | Deal closed |

Companies have a full sales motion from cold prospect to closed-won. The display labels are mostly abbreviations of the canonical storage values (`Discovery Call` → `Disc Call`, `Requested Information` → `Info Request`, etc.). The labels can drift per-workspace; the storage values stay canonical.

### Score thresholds differ between levels

Note the threshold bands:

- **People:** `0–2` / `3–5` / `6–25` / `≥26`
- **Companies:** `0–4` / `5–19` / `20–49` / `≥50`

Companies need higher scores at each band because the company score aggregates signals across all the company's contacts. A company with five contacts each averaging 5 points sums to ~25 — that's still only "Signal Found" at the company level even though some individual contacts might be "Highly Engaged."

Both sets of thresholds live in `WorkspaceConfig.scoring.thresholds` (for contacts) and `WorkspaceConfig.scoring.companyThresholds` (for companies). They're independent and workspace-tunable.

## Decision

The funnel is two-level with these properties:

1. **People stages stop at Ambassador (5).** Deal-progress is exclusively a company-level concept.
2. **Companies extend past Discovery Call (11).** Post-MQL stages (Info Request through Won) are companies-only.
3. **Storage is shared for the first 5 stages.** Both `contacts.manual_stage` and `companies.manual_stage` can hold `Prospect`, `Signal Found`, `Engaged`, `High Signal`, `Discovery Call`. The dashboard relabels at the SDR view via `STAGE_DISPLAY_LABEL` so people see "Highly Engaged" / "Ambassadors" while companies see the canonical names.
4. **Score thresholds differ between levels.** People are calibrated against contact-level `signal_score`; companies against an aggregate. Different bands, both per-workspace.

## Why people stop at Ambassador

A person doesn't "negotiate a contract" or "complete diligence" — the company does. A person can:

- Engage (and become more engaged via signals).
- Book a meeting (becoming an Ambassador).
- Continue engaging after their company is a customer (still Ambassador — same stage value).
- Move to a new company (becoming a Prospect again at the new account; their old contact row stays Ambassador linked to the original company).
- Disengage (silence — they stay at Ambassador in the DB; the SDR view's signal-recency sort naturally pushes them down).

There is no person-level "Won" because winning is a deal, and deals are between companies, not between people. The Ambassador stage already does double duty as the post-sale relationship state — the cultivation lens kicks in for any Ambassador whose company is at `Won`.

## Implementation status

What's there:
- The `SDRStage` union includes all 11 storage values plus the score-derived stages.
- `STAGE_DISPLAY_LABEL` implements the people-view overrides (`High Signal` → `Highly Engaged`, `Discovery Call` → `Ambassadors`).
- Per-workspace contact thresholds (`scoring.thresholds`) and company thresholds (`scoring.companyThresholds`) exist in `WorkspaceConfig`.
- Score-derived stage computation runs at contact-level on every signal write.

What's missing or needs verification:
1. **`companies.manual_stage`** — confirm the column exists in `schema.sql`. If not, schema migration.
2. **Company-level score derivation cron.** Does the aggregate company score recompute on every contact-level signal write, or via a periodic job? Pin in code.
3. **People-stage truncation in the UI.** When the SDR view renders a manual_stage filter dropdown for people, it should ONLY offer Prospect / Signal Found / Engaged / Highly Engaged / Ambassador — not the company-level deal-progress values. Confirm this is filtered.
4. **Companies dashboard stage chips.** Currently shows the 11 company stages with their abbreviated labels. Confirm the chip set matches the screenshot exactly.

## Canonical funnel ordering

A dedicated `FUNNEL_ORDER` constant (`apps/web/lib/funnel-order.ts`) defines the canonical rank of each stage across both levels — a single `Record<SDRStage, number>` from `Prospect` (0) through `Customer Won` (10). People-level code only ever sees values 0–4; company-level code uses the full range. This decouples regression-guard ordering from the display-order arrays in `stage-select.tsx`, so reordering chips for UI doesn't silently change rollup behaviour.

The don't-regress guard (ADR-012) and any future funnel-comparison logic should always go through `FUNNEL_ORDER`, never `SDR_STAGES.indexOf(...)`.

## Open questions

1. **Workspace-customizable stages.** MVPR's 11-stage company funnel is opinionated. Should a simpler workspace be able to drop `2nd Call` or `Sent Info`? Currently the dropdown offers everything; a workspace-level "stages I use" config would clean this up. If this lands, `FUNNEL_ORDER` would need to become workspace-scoped too (or the global constant becomes the maximum order, with workspace config defining which stages are *active*).
2. **People-level "Lapsed" / "Departed" / "Reference"?** Earlier drafts of ADR-013 proposed these. The current screenshot shows only 5 people stages — no Lapsed / Departed / Reference. Are those concepts (a) tracked elsewhere (a contact attribute, a tag), (b) intentionally omitted, or (c) future work?

## Settled (no longer open)

- ~~Customer-active and beyond~~ — `Won` IS terminal at the company level. Churn and expansion, if tracked, are not stages — they're separate signal/metric concerns (Stripe revenue events, lifecycle attributes, etc.).

## Consequences

**Upsides:**
- Clean separation: marketing operates on the 5-stage people funnel; sales operates on the 11-stage company funnel.
- Storage stays simple: shared union of stage values; display layer handles the lens-switch.
- Per-workspace threshold tuning is honest about the difference between contact-level and company-level scoring.

**Downsides:**
- The two-level rendering means every dashboard surface has to decide which level it's showing and apply the right labels + filter the right stage subset. Easy to get wrong.
- A user who sees "Ambassador" in one view and "Discovery Call" in another (because they switched from SDR to Companies) may be confused. Documentation + consistent navigation are the mitigation.
- Adding a new company stage (e.g. `Procurement Review`) means schema-equivalent thinking — no DB migration needed (it's a TEXT column with a comment), but the dropdown order, colour map, and persona-stage labels all have to update.

## Rollup rule for ADR-012 (meeting-booked)

Simpler than previously documented:

- When a `booked_meeting` signal arrives, set the contact's `manual_stage` to `Discovery Call` (which the SDR view will render as "Ambassador") and set the company's `manual_stage` to `Discovery Call` (which the Companies view will render as "Disc Call") — IF the company is at a pre-MQL stage.
- If the company is already past `Discovery Call` (e.g. at `Info Request` or `Diligence`), the company stays at its current stage — don't regress. The contact still moves to `Discovery Call` / Ambassador.
- If the company is at `Won`, same rule: company stays, contact updates to `Discovery Call` (which the SDR view renders as "Ambassador"). The Ambassador label naturally captures "still engaging post-sale."

## What would invalidate this decision

- A sales motion where the person and the deal are the same entity (sole-trader / freelancer market). Then people would need deal-progress stages too.
- A company funnel that varies across segments enough to require per-segment stage sets. Then the company stage list becomes config-driven, not code-defined.

Both are unlikely for the kinds of motions this CRM targets.
