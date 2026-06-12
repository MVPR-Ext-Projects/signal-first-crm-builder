/**
 * Migration: add company_linkedin_url column + company_enrichments table.
 *
 * Idempotent — safe to run multiple times.
 *
 * Usage:
 *   node scripts/migrate-add-company-linkedin.mjs
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
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_linkedin_url TEXT`,
  `CREATE TABLE IF NOT EXISTS company_enrichments (
    id                    BIGSERIAL    PRIMARY KEY,
    workspace_id          TEXT         NOT NULL,
    company_linkedin_url  TEXT         NOT NULL,
    company_name          TEXT,
    fetched_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    raw_count             INTEGER      NOT NULL DEFAULT 0,
    match_count           INTEGER      NOT NULL DEFAULT 0,
    employees             JSONB        NOT NULL,
    UNIQUE (workspace_id, company_linkedin_url)
  )`,
  `CREATE INDEX IF NOT EXISTS company_enrichments_workspace_idx
    ON company_enrichments (workspace_id, fetched_at DESC)`,
]

for (const s of statements) {
  process.stdout.write(`→ ${s.slice(0, 80).replace(/\s+/g, " ")}${s.length > 80 ? "…" : ""} `)
  await sql(s)
  console.log("✓")
}
console.log("\nMigration complete.")
