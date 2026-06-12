/**
 * Teamfluence webhook handler — receives LinkedIn signal events for a workspace.
 *
 * CRM-agnostic: uses createCrmAdapter() to write contacts and signals.
 * Company linking is handled via the gtm-os internal companies waterfall
 * (HubSpot stores company as a string property on the contact via createContact).
 *
 * Auth: the workspaceId in the URL path is the auth surface. Teamfluence's
 * webhook configuration doesn't include a custom-header option, so we don't
 * require an X-Teamfluence-Secret. Anyone who learns the workspace UUID can
 * post events for that workspace — UUIDs are unguessable in practice but
 * rotate via Redis if one ever leaks.
 */

import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig, classifyIcpGroup, checkExclusion, resolveVerbWeight } from "@/lib/workspace-config"
import { sql } from "@/lib/db"
import { createCrmAdapter } from "@/lib/crm"
import type { EnrichedContact } from "@/lib/crm/types"
import { queueEnrichment } from "@/lib/enrichment"
import { safeUpsertContact, recordSignal, isDbConfigured } from "@/lib/db/contact-store"
import { findOrCreateCompany } from "@/lib/companies/find-or-create"
import { normalizeDomain } from "@/lib/normalize/domain"
import { classifyContactPersona } from "@/lib/persona-match"
import { isJunkName, nameFromEmail } from "@/lib/name-utils"

const TEAMFLUENCE_BASE = "https://api.teamfluence.app/external"

// ─── Payload types ────────────────────────────────────────────────────────────

interface TeamfluenceCompany {
  name?: string
  domain?: string
  website?: string
  website_url?: string
  linkedin_url?: string
  employee_count?: number
  employees_num_min?: number
  employees_num_max?: number
  industries?: string[]
  specialties?: string[]
  country?: string
  headquarters?: string
  location?: string
  company_type?: string
  description?: string
  followers?: number
  founded_year?: number
}

interface TeamfluenceHistoryEvent {
  id?: string
  event_type: string
  post_url?: string
  comment_url?: string
  description?: string
  created_at?: string
}

interface TeamfluencePayload {
  id: string
  stage?: string
  source?: string
  source_content_url?: string
  first_name?: string
  last_name?: string
  linkedin_url?: string
  email?: string
  job_title?: string
  headline?: string
  team_member_email?: string
  followers_count?: number
  connections_count?: number
  picture?: string
  phone_number?: string
  company?: TeamfluenceCompany
  history: TeamfluenceHistoryEvent[]
}

// ─── Event mapping ────────────────────────────────────────────────────────────

// ─── Signal field resolution ──────────────────────────────────────────────────

const TEAM_MEMBERS = ["Tom Lawrence", "Camille Oster", "John Mayhew", "Konrad", "Laura"]

function extractName(desc: string | undefined, pattern: RegExp): string | null {
  if (!desc) return null
  const m = desc.match(pattern)
  return m ? m[1].trim() : null
}

function resolveVerbFields(
  event: TeamfluenceHistoryEvent,
  payload: TeamfluencePayload,
  contactName: string | undefined,
): { signalVerb: string; signalActor: string | null; signalObject: string | null; verbDescription: string | null } {
  const url = event.post_url ?? event.comment_url ?? payload.source_content_url ?? null
  const isPostUrl = url ? /\/(feed\/update|posts)\//.test(url) : false
  const actor = contactName ?? null

  if (isPostUrl) {
    const verb = event.event_type === "LINKEDIN_COMMENT_ENGAGEMENT" ? "commented_post" : "liked_post"
    const object = extractName(event.description, /(?:engaged with|liked|reacted to|commented on)\s+([^']+)'s\s+(?:post|comment|linkedin)/i)
    return { signalVerb: verb, signalActor: actor, signalObject: object, verbDescription: url }
  }

  switch (event.event_type) {
    case "LINKEDIN_PROFILE_VIEWER":
      return {
        signalVerb: "viewed_profile",
        signalActor: actor,
        signalObject: extractName(event.description, /(?:visited|viewed)\s+([^']+)'s\s+(?:profile|linkedin)/i),
        verbDescription: null,
      }
    case "LINKEDIN_PROFILE_FOLLOWER":
      return {
        signalVerb: "followed_our_team_member",
        signalActor: actor,
        signalObject: extractName(event.description, /following\s+([^']+)'s\s+profile/i),
        verbDescription: null,
      }
    case "LINKEDIN_ACCEPTED_CONNECTION":
      return {
        signalVerb: "accepted_our_connection",
        signalActor: actor,
        signalObject: extractName(event.description, /connected (?:with|to)\s+(.+?)(?:\s+on\s+linkedin|\s+after|$)/i),
        verbDescription: null,
      }
    case "LINKEDIN_PRIVATE_MESSAGE":
      return {
        signalVerb: "sent_dm",
        signalActor: TEAM_MEMBERS.find(t => payload.team_member_email?.includes(t.split(" ")[0].toLowerCase())) ?? payload.team_member_email ?? null,
        signalObject: actor,
        verbDescription: event.description ?? null,
      }
    default:
      return { signalVerb: event.event_type, signalActor: actor, signalObject: null, verbDescription: url }
  }
}

const EVENT_MAP: Record<string, { sourceType: string; score: number }> = {
  LINKEDIN_PROFILE_VIEWER:      { sourceType: "Profile Viewer",        score: 3 },
  LINKEDIN_ACCEPTED_CONNECTION: { sourceType: "New Connection",        score: 10 },
  LINKEDIN_POST_ENGAGEMENT:     { sourceType: "Post Reaction",         score: 3 },
  LINKEDIN_COMMENT_ENGAGEMENT:  { sourceType: "Post Comment",          score: 5 },
  LINKEDIN_PROFILE_FOLLOWER:    { sourceType: "Profile Follower",      score: 10 },
  // Outbound action — recorded as context for SDRs ("we already DM'd them")
  // but with score 0 so it doesn't affect funnel ranking.
  LINKEDIN_PRIVATE_MESSAGE:     { sourceType: "Private Message Sent",  score: 0 },
}

/**
 * Drop signals where the engager is an employee of the workspace's own
 * company. Without this, e.g. Fiat employees liking each other's posts would
 * show up in the SDR queue as "leads".
 */
function isInternalContact(
  config: { internalLinkedinUrls?: string[] },
  linkedinUrl: string | undefined,
): boolean {
  if (!linkedinUrl) return false
  const lc = linkedinUrl.toLowerCase().replace(/\/$/, "")
  return (config.internalLinkedinUrls ?? []).some(
    u => u.toLowerCase().replace(/\/$/, "") === lc,
  )
}

// (Previously: inline CRM company-linking helpers. Removed — gtm-os is now
//  the source of truth for company records via the gtm-os Companies
//  waterfall; the configured CRM is repopulated by the downstream adapter.)

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params
  const rawBody = await req.text()

  // Diagnostic: log incoming headers + body preview so we can identify
  // Teamfluence's actual auth scheme. Remove once webhook auth is verified.
  console.log(
    `[webhook/teamfluence] inbound workspace=${workspaceId} ` +
      `headers=${JSON.stringify(Object.fromEntries(req.headers.entries()))} ` +
      `body=${rawBody.slice(0, 500)}`,
  )

  const config = await getWorkspaceConfig(workspaceId)
  if (!config) {
    return NextResponse.json({ error: "Unknown workspace" }, { status: 404 })
  }

  let payload: TeamfluencePayload
  try {
    payload = JSON.parse(rawBody) as TeamfluencePayload
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  if (!payload.history?.length) {
    return NextResponse.json({ ok: true, skipped: true, reason: "no_history_events" })
  }

  // Drop events where the *tracked profile* belongs to an agency / operator
  // team member rather than a workspace employee. Teamfluence sends every
  // tracked profile's events through the same webhook — when an agency's own
  // profile sits under a customer's TF account, those events would otherwise
  // pollute the customer's signals. Match on `team_member_email`
  // case-insensitively against config.agencyTeamMemberEmails.
  const teamEmail = payload.team_member_email?.trim().toLowerCase()
  if (teamEmail && config.agencyTeamMemberEmails?.length) {
    const blocked = config.agencyTeamMemberEmails.some(e => e.trim().toLowerCase() === teamEmail)
    if (blocked) {
      return NextResponse.json({ ok: true, skipped: true, reason: "agency_team_member" })
    }
  }

  // Drop signals where the engager is one of the workspace's own employees.
  if (isInternalContact(config, payload.linkedin_url)) {
    return NextResponse.json({ ok: true, skipped: true, reason: "internal_contact" })
  }

  // Adapter may be null when a workspace has no CRM configured yet (e.g. Fiat
  // pre-HubSpot). The handler still writes to the Postgres projection so
  // signals show up in the SDR dashboard from day one.
  const adapter = createCrmAdapter(config)
  const crmProvider = config.crmProvider ?? "hubspot"

  // gtm-os is the source of truth — the Postgres projection (Section 4 below)
  // captures every signal + contact + company. The configured CRM adapter
  // (HubSpot) mirrors the writes when present; workspaces with no adapter
  // still get the projection and downstream enrichment flows.
  const effectiveAdapter = adapter

  // Strip junk LinkedIn URN identifiers (e.g. "ACoAAAFU75UBrEyKsG…") and
  // "Unknown <foo>" placeholders that TF / Zapier sometimes emits when it
  // can't resolve a real name. Fall back to email-derived name when possible.
  const cleanFirst = isJunkName(payload.first_name) ? undefined : payload.first_name ?? undefined
  const cleanLast  = isJunkName(payload.last_name)  ? undefined : payload.last_name  ?? undefined
  const cleanTitle = isJunkName(payload.job_title)  ? undefined : payload.job_title  ?? undefined
  const cleanHeadline = isJunkName(payload.headline) ? undefined : payload.headline ?? undefined

  let resolvedFirst: string | undefined = cleanFirst
  let resolvedLast:  string | undefined = cleanLast
  if ((!resolvedFirst || !resolvedLast) && payload.email) {
    const fromEmail = nameFromEmail(payload.email)
    if (fromEmail) {
      resolvedFirst ??= fromEmail.firstName
      resolvedLast  ??= fromEmail.lastName ?? undefined
    }
  }
  const fullName = [resolvedFirst, resolvedLast].filter(Boolean).join(" ") || undefined

  // Normalise Teamfluence payload into our contact shape
  const contact: EnrichedContact = {
    firstName:   resolvedFirst,
    lastName:    resolvedLast,
    fullName,
    email:       payload.email        ?? undefined,
    jobTitle:    cleanTitle ?? cleanHeadline,
    linkedinUrl: payload.linkedin_url ?? undefined,
    companyName: payload.company?.name ?? undefined,
  }

  // ── 1. Find or create contact (CRM only — skipped if no adapter) ─────────

  let contactId: string | null = null
  if (effectiveAdapter) {
    try {
      if (payload.linkedin_url) contactId = await effectiveAdapter.findContactByLinkedin(payload.linkedin_url)
      if (!contactId && payload.email) contactId = await effectiveAdapter.findContactByEmail(payload.email)

      if (contactId) {
        await effectiveAdapter.updateContact(contactId, contact)
      } else {
        contactId = await effectiveAdapter.createContact(contact)
      }
    } catch (err) {
      console.error(`[webhook/teamfluence] Failed to find/create contact for workspace ${workspaceId}:`, err)
    }
  }

  // ── 2. Company linking — handled by the gtm-os Companies waterfall ──────
  // gtm-os is the source of truth for company identity via the Companies
  // waterfall (see Section 4 — safeUpsertContact populates gtm_company_id
  // via findOrCreateCompany). The configured CRM adapter mirrors the linkage
  // downstream when applicable.

  // ── 3. Create one signal per history event (CRM only) ────────────────────

  const signalIds: string[] = []

  if (effectiveAdapter && contactId) {
    for (const event of payload.history) {
      const mapping = EVENT_MAP[event.event_type]
      if (!mapping) {
        console.warn(`[webhook/teamfluence] Unknown event_type: ${event.event_type}`)
        continue
      }

      try {
        const verbFields = resolveVerbFields(event, payload, fullName)
        const verbScore = verbFields.signalVerb
          ? resolveVerbWeight(config, verbFields.signalVerb)
          : mapping.score
        const signalId = await effectiveAdapter.createSignal(contactId, {
          signalId:          "",   // filled by the adapter on creation
          sourceType:        mapping.sourceType,
          engagementUrl:     event.post_url ?? event.comment_url ?? undefined,
          score:             verbScore,
          teamfluenceCrmId:  payload.id,
        }, contact)

        if (signalId) signalIds.push(signalId)
      } catch (err) {
        console.error(`[webhook/teamfluence] createSignal failed for ${event.event_type}:`, err)
      }
    }
  }

  // ── 4. Write to Postgres projection (multi-tenant clients) ───────────────
  // Always runs when DB is configured — independent of CRM. For workspaces
  // without a CRM, we synthesise a stable crm_contact_id from TF's lead ID
  // and use TF's per-event history.id for signal dedup.

  if (isDbConfigured()) {
    const pgCrmContactId = contactId ?? `tf:lead:${payload.id}`
    // Classify ICP group from company name + industries before write
    const icpGroup = classifyIcpGroup(
      payload.company?.name ?? null,
      payload.company?.industries ?? null,
      config,
    )?.name ?? undefined

    // Phase 2 dedup: resolve the company in the gtm-os internal companies
    // table. Captures domain + website on the contact row too (previously
    // discarded). Sole company-resolution path on the inbound webhook.
    // TF sends either company.website or company.website_url depending on the payload version.
    const tfCompanyWebsite = payload.company?.website_url ?? payload.company?.website ?? undefined
    const tfCompanyDomain  = payload.company?.domain ?? normalizeDomain(tfCompanyWebsite) ?? undefined
    let gtmCompanyId: number | undefined
    if (payload.company?.linkedin_url || tfCompanyDomain || payload.company?.name) {
      try {
        const result = await findOrCreateCompany(workspaceId, {
          linkedinUrl: payload.company?.linkedin_url,
          domain:      tfCompanyDomain,
          website:     tfCompanyWebsite,
          name:        payload.company?.name,
        })
        gtmCompanyId = result?.companyId
      } catch (err) {
        console.warn(`[webhook/teamfluence] findOrCreateCompany failed:`, err)
      }
    }

    const pgContactId = await safeUpsertContact(workspaceId, crmProvider, pgCrmContactId, {
      email:       contact.email,
      linkedinUrl: contact.linkedinUrl,
      firstName:   contact.firstName,
      lastName:    contact.lastName,
      fullName,
      jobTitle:    contact.jobTitle,
      avatarUrl:   payload.picture ?? undefined,
      companyLinkedinUrl: payload.company?.linkedin_url,
      companyName: contact.companyName,
      // Company-level metadata from TF (used by exclusion rules + display)
      companyIndustries:    payload.company?.industries,
      companyEmployeesMin:  payload.company?.employees_num_min,
      companyEmployeesMax:  payload.company?.employees_num_max,
      companyCountry:       payload.company?.country,
      companyType:          payload.company?.company_type,
      icpGroup,
      linkedinFollowersCount:   payload.followers_count,
      linkedinConnectionsCount: payload.connections_count,
      // Phase 2 dedup additions
      companyDomain:  tfCompanyDomain,
      companyWebsite: tfCompanyWebsite,
      gtmCompanyId,
      // Extended company fields
      companyFollowersCount: payload.company?.followers,
      companySpecialties:    payload.company?.specialties,
      companyHeadquarters:   payload.company?.headquarters ?? payload.company?.location,
      companyFoundedYear:    payload.company?.founded_year,
    })

    if (pgContactId !== null) {
      // Re-classify the persona based on the latest job_title — fire-and-forget.
      void classifyContactPersona(workspaceId, pgContactId)
      for (let i = 0; i < payload.history.length; i++) {
        const event = payload.history[i]
        const mapping = EVENT_MAP[event.event_type]
        if (!mapping) continue
        const pgSignalId = signalIds[i] ?? (event.id ? `tf:event:${event.id}` : undefined)
        const verbFields = resolveVerbFields(event, payload, fullName)
        const pgScore = verbFields.signalVerb
          ? resolveVerbWeight(config, verbFields.signalVerb)
          : mapping.score
        await recordSignal(workspaceId, pgContactId, {
          crmSignalId:     pgSignalId,
          sourceType:      mapping.sourceType,
          engagementUrl:   event.post_url ?? event.comment_url ?? payload.source_content_url ?? undefined,
          description:     event.description ?? undefined,
          signalVerb:      verbFields.signalVerb,
          signalActor:     verbFields.signalActor ?? undefined,
          signalObject:    verbFields.signalObject ?? undefined,
          verbDescription: verbFields.verbDescription ?? undefined,
          scoreDelta:      pgScore,
          occurredAt:      event.created_at ? new Date(event.created_at) : undefined,
        })

        // Near-realtime "now connected" flip: when Teamfluence reports a
        // new 1st-degree connection, mark linkedin_connected = TRUE
        // immediately rather than waiting for the daily sweep. Only
        // touches NULL rows so manual FALSE overrides are preserved.
        if (verbFields.signalVerb === "accepted_our_connection") {
          const db = sql()
          await db`
            UPDATE contacts
            SET    linkedin_connected = TRUE,
                   updated_at         = NOW()
            WHERE  workspace_id       = ${workspaceId}
              AND  id                 = ${pgContactId}
              AND  linkedin_connected IS NULL
          `
        }
      }
    }
  }

  // ── 5. Queue enrichment ──────────────────────────────────────────────────
  // CRM workspaces (HubSpot): trigger as before once a contactId exists.
  // No-CRM workspaces (Fiat-style): trigger when the contact's signal score
  // crosses AUTO_ENRICH_THRESHOLD and exclusion rules don't disqualify them.

  const AUTO_ENRICH_THRESHOLD = 5
  const surfeKey = config.enrichment?.surfe?.apiKey

  if (contactId && !payload.email && payload.linkedin_url) {
    // CRM path — unchanged. Only fires when effectiveAdapter resolved a real
    // CRM contactId (i.e. HubSpot workspaces today). Workspaces without a
    // configured CRM fall through to the no-CRM-style path below.
    const enrichmentTarget = contactId
    try {
      await queueEnrichment(enrichmentTarget, payload.linkedin_url, config)
    } catch (err) {
      console.warn(`[webhook/teamfluence] Enrichment queue failed:`, err)
    }
  } else if (
    !effectiveAdapter && surfeKey && !payload.email && payload.linkedin_url && isDbConfigured()
  ) {
    // No-CRM path — gate on score threshold + exclusion rules
    try {
      const exclusion = checkExclusion({
        companyEmployeesMax: payload.company?.employees_num_max ?? null,
        companyCountry:      payload.company?.country ?? null,
        companyIndustries:   payload.company?.industries ?? null,
        companyType:         payload.company?.company_type ?? null,
      }, config.exclusionRules)
      if (exclusion) {
        console.log(`[webhook/teamfluence] auto-enrich skipped (excluded: ${exclusion}) for ${payload.linkedin_url}`)
      } else {
        // Read the contact's current score to know if it crosses the threshold.
        const db = sql()
        const W = workspaceId
        const url = payload.linkedin_url.toLowerCase().replace(/\/$/, "")
        const rows = await db`
          SELECT signal_score FROM contacts
          WHERE workspace_id = ${W}
            AND LOWER(REGEXP_REPLACE(linkedin_url, '/$', '')) = ${url}
          LIMIT 1
        `
        const score = (rows[0] as { signal_score: number } | undefined)?.signal_score ?? 0
        if (score >= AUTO_ENRICH_THRESHOLD) {
          await queueEnrichment(`tf:lead:${payload.id}`, payload.linkedin_url, config)
          console.log(`[webhook/teamfluence] auto-enrich queued (score=${score}) for ${payload.linkedin_url}`)
        } else {
          console.log(`[webhook/teamfluence] auto-enrich deferred (score=${score} < ${AUTO_ENRICH_THRESHOLD}) for ${payload.linkedin_url}`)
        }
      }
    } catch (err) {
      console.warn(`[webhook/teamfluence] Auto-enrich (no-CRM) failed:`, err)
    }
  }

  // ── 6. Write CRM contact ID back to Teamfluence (bidirectional link) ─────

  if (contactId && config.webhookSecrets?.teamfluence) {
    try {
      await fetch(`${TEAMFLUENCE_BASE}/${payload.id}/crm`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${config.webhookSecrets.teamfluence}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ crm_id: contactId }),
      })
    } catch (err) {
      console.warn(`[webhook/teamfluence] crm_id writeback failed:`, err)
    }
  }

  console.log(
    `[webhook/teamfluence] workspace=${workspaceId} lead=${payload.id} signals=${signalIds.length} contact=${contactId} crm=${crmProvider}`,
  )

  return NextResponse.json({
    ok: true,
    signalsCreated: signalIds.length,
    contactId,
    crmProvider,
  })
}
