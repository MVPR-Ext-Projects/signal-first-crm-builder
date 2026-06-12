/**
 * PATCH /api/dashboard/[workspaceId]/companies/edit
 *
 * Manually edit company-level fields — currently companyName and/or
 * linkedinUrl. Both are propagated to every contact row that belongs to
 * the company (identified by the current companyName).
 *
 * Renaming also updates the company_tags row so prospect-type / stage /
 * assignment metadata follows the rename.
 *
 * Body: { companyName: string, linkedinUrl?: string | null, newCompanyName?: string | null }
 */

import { cookies } from "next/headers"
import { revalidatePath } from "next/cache"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { sql, isDbConfigured } from "@/lib/db"
import { saveCompanyWebsiteDomain } from "@/lib/db/contact-store"

export async function PATCH(
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

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }

  const companyName = typeof body.companyName === "string" ? body.companyName.trim() : null
  if (!companyName) {
    return NextResponse.json({ error: "companyName required" }, { status: 400 })
  }

  const newCompanyName =
    "newCompanyName" in body
      ? typeof body.newCompanyName === "string" ? body.newCompanyName.trim() || null : null
      : undefined

  const linkedinUrl =
    "linkedinUrl" in body
      ? typeof body.linkedinUrl === "string" ? body.linkedinUrl.trim() || null : null
      : undefined

  const websiteDomain =
    "websiteDomain" in body
      ? typeof body.websiteDomain === "string" ? body.websiteDomain.trim() || null : null
      : undefined

  if (newCompanyName === undefined && linkedinUrl === undefined && websiteDomain === undefined) {
    return NextResponse.json({ error: "No editable fields provided" }, { status: 400 })
  }

  const db = sql()
  const resolvedName = newCompanyName ?? companyName

  if (linkedinUrl !== undefined) {
    await db`
      UPDATE contacts
      SET company_linkedin_url = ${linkedinUrl}, updated_at = NOW()
      WHERE workspace_id = ${workspaceId}
        AND company_name = ${companyName}
    `
  }

  if (newCompanyName !== null && newCompanyName !== undefined && newCompanyName !== companyName) {
    await db`
      UPDATE contacts
      SET company_name = ${newCompanyName}, updated_at = NOW()
      WHERE workspace_id = ${workspaceId}
        AND company_name = ${companyName}
    `
    // Rename the company_tags row if it exists
    await db`
      UPDATE company_tags
      SET company_name = ${newCompanyName}
      WHERE workspace_id = ${workspaceId}
        AND company_name = ${companyName}
    `
  }

  if (websiteDomain !== undefined) {
    await saveCompanyWebsiteDomain(workspaceId, companyName, websiteDomain)
  }

  revalidatePath(`/dashboard/${workspaceId}/companies`)
  revalidatePath(`/dashboard/${workspaceId}/sdr`)

  return NextResponse.json({ ok: true, companyName: resolvedName })
}
