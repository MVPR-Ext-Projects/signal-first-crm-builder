/**
 * Daily email-freshness cron (Task #18 continued).
 *
 * Finds contacts whose corporate email was last confirmed more than the
 * freshness threshold ago (default 365d) and flips them to status='stale'
 * + needs_enrichment=TRUE so they surface on the Enrichment Candidates
 * page. From there, the user can click "Enrich now" to run a fresh
 * Surfe pass; a successful enrichment will either re-confirm or
 * invalidate the address.
 *
 * Does NOT attempt synchronous re-enrichment in the cron itself - one
 * Surfe call per contact at ~30-60s would blow the function timeout if
 * many contacts go stale on the same day. The Enrichment Candidates
 * page is the human-paced path; an enrichment-queue / background
 * worker is a follow-up if volume grows.
 *
 * Schedule: daily 11:00 UTC (after the existing enrichment-poll cron
 * at 10:00 UTC, so any in-flight enrichment from that has a chance to
 * land first).
 *
 * Auth: Bearer CRON_SECRET in the Authorization header. Same pattern
 * as the other crons in this app.
 *
 * Idempotent - re-running the same day is a no-op since stale rows
 * already have needs_enrichment=TRUE; the UPDATE only touches rows
 * still in status='confirmed'.
 */

import { NextRequest, NextResponse } from "next/server"
import { sql, isDbConfigured } from "@/lib/db"
import { getWorkspaceConfig } from "@/lib/workspace-config"

const DEFAULT_FRESHNESS_DAYS = 365

export async function GET(req: NextRequest) {
  return run(req)
}
export async function POST(req: NextRequest) {
  return run(req)
}

async function run(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DB not configured" }, { status: 500 })
  }

  const db = sql()

  // Per-workspace freshness threshold (Task #22). The threshold lives on
  // WorkspaceConfig.messaging.emailFreshnessDays; we look up each
  // workspace that has confirmed corporate emails and apply its threshold.
  // Workspaces that haven't set one fall back to DEFAULT_FRESHNESS_DAYS.
  const workspaceRows = await db<{ workspace_id: string }>`
    SELECT DISTINCT workspace_id FROM contacts
    WHERE corporate_email_status = 'confirmed'
      AND needs_enrichment       = FALSE
  `

  let totalFlagged = 0
  const byWorkspace: Record<string, { flagged: number; thresholdDays: number }> = {}

  for (const { workspace_id: workspaceId } of workspaceRows) {
    const config        = await getWorkspaceConfig(workspaceId)
    const thresholdDays = config?.messaging?.emailFreshnessDays ?? DEFAULT_FRESHNESS_DAYS
    const cutoff        = new Date(Date.now() - thresholdDays * 24 * 60 * 60 * 1000)

    // status='stale' rather than 'not_found' because the address may
    // still work - we just don't know any more. status='not_found' is
    // reserved for definitive invalidation (bounce / enrichment empty).
    const updated = await db<{ id: number }>`
      UPDATE contacts SET
        corporate_email_status = 'stale',
        needs_enrichment       = TRUE,
        enrichment_reason      = ${`Corporate email not re-confirmed in ${thresholdDays} days.`},
        updated_at             = NOW()
      WHERE workspace_id                = ${workspaceId}
        AND corporate_email_status      = 'confirmed'
        AND corporate_email_confirmed_at < ${cutoff.toISOString()}
        AND needs_enrichment            = FALSE
      RETURNING id
    `
    const flagged = updated.length
    totalFlagged += flagged
    byWorkspace[workspaceId] = { flagged, thresholdDays }
  }

  console.log(`[cron/email-freshness] flagged ${totalFlagged} contacts as stale across ${Object.keys(byWorkspace).length} workspaces`)

  return NextResponse.json({
    ok:           true,
    flagged:      totalFlagged,
    byWorkspace,
  })
}
