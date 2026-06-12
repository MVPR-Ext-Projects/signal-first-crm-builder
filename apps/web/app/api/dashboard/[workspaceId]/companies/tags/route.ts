/**
 * POST /api/dashboard/[workspaceId]/companies/tags
 *
 * Sets the Prospect Type tag set on a company. Pass an empty array to clear.
 * Body: { companyName: string, prospectTypes: string[] }
 *
 * Tag values are validated against WorkspaceConfig.prospectTypes (or the
 * defaults when unset) so the dashboard can't write a stray value the
 * Settings UI doesn't know about.
 *
 * Auth: same cookie check as the dashboard page.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig, resolveProspectTypes } from "@/lib/workspace-config"
import { setCompanyProspectTypes } from "@/lib/db/contact-store"

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

  let companyName: string | undefined
  let prospectTypes: string[] | undefined
  try {
    const body = await request.json()
    companyName   = typeof body.companyName === "string" ? body.companyName : undefined
    prospectTypes = Array.isArray(body.prospectTypes)
      ? body.prospectTypes.filter((v: unknown): v is string => typeof v === "string")
      : undefined
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }

  if (!companyName || !prospectTypes) {
    return NextResponse.json(
      { error: "companyName (string) and prospectTypes (string[]) are required" },
      { status: 400 },
    )
  }

  const allowed = new Set(resolveProspectTypes(config))
  const unknown = prospectTypes.filter(p => !allowed.has(p))
  if (unknown.length > 0) {
    return NextResponse.json(
      { error: `Unknown prospect types: ${unknown.join(", ")}` },
      { status: 400 },
    )
  }

  await setCompanyProspectTypes(workspaceId, companyName, prospectTypes)
  return NextResponse.json({ ok: true, companyName, prospectTypes })
}
