/**
 * GET /api/dashboard/[workspaceId]/campaigns/[campaignId]/unfurl
 *
 * Returns the campaign's Companies -> People -> Signals tree. Used by the
 * Channels page row-unfurl pattern; lazy-loaded when the user expands a row.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { getCampaignUnfurl } from "@/lib/db/campaigns"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; campaignId: string }> },
) {
  const { workspaceId, campaignId } = await params

  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Unknown workspace" }, { status: 404 })
  if (config.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  const companies = await getCampaignUnfurl(workspaceId, campaignId)
  return NextResponse.json({ companies })
}
