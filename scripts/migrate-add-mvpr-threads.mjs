/**
 * Migration: add MVPR journalist-outreach threads + PR-performance plumbing.
 *
 * Adds:
 *   - mvpr_threads table (the pitch conversations behind coverage)
 *   - mvpr_sync_state.last_thread_sync_at watermark column
 *   - mvpr_coverage.thread_id (links a coverage back to the thread that won it,
 *     so coverage rate = threads that produced coverage / threads sent)
 *
 * Powers the PR-performance tracking surface (response rate, coverage rate,
 * which intents/messages land) and the pr_* signal verbs. See ADR-014 and
 * docs/PR-LinkedIn-Measurement.md.
 *
 * Idempotent. Safe to re-run.
 *
 * Usage:
 *   node scripts/migrate-add-mvpr-threads.mjs
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
  `CREATE TABLE IF NOT EXISTS mvpr_threads (
    workspace_id         TEXT         NOT NULL,
    mvpr_id              TEXT         NOT NULL,
    subject              TEXT         NOT NULL,
    intent               TEXT         NOT NULL,
    status               TEXT         NOT NULL,
    is_archived          BOOLEAN      NOT NULL DEFAULT FALSE,
    message_count        INTEGER      NOT NULL DEFAULT 0,
    has_journalist_reply BOOLEAN      NOT NULL DEFAULT FALSE,
    journalist_id        TEXT         NOT NULL,
    journalist_name      TEXT         NOT NULL,
    publication_id       TEXT,
    publication_name     TEXT,
    mvpr_created_at      TIMESTAMPTZ  NOT NULL,
    last_action_at       TIMESTAMPTZ  NOT NULL,
    raw_payload          JSONB,
    synced_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, mvpr_id)
  )`,

  `CREATE INDEX IF NOT EXISTS mvpr_threads_workspace_time_idx
    ON mvpr_threads (workspace_id, last_action_at DESC)`,

  `CREATE INDEX IF NOT EXISTS mvpr_threads_workspace_intent_idx
    ON mvpr_threads (workspace_id, intent)`,

  `CREATE INDEX IF NOT EXISTS mvpr_threads_journalist_idx
    ON mvpr_threads (workspace_id, journalist_id)`,

  `ALTER TABLE mvpr_sync_state
    ADD COLUMN IF NOT EXISTS last_thread_sync_at TIMESTAMPTZ`,

  `ALTER TABLE mvpr_coverage
    ADD COLUMN IF NOT EXISTS thread_id TEXT`,
]

for (const s of statements) {
  process.stdout.write(`→ ${s.slice(0, 80).replace(/\s+/g, " ")}${s.length > 80 ? "…" : ""} `)
  await sql(s)
  console.log("✓")
}
console.log("\nMigration complete.")
