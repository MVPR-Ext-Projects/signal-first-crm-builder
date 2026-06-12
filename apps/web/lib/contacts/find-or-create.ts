/**
 * People dedup waterfall — find an existing contact by identity keys.
 *
 * Phase 1 of the gtm-os dedup work exposes the *lookup* half of the waterfall.
 * Phase 2 wires the existing webhook write paths to call this before deciding
 * whether to UPDATE an existing contact or INSERT a new one.
 *
 * Identity ranking (stop at first match):
 *   1. LinkedIn URL match (normalize both sides)
 *   2. Email match — skipped when the email is in the personal-provider
 *      blocklist (gmail, yahoo, etc.)
 *   3. Name + company website match — website is either supplied or derived
 *      from a corporate-email domain; matches on contacts where the same
 *      person + same company website are already known
 *   4. Name + company name match — fallback when no website is available
 *
 * Step 3 and 4 use fuzzy name matching (Tom Lawrence ↔ Thomas Lawrence,
 * T. Lawrence ↔ Tom Lawrence, etc.). Tom accepted some false-merge risk
 * to catch real duplicates.
 *
 * Returns null when no existing contact matches — the caller creates a new
 * row. The caller also handles the actual contact INSERT/UPDATE; this
 * module is the dedup arbiter only.
 */

import { sql } from "@/lib/db"
import { normalizeLinkedinProfileUrl } from "@/lib/normalize/linkedin-url"
import { normalizeDomain, emailDomain } from "@/lib/normalize/domain"
import { normalizeCompanyName } from "@/lib/normalize/company-name"
import { fuzzyNameMatch } from "@/lib/normalize/person-name"
import { isPersonalEmail } from "@/lib/email/personal-providers"

export interface ContactIdentity {
  /** Full LinkedIn profile URL — normalized internally for match. */
  linkedinUrl?: string | null
  /** Email — skipped as a match key if it's a personal-provider domain. */
  email?: string | null
  /** Used for steps 3 and 4 with fuzzy matching. */
  firstName?: string | null
  lastName?: string | null
  fullName?: string | null
  /** Used for step 3 (and step 3's email-derived sub-case). */
  companyWebsite?: string | null
  /** Used for step 4 fallback. */
  companyName?: string | null
}

export type ContactMatchSource =
  | "linkedin_url"
  | "email"
  | "name+website"
  | "name+company"

export interface FindContactResult {
  contactId: number
  matchedVia: ContactMatchSource
}

interface ContactCandidateRow {
  id: number
  full_name: string | null
  first_name: string | null
  last_name: string | null
  company_website: string | null
  company_domain: string | null
  company_name: string | null
}

function nameForMatch(inbound: ContactIdentity): string | null {
  if (inbound.fullName?.trim()) return inbound.fullName
  const fn = inbound.firstName?.trim()
  const ln = inbound.lastName?.trim()
  if (fn && ln) return `${fn} ${ln}`
  return null
}

function rowName(row: ContactCandidateRow): string | null {
  if (row.full_name?.trim()) return row.full_name
  if (row.first_name && row.last_name) return `${row.first_name} ${row.last_name}`
  return null
}

/**
 * Run the People waterfall against the gtm-os projection. Returns the matched
 * contact_id + which step matched, or null when no existing contact qualifies.
 *
 * The caller is responsible for INSERTing a new contact when this returns null.
 */
export async function findContactByIdentity(
  workspaceId: string,
  inbound: ContactIdentity,
): Promise<FindContactResult | null> {
  const db = sql()

  // ── Step 1: LinkedIn URL match (normalized both sides) ─────────────────
  const linkedinNormalized = normalizeLinkedinProfileUrl(inbound.linkedinUrl)
  if (linkedinNormalized) {
    // Match against any stored value that normalizes to the same form. We
    // can't do a full normalization in pure SQL, but most stored values are
    // already close-to-normalized — strip protocol, www, trailing slash on
    // the SQL side and compare.
    const rows = await db<{ id: number }>`
      SELECT id
      FROM contacts
      WHERE workspace_id = ${workspaceId}
        AND linkedin_url IS NOT NULL
        AND lower(
              regexp_replace(
                regexp_replace(linkedin_url, '^https?://(www\\.)?', ''),
                '/+$', ''
              )
            ) = ${linkedinNormalized}
      LIMIT 1
    `
    if (rows[0]) {
      return { contactId: rows[0].id, matchedVia: "linkedin_url" }
    }
  }

  // ── Step 2: Email match (skip personal-provider domains) ───────────────
  const email = inbound.email?.trim().toLowerCase()
  if (email && !isPersonalEmail(email)) {
    const rows = await db<{ id: number }>`
      SELECT id
      FROM contacts
      WHERE workspace_id = ${workspaceId}
        AND lower(email) = ${email}
      LIMIT 1
    `
    if (rows[0]) {
      return { contactId: rows[0].id, matchedVia: "email" }
    }
  }

  // Steps 3 and 4 need a name to compare on. If we have neither LinkedIn nor
  // email match AND we don't have a name, no further dedup is possible.
  const inboundName = nameForMatch(inbound)
  if (!inboundName) return null

  // ── Step 3: name + company website match ───────────────────────────────
  // Website source: directly supplied, OR derived from a corporate-email
  // domain. Personal-email domains don't count (per Principle 3).
  const directWebsite = normalizeDomain(inbound.companyWebsite)
  const derivedWebsite =
    email && !isPersonalEmail(email) ? emailDomain(email) : null
  const websiteForMatch = directWebsite ?? derivedWebsite

  if (websiteForMatch) {
    // Pull candidates that share the website and have any name on the row.
    // Then apply fuzzy match in JS — Postgres doesn't natively know about
    // diminutives.
    const candidates = await db<ContactCandidateRow>`
      SELECT id, full_name, first_name, last_name, company_website, company_domain, company_name
      FROM contacts
      WHERE workspace_id = ${workspaceId}
        AND (
          lower(
            regexp_replace(
              regexp_replace(coalesce(company_website, ''), '^https?://(www\\.)?', ''),
              '/+$', ''
            )
          ) = ${websiteForMatch}
          OR lower(coalesce(company_domain, '')) = ${websiteForMatch}
        )
      LIMIT 50
    `
    const hit = candidates.find(c => fuzzyNameMatch(rowName(c), inboundName))
    if (hit) {
      return { contactId: hit.id, matchedVia: "name+website" }
    }
  }

  // ── Step 4: name + company name match (fallback) ───────────────────────
  const inboundCompany = normalizeCompanyName(inbound.companyName)
  if (inboundCompany) {
    // Same pattern: pull candidates by canonical company name match in SQL,
    // then fuzzy-match the person name in JS.
    const candidates = await db<ContactCandidateRow>`
      SELECT id, full_name, first_name, last_name, company_website, company_domain, company_name
      FROM contacts
      WHERE workspace_id = ${workspaceId}
        AND lower(trim(coalesce(company_name, ''))) = ${(inbound.companyName ?? "").toLowerCase().trim()}
      LIMIT 50
    `
    const hit = candidates.find(c => fuzzyNameMatch(rowName(c), inboundName))
    if (hit) {
      return { contactId: hit.id, matchedVia: "name+company" }
    }
  }

  return null
}
