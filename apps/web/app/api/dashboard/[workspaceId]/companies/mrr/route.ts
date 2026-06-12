/**
 * POST /api/dashboard/[workspaceId]/companies/mrr
 *
 * Sets or clears the deal_mrr on a company. Body:
 * { companyName: string, dealMrr: number | null }.
 *
 * Number is stored as the workspace's working-currency value (GBP for
 * MVPR). null clears the value.
 */
import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { sql, isDbConfigured } from "@/lib/db"

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
    if (token !== config.accessToken) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  if (!isDbConfigured()) return NextResponse.json({ error: "Postgres not configured" }, { status: 500 })

  let body: { companyName?: unknown; dealMrr?: unknown }
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid request body" }, { status: 400 }) }

  const companyName = typeof body.companyName === "string" ? body.companyName : null
  if (!companyName) return NextResponse.json({ error: "companyName is required" }, { status: 400 })

  let dealMrr: number | null
  if (body.dealMrr === null) {
    dealMrr = null
  } else if (typeof body.dealMrr === "number" && Number.isFinite(body.dealMrr) && body.dealMrr >= 0) {
    dealMrr = Math.round(body.dealMrr * 100) / 100  // pin to 2dp
  } else {
    return NextResponse.json({ error: "dealMrr must be a non-negative number or null" }, { status: 400 })
  }

  const db = sql()
  await db`
    INSERT INTO company_tags (workspace_id, company_name, deal_mrr, updated_at)
    VALUES (${workspaceId}, ${companyName}, ${dealMrr}, NOW())
    ON CONFLICT (workspace_id, company_name) DO UPDATE
    SET deal_mrr = EXCLUDED.deal_mrr, updated_at = NOW()
  `
  return NextResponse.json({ ok: true, companyName, dealMrr })
}
