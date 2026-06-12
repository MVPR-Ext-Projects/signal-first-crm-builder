/**
 * POST /api/enrich/companies/[workspaceId]
 *
 * Trigger an Apify employee-scrape for one company. Persists the result in
 * `company_enrichments` (one row per workspace × company_linkedin_url, latest
 * fetch wins). Returns the normalized profile list and counts.
 *
 * Does NOT write to the configured CRM — that wiring lives in a separate
 * follow-up. Today this endpoint is purely "fetch + cache + return".
 *
 * Body (JSON):
 *   { companyLinkedinUrl: string, companyName?: string }
 *
 * Auth: requires the dashboard cookie matching `WorkspaceConfig.accessToken`
 * (when set on the workspace) — same gate as the SDR dashboard.
 */

import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { fetchCompanyEmployees, looksLikeValidCompanyLinkedin } from "@/lib/apify-enrichment"
import { saveCompanyEnrichment } from "@/lib/db/contact-store"
import { logUsage } from "@/lib/usage-log"
import { APIFY_COMPANY_EMPLOYEES_CENTS_PER_RUN } from "@/lib/pricing"

export const runtime = "nodejs"

interface RequestBody {
  companyLinkedinUrl?: string
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

  // Same auth gate as the SDR dashboard: if the workspace has an accessToken,
  // require the matching cookie. Otherwise the workspace is open.
  if (config.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  const apify = config.enrichment?.apify
  if (!apify?.apiToken) {
    return NextResponse.json(
      { error: "Apify token not configured for this workspace. Add it via the wizard." },
      { status: 400 },
    )
  }

  let body: RequestBody
  try {
    body = (await req.json()) as RequestBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const companyLinkedinUrl = body.companyLinkedinUrl?.trim()
  if (!companyLinkedinUrl) {
    return NextResponse.json({ error: "companyLinkedinUrl is required" }, { status: 400 })
  }
  if (!looksLikeValidCompanyLinkedin(companyLinkedinUrl)) {
    return NextResponse.json(
      { error: `Not a valid linkedin.com/company/<slug> URL: ${companyLinkedinUrl}` },
      { status: 400 },
    )
  }

  const result = await fetchCompanyEmployees(companyLinkedinUrl, {
    apiToken:     apify.apiToken,
    actorId:      apify.actorId,
    maxEmployees: apify.maxEmployees,
    // Match titles against the workspace's persona match patterns instead
    // of the legacy founder-only regex. When the workspace has no personas
    // configured the lib falls back to the regex automatically.
    personas: (config.messaging?.personas ?? []).map(p => ({
      name:          p.name,
      matchPatterns: p.matchPatterns,
    })),
  })

  if (result.error) {
    // Translate the most common Apify failures into something the SDR can act
    // on without reading raw JSON. The button surfaces { error, code } so the
    // UI can render a richer message (e.g. a "Top up Apify" link for 402).
    const raw = result.error.message ?? ""
    let message = `Apify ${result.error.status}: ${raw}`
    let code: string | undefined
    if (result.error.status === 402 || raw.includes("not-enough-usage")) {
      code    = "apify-out-of-credits"
      message = "Out of Apify credits — top up your account to run more enrichments."
    } else if (raw.includes("max-items-must-be-greater-than-zero")) {
      code    = "apify-bad-config"
      message = "Apify rejected the run (no result cap). This is a bug — let support know."
    }
    return NextResponse.json(
      { error: message, code, rawApifyError: raw },
      { status: 502 },
    )
  }

  // Cost tracking — fire-and-forget. Hardcoded per-run estimate; refine later
  // by hitting /actor-runs/{id} for the real compute-unit usage if needed.
  void logUsage({
    workspaceId,
    category:      "enrichment",
    provider:      "apify",
    units:         1,
    unitCostCents: APIFY_COMPANY_EMPLOYEES_CENTS_PER_RUN,
    metadata:      { actor: "company-employees", companyLinkedinUrl, rawCount: result.rawCount },
  })

  await saveCompanyEnrichment(workspaceId, {
    companyLinkedinUrl,
    companyName: body.companyName ?? null,
    rawCount: result.rawCount,
    matchCount: result.matchCount,
    employees: result.profiles,
  })

  // Profiles are NOT auto-promoted to contacts. The Reveal-employees drawer
  // on the Companies page lets the user qualify-in which profiles to keep,
  // and POSTs the selected ones to /companies/promote-contacts.
  return NextResponse.json({
    companyLinkedinUrl,
    companyName: body.companyName ?? null,
    rawCount: result.rawCount,
    matchCount: result.matchCount,
    employees: result.profiles,
  })
}
