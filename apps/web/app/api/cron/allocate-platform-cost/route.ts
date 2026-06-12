/**
 * Daily platform-cost allocation cron.
 *
 * Splits the previous UTC day's slice of fixed monthly Vercel + Neon costs
 * across workspaces by share-of-events. The "events" denominator is the
 * count of non-platform usage_log rows for that day — i.e. real provider
 * calls (AI, Surfe, Apify, Unipile). A workspace doing 90% of yesterday's
 * work pays ~90% of yesterday's platform allocation.
 *
 * Triggered by: vercel.json cron (daily 04:00 UTC) or POST/GET to this
 * endpoint with the CRON_SECRET header. Idempotent — re-runs for the same
 * day delete and re-insert cleanly.
 *
 * Why hardcoded monthly totals? See lib/pricing.ts. Real Vercel + Neon API
 * pulls are a follow-up (task #29). Until then, update the constants in
 * pricing.ts after each invoice or plan change.
 */

import { NextRequest, NextResponse } from "next/server"
import { sql, isDbConfigured } from "@/lib/db"
import { VERCEL_MONTHLY_CENTS, NEON_MONTHLY_CENTS } from "@/lib/pricing"

interface WorkspaceEventRow {
  workspace_id: string
  events:       number
}

// Days-per-month divisor — using a flat 30 keeps the daily rate stable
// across 28/31-day months. Off by ~3% on either side; well inside the
// approximation tolerance the user signed off on.
const DAYS_PER_MONTH = 30

export async function GET(req: NextRequest) {
  return run(req)
}
export async function POST(req: NextRequest) {
  return run(req)
}

async function run(req: NextRequest) {
  // Auth — same pattern as other crons in this app
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DB not configured" }, { status: 500 })
  }

  const db = sql()

  // Yesterday's full UTC day [start, end)
  const now = new Date()
  const yesterdayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1))
  const yesterdayEnd   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const allocationDate = yesterdayStart.toISOString().slice(0, 10)

  // Idempotency: drop any prior platform rows for this date so a re-run
  // doesn't double-count.
  await db`
    DELETE FROM usage_log
    WHERE category = 'platform'
      AND (metadata->>'allocationDate') = ${allocationDate}
  `

  // Event counts per workspace, excluding platform rows (which are the
  // *output* of this allocation, not real calls).
  const rows = (await db`
    SELECT workspace_id, COUNT(*)::int AS events
    FROM usage_log
    WHERE occurred_at >= ${yesterdayStart.toISOString()}
      AND occurred_at <  ${yesterdayEnd.toISOString()}
      AND category != 'platform'
    GROUP BY workspace_id
  `) as WorkspaceEventRow[]

  if (rows.length === 0) {
    return NextResponse.json({
      ok:             true,
      allocationDate,
      message:        "No workspace activity yesterday — nothing to allocate.",
      rowsInserted:   0,
    })
  }

  const totalEvents       = rows.reduce((s, r) => s + r.events, 0)
  const dailyVercelCents  = VERCEL_MONTHLY_CENTS / DAYS_PER_MONTH
  const dailyNeonCents    = NEON_MONTHLY_CENTS   / DAYS_PER_MONTH

  // Per-event rate that, when multiplied by a workspace's event count,
  // yields its share. Stored as unit_cost_cents so the helper's
  // total = units * unit_cost_cents math comes out right.
  const vercelCentsPerEvent = dailyVercelCents / totalEvents
  const neonCentsPerEvent   = dailyNeonCents   / totalEvents

  let inserted = 0
  for (const r of rows) {
    const meta = JSON.stringify({
      allocationDate,
      totalEvents,
      share: r.events / totalEvents,
    })
    await db`
      INSERT INTO usage_log (
        workspace_id, occurred_at, category, provider,
        units, unit_cost_cents, total_cost_cents, metadata
      )
      VALUES (
        ${r.workspace_id}, ${yesterdayEnd.toISOString()}, 'platform', 'vercel',
        ${r.events}, ${vercelCentsPerEvent}, ${r.events * vercelCentsPerEvent},
        ${meta}::jsonb
      )
    `
    await db`
      INSERT INTO usage_log (
        workspace_id, occurred_at, category, provider,
        units, unit_cost_cents, total_cost_cents, metadata
      )
      VALUES (
        ${r.workspace_id}, ${yesterdayEnd.toISOString()}, 'platform', 'neon',
        ${r.events}, ${neonCentsPerEvent}, ${r.events * neonCentsPerEvent},
        ${meta}::jsonb
      )
    `
    inserted += 2
  }

  return NextResponse.json({
    ok:             true,
    allocationDate,
    workspaces:     rows.length,
    totalEvents,
    dailyVercelCents,
    dailyNeonCents,
    rowsInserted:   inserted,
  })
}
