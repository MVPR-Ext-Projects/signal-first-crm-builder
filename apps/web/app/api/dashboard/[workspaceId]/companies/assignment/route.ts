/**
 * POST /api/dashboard/[workspaceId]/companies/assignment
 *
 * Sets a company's manual SDR / team-member assignment. Pass `null` to
 * clear. Body: { companyName: string, teamMemberId: string | null }.
 *
 * The id is validated against WorkspaceConfig.teamMembers so a stale UI
 * can't write an unknown member id. Auth: same dashboard cookie as the
 * page.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { setCompanyAssignment, isDbConfigured } from "@/lib/db/contact-store"

export async function POST(
  request: NextRequest,
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

  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Postgres not configured" }, { status: 500 })
  }

  let body: { companyName?: unknown; teamMemberId?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }

  const companyName = typeof body.companyName === "string" ? body.companyName : null
  if (!companyName) {
    return NextResponse.json({ error: "companyName is required" }, { status: 400 })
  }

  let teamMemberId: string | null
  if (body.teamMemberId === null) {
    teamMemberId = null
  } else if (typeof body.teamMemberId === "string") {
    teamMemberId = body.teamMemberId
    const allowed = new Set((config.teamMembers ?? []).map(m => m.id))
    if (!allowed.has(teamMemberId)) {
      return NextResponse.json(
        { error: "teamMemberId must be one of the workspace's configured team members" },
        { status: 400 },
      )
    }
  } else {
    return NextResponse.json({ error: "teamMemberId must be a string or null" }, { status: 400 })
  }

  await setCompanyAssignment(workspaceId, companyName, teamMemberId)
  return NextResponse.json({ ok: true, companyName, teamMemberId })
}
