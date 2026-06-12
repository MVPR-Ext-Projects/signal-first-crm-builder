/**
 * Migration: add a clean `phone` column to contacts.
 *
 * The legacy `prospect_phone` column from the one-off MVPR CSV import is
 * dormant (per schema.sql comment). This adds a top-level `phone` field
 * that's editable from the manual contact-edit form and populated by Surfe
 * mobile-phone enrichment when available - eventually consumed by the
 * Twilio dialer integration.
 *
 * Usage: node scripts/migrate-add-contacts-phone.mjs
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
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone TEXT`,
]

for (const s of statements) {
  const preview = s.replace(/\s+/g, " ").trim()
  process.stdout.write(`-> ${preview} `)
  await sql.query(s)
  console.log("done")
}
console.log("\nMigration complete.")
