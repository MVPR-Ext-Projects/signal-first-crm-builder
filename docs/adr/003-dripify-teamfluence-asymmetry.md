# 003 — Dripify signals do not push to external CRM; Teamfluence does

**Status:** Accepted

## Context

The system ingests LinkedIn-engagement signals from two sources:
- **Teamfluence** — high-signal events (likes, comments, profile views, follows). Sends rich payloads including the prospect's company LinkedIn URL, employee count, etc.
- **Dripify** — outbound automation events (connection requests sent, accepted, DMs sent). Sends lighter payloads — no company LinkedIn URL, less metadata.

Both write to `signals` in Postgres. The question was: should both also push to the external CRM (HubSpot) so the CRM timeline reflects every engagement?

The argument for pushing both: complete CRM timeline = single pane of glass.
The argument for pushing only Teamfluence: Dripify is *our* outbound machinery; the CRM should reflect the prospect's behaviour, not our own. And the CRM gets noisy when every connection-request-sent shows up as a timeline event.

## Decision

Teamfluence pushes signals to the CRM (find-or-create company by domain → name, then write a signal event under the contact). Dripify writes to Postgres only — no CRM push.

A Dripify-tracked contact still ends up in HubSpot when they reach a meaningful stage — but via the general stage-transition path (see ADR-012 for the meeting-booked → Discovery Call transition and ADR-010 for the best-effort CRM push that follows any stage update), not via a Dripify-specific graduation rule.

## Consequences

**Upsides:**
- The CRM stays clean: it shows what the prospect did, not what we did.
- Dripify's outbound automations don't pollute the CRM with thousands of "connection request sent" events.
- The CRM timeline still has the high-signal events that matter for sales review.

**Downsides:**
- Asymmetry is a footgun. If you change signal-logic in `teamfluence/route.ts`, you have to ask: does the same change apply to `dripify/route.ts`? Sometimes yes, sometimes deliberately no.
- The CRM is *not* a complete log of every engagement. Pipeline reviewers who expect to find every event in the CRM will be confused. (Direct them to the dashboard, which has both.)

**What would invalidate this decision:**
- A CRM that natively supports "internal-only" timeline events (so we could push Dripify-sourced ones with a label that excludes them from pipeline reports).
- A change in the outbound tooling that means Dripify becomes the source of truth for high-signal events too.

## How to remember the asymmetry

The CLAUDE.md pre-work checklist asks: "Cross-source consistency. If you're touching signal logic, will the change need to apply to both the Dripify and Teamfluence webhooks?" That's the prompt to think about this ADR.
