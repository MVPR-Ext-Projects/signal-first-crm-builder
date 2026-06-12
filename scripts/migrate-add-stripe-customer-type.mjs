/**
 * Migration: add customer_type to stripe_customers + supporting index.
 *
 * Workspace-curated classification of what a Stripe customer represents.
 * Used by the reclassifier (and future dashboard queries) to exclude
 * test / internal / free-tier customers from funnel + reporting.
 * Values are free-form text; current conventional values:
 *   'untracked' | 'recurring_subscriber' | 'announcement_only' |
 *   'free_tier' | NULL (= regular, auto-classified).
 *
 * Strictly additive. Idempotent.
 *
 * Usage:
 *   node scripts/migrate-add-stripe-customer-type.mjs
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
  `ALTER TABLE stripe_customers
     ADD COLUMN IF NOT EXISTS customer_type TEXT`,
  `CREATE INDEX IF NOT EXISTS stripe_customers_workspace_type_idx
     ON stripe_customers (workspace_id, customer_type)
     WHERE customer_type IS NOT NULL`,
]

for (const s of statements) {
  process.stdout.write(`-> ${s.slice(0, 70).replace(/\s+/g, " ")}${s.length > 70 ? "..." : ""} `)
  await sql.query(s)
  console.log("OK")
}
console.log("\nMigration complete.")
