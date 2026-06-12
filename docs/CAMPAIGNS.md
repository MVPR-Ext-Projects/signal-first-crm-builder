# Campaigns and delivery

Campaigns are the bridge between "this is what I want to send" and "this contact got that message." This doc covers what a campaign is, what adding a contact to a campaign does, and how delivery flows from the campaign through to a sent message + an outreach log entry.

Companion reading: `PHILOSOPHY.md` (signal-first targeting, fingerprints) and `docs/adr/004-three-fingerprint-scopes.md` (how voice resolves at draft time).

---

## What a campaign is

A campaign is a row in the `campaigns` table (`apps/web/lib/db/schema.sql` ~line 272) with:

- `id` — TEXT primary key. Used as the `utm_medium` for click attribution (see attribution app).
- `workspace_id` — tenant scope.
- `name` — human-readable label.
- `channel` — legacy enum: `linkedin_dm | email | newsletter | lead_magnet | other`. Kept for back-compat with existing stats queries.
- `channel_id` — FK to the parent `channels` table. The modern way of associating a campaign with its delivery channel.
- `clicked_link_score` — the score delta applied when a tracked link in this campaign is clicked. Default 0; campaigns that want clicks to count as engagement set a non-zero value.
- `archived_at` — soft-delete timestamp. NULL = active.

So conceptually, a campaign is **a delivery intent**: a named bucket of outbound activity, scoped to one channel, with optional click-scoring baked in.

## Campaign templates

A campaign can hold one or more **templates** (`campaign_templates` table). Each template is an editable message shell that the drafter uses as a starting point. The shape varies by channel:

| Channel | Template shape |
|---|---|
| `linkedin_dm` | `{ body }` (plain text) |
| `email` | `{ subject, html?, body }` (HTML preferred, body as fallback) |
| `newsletter` | Same as email |
| `lead_magnet` / `other` | `{ body }` default; `subject` and `html` optional |

A campaign with multiple templates supports A/B variants — `is_default = true` on one template marks the one the drafter uses unless the user overrides at draft time. The unique partial index on `(workspace_id, campaign_id) WHERE is_default = TRUE` enforces exactly one default.

## Channels vs Campaigns

It's easy to confuse them. The distinction:

- **Channel** — a delivery mechanism (LinkedIn DM, Direct Email, Newsletter, Product Updates, Outbound Calls). Workspace-scoped, DB-driven (the `channels` table). Each channel has its own fingerprint set (per ADR-004).
- **Campaign** — a named effort within a channel. "Q1 fintech outbound" is a campaign; the LinkedIn DM channel is its parent.

A workspace has a small number of channels (typically 4–6, seeded on first install) and many campaigns over time. Campaigns archive; channels generally don't.

## What adding a contact to a campaign does

This is the load-bearing question for understanding delivery. Adding a contact to a campaign doesn't immediately send them anything — it associates the contact with the campaign so:

1. **The drafter knows which template + which fingerprint to use** for the next send to that contact. The campaign tells the drafter the intent (e.g. "Q1 fintech outbound" using template variant A); the channel + persona match drive fingerprint resolution.
2. **Click attribution can find the campaign** when the contact clicks a tracked link. The attribution app reads the URL's `utm_medium` (which is the campaign ID) and looks up the campaign's `clicked_link_score` to write a `clicked_link` signal with the right score delta.
3. **The campaign's send progress is countable** — how many of the campaign's associated contacts have been sent the message; how many have been opened / clicked / replied.

Association doesn't trigger automatic sending. **The seller (or a scheduled job) initiates the send.** Adding a contact to a campaign is closer to "queue this contact for outreach in this campaign's context" than "send now."

## The delivery flow, end to end

When a campaign-associated contact is actually messaged:

1. **Draft.** The drafter endpoint (e.g. `/api/dashboard/[workspaceId]/draft-message`) loads:
   - The contact's recent signals (for context-in-prompt).
   - The matched persona (or "no persona" — see GLOSSARY).
   - The fingerprint at the most-specific scope (`channel_persona` if persona match + channel; otherwise `channel`; otherwise `corporate`).
   - The campaign's default template (or selected variant) as the message shell.
2. **Render the prompt** with persona + fingerprint + signal context + template shell, hit Anthropic, get the draft.
3. **Send.** Calls the channel-specific send function:
   - `linkedin_dm` → `sendLinkedInDm` via Unipile (`apps/web/app/api/dashboard/[workspaceId]/send-dm/route.ts`).
   - `email` → `sendOutbound` via Resend (`apps/web/lib/email/send-outbound.ts`).
   - `newsletter` → broadcast pipeline.
   - `outbound_call` → manual logged via call-log UI (no fingerprint, per ADR-005).
4. **Outreach log + signal.** On successful send:
   - Append an `outreach_log` row with `(workspace_id, contact_id, channel, fingerprint_version_id, campaign_id, sent_at, status)`. The `fingerprint_version_id` records the exact fingerprint row that drove the draft — outcome attribution depends on this (ADR-004).
   - Append a signal: `sent_email` / `sent_dm` / etc. The `sent_*` verbs typically have score_delta = 0 (outbound action, not buyer engagement) but the verb weight is workspace-tunable.
5. **Wait for response signals.** When the recipient replies / clicks / opens, the relevant inbound webhook (Unipile / Resend) fires the corresponding verb. The signal is linked to the contact, the score increments, and the funnel updates.

## What "Delivery" means in the dashboard

The top-level Delivery section (previously Actions) is the workspace's view onto all this. It has:

- **Channels** as the primary navigation — each channel renders one card.
- Each channel shows stat strips (sends, opens, replies) and the campaigns nested under it.
- Each campaign row shows its own stat strip + the contacts on it.
- Click a row to unfurl Companies → People → Signals in place (per the unfurl-rows pattern; right-edge drawers are reserved for settings, not browsing).

## Click attribution flow

A campaign's `clicked_link_score` is the magic that makes click-tracking part of the funnel:

1. Outbound email includes a tracked link with `?utm_medium=<campaign-id>&utm_content=<contact-id>` (or similar) added by the attribution app's URL builder.
2. Recipient clicks. Browser hits the attribution app's click endpoint (`apps/attribution/api/track.ts`).
3. Attribution app resolves `utm_medium` → campaign, `utm_content` → contact, looks up the campaign's `clicked_link_score`, and writes a `clicked_link` signal on the contact with that score as the delta.
4. The score lifts the contact in the SDR action list.

This is why `clicked_link_score` lives on the campaign rather than being a global verb weight: different campaigns warrant different signal strengths (a "click on a pricing page link" is worth more than "click on a blog link"), and the campaign is the natural scope.

## Common operations

### Create a campaign

Settings → Campaigns → "New campaign." Pick a channel, give it a name, set the click-link score (default 0). The first template comes auto-seeded as the default.

### Edit a template / add variants

In the campaign settings drawer, add additional templates and mark whichever should be default. The unique partial index makes sure exactly one is default.

### Archive a campaign

Sets `archived_at = NOW()`. The campaign disappears from active lists but its templates + associated outreach log rows stay (append-only; you don't lose history).

### Move contacts between campaigns

Currently: remove from one campaign, add to another. There's no bulk-move primitive yet. Adding one would be a follow-up.

## Footguns

- **Don't reuse a campaign ID** for a different campaign meaning. It becomes the `utm_medium`; renaming it after sends have gone out doesn't change the historical attribution.
- **Don't change a template AFTER mid-flight sends** unless you're OK that subsequent draft refreshes will use the new shell. The `outreach_log.fingerprint_version_id` records the fingerprint version, but the template content isn't versioned — only the campaign-template row's current state.
- **Don't bypass the drafter** for a "raw send" through the channel API. The drafter is what hooks up the fingerprint, persona, and template. Bypassing it produces drafts without voice attribution and breaks ADR-004's resolution rules.
