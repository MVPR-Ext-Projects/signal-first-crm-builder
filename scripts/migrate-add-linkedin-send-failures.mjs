/**
 * Migration: linkedin_send_failures log table.
 *
 * Tracks individual Unipile send failures so the "2 hard fails in 48h ->
 * mark URL inactive" policy can be checked with one query. Each row is a
 * single failure event; rows are kept indefinitely for audit, with the
 * runtime query windowing to the last 48h.
 *
 * Schema:
 *   id           BIGSERIAL    PK
 *   workspace_id TEXT         NOT NULL
 *   contact_id   BIGINT       NOT NULL REFERENCES contacts(id) ON DELETE CASCADE
 *   linkedin_url TEXT         NOT NULL (snapshot of the URL at fail time)
 *   reason       TEXT         (e.g. 'unipile_no_provider_id', 'unipile_send_error')
 *   occurred_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
 *
 * Index: (workspace_id, contact_id, occurred_at DESC) - the runtime query
 * is "how many fails for this contact in the last 48h" so the composite
 * lookup is the hot path.
 *
 * Strictly additive. Idempotent.
 *
 * Usage:
 *   node scripts/migrate-add-linkedin-send-failures.mjs
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
  `CREATE TABLE IF NOT EXISTS linkedin_send_failures (
    id            BIGSERIAL    PRIMARY KEY,
    workspace_id  TEXT         NOT NULL,
    contact_id    BIGINT       NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    linkedin_url  TEXT         NOT NULL,
    reason        TEXT,
    occurred_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS linkedin_send_failures_contact_window_idx
    ON linkedin_send_failures (workspace_id, contact_id, occurred_at DESC)`,
]

for (const s of statements) {
  process.stdout.write(`-> ${s.slice(0, 70).replace(/\s+/g, " ")}${s.length > 70 ? "..." : ""} `)
  await sql(s)
  console.log("OK")
}
console.log("\nMigration complete.")
