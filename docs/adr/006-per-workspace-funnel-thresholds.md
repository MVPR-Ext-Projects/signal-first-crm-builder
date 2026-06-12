# 006 — Funnel thresholds are per-workspace, not global

**Status:** Accepted

## Context

The funnel stage (Prospect, Signal Found, Engaged, High Signal) is derived from `signal_score` by comparing to thresholds. The question was: where do those thresholds live?

Option A: **Global constants in code.** Simple, but every workspace gets the same definition of "Engaged" regardless of how active their signal sources are. A workspace with one signal source averages low scores; a workspace with five averages high scores. "Engaged = score ≥ 20" makes sense for one and is meaningless for the other.

Option B: **Per-workspace thresholds in WorkspaceConfig.** Lets each workspace calibrate to their own signal volume + verb weights. Costs more UX (a settings page).

## Decision

Thresholds live per-workspace in `WorkspaceConfig.scoring.thresholds`. The Scoring settings page exposes them. The contact funnel-stage is recomputed when thresholds change (an explicit "Recalculate" action — not silent).

The same applies to per-verb weights: `WorkspaceConfig.scoring.verbWeights` lets each workspace decide that, e.g., `commented_post` is worth more than `liked_post`.

## Consequences

**Upsides:**
- Workspaces with different signal-source mixes can each have a meaningful funnel.
- Sellers can tune the bar empirically — start with defaults, watch the funnel shape, adjust.
- No code change required to recalibrate.

**Downsides:**
- Cross-workspace comparisons of "stage Engaged" become meaningless without normalising. The label "Engaged" in workspace A is a different population than "Engaged" in workspace B.
- Reports that aggregate across workspaces (in a partner-workspace context, which has been removed from this template) need to use scores, not stages.
- A score of 47 doesn't tell you anything until you also know the workspace's thresholds.

**What would invalidate this decision:**
- A multi-workspace reporting layer where cross-workspace comparison is a key feature. Then either thresholds need to be global, or the report needs to use normalised scores.

## Operational notes

Recalculating funnel stages after a threshold change is workspace-scoped and operationally noisy (large UPDATE). It's exposed as an explicit "Recalculate" action in Settings → Scoring, not as automatic-on-change. Users should preview the change first.
