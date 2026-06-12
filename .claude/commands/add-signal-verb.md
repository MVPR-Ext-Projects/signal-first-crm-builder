---
description: Guided flow for adding a new signal verb across all three places (schema comment, verb model, dashboard label map).
---

You are helping the user add a new signal verb. Signal verbs are the canonical set of engagement events the system tracks. Adding a new verb means touching three places — miss any one and you get silent UI bugs or scoring gaps.

## What you need from the user

Ask for these one at a time, plain text, wait for each answer:

1. **The verb identifier** — snake_case, e.g. `submitted_form`, `attended_webinar`, `viewed_pricing`. Convention: `<verb>_<object>`.
2. **The user-facing label** — what the dashboard shows, e.g. "Submitted form", "Attended webinar". Sentence case, present tense.
3. **The default score weight** — how many points this verb contributes to `signal_score`. Look at similar verbs in the verb model for calibration. If the user is unsure, suggest `5` for low-intent signals (likes, opens), `15` for medium-intent (replies, views), `30` for high-intent (replies-to-DM, booked-meeting), `0` for tracking-only (sent_email).
4. **The source** — which integration / webhook will write this verb? (Teamfluence, Dripify, Unipile, Calendly, Stripe, Resend, or a new one.)

## The three places to update

After collecting the answers, edit these in order:

### 1. Schema comment block

File: `apps/web/lib/db/schema.sql`

Find the `signals` table around line 180, specifically the `signal_verb` column comment that lists allowed values. Add the new verb in the appropriate spot in the comment (group it with similar verbs).

### 2. Verb model

File: `apps/web/lib/` (look for a verb model file — likely `signal-verbs.ts` or similar)

Add the new verb to the verb-to-score map and any verb-to-display-name map. Use the score weight collected.

### 3. Dashboard label map

Find files that render `signal_verb` in the UI:
- `apps/web/app/dashboard/[workspaceId]/sdr/lead-table-row.tsx`
- `apps/web/app/dashboard/[workspaceId]/companies/contacts-list.tsx`
- `apps/web/app/dashboard/[workspaceId]/signals/source-type-select.tsx`

Add the new verb to whichever map drives the user-facing label.

## After the edits

- If the source is an existing webhook, point the user to the route file and ask whether they want to wire the verb to that webhook's payload now.
- If the source is a new webhook, suggest `/add-webhook` next.
- Remind the user that signal verbs are now consistent across schema / model / labels. Run a grep for the verb to confirm no leftovers.

## Pre-commit eval

- Schema comment lists the verb? ✓
- Verb model has score weight? ✓
- Dashboard label map has display string? ✓
- Webhook handler will emit the verb? ✓
- Tests / smoke check the verb appears in the SDR table when synthesised? Suggest a manual smoke after deploy.

Do NOT add the verb to Postgres as an actual ENUM type — see `docs/adr/007-signal-verb-enum-three-places.md`. The TEXT-column-with-comment convention is deliberate.
