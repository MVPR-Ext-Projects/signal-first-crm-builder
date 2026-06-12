/**
 * Enrichment pipeline — async two-step Surfe integration.
 *
 * Surfe enrichment is asynchronous (~45s waterfall):
 *   Step 1: POST /v1/people/enrichments → returns enrichmentId, stored in KV
 *   Step 2: GET  /v1/people/enrichments/{id} → polled by cron after 60s
 *
 * Flow:
 *   Webhook (new signal / new contact) → queueEnrichment() → KV stores pending job
 *   Cron (every 2 min) → processPendingEnrichments() → GET Surfe → update CRM + Postgres
 *
 * CRM writes go through createCrmAdapter() (HubSpot today).
 *
 * crmProvider-specific behaviour in processPendingEnrichments():
 *   "hubspot": contact already exists — update it with enriched properties
 */

import { Redis } from "@upstash/redis"
import type { WorkspaceConfig } from "./workspace-config"
import { getWorkspaceConfig, saveWorkspaceConfig, classifyIcpGroup } from "./workspace-config"
import { createCrmAdapter } from "./crm"
import { safeUpsertContact } from "./db/contact-store"
import { sql, isDbConfigured } from "./db"
import { isJunkName, resolveBestName } from "./name-utils"
import { logUsage } from "./usage-log"
import { SURFE_CENTS_PER_CREDIT } from "./pricing"
import { classifyContactPersona } from "./persona-match"
import { extractValidEmail, extractPhone, extractLinkedinMemberId, parseSurfeCredits, type SurfeEnrichmentResponse } from "./surfe"

export type { EnrichedContact } from "./crm/types"

const SURFE_BASE = "https://api.surfe.com/v1"

// Minimum age before we poll Surfe for results (Surfe says ~45s)
const POLL_AFTER_MS = 60_000

// ─── Types ────────────────────────────────────────────────────────────────────

interface PendingEnrichment {
  workspaceId: string
  /**
   * For HubSpot: the contact ID to update with enriched properties.
   * For other providers wired in the future, the canonical CRM record id.
   */
  crmRecordId: string
  /** Discriminator for the target CRM (e.g. "hubspot"). */
  crmProvider: string
  linkedinUrl: string
  enrichmentId: string
  startedAt: string   // ISO timestamp
}

// ─── KV helpers ───────────────────────────────────────────────────────────────

function kv() {
  return new Redis({
    url: process.env.KV_REST_API_URL!,
    token: process.env.KV_REST_API_TOKEN!,
  })
}

const PENDING_SET_KEY = "enrichment:pending"

async function storePending(job: PendingEnrichment): Promise<void> {
  const redis = kv()
  await redis.set(`enrichment:job:${job.enrichmentId}`, job, { ex: 3600 })
  await redis.sadd(PENDING_SET_KEY, job.enrichmentId)
}

async function removePending(enrichmentId: string): Promise<void> {
  const redis = kv()
  await Promise.all([
    redis.del(`enrichment:job:${enrichmentId}`),
    redis.srem(PENDING_SET_KEY, enrichmentId),
  ])
}

export async function getPendingEnrichments(): Promise<PendingEnrichment[]> {
  const redis = kv()
  const ids = await redis.smembers<string[]>(PENDING_SET_KEY)
  if (!ids.length) return []

  const jobs = await Promise.all(
    ids.map(id => redis.get<PendingEnrichment>(`enrichment:job:${id}`))
  )
  return jobs.filter((j): j is PendingEnrichment => j !== null)
}

// ─── Surfe API ────────────────────────────────────────────────────────────────

/**
 * Step 1: Start Surfe enrichment. Returns the enrichmentId to poll later.
 */
export async function startSurfeEnrichment(
  linkedinUrl: string,
  apiKey: string,
): Promise<string | null> {
  const res = await fetch(`${SURFE_BASE}/people/enrichments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      enrichmentType: "email",
      person: { linkedinUrl },
    }),
  })

  if (!res.ok) {
    console.warn(`[enrichment] Surfe start failed ${res.status}: ${await res.text()}`)
    return null
  }

  const data = await res.json() as { id?: string }
  return data.id ?? null
}

/**
 * Surfe v1 response shape — flat at the root, not nested under `person`.
 * Includes credits-used so we can log spend.
 */
interface SurfeResult {
  contact: import("./crm/types").EnrichedContact
  emailCredits: number
  mobileCredits: number
  companyId?: string
  expiresAt?: string
}

/**
 * Step 2: Poll Surfe for the enrichment result.
 * Returns "pending" if still processing, null on error, or the enriched contact.
 */
async function getSurfeEnrichment(
  enrichmentId: string,
  apiKey: string,
): Promise<SurfeResult | null | "pending"> {
  const res = await fetch(`${SURFE_BASE}/people/enrichments/${enrichmentId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  })

  if (res.status === 202) return "pending"
  if (!res.ok) {
    console.warn(`[enrichment] Surfe GET failed ${res.status}: ${await res.text()}`)
    return null
  }

  const data = await res.json() as SurfeEnrichmentResponse
  const status = (data.status ?? "").toLowerCase()
  if (status === "pending" || status === "processing") return "pending"

  const validEmail = extractValidEmail(data)
  const phone      = extractPhone(data)
  const hasAnyData = !!(validEmail || data.firstName || data.lastName || data.companyName)
  const credits    = parseSurfeCredits(data, { hasAnyData, hasPhone: !!phone })

  return {
    contact: {
      firstName:        data.firstName,
      lastName:         data.lastName,
      fullName:         [data.firstName, data.lastName].filter(Boolean).join(" ") || data.name || undefined,
      email:            validEmail,
      phone,
      companyName:      data.companyName,
      linkedinUrl:      data.linkedinUrl,
      linkedinMemberId: extractLinkedinMemberId(data),
      location:         data.country,
      jobTitle:         data.jobTitle,
    },
    emailCredits:  credits.emailCredits,
    mobileCredits: credits.mobileCredits,
    companyId:     data.companyID,
    expiresAt:     data.expiresAt,
  }
}

const normalizeUrl = (u: string) => u.toLowerCase().replace(/\/$/, "")

function isInternalAfterEnrichment(
  email: string | undefined,
  companyName: string | undefined,
  config: WorkspaceConfig,
): boolean {
  if (email) {
    const domain = email.split("@")[1]?.toLowerCase()
    if (domain && (config.internalEmailDomains ?? []).map(d => d.toLowerCase()).includes(domain)) return true
  }
  if (companyName) {
    const lc = companyName.toLowerCase()
    if ((config.internalCompanyNames ?? []).some(c => lc.includes(c.toLowerCase()))) return true
  }
  return false
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Called by webhook handlers when a new contact (HubSpot) or signal needs
 * enriching. Kicks off Surfe and stores the pending job in KV.
 *
 * crmRecordId:
 *   HubSpot → contact ID (the contact to update after enrichment)
 */
export async function queueEnrichment(
  crmRecordId: string,
  linkedinUrl: string,
  config: WorkspaceConfig,
): Promise<{ queued: boolean; enrichmentId?: string }> {
  const surfeKey = config.enrichment?.surfe?.apiKey
  if (!surfeKey) {
    console.log(`[enrichment] No Surfe key for workspace ${config.workspaceId}`)
    return { queued: false }
  }

  const enrichmentId = await startSurfeEnrichment(linkedinUrl, surfeKey)
  if (!enrichmentId) return { queued: false }

  await storePending({
    workspaceId:  config.workspaceId,
    crmRecordId,
    crmProvider:  config.crmProvider ?? "hubspot",
    linkedinUrl,
    enrichmentId,
    startedAt:    new Date().toISOString(),
  })

  console.log(`[enrichment] Queued ${enrichmentId} for record ${crmRecordId} (${config.crmProvider ?? "hubspot"})`)
  return { queued: true, enrichmentId }
}

/**
 * Called by the enrichment poll cron. Processes all pending enrichments
 * that are old enough to have a result from Surfe.
 */
export async function processPendingEnrichments(): Promise<{
  processed: number
  pending: number
  failed: number
}> {
  const jobs = await getPendingEnrichments()
  const now = Date.now()
  let processed = 0, stillPending = 0, failed = 0

  for (const job of jobs) {
    const age = now - new Date(job.startedAt).getTime()
    if (age < POLL_AFTER_MS) {
      stillPending++
      continue
    }

    const config = await getWorkspaceConfig(job.workspaceId)
    if (!config?.enrichment?.surfe?.apiKey) {
      await removePending(job.enrichmentId)
      continue
    }

    const result = await getSurfeEnrichment(job.enrichmentId, config.enrichment.surfe.apiKey)

    if (result === "pending") {
      if (age > 600_000) {
        console.warn(`[enrichment] Giving up on ${job.enrichmentId} after 10 min`)
        await removePending(job.enrichmentId)
        failed++
      } else {
        stillPending++
      }
      continue
    }

    if (!result) {
      console.warn(`[enrichment] No result for ${job.enrichmentId}`)
      await removePending(job.enrichmentId)
      failed++
      continue
    }

    const { contact, emailCredits, mobileCredits, companyId, expiresAt } = result
    const hasAnyData = !!(contact.email || contact.firstName || contact.lastName || contact.companyName)

    try {
      const adapter = createCrmAdapter(config)
      const crmProvider = job.crmProvider ?? config.crmProvider ?? "hubspot"

      // ── No-CRM workspaces (e.g. Fiat pre-HubSpot) — write to Postgres directly
      if (!adapter) {
        if (!isDbConfigured()) {
          console.error(`[enrichment] No CRM adapter and no DB for workspace ${job.workspaceId}`)
          await removePending(job.enrichmentId)
          failed++
          continue
        }
        const db = sql()
        const norm = normalizeUrl(job.linkedinUrl)

        // Look up the Postgres contact by linkedin_url (also fetch name fields so we
        // can detect & overwrite junk LinkedIn URN identifiers / "Unknown" placeholders)
        const found = await db`
          SELECT id, email, first_name, last_name, full_name
          FROM contacts
          WHERE workspace_id = ${job.workspaceId}
            AND LOWER(REGEXP_REPLACE(linkedin_url, '/$', '')) = ${norm}
          LIMIT 1
        `
        const existingRow = found[0] as
          | { id: number; email: string | null; first_name: string | null; last_name: string | null; full_name: string | null }
          | undefined
        const contactId = existingRow?.id ?? null

        // Status for the credits log
        let logStatus: "enriched" | "no_match" | "internal_purged" = "enriched"

        if (!hasAnyData) {
          logStatus = "no_match"
        } else if (isInternalAfterEnrichment(contact.email, contact.companyName, config)) {
          logStatus = "internal_purged"
          // Add the LinkedIn URL to internalLinkedinUrls + delete the contact
          const existing = config.internalLinkedinUrls ?? []
          if (!existing.some(u => normalizeUrl(u) === norm)) {
            await saveWorkspaceConfig({ ...config, internalLinkedinUrls: [...existing, job.linkedinUrl] })
          }
          if (contactId !== null) {
            await db`DELETE FROM contacts WHERE id = ${contactId}`
          }
        } else if (contactId !== null && existingRow) {
          // Classify ICP group with the freshly-known company info
          const icp = classifyIcpGroup(contact.companyName ?? null, null, config)?.name ?? null

          // Resolve the best name we can — overwrites junk LinkedIn URN ids and
          // "Unknown" placeholders with provider data or an email-derived fallback.
          const resolvedEmail = contact.email ?? existingRow.email ?? null
          const resolved = resolveBestName({
            existing:     { firstName: existingRow.first_name, lastName: existingRow.last_name, fullName: existingRow.full_name },
            fromProvider: { firstName: contact.firstName,      lastName: contact.lastName,      fullName: contact.fullName    },
            email:        resolvedEmail,
          })

          await db`
            UPDATE contacts SET
              email                 = COALESCE(${contact.email ?? null},                  email),
              first_name            = ${resolved.firstName},
              last_name             = ${resolved.lastName},
              full_name             = ${resolved.fullName},
              company_name          = COALESCE(${contact.companyName ?? null},            company_name),
              company_id            = COALESCE(${companyId ?? null},                      company_id),
              location              = COALESCE(${contact.location ?? null},               location),
              icp_group             = COALESCE(${icp},                                    icp_group),
              linkedin_member_id    = COALESCE(${contact.linkedinMemberId ?? null},       linkedin_member_id),
              phone                 = COALESCE(${contact.phone ?? null},                  phone),
              enrichment_expires_at = ${expiresAt ? new Date(expiresAt) : null},
              updated_at            = NOW()
            WHERE id = ${contactId}
          `
        }

        // Log the credit spend regardless
        await db`
          INSERT INTO enrichment_log
            (workspace_id, contact_id, linkedin_url, enrichment_id, provider, status, email_credits, mobile_credits)
          VALUES
            (${job.workspaceId}, ${contactId}, ${job.linkedinUrl}, ${job.enrichmentId}, 'surfe', ${logStatus}, ${emailCredits}, ${mobileCredits})
        `
        // Cost tracking — fire-and-forget. One row per credit type spent.
        const totalCredits = emailCredits + mobileCredits
        if (totalCredits > 0) {
          void logUsage({
            workspaceId:   job.workspaceId,
            category:      "enrichment",
            provider:      "surfe",
            units:         totalCredits,
            unitCostCents: SURFE_CENTS_PER_CREDIT,
            metadata:      { emailCredits, mobileCredits, status: logStatus, enrichmentId: job.enrichmentId },
          })
        }

        console.log(`[enrichment] (no-CRM) ${job.enrichmentId} → ${logStatus} for ${job.linkedinUrl}`)
        await removePending(job.enrichmentId)
        processed++
        continue
      }

      // ── CRM path (HubSpot today) ─────────────────────────────────────────
      let contactId: string

      if (crmProvider === "hubspot") {
        await adapter.updateContact(job.crmRecordId, contact)
        contactId = job.crmRecordId
      } else {
        let found: string | null = null
        if (contact.email) found = await adapter.findContactByEmail(contact.email)
        if (!found) found = await adapter.findContactByLinkedin(job.linkedinUrl)

        if (found) {
          await adapter.updateContact(found, contact)
          contactId = found
        } else {
          contactId = await adapter.createContact(contact)
        }

        await adapter.linkEnrichment(job.crmRecordId, contactId, contact)
      }

      const pgContactId = await safeUpsertContact(job.workspaceId, crmProvider, contactId, {
        email:            contact.email,
        linkedinUrl:      contact.linkedinUrl,
        linkedinMemberId: contact.linkedinMemberId,
        firstName:        contact.firstName,
        lastName:         contact.lastName,
        fullName:         contact.fullName,
        jobTitle:         contact.jobTitle,
        companyName:      contact.companyName,
        avatarUrl:        contact.avatarUrl,
        location:         contact.location,
        phone:            contact.phone,
      })
      // Re-classify persona — fire-and-forget. Surfe rarely returns job_title
      // today, but if/when it does this keeps the persona column in sync.
      if (pgContactId) void classifyContactPersona(job.workspaceId, pgContactId)

      // Log credit usage
      if (isDbConfigured()) {
        await sql()`
          INSERT INTO enrichment_log
            (workspace_id, linkedin_url, enrichment_id, provider, status, email_credits, mobile_credits)
          VALUES
            (${job.workspaceId}, ${job.linkedinUrl}, ${job.enrichmentId}, 'surfe', 'enriched', ${emailCredits}, ${mobileCredits})
        `
      }
      // Cost tracking
      const totalCredits = emailCredits + mobileCredits
      if (totalCredits > 0) {
        void logUsage({
          workspaceId:   job.workspaceId,
          category:      "enrichment",
          provider:      "surfe",
          units:         totalCredits,
          unitCostCents: SURFE_CENTS_PER_CREDIT,
          metadata:      { emailCredits, mobileCredits, status: "enriched", enrichmentId: job.enrichmentId },
        })
      }

      console.log(`[enrichment] Completed ${job.enrichmentId} → ${crmProvider} contact ${contactId}`)
      await removePending(job.enrichmentId)
      processed++
    } catch (err) {
      console.error(`[enrichment] Failed for ${job.enrichmentId}:`, err)
      failed++
    }
  }

  return { processed, pending: stillPending, failed }
}
