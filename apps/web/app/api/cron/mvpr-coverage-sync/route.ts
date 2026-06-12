/**
 * MVPR coverage sync cron.
 *
 * Iterates every workspace with config.mvpr.apiKey set and pulls coverage
 * + announcements via lib/mvpr-sync.ts. Schedule: every 6h (see apps/web/vercel.json).
 *
 * Auth: Bearer CRON_SECRET in the Authorization header - same pattern as
 * the other crons.
 *
 * Idempotent. One workspace's failure doesn't block others (errors are
 * collected per-workspace in the response body so the cron log surfaces
 * what broke without taking the whole run down).
 */

import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { syncWorkspace, listWorkspaceIds, type SyncResult } from "@/lib/mvpr-sync"

export const maxDuration = 300

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

  const ids = await listWorkspaceIds()
  const results: SyncResult[] = []
  let totalCoverages     = 0
  let totalAnnouncements = 0

  for (const workspaceId of ids) {
    const config = await getWorkspaceConfig(workspaceId)
    if (!config?.mvpr?.apiKey) continue
    const r = await syncWorkspace(workspaceId)
    results.push(r)
    totalCoverages     += r.coveragesIngested
    totalAnnouncements += r.announcementsIngested
  }

  console.log(
    `[cron/mvpr-coverage-sync] ${totalCoverages} coverages + ${totalAnnouncements} announcements across ${results.length} workspaces`,
  )

  return NextResponse.json({
    ok:                 true,
    workspaces:         results.length,
    totalCoverages,
    totalAnnouncements,
    results,
  })
}
