/**
 * GET /api/dashboard/[workspaceId]/coverage/[coverageId]
 *
 * Single coverage row + the linked announcement (if any). Used by the
 * coverage-detail drawer on /actions.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { getCoverage, findAnnouncementForCoverage } from "@/lib/db/coverage"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; coverageId: string }> },
) {
  const { workspaceId, coverageId } = await params

  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Unknown workspace" }, { status: 404 })
  if (config.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  const coverage = await getCoverage(workspaceId, coverageId)
  if (!coverage) return NextResponse.json({ error: "Coverage not found" }, { status: 404 })

  const announcement = await findAnnouncementForCoverage(workspaceId, coverageId)
  return NextResponse.json({ coverage, announcement })
}
