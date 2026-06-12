# 001 — Signal-first, not opportunity-first

**Status:** Accepted

## Context

Traditional CRMs (Salesforce, HubSpot, Pipedrive) are opportunity-first: the seller creates a deal record, assigns it a stage, and updates the stage manually. The data is what the seller asserts.

This means:
- Pipeline accuracy depends entirely on seller discipline.
- "Stage Engaged" doesn't tell you *why* — there's no audit trail of what the prospect actually did.
- Recomputing the pipeline after a strategy change (different qualification bar, different ICP) is an all-hands manual exercise.

We wanted a CRM where the *prospect's behaviour* drives the pipeline, not the seller's confidence. That requires the unit of truth to be an event the prospect performed, not a stage the seller asserted.

## Decision

The unit of truth is a **signal** — a scored event attributable to a contact, sourced from external systems (Teamfluence, Dripify, Unipile, Calendly, Stripe, Resend). The funnel stage is *derived* from the signal score using per-workspace thresholds, not set manually.

Manual stage overrides exist (`manual_stage`) for deal-progress markers a human asserts — but they're an override layer on top of the score-derived funnel, not a parallel system.

## Consequences

**Upsides:**
- Auditable: every contact's score is recomputable from the signal log.
- Re-shape-able: change the thresholds and the whole pipeline re-shapes instantly.
- Honest: no "I'm going to mark this Engaged because I have a good feeling" inflation.
- Multi-source: any new integration is just a new signal source.

**Downsides:**
- Higher cognitive load for sellers used to manually staging. The dashboard makes the score visible, but discipline shifts from "mark the stage" to "let the score speak."
- Inbound integrations are load-bearing. If Teamfluence breaks, the pipeline goes quiet.
- "Deal value" is a separate concept — signals don't carry monetary weight, so revenue forecasting is bolted on (Stripe integration) rather than baked into the funnel.

**What would invalidate this decision:**
- A user-facing "create deal" affordance not derived from signals. That re-introduces the bet we didn't make.
- Allowing `signal_score` to be set manually without an underlying signal. The audit chain breaks.
