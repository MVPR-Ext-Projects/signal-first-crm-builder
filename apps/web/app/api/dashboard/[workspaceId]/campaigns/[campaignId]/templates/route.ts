/**
 * GET  /api/dashboard/[workspaceId]/campaigns/[campaignId]/templates - list
 * POST /api/dashboard/[workspaceId]/campaigns/[campaignId]/templates - create
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { listTemplatesForCampaign, createTemplate } from "@/lib/db/campaign-templates"

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
  { params }: { params: Promise<{ workspaceId: string; campaignId: string }> },
) {
  const { workspaceId, campaignId } = await params
  const err = await auth(workspaceId)
  if (err) return err
  const templates = await listTemplatesForCampaign(workspaceId, campaignId)
  return NextResponse.json({ templates })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; campaignId: string }> },
) {
  const { workspaceId, campaignId } = await params
  const err = await auth(workspaceId)
  if (err) return err

  const body = await req.json().catch(() => null) as {
    name?: string; body?: string; subject?: string | null; html?: string | null; isDefault?: boolean
  } | null
  if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 })

  const name = (body.name ?? "").trim()
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 })
  const text = (body.body ?? "").trim()
  if (!text) return NextResponse.json({ error: "body is required" }, { status: 400 })

  const id = await createTemplate({
    workspaceId,
    campaignId,
    name,
    body:      text,
    subject:   body.subject ?? null,
    html:      body.html    ?? null,
    isDefault: Boolean(body.isDefault),
  })
  return NextResponse.json({ ok: true, id })
}
