# 010 — CRM as secondary projection, not source of truth

**Status:** Accepted

## Context

The system has three storage layers: Upstash Redis (workspace config), Postgres (the projection), and HubSpot (the CRM). A question that comes up: why have all three? Specifically — why project signals to Postgres if we're going to push them to HubSpot anyway, and vice versa?

Three plausible designs were considered:

1. **CRM-only.** Skip Postgres. Read and write contacts + signals directly to HubSpot. Simplest.
2. **Postgres-only.** Skip the CRM push. Run a self-contained CRM. Cleanest from a data-ownership standpoint.
3. **Both, with Postgres as primary and the CRM as a secondary projection.** Pay the cost of two stores.

We chose 3.

## Decision

Postgres is the primary store. Every signal, every contact, every outreach log row lives in Postgres first. The CRM (HubSpot) is a **secondary projection**: writes flow Postgres → CRM, not the other way around, and the CRM only receives a subset of what's in Postgres.

Specifically:
- **Postgres holds everything**: every signal verb, every Dripify event, every Resend lifecycle event, every Unipile reply, every score derivation, every outreach attempt.
- **HubSpot receives a curated subset**: contact CRUD and high-signal timeline events from Teamfluence. Dripify is intentionally not pushed (see ADR-003). Internal scoring, fingerprint resolution, and the outreach log stay in Postgres.

The CRM push is best-effort. If HubSpot is down or rate-limited, the Postgres write still happens; the CRM mirror falls behind and catches up later. The webhook response code reflects the Postgres write status, not the CRM write status.

## Consequences

**Upsides:**
- Postgres gives us cheap, fast, indexed queries for the dashboard. HubSpot's REST API can't sustain the read volume of a busy SDR page.
- Score derivation and append-only event logging belong in a SQL store, not a CRM. We do them in Postgres.
- The CRM stays clean: only events a salesperson actually wants to see in their pipeline view appear there.
- Data ownership: we always have a complete copy of the engagement history, not at the mercy of HubSpot's retention policies.
- Resilience: if HubSpot has an outage, the system keeps ingesting signals. They mirror to HubSpot when it recovers.

**Downsides:**
- Two stores to keep in sync. The mirror can fall behind; reconciliation needs to be observable.
- A user looking at HubSpot will see fewer events than a user looking at the dashboard. This is intentional but needs documenting (the dashboard is the canonical view).
- Schema migrations happen in two places: Postgres (via `schema.sql` + migrations) and HubSpot (via the adapter, which manages custom properties + timeline event templates).

**What would invalidate this decision:**
- A CRM that natively supports event sourcing, append-only logs, and high-throughput timeline writes (none today). Then the CRM-only design might work.
- A regulatory regime where data residency requirements make holding a second copy in our database illegal. Unlikely.

## Practical implications

- **Don't reverse the flow.** Don't write code that reads contact state from HubSpot and pushes it to Postgres. The direction is Postgres → CRM, not CRM → Postgres. The exceptions: the HubSpot webhook handler (inbound updates from HubSpot, used to keep the contact email / lifecycle stage fresh) and the HubSpot adapter's `findContact*` methods (used during ingest to dedup against existing HubSpot records).
- **Don't make CRM push synchronous-blocking.** If the CRM push fails, the webhook response should still be 2xx (Postgres write succeeded). Log the CRM failure for retry; don't 500 the inbound webhook.
- **Don't store score / fingerprint / outreach-log state in HubSpot.** Those are projection concerns. HubSpot timeline events are a *projection* of the score-bearing event, not the canonical record.
