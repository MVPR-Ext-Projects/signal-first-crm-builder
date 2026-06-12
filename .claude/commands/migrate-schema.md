---
description: Scaffold a new Postgres schema migration following the project's migrate-add-*.mjs convention.
---

You are helping the user create a new schema migration. The convention is `scripts/migrate-<description>.mjs`, runnable standalone, idempotent where possible.

`apps/web/lib/db/schema.sql` is the source of truth for fresh installs — it describes the schema at v1. Once shipped, additive changes go through migration scripts; `schema.sql` is updated in lockstep so a new install gets the latest state.

## What you need from the user

1. **The change** — short description, e.g. "add `linkedin_invite_status` column to contacts", "add `discount_tier` enum to companies".
2. **Whether it's additive** — adding columns / tables / indexes (safe) — or destructive — dropping / renaming (requires care, may need a backfill).

## Scaffold the migration

Filename: `scripts/migrate-add-<short-snake>.mjs` (use `migrate-rename-` or `migrate-drop-` for non-additive).

Skeleton:

```js
/**
 * Migration: <one-line description>
 *
 * What it does:
 *   - <step 1>
 *   - <step 2>
 *
 * Idempotent: yes (uses IF NOT EXISTS) / no (explain why)
 *
 * Backfill: yes (column defaults to NULL; backfilled by ...) / no
 *
 * Run:
 *   node scripts/migrate-add-<short-snake>.mjs
 *
 * Required env: POSTGRES_URL
 */

import { config } from "dotenv"
import { neon } from "@neondatabase/serverless"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, "../.env.local") })
config({ path: resolve(__dirname, "../.env.production.local") })

if (!process.env.POSTGRES_URL) {
  console.error("✗ POSTGRES_URL must be set")
  process.exit(1)
}

const sql = neon(process.env.POSTGRES_URL)

console.log("▶ Adding <thing>...")

await sql`
  ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS <field_name> <TYPE>
`

console.log("✓ Migration complete")
```

For more complex changes (multi-statement, requires transaction), use `await sql.transaction([...])` per the Neon serverless driver docs.

## Also update schema.sql

Find the corresponding table block in `apps/web/lib/db/schema.sql` and add the column / constraint in the right place. Match the comment style of nearby fields.

This is critical: `schema.sql` is what a fresh install runs. If you only write the migration, new deployments won't get the change.

## Backfill considerations

If the new column needs a default value beyond NULL:
- Add the column with `DEFAULT <value>` if the default is universal.
- If the default depends on existing row state, run a separate UPDATE in the migration to backfill, AFTER the column is added.
- If the backfill is expensive on a large table, paginate (`LIMIT 10000`, loop) to avoid lock contention.

## Pre-commit eval (for this change)

- `schema.sql` updated in lockstep? ✓
- Migration uses `IF NOT EXISTS` where applicable? ✓
- Multi-tenancy: does any new column / table scope correctly by `workspace_id`? ✓
- Indexes: did you add an index for any new column that will be queried? Prefer `(workspace_id, <column>)` for the leading index.
- WorkspaceConfig: if this change introduces per-workspace settings, the config side needs updating too (`workspace-config.ts`, encryption, seed, wizard, dashboard).
- Reports + costs pages: will reports show different numbers after this? Audit and update in the same commit.

## Don't

- Don't write destructive migrations (DROP COLUMN, DROP TABLE) without first explicitly confirming with the user. They're rarely reversible without backups.
- Don't use Postgres ENUM types for things that change. Use TEXT + check constraint or TEXT + comment (per `docs/adr/007-signal-verb-enum-three-places.md`).
- Don't reference `synced_to_attio_at` semantics in new code — that column is legacy from a previous CRM (see `apps/web/lib/db/schema.sql` comments).
