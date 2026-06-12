/**
 * Migration: add `contacts.persona` column + index.
 *
 * Idempotent. Run once per environment.
 *
 *   node scripts/migrate-add-persona-column.mjs
 *
 * After this lands, run scripts/migrate-classify-personas.mjs to populate
 * the column for existing rows.
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
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS persona TEXT`,
  `CREATE INDEX IF NOT EXISTS contacts_workspace_persona_idx
     ON contacts (workspace_id, persona)
     WHERE persona IS NOT NULL`,
]

for (const s of statements) {
  process.stdout.write(`-> ${s.slice(0, 80).replace(/\s+/g, " ")}${s.length > 80 ? "…" : ""} `)
  await sql.query(s)
  console.log("done")
}
console.log("\nMigration complete.")
