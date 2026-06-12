/**
 * Migration: add `influenced_by` JSONB column to contacts.
 *
 * Mirrors Attio's `influenced_by` attribute on People — a multi-reference
 * to People or Companies that influence this person (e.g. journalists they
 * read, podcasts they listen to, founders they admire). Stored as a JSONB
 * array of:
 *   { kind: "person" | "company", attioId, name, linkedinUrl?, domain? }
 *
 * NULL = unknown / not yet fetched. [] = explicitly empty (we asked Attio
 * and there were no influences). The dashboard treats both the same when
 * rendering, but the distinction lets us tell "never imported" apart from
 * "imported but no influences" for re-run heuristics.
 *
 * Idempotent.
 *
 * Usage:
 *   node scripts/migrate-add-influenced-by.mjs
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
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS influenced_by JSONB`,
]

for (const s of statements) {
  process.stdout.write(`-> ${s} `)
  await sql(s)
  console.log("done")
}
console.log("\nMigration complete.")
