/**
 * GET /api/dashboard/[workspaceId]/influenced-by?linkedinUrl=...
 *
 * Returns the influenced_by JSONB array stored on the contact's row in
 * Postgres (populated by historical import scripts).
 *
 * Lazy-fetched by the InfluencedByPanel client component when a lead row
 * expands. Kept off the SSR getLeads pipeline so a contact with thousands
 * of references (Barney Hussey-Yeo has ~1.7k) doesn't bloat the dashboard's
 * initial payload.
 *
 * Returns an empty array (not null) when the contact exists but has no
 * influences, and 404 if the contact isn't found at all.
 *
 * Auth: same dashboard cookie as the page.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { sql, isDbConfigured } from "@/lib/db"

interface InfluencedByEntry {
  kind:           "person" | "company" | "influencer" | string
  crmId?:         string
  name:           string | null
  linkedinUrl?:   string | null   // person
  domain?:        string | null   // company
  url?:           string | null   // influencer (Twitter or LinkedIn handle)
  website?:       string | null   // influencer
  classification?: string | null  // influencer (Journalist / Other / …)
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params

  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Unknown workspace" }, { status: 404 })

  // Auth — same cookie check as the dashboard page
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

  const linkedinUrl = request.nextUrl.searchParams.get("linkedinUrl")
  if (!linkedinUrl) {
    return NextResponse.json({ error: "linkedinUrl is required" }, { status: 400 })
  }

  const norm = linkedinUrl.toLowerCase().replace(/\/$/, "")
  const db   = sql()
  const rows = await db`
    SELECT influenced_by
    FROM contacts
    WHERE workspace_id = ${workspaceId}
      AND LOWER(REGEXP_REPLACE(linkedin_url, '/$', '')) = ${norm}
    LIMIT 1
  `
  if (rows.length === 0) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 })
  }

  // NULL = never imported, [] = imported with no entries — surface both as
  // an empty list to the client. The "imported" distinction is only useful
  // server-side for re-run heuristics.
  const data = (rows[0] as { influenced_by: InfluencedByEntry[] | null }).influenced_by ?? []
  return NextResponse.json({ influencedBy: data })
}
