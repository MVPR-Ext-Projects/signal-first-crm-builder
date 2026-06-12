/**
 * Migration: add crm_company_id column on the companies table.
 *
 * Caches the CRM-native (today: Attio) company record id so future syncs
 * - both directions - can map between gtm-os and Attio without falling
 * back to fuzzy domain/name matching. Mirrors the way contacts.crm_contact_id
 * works for the people side.
 *
 * Used by scripts/retro-pull-attio-deals.mjs in Task #26 to backfill
 * matched companies from Attio's Deals object's associated_company link.
 *
 * Strictly additive. Nullable; existing rows have no value (and will
 * get backfilled by the retro pull). Partial unique index so a given
 * Attio company record can't be linked to two different gtm-os companies.
 *
 * Usage:
 *   node scripts/migrate-add-companies-crm-id.mjs
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
  `ALTER TABLE companies ADD COLUMN IF NOT EXISTS crm_company_id TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS companies_workspace_crm_id_idx
     ON companies (workspace_id, crm_company_id)
     WHERE crm_company_id IS NOT NULL`,
]

for (const s of statements) {
  process.stdout.write(`-> ${s.slice(0, 70).replace(/\s+/g, " ")}${s.length > 70 ? "..." : ""} `)
  await sql(s)
  console.log("OK")
}
console.log("\nMigration complete.")
