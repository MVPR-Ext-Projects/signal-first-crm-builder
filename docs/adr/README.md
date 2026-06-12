# Architectural Decision Records

One file per non-obvious decision. Read the relevant ADR before suggesting changes in that area — chances are the alternative you're proposing was considered and rejected for a reason that's still load-bearing.

Format follows Michael Nygard's template: Status / Context / Decision / Consequences.

| # | Decision | Status |
|---|---|---|
| [001](./001-signal-first-not-opportunity-first.md) | Signal-first, not opportunity-first | Accepted |
| [002](./002-companies-first-class-entity.md) | Companies as a first-class entity (with deterministic dedup waterfall) | Accepted |
| [003](./003-dripify-teamfluence-asymmetry.md) | Dripify signals do not push to external CRM; Teamfluence does | Accepted |
| [004](./004-three-fingerprint-scopes.md) | Style fingerprints have three resolution scopes | Accepted |
| [005](./005-outbound-calls-not-fingerprint.md) | Outbound Calls is intentionally not a fingerprint channel | Accepted |
| [006](./006-per-workspace-funnel-thresholds.md) | Funnel thresholds are per-workspace, not global | Accepted |
| [007](./007-signal-verb-enum-three-places.md) | Signal verb enum is maintained in three places | Accepted |
| [008](./008-tenant-secrets-encrypted-at-rest.md) | Tenant secrets are AES-encrypted at rest in WorkspaceConfig | Accepted |
| [009](./009-append-only-signals-and-outreach.md) | Signals and outreach_log are append-only | Accepted |
| [010](./010-crm-as-secondary-projection.md) | CRM is a secondary projection, Postgres is primary | Accepted |
| [011](./011-webhook-contract.md) | Webhook contract (signature, idempotency, retries, response codes) | Accepted |
| [012](./012-meeting-booked-stage-transition.md) | Meeting-booked triggers Discovery Call (= MQL) stage transition for contact + company | Accepted (intent), incomplete |
| [013](./013-separate-stage-taxonomies-for-contacts-and-companies.md) | Two-level funnel: people are 5 stages, companies are 11 stages, storage shared for the first 5 | Accepted (principle), partial |
| [014](./014-mvpr-pr-signal-source-and-performance-tracking.md) | MVPR is a first-class signal source (coverage + journalist threads), with response/coverage-rate tracking and `pr_*` verbs | Accepted (intent), emission incomplete |
| [015](./015-influencers-first-class-entity.md) | Influencers are a first-class entity (person or organization), many-to-many with prospects via `influences` / `influenced_by`; MVPR writes journalists + publications; edges drawn from coverage-engagement, social follows, and publication audiences | Accepted (intent); edges wired (3 sources), IG/FB + backfill pending |

## When to write a new ADR

Write one when:
- You're making a non-obvious choice (the right answer wasn't unanimous).
- You're locking in something that future contributors might be tempted to change.
- You're crossing a line listed in `PHILOSOPHY.md` under "What would break this design."

Don't write one for:
- Cosmetic changes (renames, refactors with no semantic shift).
- Bug fixes that restore intended behaviour.
- Things that have an obvious right answer.

## ADR template

```markdown
# NNN — Title

**Status:** Proposed | Accepted | Superseded by ADR-XXX

**Context:** What forces were in play. What we were observing. What the alternatives were.

**Decision:** What we chose. Stated in active voice, as a commitment.

**Consequences:** What changes for code and humans. Both upsides and downsides.
```
