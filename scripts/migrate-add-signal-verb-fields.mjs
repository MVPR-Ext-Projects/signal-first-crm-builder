/**
 * Migration: add signal_verb, signal_actor, signal_object, verb_description
 * columns to the signals table.
 *
 * Safe to re-run (IF NOT EXISTS).
 *
 * Usage: node scripts/migrate-add-signal-verb-fields.mjs
 */

import { neon } from "@neondatabase/serverless"
import { config as loadEnv } from "dotenv"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(__dirname, "../.env.production.local") })
loadEnv({ path: resolve(__dirname, "../apps/web/.env.local") })

const sql = neon(process.env.DATABASE_URL)

await sql`ALTER TABLE signals ADD COLUMN IF NOT EXISTS signal_verb       TEXT`
await sql`ALTER TABLE signals ADD COLUMN IF NOT EXISTS signal_actor      TEXT`
await sql`ALTER TABLE signals ADD COLUMN IF NOT EXISTS signal_object     TEXT`
await sql`ALTER TABLE signals ADD COLUMN IF NOT EXISTS verb_description  TEXT`

console.log("Done — signal_verb, signal_actor, signal_object, verb_description columns added.")
