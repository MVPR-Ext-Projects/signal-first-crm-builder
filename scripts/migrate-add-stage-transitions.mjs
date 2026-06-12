/**
 * Migration: add company_stage_transitions table.
 *
 * Tracks when a company moves between funnel stages (auto or manual).
 * Populated by recordSignal() and setCompanyStage() in contact-store.ts.
 *
 * Idempotent.
 *
 * Usage:
 *   node scripts/migrate-add-stage-transitions.mjs
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
  `CREATE TABLE IF NOT EXISTS company_stage_transitions (
    id              BIGSERIAL    PRIMARY KEY,
    workspace_id    TEXT         NOT NULL,
    company_name    TEXT         NOT NULL,
    from_stage      TEXT,
    to_stage        TEXT         NOT NULL,
    transitioned_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    trigger         TEXT         NOT NULL DEFAULT 'auto'
  )`,
  `CREATE INDEX IF NOT EXISTS company_stage_transitions_ws_time_idx
    ON company_stage_transitions (workspace_id, transitioned_at DESC)`,
  `CREATE INDEX IF NOT EXISTS company_stage_transitions_ws_company_idx
    ON company_stage_transitions (workspace_id, company_name, transitioned_at DESC)`,
]

for (const s of statements) {
  const preview = s.replace(/\s+/g, " ").trim()
  process.stdout.write(`-> ${preview.slice(0, 80)}${preview.length > 80 ? "…" : ""} `)
  await sql.query(s)
  console.log("done")
}

console.log("\nMigration complete.")
