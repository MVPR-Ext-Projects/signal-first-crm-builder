/**
 * Campaigns API (Task #23).
 *
 *   GET    /api/dashboard/[workspaceId]/campaigns
 *   POST   /api/dashboard/[workspaceId]/campaigns   { name, channel, clickedLinkScore }
 *
 * Per-campaign updates and archives live at .../campaigns/[id]/route.ts.
 *
 * Auth: same dashboard cookie as the page.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { listCampaigns, createCampaign, type CampaignChannel } from "@/lib/db/campaigns"

const VALID_CHANNELS: CampaignChannel[] = ["linkedin_dm", "email", "newsletter", "lead_magnet", "other"]

async function auth(workspaceId: string): Promise<NextResponse | null> {
  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Unknown workspace" }, { status: 404 })
  if (config.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }
  return null
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params
  const err = await auth(workspaceId)
  if (err) return err
  const campaigns = await listCampaigns(workspaceId)
  return NextResponse.json({ campaigns })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params
  const err = await auth(workspaceId)
  if (err) return err

  let body: { name?: string; channel?: string; clickedLinkScore?: number }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }

  const name = (body.name ?? "").trim()
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 })

  const channel = body.channel as CampaignChannel | undefined
  if (!channel || !VALID_CHANNELS.includes(channel)) {
    return NextResponse.json(
      { error: `channel must be one of: ${VALID_CHANNELS.join(", ")}` },
      { status: 400 },
    )
  }

  const score = Number(body.clickedLinkScore ?? 0)
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    return NextResponse.json({ error: "clickedLinkScore must be 0..100" }, { status: 400 })
  }

  const id = await createCampaign({
    workspaceId,
    name,
    channel,
    clickedLinkScore: Math.round(score),
  })
  return NextResponse.json({ ok: true, id })
}
