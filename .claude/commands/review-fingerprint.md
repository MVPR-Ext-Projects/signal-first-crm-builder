---
description: Review a writing-style fingerprint for completeness, scope correctness, and drift from sample writing.
---

You are reviewing a writing-style fingerprint (a row in `style_fingerprints`). Fingerprints control voice for outbound drafts. Bad fingerprints produce stilted, off-brand drafts — and the failure mode is silent.

## What you need from the user

1. **The fingerprint scope** — corporate / channel / channel_persona. (If not specified, ask.)
2. **The channel and persona** (if scope is channel or channel_persona).
3. **A sample of intended output** — what the user wants drafts to sound like. Either paste 2-3 sample sends, or point at existing drafts to compare.

## Checks to run

### Scope correctness

Read `docs/adr/004-three-fingerprint-scopes.md` and confirm:
- If scope=corporate, `channel` and `persona_id` should be NULL.
- If scope=channel, `channel` set, `persona_id` NULL.
- If scope=channel_persona, both set.

Wrong scope = wrong precedence at draft time.

### Field completeness

Open the fingerprint row. Check it has substantive content in:
- `voice_summary` — 2-4 sentences describing the voice.
- `vocabulary_preferences` — words to use / avoid.
- `sentence_patterns` — average length, complexity, punctuation rules.
- `paragraph_shape` — opener style, structure, closer style.
- `tone_axes` — formality, warmth, directness, etc.
- `forbidden_patterns` — things never to do (e.g. "no em dashes", "no sales-y openers").

Each empty field is a place where the LLM falls back to its default voice, which is rarely what the user wants.

### Match against samples

Compare the fingerprint's claims against the sample output the user provided:
- Does the sample use em dashes? If yes but fingerprint says "no em dashes", they disagree — surface it.
- Does the sample open with "I noticed..."? If yes but fingerprint forbids it, surface.
- Is the sentence length distribution in the sample consistent with `sentence_patterns`?
- Is the tone in the sample consistent with `tone_axes`?

Flag any field where the fingerprint and the sample disagree.

### Forbidden-pattern coverage

Critical for this codebase: the user has a hard rule of **no em dashes**, always hyphens. Confirm the fingerprint includes this in `forbidden_patterns`. If not, flag it as a must-add.

Also check for other workspace-wide preferences in the corporate fingerprint that should never be overridden at lower scopes (e.g. "no fake first-name personalisation", "no false-urgency claims").

## Output

```
Fingerprint review — scope=<scope>, channel=<channel>, persona=<persona>
─────────────────────────────────────────────────────────────────────

COMPLETENESS:
  - voice_summary: <ok | sparse | empty>
  - vocabulary_preferences: ...
  - sentence_patterns: ...
  - paragraph_shape: ...
  - tone_axes: ...
  - forbidden_patterns: ...

CONSISTENCY WITH SAMPLE:
  - <field>: agrees / disagrees because <reason>

WORKSPACE-WIDE RULES:
  - No em dashes: <present in fingerprint? ✓ / missing>
  - [other rules]: ...

SUGGESTED EDITS (ordered by impact):
  1. <specific edit>
  2. ...
```

## What you should NOT do

- Don't propose moving content from a channel_persona fingerprint up to corporate without consent — the user may have chosen the specific scope deliberately.
- Don't suggest broad "make it more conversational" edits — be specific. "Replace 'I wanted to reach out' with a direct opener like 'X is hiring [their job title] — your post about Y came up.'"
- Don't compute the actual fingerprint resolution at draft time; that's a different review.
