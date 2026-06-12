/**
 * Migration: add company_moz_history table.
 *
 * company_moz_data keeps only the latest Moz snapshot per domain (upsert
 * overwrites). This table records every fetch as an immutable row so we
 * can track DA trends over time, compute per-segment averages, and spot
 * outliers (e.g. large headcount + low DA = untapped PR opportunity).
 *
 * Idempotent — safe to run multiple times.
 *
 * Usage:
 *   node scripts/migrate-add-company-moz-history.mjs
 */

import { neon } from "@neondatabase/serverless"
import { config as loadEnv } from "dotenv"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(__dirname, "../.env.production.local") })
loadEnv({ path: resolve(__dirname, "../apps/web/.env.production.local") })
loadEnv({ path: resolve(__dirname, "../apps/web/.env.local") })

if (!process.env.DATABASE_URL) { console.error("Missing DATABASE_URL"); process.exit(1) }
const sql = neon(process.env.DATABASE_URL)

const statements = [
  `CREATE TABLE IF NOT EXISTS company_moz_history (
    id               BIGSERIAL    PRIMARY KEY,
    workspace_id     TEXT         NOT NULL,
    domain           TEXT         NOT NULL,
    domain_authority INTEGER,
    page_authority   INTEGER,
    backlinks        BIGINT,
    root_domains     INTEGER,
    spam_score       INTEGER,
    fetched_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS company_moz_history_workspace_domain_time_idx
    ON company_moz_history (workspace_id, domain, fetched_at DESC)`,
]

for (const stmt of statements) {
  console.log("Running:", stmt.slice(0, 60), "...")
  await sql(stmt)
  console.log("  done.")
}

console.log("Migration complete.")
