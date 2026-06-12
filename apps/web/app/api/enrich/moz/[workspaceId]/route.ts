/**
 * POST /api/enrich/moz/[workspaceId]
 *
 * Fetches Moz domain authority and link metrics for a given website domain.
 * Stores the result in company_moz_data and optionally persists the domain
 * to company_tags.website_domain so future card renders pick it up.
 *
 * Body (JSON):
 *   { domain: string, companyName?: string }
 *
 * Auth: same dashboard-cookie gate used by other enrich endpoints.
 */

import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { fetchMozMetrics, normaliseDomain } from "@/lib/moz"
import { saveMozData, saveCompanyWebsiteDomain } from "@/lib/db/contact-store"

export const runtime = "nodejs"

interface RequestBody {
  domain?: string
  companyName?: string
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await ctx.params

  const config = await getWorkspaceConfig(workspaceId)
  if (!config) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 })
  }

  if (config.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  const moz = config.enrichment?.moz
  if (!moz?.apiKey) {
    return NextResponse.json(
      { error: "Moz API key not configured for this workspace. Add it in Settings." },
      { status: 400 },
    )
  }

  let body: RequestBody
  try {
    body = (await req.json()) as RequestBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const rawDomain = body.domain?.trim()
  if (!rawDomain) {
    return NextResponse.json({ error: "domain is required" }, { status: 400 })
  }

  const domain = normaliseDomain(rawDomain)
  if (!domain || domain.length < 3 || !domain.includes(".")) {
    return NextResponse.json({ error: `Not a valid domain: ${rawDomain}` }, { status: 400 })
  }

  const metrics = await fetchMozMetrics(domain, moz.apiKey)
  if (!metrics) {
    return NextResponse.json(
      { error: "Moz API request failed. Check your credentials or try again." },
      { status: 502 },
    )
  }

  await saveMozData(workspaceId, domain, metrics)

  if (body.companyName?.trim()) {
    await saveCompanyWebsiteDomain(workspaceId, body.companyName.trim(), domain)
  }

  return NextResponse.json({
    domain,
    domainAuthority:  metrics.domainAuthority,
    pageAuthority:    metrics.pageAuthority,
    backlinks:        metrics.backlinks,
    rootDomains:      metrics.rootDomains,
    spamScore:        metrics.spamScore,
  })
}
