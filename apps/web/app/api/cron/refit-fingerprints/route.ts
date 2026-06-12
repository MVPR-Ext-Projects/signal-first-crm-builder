/**
 * Daily refit cron (cozy-tiger Phase 4).
 *
 * Two-phase pipeline per workspace:
 *
 *   A. PROJECTION
 *      Walks recent outreach_log rows stamped with fingerprint_version_id
 *      and projects them into style_samples with outcome_score from the
 *      locked rubric (scoreSendOutcome). Only inserts when the outcome has
 *      resolved (a strong signal landed, or the 14-day no-signal window
 *      closed).
 *
 *   B. REFIT
 *      For each (channel, persona_id) cell with >= 20 fresh resolved
 *      samples (contributed_to_fp_version IS NULL), re-runs the 63-dim
 *      analyzer on the positive bucket (score >= 1). Lands a new active
 *      style_fingerprints row, deactivates the prior. Marks every
 *      consumed sample.
 *
 * Schedule: daily 03:00 UTC (off-peak; runs after the email-freshness
 * cron at 11:00 UTC on the prior day so signal data has had time to
 * stabilize).
 *
 * Auth: Bearer CRON_SECRET in the Authorization header. Same pattern
 * as the other crons in this app.
 *
 * Cost: refits run only when the cell threshold is met. Each refit is
 * one Sonnet 4.6 call (~$0.14). Logged to usage_log via the standard
 * generator path.
 */

import { NextRequest, NextResponse } from "next/server"
import { sql, isDbConfigured } from "@/lib/db"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { projectPendingSamples, refitEligibleCells } from "@/lib/style/refit"

export async function GET(req: NextRequest)  { return run(req) }
export async function POST(req: NextRequest) { return run(req) }

async function run(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DB not configured" }, { status: 500 })
  }

  const db = sql()

  // Workspaces that have AI-drafted sends in the recent window. Cheaper
  // than iterating every workspace - a workspace with no AI sends has no
  // samples to project and no cells to refit.
  const workspaceRows = await db<{ workspace_id: string }>`
    SELECT DISTINCT workspace_id
    FROM   outreach_log
    WHERE  fingerprint_version_id IS NOT NULL
      AND  occurred_at            > NOW() - INTERVAL '90 days'
  `

  const summary: Array<{
    workspaceId: string
    projected:   number
    unresolved:  number
    skipped:     number
    refits: Array<{
      channel:       string
      personaId:     string
      positives:     number
      negatives:     number
      version:       number
      fingerprintId: number
    }>
  }> = []

  for (const { workspace_id: workspaceId } of workspaceRows) {
    const config = await getWorkspaceConfig(workspaceId)
    if (!config) continue

    try {
      const proj = await projectPendingSamples(workspaceId, config)
      const refits = await refitEligibleCells(workspaceId)
      summary.push({
        workspaceId,
        projected:  proj.projected,
        unresolved: proj.unresolved,
        skipped:    proj.skipped,
        refits,
      })
    } catch (err) {
      console.error(`[refit-fingerprints] workspace ${workspaceId} failed:`, err)
      summary.push({
        workspaceId,
        projected:  0,
        unresolved: 0,
        skipped:    0,
        refits:     [],
      })
    }
  }

  const totals = summary.reduce(
    (acc, w) => ({
      projected:  acc.projected  + w.projected,
      unresolved: acc.unresolved + w.unresolved,
      refits:     acc.refits     + w.refits.length,
    }),
    { projected: 0, unresolved: 0, refits: 0 },
  )

  return NextResponse.json({
    ok:         true,
    workspaces: summary.length,
    totals,
    summary,
  })
}
