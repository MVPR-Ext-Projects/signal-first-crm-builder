/**
 * PATCH  /api/dashboard/[workspaceId]/campaigns/[campaignId]/templates/[templateId]
 * DELETE /api/dashboard/[workspaceId]/campaigns/[campaignId]/templates/[templateId]
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { updateTemplate, deleteTemplate } from "@/lib/db/campaign-templates"

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
  { params }: { params: Promise<{ workspaceId: string; templateId: string }> },
) {
  const { workspaceId, templateId } = await params
  const err = await auth(workspaceId)
  if (err) return err

  const body = await req.json().catch(() => null) as {
    name?: string; body?: string; subject?: string | null; html?: string | null; isDefault?: boolean
  } | null
  if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 })

  const ok = await updateTemplate({
    workspaceId,
    id:        templateId,
    name:      body.name,
    body:      body.body,
    subject:   body.subject,
    html:      body.html,
    isDefault: body.isDefault,
  })
  if (!ok) return NextResponse.json({ error: "Template not found" }, { status: 404 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; templateId: string }> },
) {
  const { workspaceId, templateId } = await params
  const err = await auth(workspaceId)
  if (err) return err
  const ok = await deleteTemplate(workspaceId, templateId)
  if (!ok) return NextResponse.json({ error: "Template not found" }, { status: 404 })
  return NextResponse.json({ ok: true })
}
