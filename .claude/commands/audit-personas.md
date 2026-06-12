---
description: Analyse the current persona library for coverage gaps, overlaps, and match-rule problems.
---

You are auditing the persona library in the workspace's `WorkspaceConfig.messaging.personas`. Goal: surface coverage gaps, overlaps, and match-rule problems before they cause silent mis-routing in outbound drafts.

## What to read

1. The seed: `seed/example-workspace.json` (the current default personas — example data shaped for a B2B platform-observability company; replace as you customize).
2. The matcher logic: `apps/web/lib/persona-match.ts` (especially the strict-matching rules).
3. The persona schema: the `Persona` interface in `apps/web/app/dashboard/[workspaceId]/settings/company-messaging/personas-form.tsx`.

## Checks to run

### Match-pattern coverage

For each persona, list its `matchPatterns`. Check:
- **Overlaps**: do two personas have overlapping job-title patterns? If so, first-match-wins means the *second* persona is unreachable for that overlap. Surface this.
- **Gaps**: are there obvious buyer job titles in the workspace's ICP that no persona matches? Use the `targetCompanyKeywords` and the `prospectTypes` to inform what the ICP looks like.

### Country and company-size strictness

The matcher is STRICT — missing country or employee data fails the match, doesn't fall through. For each persona:
- If `matchCountries` is set, what fraction of the workspace's known contacts have a country populated? (If most don't, this persona will under-match.)
- If `minEmployees` / `maxEmployees` is set, same question for employee data.

If you can't run queries (no DB access in this session), explain the risk and suggest the user inspect contact-coverage from the dashboard's data state.

### Rich-schema completeness

For each persona, check that the rich fields are populated:
- `whoTheyAre` (description)
- `jobsToBeDone` (at least 3 entries)
- `valueProps` (at least 3)
- `painPoints` (at least 3)
- `desiredOutcomes` (at least 3)

A persona with sparse fields will produce thin drafts. Surface "Persona X is missing: pain points, desired outcomes."

### Near-duplicates

Are any two personas suspiciously similar? Same product, overlapping match patterns, similar JTBD? Flag candidate pairs for the user to review.

## Output

Return a punch list:

```
Persona library audit — N personas
─────────────────────────────────────

OVERLAPS (first-match-wins makes later ones unreachable):
  - "Persona A" and "Persona B" both match "ceo, coo" in EU

GAPS (no persona matches these likely buyers):
  - <job-title-pattern> appears to be in ICP but no persona matches

SPARSE PERSONAS (will produce thin drafts):
  - "Persona C": missing pain points, only 1 valueProp

NEAR-DUPLICATES (consider merging):
  - "<persona name>" (idx X) and "<persona name>" (idx Y) — same product, overlapping match patterns, similar JTBD

STRICT-MATCH RISK:
  - "Persona D" requires matchCountries=[EU,US] — many contacts have no country populated

Recommendations:
  - <ordered list of specific edits>
```

Be specific. Cite which persona by name. Don't be vague.

## What you should NOT do

- Don't propose merging without explicit consent — flag the near-duplicate, let the user decide.
- Don't loosen match rules to "fix" gaps. Per `PHILOSOPHY.md` and the persona-coverage feedback, strict matching is the design; unmatched contacts are a feature.
- Don't suggest adding more personas to maximise coverage; suggest adding ones that address a specific named gap.
