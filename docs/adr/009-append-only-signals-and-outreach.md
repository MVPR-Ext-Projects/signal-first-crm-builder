# 009 — Signals and outreach_log are append-only

**Status:** Accepted

## Context

The `signals` and `outreach_log` tables are the event log of the system. They drive the funnel, the reports, and the attribution.

Two options for keeping them up to date when context changes (e.g. a signal was misclassified, an outreach was retried):

1. **Mutate in place.** Update the existing row. Simple, fewer rows.
2. **Append a new row.** Add a corrective signal or retry log row. More rows, no edits.

## Decision

Both tables are append-only. Context changes append a new row, not edit an old one. The funnel score is the sum across all signals; the outreach history is the full ordered list of attempts.

The exceptions are limited and explicit:
- **Retraction columns**: a row can be soft-retracted via a `*_at` column (e.g. `recalled_at`, `declined_at`) without being deleted. The funnel logic ignores retracted rows.
- **DELETE**: allowed only for genuine error recovery (e.g. a webhook re-delivered the same event with a different ID). Always paired with explicit logging.

## Consequences

**Upsides:**
- The funnel score is recomputable from the log. Audit trails are intact.
- Retries are visible — three attempts to send a DM show as three rows, not one row with a counter.
- A change to scoring weights or stage thresholds can be re-applied to the full history without losing the original events.

**Downsides:**
- Storage grows linearly with engagement volume. Indexes on `(workspace_id, occurred_at)` and `(workspace_id, last_signal_at)` are critical.
- "How many sends to this contact?" requires a COUNT(*), not a single column read. Acceptable cost.
- A misclassified signal isn't fixable by editing the row — you have to append a correction. Slightly unintuitive in practice but the right design.

**What would invalidate this decision:**
- A storage backend where append-cost > mutation-cost (unusual for Postgres). Then mutations might win.
- A workflow that requires editing past events for compliance reasons (e.g. GDPR right-to-be-forgotten). Then DELETE becomes routine, but always paired with audit logging.

## Guardrails

- Don't write `UPDATE signals SET score_delta = ...` to "fix" a past signal. Append a new signal with an offsetting `score_delta`.
- Don't reuse `outreach_log` rows on retry — each attempt is a new row.
- DELETE on these tables is a code smell. If you find one in a code review, ask: is this a retraction (set a `*_at` column) or a genuine error recovery (with a comment explaining why)?
