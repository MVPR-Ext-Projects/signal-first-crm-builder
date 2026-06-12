/**
 * Migration: add `manual_stage` column to contacts + extend the funnel-stage
 * vocabulary.
 *
 * The funnel now has 5 stages instead of 3:
 *   Prospect → Signal Found → Engaged → High Signal → Discovery Call
 *
 * Auto-derivation (when manual_stage is NULL):
 *   score >= 50 → High Signal
 *   score >= 20 → Engaged
 *   score >=  5 → Signal Found
 *   else        → Prospect (replaces the old "New" default)
 *
 * Manual override (manual_stage != NULL):
 *   Sticky regardless of score. Today only "Discovery Call" gets set this way
 *   (a Calendly hook will write here). The column accepts any of the five
 *   stage names so a future UI can let SDRs lock any stage manually.
 *
 * This migration also rewrites every existing `funnel_stage = 'New'` row to
 * `Prospect` so the dashboard's stage filter has a stable vocabulary.
 *
 * Idempotent.
 *
 * Usage:
 *   node scripts/migrate-add-manual-stage.mjs
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
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS manual_stage TEXT`,
  `UPDATE contacts SET funnel_stage = 'Prospect' WHERE funnel_stage = 'New' OR funnel_stage IS NULL`,
]

for (const s of statements) {
  process.stdout.write(`-> ${s.slice(0, 80).replace(/\s+/g, " ")}${s.length > 80 ? "…" : ""} `)
  await sql.query(s)
  console.log("done")
}

const counts = await sql`
  SELECT funnel_stage, COUNT(*)::int AS n
  FROM contacts
  GROUP BY funnel_stage
  ORDER BY n DESC
`
console.log("\nStage distribution after migration:")
for (const r of counts) console.log(`  ${r.n.toString().padStart(6)}  ${r.funnel_stage}`)
console.log("\nMigration complete.")
