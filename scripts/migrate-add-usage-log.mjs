/**
 * Migration: add `usage_log` table for per-workspace cost tracking.
 *
 * Idempotent (CREATE TABLE IF NOT EXISTS).
 *
 * Usage:
 *   node scripts/migrate-add-usage-log.mjs
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
  console.error("Missing DATABASE_URL")
  process.exit(1)
}

const sql = neon(process.env.DATABASE_URL)

const statements = [
  `CREATE TABLE IF NOT EXISTS usage_log (
     id                BIGSERIAL    PRIMARY KEY,
     workspace_id      TEXT         NOT NULL,
     occurred_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
     category          TEXT         NOT NULL,
     provider          TEXT         NOT NULL,
     units             NUMERIC      NOT NULL DEFAULT 0,
     unit_cost_cents   NUMERIC      NOT NULL DEFAULT 0,
     total_cost_cents  NUMERIC      NOT NULL DEFAULT 0,
     metadata          JSONB        NOT NULL DEFAULT '{}'::jsonb
   )`,
  `CREATE INDEX IF NOT EXISTS usage_log_workspace_time_idx
     ON usage_log (workspace_id, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS usage_log_workspace_provider_time_idx
     ON usage_log (workspace_id, provider, occurred_at DESC)`,
]

for (const s of statements) {
  process.stdout.write(`-> ${s.slice(0, 80).replace(/\s+/g, " ")}${s.length > 80 ? "…" : ""} `)
  await sql.query(s)
  console.log("done")
}
console.log("\nMigration complete.")
