/**
 * Dripify webhook handler — receives a lead payload each time a campaign
 * action fires (e.g. "Follow Profile").
 *
 * Writes to the gtm-os Postgres projection only. Deliberately does not
 * push to the configured CRM — Dripify signals are managed entirely within
 * the CRM builder. External CRM handover happens at MQL (meeting booked).
 *
 * Auth: configure webhookSecrets.dripify on the workspace, then add the
 * secret as a custom header named X-Dripify-Secret in Dripify's webhook
 * settings. Requests without a matching header are rejected 401.
 *
 * Provenance: the actor and campaign are not in the Dripify payload, so
 * they are encoded in the URL as ?actorId=<teamMemberId>&campaign=<name>.
 * actorId is resolved to a display name from config.teamMembers at request
 * time, so renaming a team member in settings propagates to future signals.
 */

import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig, resolveVerbWeight, findTeamMember } from "@/lib/workspace-config"
import { safeUpsertContact, recordSignal, isDbConfigured, updateContactById } from "@/lib/db/contact-store"
import { classifyContactPersona } from "@/lib/persona-match"
import { findContactByIdentity } from "@/lib/contacts/find-or-create"
import { findOrCreateCompany } from "@/lib/companies/find-or-create"
import { normalizeDomain } from "@/lib/normalize/domain"

// ─── Payload type ─────────────────────────────────────────────────────────────

interface DripifyPayload {
  firstName?:                string
  lastName?:                 string
  location?:                 string
  city?:                     string
  country?:                  string
  premium?:                  string
  link?:                     string   // LinkedIn profile URL
  website?:                  string
  email?:                    string
  manualEmail?:              string
  corporateEmail?:           string
  linkedInEmail?:            string
  phone?:                    string
  company?:                  string
  companyWebsite?:           string
  position?:                 string
  industry?:                 string
  education?:                string
  hookDate?:                 string   // dd/mm/yyyy
  numberOfCompanyEmployees?: string
  numberOfCompanyFollowers?: string
  campaignName?:             string | null
  conversation?:             string | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveEmail(p: DripifyPayload): string | undefined {
  return p.email || p.linkedInEmail || p.corporateEmail || p.manualEmail || undefined
}

// Dripify uses dd/mm/yyyy
function parseHookDate(hookDate: string | undefined): Date | undefined {
  if (!hookDate) return undefined
  const [dd, mm, yyyy] = hookDate.split("/")
  if (!dd || !mm || !yyyy) return undefined
  const d = new Date(`${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`)
  return isNaN(d.getTime()) ? undefined : d
}

const SOURCE_TYPE   = "LinkedIn Follow (Dripify)"
const SIGNAL_VERB   = "followed_prospect"
const DEFAULT_SCORE = 0

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params
  const rawBody = await req.text()

  const searchParams = req.nextUrl.searchParams
  const actorId      = searchParams.get("actorId")   ?? undefined
  const campaignQp   = searchParams.get("campaign")  ?? undefined

  console.log(
    `[webhook/dripify] inbound workspace=${workspaceId} actorId=${actorId} campaign=${campaignQp} body=${rawBody.slice(0, 500)}`,
  )

  const config = await getWorkspaceConfig(workspaceId)
  if (!config) {
    return NextResponse.json({ error: "Unknown workspace" }, { status: 404 })
  }

  if (config.webhookSecrets?.dripify) {
    const incoming = req.headers.get("x-dripify-secret")
    if (incoming !== config.webhookSecrets.dripify) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  const actor = actorId
    ? (findTeamMember(config, actorId)?.name ?? actorId)
    : undefined

  let payload: DripifyPayload
  try {
    payload = JSON.parse(rawBody) as DripifyPayload
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  // Payload campaignName wins if Dripify ever populates it; query param is the fallback.
  const campaignName = (payload.campaignName || campaignQp) ?? undefined

  const linkedinUrl = payload.link ?? undefined
  const email       = resolveEmail(payload)
  const fullName    = [payload.firstName, payload.lastName].filter(Boolean).join(" ") || undefined

  if (!isDbConfigured()) {
    return NextResponse.json({ ok: true, skipped: true, reason: "no_db" })
  }

  const employeeCount = payload.numberOfCompanyEmployees
    ? parseInt(payload.numberOfCompanyEmployees, 10)
    : undefined

  // ── Phase 2 dedup: run the Companies waterfall to resolve company identity,
  //    then the People waterfall to find an existing contact (across sources).
  //    Falls back to the historical synthetic-key insert when no match exists.

  const companyDomain = normalizeDomain(payload.companyWebsite) ?? undefined

  let gtmCompanyId: number | undefined
  if (payload.company || payload.companyWebsite) {
    try {
      const result = await findOrCreateCompany(workspaceId, {
        name:    payload.company,
        website: payload.companyWebsite,
      })
      gtmCompanyId = result?.companyId
    } catch (err) {
      console.warn(`[webhook/dripify] findOrCreateCompany failed:`, err)
    }
  }

  const companyFollowersCount = payload.numberOfCompanyFollowers
    ? parseInt(payload.numberOfCompanyFollowers, 10)
    : undefined

  const linkedinPremium = payload.premium?.toLowerCase() === "yes"
    ? true
    : payload.premium?.toLowerCase() === "no"
      ? false
      : undefined

  const contactData = {
    email,
    linkedinUrl,
    firstName:           payload.firstName ?? undefined,
    lastName:            payload.lastName  ?? undefined,
    fullName,
    jobTitle:            payload.position  ?? undefined,
    companyName:         payload.company   ?? undefined,
    location:            payload.location  ?? payload.country ?? undefined,
    companyEmployeesMax: !isNaN(employeeCount ?? NaN) ? employeeCount : undefined,
    companyDomain,
    companyWebsite:      payload.companyWebsite ?? undefined,
    gtmCompanyId,
    phone:               payload.phone || undefined,
    contactIndustry:     payload.industry ?? undefined,
    linkedinPremium,
    companyFollowersCount: !isNaN(companyFollowersCount ?? NaN) ? companyFollowersCount : undefined,
  }

  let pgContactId: number | null = null
  let matchedVia: string | null = null

  try {
    const found = await findContactByIdentity(workspaceId, {
      linkedinUrl,
      email,
      firstName:      payload.firstName,
      lastName:       payload.lastName,
      fullName,
      companyWebsite: payload.companyWebsite,
      companyName:    payload.company,
    })
    if (found) {
      await updateContactById(found.contactId, contactData)
      pgContactId = found.contactId
      matchedVia  = found.matchedVia
    }
  } catch (err) {
    console.warn(`[webhook/dripify] findContactByIdentity failed; falling back to synthetic upsert:`, err)
  }

  if (pgContactId === null) {
    pgContactId = await safeUpsertContact(
      workspaceId,
      "dripify",
      `dripify:${linkedinUrl ?? fullName ?? "unknown"}`,
      contactData,
    )
  }

  if (pgContactId !== null) {
    void classifyContactPersona(workspaceId, pgContactId)

    const score = resolveVerbWeight(config, SIGNAL_VERB) ?? DEFAULT_SCORE
    await recordSignal(workspaceId, pgContactId, {
      sourceType:      SOURCE_TYPE,
      signalVerb:      SIGNAL_VERB,
      signalActor:     actor ?? "Dripify",
      signalObject:    fullName,
      verbDescription: campaignName,
      scoreDelta:      score,
      occurredAt:      parseHookDate(payload.hookDate),
    })
  }

  console.log(
    `[webhook/dripify] workspace=${workspaceId} actor=${actor} campaign=${campaignName} contact=${fullName} linkedin=${linkedinUrl} pgContactId=${pgContactId} matchedVia=${matchedVia ?? "synthetic"} gtmCompanyId=${gtmCompanyId ?? "null"}`,
  )

  return NextResponse.json({ ok: true, pgContactId, matchedVia, gtmCompanyId })
}
