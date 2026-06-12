/**
 * Usage status — print per-workspace × per-provider cost totals from
 * the usage_log table.
 *
 * Default window is month-to-date (start of current UTC month → now).
 * Pass --all to see lifetime totals.
 *
 * Usage:
 *   node scripts/usage-status.mjs
 *   node scripts/usage-status.mjs --all
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
const allTime = process.argv.includes("--all")

const since = allTime
  ? null
  : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1))

const rows = since
  ? await sql`
      SELECT workspace_id, provider,
             SUM(units)::numeric            AS units,
             SUM(total_cost_cents)::numeric AS cents,
             COUNT(*)::int                  AS events
      FROM usage_log
      WHERE occurred_at >= ${since.toISOString()}
      GROUP BY workspace_id, provider
      ORDER BY workspace_id, cents DESC
    `
  : await sql`
      SELECT workspace_id, provider,
             SUM(units)::numeric            AS units,
             SUM(total_cost_cents)::numeric AS cents,
             COUNT(*)::int                  AS events
      FROM usage_log
      GROUP BY workspace_id, provider
      ORDER BY workspace_id, cents DESC
    `

const label = since
  ? `Month-to-date (since ${since.toISOString().slice(0, 10)} UTC)`
  : "All time"
console.log(`\n${label}\n`)

if (rows.length === 0) {
  console.log("  No usage logged yet.\n")
  process.exit(0)
}

// Group rows by workspace for tidy output.
const byWs = new Map()
for (const r of rows) {
  if (!byWs.has(r.workspace_id)) byWs.set(r.workspace_id, [])
  byWs.get(r.workspace_id).push(r)
}

let grand = 0
for (const [ws, providerRows] of byWs) {
  const total = providerRows.reduce((s, r) => s + Number(r.cents), 0)
  grand += total
  console.log(`  ${ws}  —  $${(total / 100).toFixed(2)}`)
  for (const r of providerRows) {
    const dollars = (Number(r.cents) / 100).toFixed(2)
    const units   = Number(r.units).toLocaleString("en-US", { maximumFractionDigits: 0 })
    console.log(`    ${r.provider.padEnd(11)} ${units.padStart(10)} units · ${r.events.toString().padStart(4)} events · $${dollars}`)
  }
  console.log()
}
console.log(`  Total across all workspaces: $${(grand / 100).toFixed(2)}\n`)
