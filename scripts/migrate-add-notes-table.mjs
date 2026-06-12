/**
 * Migration: add the notes table.
 *
 * Task #12 of the dedup master plan. General notes (currently 'Manual Note'
 * rows on the signals table) move to a dedicated home — they aren't
 * engagement signals and shouldn't roll into signal_count / signal_score /
 * funnel_stage.
 *
 * Idempotent. Safe to re-run.
 *
 * Companion: scripts/retro-migrate-notes-to-notes-table.mjs moves the
 * historical 'Manual Note' rows out of `signals` into this new table and
 * recomputes signal_count on each affected contact.
 *
 * Usage:
 *   node scripts/migrate-add-notes-table.mjs
 */

import { neon } from "@neondatabase/serverless"
import { config as loadEnv } from "dotenv"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(__dirname, "../.env.production.local") })
loadEnv({ path: resolve(__dirname, "../.env.local") })
loadEnv({ path: resolve(__dirname, "../apps/web/.env.production.local") })
loadEnv({ path: resolve(__dirname, "../apps/web/.env.local") })

if (!process.env.DATABASE_URL) {
  console.error("✗ Missing DATABASE_URL")
  process.exit(1)
}

const sql = neon(process.env.DATABASE_URL)

const statements = [
  `CREATE TABLE IF NOT EXISTS notes (
    id             BIGSERIAL    PRIMARY KEY,
    workspace_id   TEXT         NOT NULL,
    contact_id     BIGINT       NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    -- Free-text note body. NOT NULL because an empty note has no purpose.
    body           TEXT         NOT NULL,
    -- Optional author display name (team_member id / name / email — caller
    -- supplies whichever it has). NULL when written by automation / unknown.
    created_by     TEXT,
    -- When the note pertains to (separate from created_at — supports
    -- back-dating a note for a conversation that happened earlier).
    occurred_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  )`,

  // Lookup index for the per-contact note list (engagement panel, timeline).
  `CREATE INDEX IF NOT EXISTS notes_contact_time_idx
    ON notes (contact_id, occurred_at DESC)`,

  // Workspace-scoped lookup for any future workspace-wide notes view.
  `CREATE INDEX IF NOT EXISTS notes_workspace_time_idx
    ON notes (workspace_id, occurred_at DESC)`,
]

for (const s of statements) {
  process.stdout.write(`→ ${s.slice(0, 80).replace(/\s+/g, " ")}${s.length > 80 ? "…" : ""} `)
  await sql(s)
  console.log("✓")
}
console.log("\nMigration complete.")
