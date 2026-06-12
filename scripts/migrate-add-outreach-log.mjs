/**
 * Migration: add outreach_log table.
 * Usage: node scripts/migrate-add-outreach-log.mjs
 */

import { neon } from "@neondatabase/serverless"
import { config as loadEnv } from "dotenv"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(__dirname, "../.env.production.local") })
loadEnv({ path: resolve(__dirname, "../apps/web/.env.production.local") })

if (!process.env.DATABASE_URL) { console.error("Missing DATABASE_URL"); process.exit(1) }
const sql = neon(process.env.DATABASE_URL)

const statements = [
  `CREATE TABLE IF NOT EXISTS outreach_log (
    id              BIGSERIAL    PRIMARY KEY,
    workspace_id    TEXT         NOT NULL,
    contact_id      BIGINT       NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    channel         TEXT         NOT NULL DEFAULT 'dm',
    message_preview TEXT,
    persona         TEXT,
    stage           TEXT,
    template_ids    TEXT[],
    occurred_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    responded_at    TIMESTAMPTZ,
    booking_at      TIMESTAMPTZ,
    chat_id         TEXT,
    message_id      TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS outreach_log_workspace_time_idx ON outreach_log (workspace_id, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS outreach_log_contact_idx ON outreach_log (contact_id, occurred_at DESC)`,
]

for (const s of statements) {
  const preview = s.replace(/\s+/g, " ").trim()
  process.stdout.write(`-> ${preview.slice(0, 80)}${preview.length > 80 ? "…" : ""} `)
  await sql.query(s)
  console.log("done")
}
console.log("\nMigration complete.")
