/**
 * GET /api/dashboard/[workspaceId]/companies/enrichment?companyLinkedinUrl=…
 *
 * Reads the cached Apify enrichment for a company (employees JSON +
 * fetched_at). Used by the "Reveal employees" drawer after a page reload —
 * the page itself doesn't carry the full profile array, only counts.
 *
 * Auth: same dashboard cookie as the page.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { getCompanyEnrichment, isDbConfigured } from "@/lib/db/contact-store"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params
  const companyLinkedinUrl = req.nextUrl.searchParams.get("companyLinkedinUrl")?.trim()
  if (!companyLinkedinUrl) {
    return NextResponse.json({ error: "companyLinkedinUrl is required" }, { status: 400 })
  }

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

  const row = await getCompanyEnrichment(workspaceId, companyLinkedinUrl)
  if (!row) {
    return NextResponse.json({ error: "No cached enrichment for this company" }, { status: 404 })
  }
  return NextResponse.json(row)
}
