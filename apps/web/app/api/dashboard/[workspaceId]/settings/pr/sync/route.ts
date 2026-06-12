/**
 * POST /api/dashboard/[workspaceId]/settings/pr/sync
 *
 * Triggers an immediate MVPR sync for one workspace (the same syncWorkspace
 * function the 6-hourly cron calls). Useful for the "Sync now" button in
 * the PR settings page so users don't have to wait for the next cron tick.
 *
 * Dashboard-cookie auth (not CRON_SECRET).
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { syncWorkspace } from "@/lib/mvpr-sync"

export const maxDuration = 300

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params
  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Unknown workspace" }, { status: 404 })

  if (config.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  if (!config.mvpr?.apiKey || !config.mvpr?.baseUrl) {
    return NextResponse.json({ error: "MVPR not configured for this workspace" }, { status: 400 })
  }

  const result = await syncWorkspace(workspaceId)
  return NextResponse.json(result)
}
