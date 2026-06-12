# 005 — Outbound Calls is intentionally not a fingerprint channel

**Status:** Accepted

## Context

The `style_fingerprints` table has a `channel` field. The set of channels grew naturally as the product added delivery surfaces: LinkedIn DM, Direct Email, Newsletter, Product Updates, PR Coverage Notes. When Outbound Calls was added as a channel in the dashboard's "Actions" surface (for tracking call activity), the question came up: should it also get a fingerprint?

The argument for yes: consistency. Every other channel has a fingerprint, why not this one?

The argument for no: fingerprints model **written** voice — sentence shapes, vocabulary, punctuation, em-dash vs hyphen preference, paragraph length. Voice in the spoken sense — tone, pace, warmth — is real but not capturable by a text-output prompt-engineering layer. A "fingerprint for calls" would just be a vague set of bullet points that doesn't actually change what the seller says on the phone.

## Decision

Outbound Calls is a channel in the dashboard but NOT in the fingerprint system. The `StyleChannel` type (in `apps/web/lib/style/`) does not include `outbound_call`. The fingerprints UI does not offer a "Calls" tab.

Call activity is tracked (via the call-log surface) but not voice-modelled by this system.

## Consequences

**Upsides:**
- The fingerprint concept stays honest: it's about written output, where prompt engineering can actually shape the result.
- The dashboard doesn't ship a UI affordance that would be effectively decorative.
- A future "voice training" feature for call coaching would be a separate system, not bolted onto fingerprints.

**Downsides:**
- Inconsistency in the dashboard: "Calls" appears in some lists, not others.
- New contributors may try to extend `StyleChannel` with `outbound_call` and get a confusing error or, worse, accidentally enable it (the type would compile but the resolver would have no fingerprint to find).

**What would invalidate this decision:**
- AI-generated call scripts becoming a real product feature. Then a fingerprint for spoken voice would make sense and the channel would be added to the fingerprint system.

## Guardrail

If you find yourself extending `StyleChannel` with `outbound_call` or a similar voice-only channel, stop and re-read this ADR. The right answer is almost always "no."
