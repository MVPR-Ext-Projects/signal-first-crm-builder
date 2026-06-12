# The Drafter

How outbound messages get written. The drafter is the engine that turns "this contact is engaging" into "here's a 90-word LinkedIn DM that sounds like us, addresses what they posted yesterday, and isn't generic LLM slop."

It's the single most differentiated piece of the system — the place where persona, fingerprint, recent signals, and the workspace's chosen template come together. Read this if you're customising any draft endpoint, adding a new channel, or wondering "why doesn't the LLM just figure this out?"

Companion reading:
- `PHILOSOPHY.md` "Why writing-style fingerprints exist" — the strategic case for the fingerprint system
- `docs/adr/004-three-fingerprint-scopes.md` — the mechanics of fingerprint resolution
- `GLOSSARY.md` — Persona, Style fingerprint, Action set, Channel
- `docs/CAMPAIGNS.md` — how templates fit in

---

## What the drafter is responsible for

When the seller clicks "Draft DM" (or "Draft email", or any other draft action), the drafter:

1. **Loads the contact** + their recent signals (the "what have they been doing" context).
2. **Matches a persona** — first persona in `WorkspaceConfig.messaging.personas` whose match rules accept this contact wins. May be "no persona" if no match — that's a feature, not a bug (PHILOSOPHY.md).
3. **Resolves the fingerprint** — three-scope resolution: corporate (baseline) → channel (LinkedIn DM vs email vs newsletter) → channel_persona (the specific intersection). The most-specific row that matches drives the draft (ADR-004).
4. **Picks the template** — if the contact is associated with a campaign, the campaign's default template is the message shell. Otherwise the channel-default template.
5. **Renders the prompt** — combines persona context + fingerprint constraints + signal context + template shell + workspace-level config (e.g. "no em dashes").
6. **Hits Anthropic** — calls Claude with the constructed prompt.
7. **Returns the draft** to the dashboard for the seller to review and (optionally) send.

The seller is always in the loop. The drafter doesn't auto-send — it drafts. The send is a separate, explicit action.

---

## Where the drafter lives in code

The draft endpoints:

- `apps/web/app/api/dashboard/[workspaceId]/draft-dm/route.ts` — LinkedIn DM drafts
- `apps/web/app/api/dashboard/[workspaceId]/draft-message/route.ts` — general / email drafts
- (Channel-specific variants for newsletter, Resend lifecycle drafts, etc.)

The processing libraries:

- `apps/web/lib/persona-match.ts` — the `pickPersona()` matcher
- `apps/web/lib/style/fetch-fingerprints.ts` — the three-scope resolver
- `apps/web/lib/ai.ts` — the Anthropic SDK wrapper + retry / cache logic

The prompt assembly is currently inline in each draft endpoint. As channels proliferate, that's the natural place to extract a shared `buildDraftPrompt()` helper.

---

## The prompt's shape

A draft prompt has roughly these layers, in order:

```
[Workspace-level "voice rules"]
  (from corporate fingerprint + workspace conventions)
  e.g. "No em dashes. Plain hyphens only.
       Sentence-case headlines. No corporate language."

[Channel-level voice]
  (from channel fingerprint)
  e.g. "LinkedIn DMs: max 90 words. Open with their post / context, not 'I hope this finds you well.'"

[Persona-specific voice]
  (from channel_persona fingerprint, if matched)
  e.g. "Engineering Managers: they read HackerNews, they're skeptical of marketing language.
        Reference concrete things they posted, not 'your impressive work.'"

[Context about this specific contact]
  (recent signals, persona match metadata, role at company)
  e.g. "Contact: Jane Doe, Engineering Manager at Acme.
        Last 7 days: liked our post on platform engineering (2d ago);
        viewed profile (1d ago). Company is at score 28, stage 'Engaged.'"

[Template (if campaign-attached)]
  (the campaign's default template — the message shell)
  e.g. "Hi {{firstName}},
        Saw you {{recentSignal}}. We help {{painPoint}}..."

[Request]
  "Draft a LinkedIn DM. 50-90 words. Follow all rules above.
   Return only the draft text, no preamble."
```

Each layer is *constraints*, not suggestions. The fingerprints are the most constraining — they say what NOT to do (no em dashes, no "I hope this finds you well," no overpromising claims) as much as what to do.

---

## Why not just prompt-engineer voice per send?

PHILOSOPHY.md has the long answer. The short version:

- **Drift.** Sellers can't paste 20 examples into every prompt. They paste 2; the LLM regresses to generic.
- **Inconsistency.** "Be conversational" is interpreted differently each time.
- **No attribution.** Without a `fingerprint_version_id` recording which row drove the draft, you can't measure which voice instruction worked.
- **No reuse.** Marketing can't share voice across SDRs. New hires can't inherit it.

A fingerprint is the encoded *answer* to "how do we sound." It's a constraint on the LLM, not a hint. The drafter loads the right one and trusts it.

---

## Fingerprint resolution at draft time

The most common bug pattern (which ADR-004 names explicitly):

```ts
// WRONG — skips corporate + channel fallback for unmatched personas
const fp = await fetchFingerprint({ scope: 'channel_persona', channel, personaId })
```

```ts
// RIGHT — fetches all three layers; resolver picks the most-specific that matches
const fp = await fetchFingerprints({ workspace, channel, personaId })
```

The helper is responsible for the three-scope precedence. Don't hardcode the scope at the call site.

If the contact has no persona match (the "no persona" default state — see GLOSSARY.md), the resolver returns the channel-scope row (or the corporate row if the channel doesn't have its own). Drafts still happen — they're just not persona-tailored. That's correct, not a degradation.

---

## What gets recorded after a successful send

When the seller hits Send, the send endpoint (`/api/dashboard/[workspaceId]/send-dm` for LinkedIn, `/send-email` for email):

1. Appends an **`outreach_log`** row with:
   - `workspace_id`, `contact_id`, `channel`
   - `fingerprint_version_id` — the exact fingerprint row that drove this draft. Critical for outcome attribution: when a reply comes in 3 days later, you can trace it back to which fingerprint version was used.
   - `campaign_id` (if applicable)
   - `sent_at`, `status`
2. Appends a **`signals`** row with the appropriate verb (`sent_dm` / `sent_email` etc.). The outbound action is itself a signal — symmetric with the prospect's signals.

This is what makes A/B testing fingerprints possible: clone a fingerprint, modify the cloned row, watch which `fingerprint_version_id` correlates with positive replies. The system measures outcomes by what's in the log, not by what feels right.

---

## When you customise

Common changes you might make to the drafter:

### Adding a new channel

The new channel needs:
- A channel-level fingerprint row (you can ship a placeholder; the channel can inherit the corporate voice initially).
- A draft endpoint that follows the pattern of the existing ones.
- A send endpoint that hands off to the channel's transport (Unipile, Resend, etc.).
- A signal verb for "sent" via the new channel (see ADR-007 — three places to update).

### Changing the prompt structure

Edit the inline prompt assembly in the draft endpoint. If you extract a shared helper, make sure every channel's draft endpoint calls it — drift in the prompt is a leading cause of voice inconsistency across channels.

### Adding more context to the prompt

Common additions: company-level signal context ("the company is in active discussion stage"), recent published content from the contact ("their last 3 LinkedIn posts were about..."), competitive intel ("they currently use [competitor]"). All of these go in the **Context about this specific contact** section of the prompt.

### Tuning the model parameters

Temperature, max tokens, model choice — currently lives in `apps/web/lib/ai.ts` or inline in the endpoints. Centralise as the number of draft channels grows.

---

## Footguns

- **Don't hardcode `scope = 'channel_persona'`** — see above. ADR-004 explains why.
- **Don't bypass the drafter** for a "raw send" through the channel API. The drafter is what hooks up persona + fingerprint + outreach_log attribution. Raw sends produce drafts with no voice constraint and no outcome trail.
- **Don't let the LLM see the raw fingerprint row** — render the *constraints* (do/don't lists, tone axes, sentence patterns), not the JSON. Models behave differently when they see structured-data-as-instructions vs structured-data-as-context.
- **Don't forget the no-em-dash rule** — it's a workspace-level convention, lives in the corporate fingerprint, and applies even inside an LLM completion. Sanity-check the draft for em dashes before returning it; this codebase strips them on render as a belt-and-braces measure.
- **Don't auto-send.** The seller is the safety check between the LLM's draft and the prospect's inbox. The dashboard surface always shows the draft for review before send.
