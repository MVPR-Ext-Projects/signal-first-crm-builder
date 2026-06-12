/**
 * POST /api/dashboard/[workspaceId]/enrich-contact
 *
 * Body: { linkedinUrl: string }
 *
 * Synchronous enrichment — calls Surfe, waits for the result, writes back to
 * Postgres, logs credits, applies the post-enrichment internal-employee filter.
 *
 * Surfe takes ~30-60s per call; this route runs at maxDuration = 90s. Vercel
 * Pro plan supports up to 60s by default; if Fiat's plan can't extend further,
 * we'd switch to a queue + cron pattern.
 *
 * Auth: same dashboard cookie as the page.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { sql, isDbConfigured } from "@/lib/db"
import { resolveBestName } from "@/lib/name-utils"
import { logUsage } from "@/lib/usage-log"
import { SURFE_CENTS_PER_CREDIT } from "@/lib/pricing"
import { extractValidEmail, extractLinkedinMemberId, extractPhone, parseSurfeCredits, type SurfeEnrichmentResponse } from "@/lib/surfe"

export const maxDuration = 90

const SURFE_BASE = "https://api.surfe.com/v1"
const POLL_TIMEOUT_MS = 80_000   // give up after ~80s
const POLL_INITIAL_MS = 30_000   // first poll after 30s
const POLL_INTERVAL_MS = 5_000   // then every 5s

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function isInternal(
  email: string | null,
  companyName: string | null | undefined,
  domains: string[],
  companies: string[],
): boolean {
  if (email) {
    const domain = email.split("@")[1]?.toLowerCase()
    if (domain && domains.map(d => d.toLowerCase()).includes(domain)) return true
  }
  if (companyName) {
    const lc = companyName.toLowerCase()
    if (companies.some(c => lc.includes(c.toLowerCase()))) return true
  }
  return false
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params

  // Auth — same cookie as dashboard
  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Unknown workspace" }, { status: 404 })
  if (config.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  const surfeKey = config.enrichment?.surfe?.apiKey
  if (!surfeKey) {
    return NextResponse.json({ error: "Surfe API key not configured for workspace" }, { status: 400 })
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Postgres not configured" }, { status: 500 })
  }

  let linkedinUrl: string | undefined
  try {
    const body = await request.json()
    linkedinUrl = typeof body.linkedinUrl === "string" ? body.linkedinUrl : undefined
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }
  if (!linkedinUrl) {
    return NextResponse.json({ error: "linkedinUrl required" }, { status: 400 })
  }

  const db = sql()

  // ── Step 1: kick off Surfe enrichment ───────────────────────────────────
  let enrichmentId: string
  try {
    const startRes = await fetch(`${SURFE_BASE}/people/enrichments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${surfeKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ enrichmentType: "email", person: { linkedinUrl } }),
    })
    if (!startRes.ok) {
      const text = await startRes.text().catch(() => "")
      return NextResponse.json({ error: `Surfe start failed: ${startRes.status} ${text.slice(0, 200)}` }, { status: 502 })
    }
    const startData = await startRes.json()
    enrichmentId = startData.id
    if (!enrichmentId) return NextResponse.json({ error: "Surfe returned no enrichment id" }, { status: 502 })
  } catch (e) {
    return NextResponse.json({ error: `Surfe network error: ${(e as Error).message}` }, { status: 502 })
  }

  // ── Step 2: poll for result ─────────────────────────────────────────────
  let data: SurfeEnrichmentResponse | null = null
  await sleep(POLL_INITIAL_MS)
  const deadline = Date.now() + POLL_TIMEOUT_MS - POLL_INITIAL_MS
  while (Date.now() < deadline) {
    const r = await fetch(`${SURFE_BASE}/people/enrichments/${enrichmentId}`, {
      headers: { Authorization: `Bearer ${surfeKey}` },
      cache: "no-store",
    })
    if (r.status === 202) {
      await sleep(POLL_INTERVAL_MS)
      continue
    }
    if (!r.ok) {
      return NextResponse.json({ error: `Surfe poll failed: ${r.status}` }, { status: 502 })
    }
    data = await r.json() as SurfeEnrichmentResponse
    const status = (data.status ?? "").toLowerCase()
    if (status === "pending" || status === "processing") {
      await sleep(POLL_INTERVAL_MS)
      continue
    }
    break
  }
  if (!data) {
    return NextResponse.json({ error: "Surfe enrichment timed out", enrichmentId }, { status: 504 })
  }

  // ── Step 3: parse + write back ──────────────────────────────────────────
  const validEmail = extractValidEmail(data) ?? null
  const fullName   = [data.firstName, data.lastName].filter(Boolean).join(" ") || data.name || null
  const country    = data.country ?? null
  const companyName = data.companyName ?? null

  // This route only requests email-type enrichment, so mobile credits stay
  // at 0 unless the response explicitly reported one. parseSurfeCredits
  // handles the v2 fallback (estimate from outcome when creditsUsed is
  // missing) — see lib/surfe.ts.
  const hasAnyData = !!(validEmail || data.firstName || data.lastName || companyName)
  const credits    = parseSurfeCredits(data, { hasAnyData, hasPhone: false })
  const emailCredits  = credits.emailCredits
  const mobileCredits = credits.mobileCredits

  // Find the contact by linkedin URL — also pull existing name fields so we
  // can overwrite junk (LinkedIn URN ids, "Unknown" placeholders) with the
  // best available value.
  const norm = linkedinUrl.toLowerCase().replace(/\/$/, "")
  const contactRows = await db`
    SELECT id, email, first_name, last_name, full_name FROM contacts
    WHERE workspace_id = ${workspaceId}
      AND LOWER(REGEXP_REPLACE(linkedin_url, '/$', '')) = ${norm}
    LIMIT 1
  `
  const existingRow = contactRows[0] as
    | { id: number; email: string | null; first_name: string | null; last_name: string | null; full_name: string | null }
    | undefined
  const contactId = existingRow?.id ?? null

  // ── Internal-employee post-filter ──
  const internal = isInternal(
    validEmail,
    companyName,
    config.internalEmailDomains ?? [],
    config.internalCompanyNames ?? [],
  )

  // Log the call regardless of outcome
  const status = !hasAnyData ? "no_match" : internal ? "internal_purged" : "enriched"
  await db`
    INSERT INTO enrichment_log
      (workspace_id, contact_id, linkedin_url, enrichment_id, provider, status, email_credits, mobile_credits)
    VALUES
      (${workspaceId}, ${contactId}, ${linkedinUrl}, ${enrichmentId}, 'surfe', ${status}, ${emailCredits}, ${mobileCredits})
  `
  // Cost tracking — fire-and-forget.
  const totalCredits = emailCredits + mobileCredits
  if (totalCredits > 0) {
    void logUsage({
      workspaceId,
      category:      "enrichment",
      provider:      "surfe",
      units:         totalCredits,
      unitCostCents: SURFE_CENTS_PER_CREDIT,
      metadata:      { emailCredits, mobileCredits, status, enrichmentId },
    })
  }

  if (!hasAnyData) {
    return NextResponse.json({ ok: true, status: "no_match", credits: emailCredits + mobileCredits })
  }

  if (internal && contactId !== null) {
    // Add the LinkedIn URL to the internal filter for future-proofing, then delete the contact
    const existing = config.internalLinkedinUrls ?? []
    const target = norm
    if (!existing.some(u => u.toLowerCase().replace(/\/$/, "") === target)) {
      // Persist the addition by re-saving config (encrypts sensitive fields)
      const { saveWorkspaceConfig } = await import("@/lib/workspace-config")
      await saveWorkspaceConfig({ ...config, internalLinkedinUrls: [...existing, linkedinUrl] })
    }
    await db`DELETE FROM contacts WHERE id = ${contactId}`
    return NextResponse.json({ ok: true, status: "internal_purged", credits: emailCredits + mobileCredits })
  }

  if (contactId === null) {
    // Contact wasn't in our DB (race?); log and return.
    return NextResponse.json({ ok: true, status: "no_contact_to_update", credits: emailCredits + mobileCredits })
  }

  // Resolve the best name we can — strips junk values (LinkedIn URN ids,
  // "Unknown" placeholders) and falls back to email-derived name when needed.
  const resolvedEmail = validEmail ?? existingRow?.email ?? null
  const resolved = resolveBestName({
    existing:     {
      firstName: existingRow?.first_name ?? null,
      lastName:  existingRow?.last_name  ?? null,
      fullName:  existingRow?.full_name  ?? null,
    },
    fromProvider: { firstName: data.firstName, lastName: data.lastName, fullName: fullName ?? undefined },
    email:        resolvedEmail,
  })

  // Clear the needs_enrichment flag - the Enrichment Candidates page sets
  // this and uses successful enrichment as the signal that the row should
  // drop off the list. If the upstream trigger reappears (e.g. another
  // LinkedIn hard-fail) the flag will be set again by that path.
  const surfeMemberId = extractLinkedinMemberId(data) ?? null
  const phone = extractPhone(data) ?? null
  await db`
    UPDATE contacts SET
      email                 = COALESCE(${validEmail},                    email),
      first_name            = ${resolved.firstName},
      last_name             = ${resolved.lastName},
      full_name             = ${resolved.fullName},
      job_title             = COALESCE(${data.jobTitle ?? null},         job_title),
      company_name          = COALESCE(${companyName},                   company_name),
      company_id            = COALESCE(${data.companyID ?? null},        company_id),
      location              = COALESCE(${country},                       location),
      linkedin_member_id    = COALESCE(${surfeMemberId},                 linkedin_member_id),
      phone                 = COALESCE(${phone},                         phone),
      enrichment_expires_at = ${data.expiresAt ? new Date(data.expiresAt) : null},
      needs_enrichment      = FALSE,
      enrichment_reason     = NULL,
      updated_at            = NOW()
    WHERE id = ${contactId}
  `

  // Corporate email lifecycle (Task #18): confirm if the enrichment returned
  // a corporate email. Personal-provider addresses are skipped by the helper
  // since we only confirm corporate. Side-effects: status='confirmed' +
  // corporate_email_confirmed_at=NOW(); clears corporate_email_invalidated_at.
  if (validEmail) {
    const { confirmCorporateEmail } = await import("@/lib/db/contact-store")
    await confirmCorporateEmail(workspaceId, contactId, validEmail)
  }

  return NextResponse.json({
    ok: true,
    status: "enriched",
    credits: emailCredits + mobileCredits,
    email: validEmail,
    company: companyName,
  })
}
