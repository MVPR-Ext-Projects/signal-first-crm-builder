/**
 * Migration: add broadcast_sends table for newsletter + product update email stats.
 * Usage: node scripts/migrate-add-broadcast-sends.mjs
 */

import { neon } from "@neondatabase/serverless"
import { config as loadEnv } from "dotenv"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(__dirname, "../.env.production.local") })
loadEnv({ path: resolve(__dirname, "../apps/web/.env.local") })

if (!process.env.DATABASE_URL) { console.error("Missing DATABASE_URL"); process.exit(1) }
const sql = neon(process.env.DATABASE_URL)

const statements = [
  `CREATE TABLE IF NOT EXISTS broadcast_sends (
    id             BIGSERIAL    PRIMARY KEY,
    workspace_id   TEXT         NOT NULL,
    type           TEXT         NOT NULL,
    name           TEXT,
    sent_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    emails_sent    INT          NOT NULL DEFAULT 0,
    opened         INT          NOT NULL DEFAULT 0,
    clicked        INT          NOT NULL DEFAULT 0,
    booked         INT          NOT NULL DEFAULT 0,
    won_or_upsold  INT          NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS broadcast_sends_workspace_type_idx
    ON broadcast_sends (workspace_id, type, sent_at DESC)`,
]

for (const s of statements) {
  const preview = s.replace(/\s+/g, " ").trim()
  process.stdout.write(`-> ${preview.slice(0, 80)}${preview.length > 80 ? "…" : ""} `)
  await sql.query(s)
  console.log("done")
}
console.log("\nMigration complete.")
