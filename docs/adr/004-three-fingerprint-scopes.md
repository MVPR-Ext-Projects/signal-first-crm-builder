# 004 — Style fingerprints have three resolution scopes

**Status:** Accepted

## Context

Writing-style fingerprints control *how* outbound messages sound — the voice, vocabulary, sentence shapes. Early on we had two options:

1. **One fingerprint per workspace** — simple, but means the same voice for every contact across every channel, which is wrong (a LinkedIn DM and a newsletter shouldn't sound identical, and the voice for a CFO buyer shouldn't sound identical to the voice for a Head of Product).
2. **One fingerprint per (channel × persona)** — accurate but combinatorially expensive to set up. A workspace with 4 personas and 6 channels needs 24 fingerprints maintained.

Neither matched how users actually wanted to work: most users want a workspace-wide voice baseline, with channel-specific overrides where they care, and (for advanced users) per-persona overrides on specific channels.

## Decision

Three resolution scopes, resolved least-to-most specific:

1. **`corporate`** — workspace-wide. The baseline voice. Always defined.
2. **`channel`** — voice for a specific delivery channel (LinkedIn DM, Direct Email, Newsletter, etc.) with `persona_id` unset. Overrides corporate when set.
3. **`channel_persona`** — voice for a specific channel AND persona combination. Overrides channel when set.

At draft time, the resolver picks the most-specific row that matches. `outreach_log.fingerprint_version_id` records which row actually drove the send, so we can attribute outcomes back to a specific fingerprint version.

## Consequences

**Upsides:**
- A new workspace can ship with just one corporate fingerprint and still get reasonable outbound.
- Power users can opt into channel-level or channel-persona-level customisation incrementally.
- A/B testing fingerprints is straightforward: clone, modify, measure.

**Downsides:**
- The resolver is a footgun. When adding a new draft endpoint, it's tempting to write `fetchFingerprint({ scope: 'channel_persona' })` directly — which skips the corporate and channel layers and breaks personas-with-no-match.
- The three scopes need to be visible in the dashboard so users understand the resolution. The current UI groups them by channel, which works but isn't obvious to new users.

**What would invalidate this decision:**
- A model that can generate voice-matched output without an explicit fingerprint (e.g. just feed the corpus of past sends each time). Currently this is too expensive and too inconsistent.

## How to use the scopes correctly

When fetching a fingerprint for a draft:
- ALWAYS fetch corporate first as the baseline.
- ALWAYS fetch the channel layer as the override.
- Then optionally fetch channel_persona if the contact has a persona match.

Never hardcode `scope = 'channel_persona'` in a fetch call. That bug was the reason this ADR exists.

## Unmatched contacts

A contact with no persona match (the default "no persona" state — see GLOSSARY.md and PHILOSOPHY.md "Strict matching beats permissive matching") still gets a fingerprint at draft time: the resolver falls back through `channel` to `corporate` scope. The `channel_persona` layer is silently skipped because there's no persona key to look it up under. This is correct behaviour, not an edge case to handle separately.

If a workspace finds that too many of their contacts are unmatched and the channel-level voice doesn't differentiate enough, the right response is to add another persona that covers the gap — not to bake "no persona" into the fingerprint system as a separate scope.
