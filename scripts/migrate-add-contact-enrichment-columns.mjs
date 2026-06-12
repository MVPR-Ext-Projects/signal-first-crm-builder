/**
 * Migration: add enrichment-source columns that were being captured in payloads
 * but had no home in the schema.
 *
 * New columns:
 *   contacts.contact_industry       TEXT     - self-reported industry (Dripify)
 *   contacts.linkedin_premium       BOOLEAN  - LinkedIn Premium flag (Dripify)
 *   contacts.company_followers_count INTEGER - company page follower count (TF / Dripify)
 *   contacts.company_specialties    TEXT[]   - company specialty tags (TF)
 *   contacts.company_headquarters   TEXT     - HQ city/location (TF)
 *   contacts.company_founded_year   INTEGER  - year founded (TF)
 *
 * Note: contacts.phone already exists (see migrate-add-contacts-phone.mjs).
 *
 * Usage: node scripts/migrate-add-contact-enrichment-columns.mjs
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
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS contact_industry TEXT`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS linkedin_premium BOOLEAN`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_followers_count INTEGER`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_specialties TEXT[]`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_headquarters TEXT`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_founded_year INTEGER`,
]

for (const s of statements) {
  const preview = s.replace(/\s+/g, " ").trim()
  process.stdout.write(`-> ${preview} `)
  await sql.query(s)
  console.log("done")
}
console.log("\nMigration complete.")
