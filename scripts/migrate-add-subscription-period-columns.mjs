/**
 * Migration: add current_period_start + current_period_end to
 * stripe_subscriptions, plus the active-period index.
 *
 * Needed for the cadence-aware Customer Won classifier (rule 1 in
 * BILLING.md): a customer with an active subscription whose
 * current_period_end is in the future is currently a customer regardless
 * of last paid_at. Handles quarterly / upfront enterprise billing
 * correctly.
 *
 * Strictly additive. Idempotent.
 *
 * Usage:
 *   node scripts/migrate-add-subscription-period-columns.mjs
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
  `ALTER TABLE stripe_subscriptions
     ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMPTZ`,
  `ALTER TABLE stripe_subscriptions
     ADD COLUMN IF NOT EXISTS current_period_end   TIMESTAMPTZ`,
  `CREATE INDEX IF NOT EXISTS stripe_subscriptions_active_period_idx
     ON stripe_subscriptions (workspace_id, stripe_customer_id, current_period_end)
     WHERE status NOT IN ('canceled', 'incomplete_expired')
       AND current_period_end IS NOT NULL`,
]

for (const s of statements) {
  process.stdout.write(`-> ${s.slice(0, 70).replace(/\s+/g, " ")}${s.length > 70 ? "..." : ""} `)
  await sql.query(s)
  console.log("OK")
}
console.log("\nMigration complete.")
