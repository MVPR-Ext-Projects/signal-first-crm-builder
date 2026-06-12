/**
 * Per-campaign API (Task #23).
 *
 *   PATCH  /api/dashboard/[workspaceId]/campaigns/[id]   { name?, channel?, clickedLinkScore? }
 *   DELETE /api/dashboard/[workspaceId]/campaigns/[id]   (archives, doesn't hard-delete)
 *
 * Hard-deletion is deliberately not exposed - existing clicked_link
 * signals reference the campaign id in their UTM payloads, so removing
 * the row would orphan those records. Archiving hides the campaign
 * from "active" listings but preserves the row.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { updateCampaign, archiveCampaign, type CampaignChannel } from "@/lib/db/campaigns"

const VALID_CHANNELS: CampaignChannel[] = ["linkedin_dm", "email", "lead_magnet", "other"]

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

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; campaignId: string }> },
) {
  const { workspaceId, campaignId } = await params
  const err = await auth(workspaceId)
  if (err) return err

  let body: { name?: string; channel?: string; clickedLinkScore?: number }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }

  if (body.channel !== undefined && !VALID_CHANNELS.includes(body.channel as CampaignChannel)) {
    return NextResponse.json(
      { error: `channel must be one of: ${VALID_CHANNELS.join(", ")}` },
      { status: 400 },
    )
  }
  if (body.clickedLinkScore !== undefined) {
    const n = Number(body.clickedLinkScore)
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return NextResponse.json({ error: "clickedLinkScore must be 0..100" }, { status: 400 })
    }
  }

  const ok = await updateCampaign({
    workspaceId,
    id:                campaignId,
    name:              body.name?.trim() || undefined,
    channel:           body.channel as CampaignChannel | undefined,
    clickedLinkScore:  body.clickedLinkScore !== undefined ? Math.round(Number(body.clickedLinkScore)) : undefined,
  })
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; campaignId: string }> },
) {
  const { workspaceId, campaignId } = await params
  const err = await auth(workspaceId)
  if (err) return err

  const ok = await archiveCampaign(workspaceId, campaignId)
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ ok: true })
}
