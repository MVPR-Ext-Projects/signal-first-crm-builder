# 007 — Signal verb enum is maintained in three places

**Status:** Accepted (with active discomfort)

## Context

The set of allowed `signal_verb` values is constrained — only certain strings are legal (`liked_post`, `commented_post`, `viewed_profile`, etc.). Where does this enum live?

The textbook answer: one place. Use a Postgres `CREATE TYPE ... AS ENUM (...)` or a TypeScript const array with a `z.enum()` schema, and reference everywhere.

The actual answer: the enum lives in three places because each consumer needs a slightly different view:

1. **Postgres** — the `signals.signal_verb` column is `TEXT` with a comment listing allowed values. Not a real ENUM, because adding new verbs to a Postgres ENUM requires a migration and a downtime window we wanted to avoid.
2. **TypeScript model** — `apps/web/lib/` has a verb-to-score and verb-to-display-name map. Used by the score derivation logic and the webhook handlers.
3. **Dashboard label map** — a separate object mapping `signal_verb` → user-facing label (with localisation potential). Lives close to the UI.

Adding a new verb means touching all three.

## Decision

Keep the enum distributed across these three places, with a convention that adding a verb means a checklist:

1. Update the comment block in `apps/web/lib/db/schema.sql` near `signals.signal_verb`.
2. Add the verb to the model in `apps/web/lib/` with its default score weight.
3. Add the verb to the dashboard label map.

The pre-commit eval in `CLAUDE.md` reminds contributors to check all three.

## Consequences

**Upsides:**
- No DB migration when adding a verb. Just code.
- Each consumer (DB constraint, score logic, UI label) can evolve independently.
- The comment-block approach is human-readable and AI-readable at the same time.

**Downsides:**
- It's the kind of distributed state that gets out of sync if you're not careful. A new verb in one place but not the others = silent UI bugs ("Unknown signal" labels) or scoring gaps (the verb counts but doesn't display).
- New contributors don't know about all three places until they trip over the inconsistency.

**What would invalidate this decision:**
- A Postgres migration tool that makes ENUM changes painless (e.g. CockroachDB-style schema changes). Then a real ENUM would be cleaner.
- A code-generation step that derives the TypeScript model + dashboard map from the schema comment block automatically. Worth considering.

## Guardrail

When adding or renaming a verb, run a grep for the old verb across `*.ts`, `*.tsx`, `*.sql`, `*.mjs`. If it appears in places other than the three documented locations, that's a sign the abstraction is leaking and worth fixing.
