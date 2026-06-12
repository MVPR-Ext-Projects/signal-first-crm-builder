/**
 * GET /api/dashboard/[workspaceId]/coverage
 *
 * List MVPR coverage rows for the workspace, with optional filters:
 *   - topic            (single topic match against the topics text[] column)
 *   - publicationName  (exact match against publication_name)
 *   - isOrganic        (true | false)
 *   - limit            (default 200, max 500)
 *
 * Returns CoverageRow[] from lib/db/coverage.ts.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { listCoverage } from "@/lib/db/coverage"

export async function GET(
  req:    NextRequest,
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

  const url = req.nextUrl
  const topic           = url.searchParams.get("topic")           ?? undefined
  const publicationName = url.searchParams.get("publicationName") ?? undefined
  const isOrganicParam  = url.searchParams.get("isOrganic")
  const isOrganic       = isOrganicParam === "true"  ? true
                       : isOrganicParam === "false" ? false
                       : undefined
  const rawLimit = Number(url.searchParams.get("limit"))
  const limit    = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(500, Math.round(rawLimit)) : 200

  const rows = await listCoverage(workspaceId, { topic, publicationName, isOrganic, limit })
  return NextResponse.json({ coverage: rows })
}
