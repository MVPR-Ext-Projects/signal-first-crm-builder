/**
 * Companies dedup waterfall — find or create a company row.
 *
 * Identity ranking (stop at first match):
 *   1. linkedin_url      strongest — linkedin.com/company/<slug>
 *   2. domain            normalized registrable domain
 *   3. canonical_name    last resort, only matches against rows where
 *                        BOTH linkedin_url IS NULL AND domain IS NULL
 *                        (guard prevents Acme ↔ Acme APAC over-merge)
 *   4. INSERT new row
 *
 * Backfill on match: when an existing row is found but the inbound carries
 * data the row is missing (e.g. existing has no domain, inbound has one),
 * fill the empty columns. Never overwrite. Future matches get stronger.
 *
 * Race protection: unique partial indexes on (workspace_id, linkedin_url)
 * and (workspace_id, domain) where non-NULL. Concurrent inserts resolve via
 * INSERT ... ON CONFLICT DO NOTHING + re-SELECT.
 *
 * Single entry point — every gtm-os write path that needs a company should
 * call this. No raw INSERT INTO companies anywhere else.
 */

import { sql } from "@/lib/db"
import { normalizeLinkedinCompanyUrl } from "@/lib/normalize/linkedin-url"
import { normalizeDomain } from "@/lib/normalize/domain"
import { normalizeCompanyName } from "@/lib/normalize/company-name"

export interface CompanyInbound {
  /** Full LinkedIn company URL (`https://www.linkedin.com/company/foo`) — normalized internally for match. */
  linkedinUrl?: string | null
  /** A website URL — domain extracted internally. Pass either `website` or `domain`, both fine. */
  website?: string | null
  /** A bare domain — preferred over website if both supplied. */
  domain?: string | null
  /** Display name as supplied — stored raw, normalized internally for match. */
  name?: string | null
}

export interface FindOrCreateCompanyResult {
  companyId: number
  created: boolean
}

interface CompanyRow {
  id: number
  linkedin_url: string | null
  domain: string | null
  canonical_name: string | null
}

/**
 * Find or create a company in the gtm-os projection. Returns null when no
 * identity is supplied (no linkedin, no domain, no name). Caller decides
 * what to do — typically: skip the company link.
 */
export async function findOrCreateCompany(
  workspaceId: string,
  inbound: CompanyInbound,
): Promise<FindOrCreateCompanyResult | null> {
  const linkedin = normalizeLinkedinCompanyUrl(inbound.linkedinUrl)
  const domain   = normalizeDomain(inbound.domain) ?? normalizeDomain(inbound.website)
  const canonical = normalizeCompanyName(inbound.name)
  const rawName  = (inbound.name ?? "").trim() || canonical

  if (!linkedin && !domain && !canonical) return null

  const db = sql()

  // ── Step 1: linkedin_url match ─────────────────────────────────────────
  if (linkedin) {
    const rows = await db<CompanyRow>`
      SELECT id, linkedin_url, domain, canonical_name
      FROM companies
      WHERE workspace_id = ${workspaceId}
        AND linkedin_url = ${linkedin}
      LIMIT 1
    `
    const hit = rows[0]
    if (hit) {
      await maybeBackfill(hit, { domain, canonical, rawName })
      return { companyId: hit.id, created: false }
    }
  }

  // ── Step 2: domain match ───────────────────────────────────────────────
  if (domain) {
    const rows = await db<CompanyRow>`
      SELECT id, linkedin_url, domain, canonical_name
      FROM companies
      WHERE workspace_id = ${workspaceId}
        AND domain = ${domain}
      LIMIT 2
    `
    if (rows.length === 1) {
      const hit = rows[0]
      await maybeBackfill(hit, { linkedin, canonical, rawName })
      return { companyId: hit.id, created: false }
    }
    if (rows.length > 1) {
      // Shared-domain ambiguity (holding co with multiple brands). Try to
      // narrow on canonical_name within the candidate set; otherwise fall
      // through to creating a new row.
      if (canonical) {
        const ids = rows.map(r => r.id)
        const narrowed = await db<CompanyRow>`
          SELECT id, linkedin_url, domain, canonical_name
          FROM companies
          WHERE id = ANY(${ids})
            AND canonical_name = ${canonical}
          LIMIT 1
        `
        const hit = narrowed[0]
        if (hit) {
          await maybeBackfill(hit, { linkedin, rawName })
          return { companyId: hit.id, created: false }
        }
      }
      // Still ambiguous → fall through to insert. Operators can manually
      // merge later if needed; logged for review.
      console.warn(
        `[findOrCreateCompany] shared-domain ambiguity for workspace=${workspaceId} domain=${domain} (${rows.length} candidates) — creating new`,
      )
    }
  }

  // ── Step 3: canonical_name match (guarded) ─────────────────────────────
  // Only matches against rows that have NEITHER linkedin_url NOR domain.
  // This prevents over-merging into a richly-known parent (Acme APAC
  // would NOT collapse into Acme, because Acme has a linkedin_url).
  if (canonical) {
    const rows = await db<CompanyRow>`
      SELECT id, linkedin_url, domain, canonical_name
      FROM companies
      WHERE workspace_id = ${workspaceId}
        AND canonical_name = ${canonical}
        AND linkedin_url IS NULL
        AND domain IS NULL
      LIMIT 1
    `
    const hit = rows[0]
    if (hit) {
      await maybeBackfill(hit, { linkedin, domain, rawName })
      return { companyId: hit.id, created: false }
    }
  }

  // ── Step 4: insert new row, with race protection ───────────────────────
  // ON CONFLICT DO NOTHING handles the race where two concurrent callers
  // both passed the find-not-found phase and try to insert with the same
  // linkedin_url or domain. The losing insert returns no row; we re-SELECT
  // to find the winner.
  const inserted = await db<{ id: number }>`
    INSERT INTO companies (workspace_id, linkedin_url, domain, canonical_name, raw_name)
    VALUES (${workspaceId}, ${linkedin}, ${domain}, ${canonical ?? rawName}, ${rawName})
    ON CONFLICT DO NOTHING
    RETURNING id
  `
  if (inserted[0]) {
    return { companyId: inserted[0].id, created: true }
  }

  // Lost the race — re-SELECT by whichever unique key we had.
  if (linkedin) {
    const rows = await db<CompanyRow>`
      SELECT id, linkedin_url, domain, canonical_name
      FROM companies
      WHERE workspace_id = ${workspaceId} AND linkedin_url = ${linkedin}
      LIMIT 1
    `
    if (rows[0]) return { companyId: rows[0].id, created: false }
  }
  if (domain) {
    const rows = await db<CompanyRow>`
      SELECT id, linkedin_url, domain, canonical_name
      FROM companies
      WHERE workspace_id = ${workspaceId} AND domain = ${domain}
      LIMIT 1
    `
    if (rows[0]) return { companyId: rows[0].id, created: false }
  }

  // Should not reach here. If we do, log loudly — something's off.
  console.error(
    `[findOrCreateCompany] unable to resolve company after insert race for workspace=${workspaceId}`,
  )
  return null
}

/**
 * Fill missing identity columns on an existing row from inbound data. Never
 * overwrites a non-null value. Skips entirely if the row already has every
 * column the inbound carried.
 */
async function maybeBackfill(
  existing: CompanyRow,
  inbound: { linkedin?: string | null; domain?: string | null; canonical?: string | null; rawName?: string | null },
): Promise<void> {
  const fillLinkedin  = !existing.linkedin_url   && inbound.linkedin
  const fillDomain    = !existing.domain         && inbound.domain
  const fillCanonical = !existing.canonical_name && inbound.canonical
  if (!fillLinkedin && !fillDomain && !fillCanonical) return

  const db = sql()
  await db`
    UPDATE companies
    SET    linkedin_url   = COALESCE(linkedin_url,   ${fillLinkedin  ? inbound.linkedin  : null}),
           domain         = COALESCE(domain,         ${fillDomain    ? inbound.domain    : null}),
           canonical_name = COALESCE(canonical_name, ${fillCanonical ? inbound.canonical : null}),
           updated_at     = NOW()
    WHERE  id = ${existing.id}
  `
}
