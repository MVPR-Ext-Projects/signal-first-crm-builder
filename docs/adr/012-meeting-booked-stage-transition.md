# 012 — Meeting-booked triggers a Discovery Call (= MQL) stage transition

**Status:** Accepted (intent); implementation incomplete

## Terminology note

In this codebase, three terms refer to the same stage:

- **Meeting Booked** — the business event (a prospect put time on the calendar).
- **MQL** — the funnel-language description (Marketing Qualified Lead).
- **Discovery Call** — the actual stage value used in code (`SDRStage`, `manual_stage` column, dashboard labels).

Read these as synonymous throughout this ADR. The code uses `Discovery Call`; the rest of the document uses whichever framing reads most naturally in context.

## Context

When a prospect books a meeting (via Calendly), that's the most explicit "yes, I want to talk" signal a buyer can give without paying us. It deserves an automatic, system-wide reaction — not a manual stage change by the seller.

The reaction has to be:

- **Source-agnostic.** It applies to every contact in the workspace, regardless of how the contact entered the system (Dripify outbound, Teamfluence organic engagement, inbound form, manual import). Whoever books a meeting has earned the stage transition.
- **Two-level.** Both the contact AND their company should reflect the transition. If anyone at the company books a meeting, the company is in active discussion territory.

Per ADR-006, funnel stages have two flavours: score-derived (Prospect / Signal Found / Engaged / High Signal) and manual (deal-progress markers a human or the system asserts). Discovery Call lives in the manual layer — it's not a score derivation, it's a discrete fact ("a meeting was booked").

## Decision

When a `booked_meeting` signal arrives via the Calendly webhook:

1. The **contact** moves to the `Discovery Call` manual stage.
2. The **contact's company** moves to the same stage (any contact at the company books → the company is at Discovery Call).
3. The transition fires for every contact, regardless of signal source. There is no "Dripify-tracked" or "organic" distinction.

CRM push (separate concern, see ADR-010): once the contact and company are at Discovery Call, they're load-bearing for the seller's pipeline review. The best-effort CRM push (ADR-011) fires as a side-effect of the stage transition, not as a special case in the Calendly handler.

## Implementation status

**The template ships with the intent encoded in this ADR but the wiring incomplete.**

What's there:
- The Calendly handler at `apps/web/app/api/webhooks/[workspaceId]/calendly/route.ts` ingests the booking and writes a `booked_meeting` signal.
- The signal-verb model includes `booked_meeting` with a high default score weight.
- `Discovery Call` already exists in the `SDRStage` union (`apps/web/app/dashboard/[workspaceId]/sdr/stage-select.tsx`) with colour mapping and persona-stage labels.

What's missing:
- The Calendly handler does NOT set the contact's `manual_stage` to `Discovery Call`.
- There is no company-level rollup that propagates `Discovery Call` to the contact's company.

Closing the gap is two changes (no new stage value needed):

1. **Wire the contact transition.** In the Calendly handler, after the `booked_meeting` signal is written, update the contact's `manual_stage` to `Discovery Call`. Guard against regressing a contact who's already further along: only update if the current `manual_stage` is NULL or earlier in the funnel order than `Discovery Call`.

2. **Wire the company transition — mirror UNLESS the company is already past Discovery Call.** Per ADR-013, the two-level funnel rule:
   - If the company is at a pre-MQL stage (Prospect / Signal Found / Engaged / High Signal): move it to `Discovery Call`. Mirror.
   - If the company is at or past `Discovery Call` (Disc Call / Info Request / Sent Info / 2nd Call / Diligence / Negotiation / Won): leave the company at its current stage. Don't regress.

   In both cases, the contact moves to `Discovery Call` (the SDR view renders this as "Ambassador"). The same storage value double-duties as the cultivation state regardless of where the deal is.

   Pseudocode:
   ```ts
   import { FUNNEL_ORDER } from "@/lib/funnel-order"
   const DISCOVERY_CALL_RANK = FUNNEL_ORDER["Discovery Call"]

   // Always update the contact.
   await sql`UPDATE contacts SET manual_stage = 'Discovery Call'
             WHERE workspace_id = ${workspaceId} AND id = ${contactId}
               AND (manual_stage IS NULL OR
                    funnel_rank(manual_stage) < ${DISCOVERY_CALL_RANK})`

   // Only update the company if it's still pre-MQL.
   await sql`UPDATE companies SET manual_stage = 'Discovery Call'
             WHERE workspace_id = ${workspaceId} AND id = ${companyId}
               AND (manual_stage IS NULL OR
                    funnel_rank(manual_stage) < ${DISCOVERY_CALL_RANK})`
   ```

   The don't-regress rule uses a dedicated `FUNNEL_ORDER` constant — a single `Record<SDRStage, number>` covering all stages across both levels (people 0–4, companies 0–10). It lives at `apps/web/lib/funnel-order.ts`, separate from the display-order arrays in `stage-select.tsx`. The decoupling matters: anyone reordering stage chips for UI reasons shouldn't be able to silently change the regression behaviour.

   The SQL helper `funnel_rank(stage TEXT) RETURNS INTEGER` is a small Postgres function defined from the same JS constant (or inlined as a CASE expression in the WHERE clause) so the lookup happens server-side without round-tripping.

   Check whether `companies.manual_stage` exists yet — if not, this is a small schema migration. The companies table is first-class per ADR-002, so the join through `gtm_company_id` is reliable on fresh installs.

Both updates should live in a single helper `applyDiscoveryCallStageTransition(workspaceId, contactId, companyId)` in `apps/web/lib/db/contact-store.ts` so future triggers (forms integration that represents "meeting agreed", a different "talk requested" signal source) can reuse it without duplicating the SQL or the regression guard.

## Cancellation behaviour

When a booked meeting is cancelled (Calendly fires `invitee.canceled`), the stage regresses back to the score-derived stage. The points stay (the `booked_meeting` signal is append-only per ADR-009 — we don't retract it; the contact did demonstrate engagement by booking), but the manual Discovery Call override is cleared so the funnel position re-derives from `signal_score`.

The cancellation rule applies to BOTH levels:

- **Contact:** if `manual_stage = 'Discovery Call'` AND the contact has no other active (non-cancelled) bookings, clear `manual_stage`. Score-derived stage (Prospect / Signal Found / Engaged / Highly Engaged) takes over.
- **Company:** if `manual_stage = 'Discovery Call'` AND no contact at the company has an active booking, clear `manual_stage`. Score-derived stage takes over.

The "no other active bookings" guard handles the case where a contact has two bookings A and B, then cancels A — they shouldn't regress because B is still active.

Don't clear a `manual_stage` value past Discovery Call. If the contact/company has progressed (e.g. Info Request, Diligence), a cancellation of the originating discovery call doesn't undo that progression — they've moved on through other interactions.

Pseudocode for the Calendly cancellation handler:

```ts
// After marking the cancelled booking
await sql`UPDATE calendly_bookings SET cancelled_at = NOW()
          WHERE workspace_id = ${workspaceId} AND event_uri = ${eventUri}`

// Clear contact's Discovery Call IF no other active bookings exist
await sql`UPDATE contacts SET manual_stage = NULL
          WHERE workspace_id = ${workspaceId} AND id = ${contactId}
            AND manual_stage = 'Discovery Call'
            AND NOT EXISTS (
              SELECT 1 FROM calendly_bookings cb
              WHERE cb.workspace_id = ${workspaceId}
                AND cb.contact_id = ${contactId}
                AND cb.cancelled_at IS NULL
            )`

// Same rule for the company - clear if no contact at the company has an active booking
await sql`UPDATE companies SET manual_stage = NULL
          WHERE workspace_id = ${workspaceId} AND id = ${companyId}
            AND manual_stage = 'Discovery Call'
            AND NOT EXISTS (
              SELECT 1 FROM calendly_bookings cb
              JOIN contacts c ON c.id = cb.contact_id AND c.workspace_id = cb.workspace_id
              WHERE cb.workspace_id = ${workspaceId}
                AND c.gtm_company_id = ${companyId}
                AND cb.cancelled_at IS NULL
            )`
```

## No-show behaviour

No-shows (the prospect booked, didn't cancel, but didn't attend) are an edge case handled manually. The seller can downgrade the stage via the dashboard's stage selector. There is no automatic detection in this template; building one would require either a calendar-attendance integration or a "did this meeting happen?" prompt to the seller after each scheduled call. Both are out of scope until the rate of no-shows justifies the build.

A `no_show` signal verb could be added later if no-shows become common enough to warrant a structured trace.

## Consequences

**Upsides (when implemented):**
- Discovery Call means "a meeting has been booked," consistently across every contact in the workspace. Sellers don't have to remember to set the stage.
- The dashboard's funnel reflects real intent rather than score derivation alone.
- Company-level rollup means account-based motion becomes possible: "show me all companies at Discovery Call" is a meaningful query.
- The transition is symmetric across signal sources — fair to every contact regardless of how they arrived.
- Cancellation symmetry: the stage moves automatically in both directions for the common case. The seller doesn't need to manually downgrade when a meeting is cancelled.

**Downsides:**
- A no-show after booking is handled manually. The contact stays at Discovery Call until a seller manually downgrades. This is acceptable for now; the workaround is fine for low-frequency events.
- The company-level rollup means one rogue booking (or a curious low-intent contact) can move a whole company to Discovery Call. Whether to weight by which contact booked (e.g. only count buyer-personas) is a follow-up.
- The cancellation handler relies on a join through `contacts.gtm_company_id`. Per ADR-002 every contact gets `gtm_company_id` on first webhook write, so the join is reliable for fresh installs. Imports from legacy CRMs need to run the dedup waterfall before they're trusted by this rollup.

## What would invalidate this decision

- A different definition of MQL in the workspace's sales motion (e.g. "MQL = scored ≥ 50", not "meeting booked"). Then the trigger is different but the principle of source-agnostic, two-level transition still holds.
- A stage taxonomy that splits Meeting Booked and Discovery Call (e.g. "Meeting Booked" = scheduled but not yet happened, "Discovery Call" = call completed). Then the trigger sets `Meeting Booked`; another signal source (e.g. a meeting-attended detector) sets `Discovery Call`. This would require adding the new stage value to `SDRStage` and updating the colour + label maps.

If the workspace's sales motion changes the rule, update this ADR with the new trigger and keep the source-agnostic + two-level principles.
