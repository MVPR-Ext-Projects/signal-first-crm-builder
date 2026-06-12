/**
 * GET  /api/dashboard/[workspaceId]/contacts/[contactId]/campaigns
 *   Returns all active campaigns with an `enrolled` flag for this contact.
 *
 * POST /api/dashboard/[workspaceId]/contacts/[contactId]/campaigns
 *   Body: { campaignId: string }           - enroll in existing campaign
 *       | { name: string }                 - create + enroll (linkedin_dm default)
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import {
  listCampaignsForContact,
  enrollContact,
  createAndEnroll,
} from "@/lib/db/campaign-contacts"
import { isDbConfigured } from "@/lib/db/contact-store"

async function auth(workspaceId: string): Promise<boolean> {
  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return false
  if (!config.accessToken) return true
  const cookieStore = await cookies()
  return cookieStore.get(`dashboard_auth_${workspaceId}`)?.value === config.accessToken
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; contactId: string }> },
) {
  const { workspaceId, contactId } = await params
  const id = Number.parseInt(contactId, 10)
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid contactId" }, { status: 400 })
  }
  if (!await auth(workspaceId)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DB not configured" }, { status: 503 })
  }
  const campaigns = await listCampaignsForContact(workspaceId, id)
  return NextResponse.json({ campaigns })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; contactId: string }> },
) {
  const { workspaceId, contactId } = await params
  const id = Number.parseInt(contactId, 10)
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid contactId" }, { status: 400 })
  }
  if (!await auth(workspaceId)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DB not configured" }, { status: 503 })
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })

  if (typeof body.campaignId === "string" && body.campaignId) {
    await enrollContact(workspaceId, body.campaignId, id)
    return NextResponse.json({ ok: true })
  }

  if (typeof body.name === "string" && body.name.trim()) {
    const campaignId = await createAndEnroll(workspaceId, body.name, id)
    if (!campaignId) return NextResponse.json({ error: "Failed to create campaign" }, { status: 500 })
    return NextResponse.json({ ok: true, campaignId })
  }

  return NextResponse.json({ error: "Provide campaignId or name" }, { status: 400 })
}
