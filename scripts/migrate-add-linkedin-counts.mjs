/**
 * Migration: add linkedin_followers_count and linkedin_connections_count columns
 * to the contacts table.
 *
 * Safe to run multiple times (IF NOT EXISTS / idempotent column add).
 *
 * Usage:
 *   node scripts/migrate-add-linkedin-counts.mjs
 */

import { neon } from "@neondatabase/serverless"
import { config as loadEnv } from "dotenv"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(__dirname, "../.env.production.local") })
loadEnv({ path: resolve(__dirname, "../apps/web/.env.local") })

const sql = neon(process.env.DATABASE_URL)

await sql`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS linkedin_followers_count   INTEGER`
await sql`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS linkedin_connections_count INTEGER`

console.log("Done — linkedin_followers_count and linkedin_connections_count columns added.")
