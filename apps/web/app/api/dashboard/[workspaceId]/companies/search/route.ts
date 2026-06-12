import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { sql, isDbConfigured } from "@/lib/db/index"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params
  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ results: [] })
  if (!isDbConfigured()) return NextResponse.json({ results: [] })

  const q = req.nextUrl.searchParams.get("q")?.trim() ?? ""

  const db = sql()
  const rows = await db`
    SELECT DISTINCT
      company_name       AS "companyName",
      company_linkedin_url AS "companyLinkedinUrl"
    FROM contacts
    WHERE workspace_id = ${workspaceId}
      AND company_name IS NOT NULL
      AND company_name <> ''
      ${q ? db`AND company_name ILIKE ${"%" + q + "%"}` : db``}
    ORDER BY company_name
    LIMIT 10
  `

  return NextResponse.json({
    results: (rows as unknown as Array<{ companyName: string; companyLinkedinUrl: string | null }>)
      .map(r => ({ name: r.companyName, linkedinUrl: r.companyLinkedinUrl })),
  })
}
