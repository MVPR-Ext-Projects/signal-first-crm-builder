/**
 * Migration: add linkedin_connected column to contacts.
 *
 * TRUE = confirmed 1st-degree LinkedIn connection with this contact.
 * NULL = unknown (default). FALSE = explicitly not connected.
 *
 * Set near-realtime by the TF webhook on accepted_our_connection signals,
 * and by the daily sweep / Unipile relations import. Already used extensively
 * in contact-store.ts — this migration adds it to the formal schema.
 *
 * Usage: node scripts/migrate-add-linkedin-connected.mjs
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
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS linkedin_connected BOOLEAN`,
]

for (const s of statements) {
  const preview = s.replace(/\s+/g, " ").trim()
  process.stdout.write(`-> ${preview} `)
  await sql.query(s)
  console.log("done")
}
console.log("\nMigration complete.")
