/**
 * DELETE /api/dashboard/[workspaceId]/contacts/[contactId]/campaigns/[campaignId]
 *   Unenroll a contact from a campaign.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { unenrollContact } from "@/lib/db/campaign-contacts"
import { isDbConfigured } from "@/lib/db/contact-store"

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; contactId: string; campaignId: string }> },
) {
  const { workspaceId, contactId, campaignId } = await params
  const id = Number.parseInt(contactId, 10)
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid contactId" }, { status: 400 })
  }

  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Unknown workspace" }, { status: 404 })
  if (config.accessToken) {
    const cookieStore = await cookies()
    if (cookieStore.get(`dashboard_auth_${workspaceId}`)?.value !== config.accessToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DB not configured" }, { status: 503 })
  }

  await unenrollContact(workspaceId, campaignId, id)
  return NextResponse.json({ ok: true })
}
