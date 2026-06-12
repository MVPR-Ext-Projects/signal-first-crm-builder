/**
 * Persona matching — picks the best-fit persona for a contact based on the
 * personas configured in WorkspaceConfig.messaging.personas.
 *
 * First match wins — workspace owners are expected to declare more specific
 * personas before broader ones. Used by the DM drafter (to inject persona
 * context into the LLM prompt), the SDR dashboard's Persona Match filter
 * (to narrow the action tab to leads that fit a known persona), and the
 * persona-classification helper that persists the matched persona name on
 * the contacts row.
 */

import type { WorkspaceConfig } from "./workspace-config"
import { getWorkspaceConfig } from "./workspace-config"
import { sql, isDbConfigured } from "./db"

export type Persona = NonNullable<NonNullable<WorkspaceConfig["messaging"]>["personas"]>[number]

/**
 * Contact context passed to pickPersona. Only the fields the matcher
 * actually inspects — kept lean so callers don't have to load extra rows.
 */
export interface ContactMatchContext {
  jobTitle:           string | null
  /** From contacts.company_employees_min — Teamfluence webhook payload. */
  companyEmployeesMin: number | null
  /** From contacts.company_employees_max. */
  companyEmployeesMax: number | null
  /** ISO-2 from contacts.company_country, e.g. "GB", "US". */
  companyCountry:      string | null
}

/**
 * A persona matches a contact when ALL of these are true (first-match-wins
 * still applies across the personas array — declare specific personas first):
 *
 *   - matchPatterns: empty array = catch-all; otherwise at least one
 *     pattern must be a case-insensitive substring of the contact's
 *     job_title. Empty job_title only matches catch-alls.
 *   - minEmployees / maxEmployees: when set, the contact's company-size
 *     range must fall inside [minEmployees, maxEmployees]. STRICT — when
 *     a persona requires size and the contact has no size data, no match.
 *   - matchCountries: when non-empty, the contact's company_country must
 *     be one of the listed ISO codes. STRICT — missing country fails.
 *
 * Personas used to also support narrowing by Teamfluence's icp_group; that
 * was dropped (the legacy matchIcpGroups field on WorkspaceConfig is
 * intentionally ignored here).
 */
export function pickPersona(
  jobTitle: string | null,
  _icpGroup: string | null,
  personas: Persona[] | undefined,
  ctx?: Partial<Omit<ContactMatchContext, "jobTitle">>,
): Persona | null {
  if (!personas || personas.length === 0) return null
  const lcJob = (jobTitle ?? "").toLowerCase()
  const empMin = ctx?.companyEmployeesMin ?? null
  const empMax = ctx?.companyEmployeesMax ?? null
  const country = (ctx?.companyCountry ?? "").toUpperCase()

  for (const p of personas) {
    // 1. Job title — empty matchPatterns is a catch-all
    const titleMatch =
      !p.matchPatterns || p.matchPatterns.length === 0
        ? true
        : (lcJob && p.matchPatterns.some(pat => pat && lcJob.includes(pat.toLowerCase())))
    if (!titleMatch) continue

    // 2. Company size band — STRICT
    if (p.minEmployees != null) {
      // Need at least one size signal. Use min (more conservative) when present.
      const cMin = empMin ?? empMax
      if (cMin == null || cMin < p.minEmployees) continue
    }
    if (p.maxEmployees != null) {
      const cMax = empMax ?? empMin
      if (cMax == null || cMax > p.maxEmployees) continue
    }

    // 3. Country allow-list — STRICT
    if (p.matchCountries && p.matchCountries.length > 0) {
      const allowed = p.matchCountries.map(c => c.trim().toUpperCase()).filter(Boolean)
      if (!country || !allowed.includes(country)) continue
    }

    return p
  }
  return null
}

// ─── Persistence helpers ─────────────────────────────────────────────────────

/**
 * Set or clear the persona name on a single contact. Fire-and-forget — never
 * throws (cost-tracking style); errors are logged. Pass `null` to clear.
 */
export async function setContactPersona(contactId: number, personaName: string | null): Promise<void> {
  if (!isDbConfigured()) return
  try {
    const db = sql()
    await db`UPDATE contacts SET persona = ${personaName} WHERE id = ${contactId}`
  } catch (err) {
    console.warn(`[persona] setContactPersona ${contactId} failed:`, err)
  }
}

/**
 * Run pickPersona against a contact and persist the result. Looks up the
 * workspace's personas + the contact's job_title fresh from storage so the
 * caller doesn't have to wire either through.
 *
 * Best-effort — never throws; errors are logged. Safe to call after every
 * contact upsert.
 */
export async function classifyContactPersona(workspaceId: string, contactId: number): Promise<void> {
  if (!isDbConfigured()) return
  try {
    const config = await getWorkspaceConfig(workspaceId)
    const personas = config?.messaging?.personas
    if (!personas || personas.length === 0) {
      // No personas configured → make sure any stale value is cleared.
      await setContactPersona(contactId, null)
      return
    }
    const db = sql()
    const rows = await db`
      SELECT job_title, icp_group, company_employees_min, company_employees_max, company_country
      FROM contacts WHERE id = ${contactId} LIMIT 1
    `
    const r = rows[0] as {
      job_title:             string | null
      icp_group:             string | null
      company_employees_min: number | null
      company_employees_max: number | null
      company_country:       string | null
    } | undefined
    if (!r) return
    const matched = pickPersona(r.job_title, r.icp_group, personas, {
      companyEmployeesMin: r.company_employees_min,
      companyEmployeesMax: r.company_employees_max,
      companyCountry:      r.company_country,
    })
    await setContactPersona(contactId, matched?.name?.trim() || null)
  } catch (err) {
    console.warn(`[persona] classifyContactPersona ${workspaceId}/${contactId} failed:`, err)
  }
}

/**
 * Re-classify every contact in a workspace. Used after a workspace edits its
 * personas list — old persona values may now be stale. Single SQL pass per
 * persona using a CASE expression so it's O(1) round-trips.
 *
 * Returns the number of contacts updated.
 */
export async function reclassifyAllContacts(workspaceId: string): Promise<number> {
  if (!isDbConfigured()) return 0
  const config = await getWorkspaceConfig(workspaceId)
  const personas = config?.messaging?.personas ?? []
  const db = sql()

  if (personas.length === 0) {
    // No personas — just clear any prior values.
    const out = await db`
      UPDATE contacts SET persona = NULL
      WHERE workspace_id = ${workspaceId} AND persona IS NOT NULL
      RETURNING id
    `
    return out.length
  }

  // Pull all contacts for the workspace with the columns the matcher uses.
  const rows = await db`
    SELECT id, persona, job_title, icp_group, company_employees_min, company_employees_max, company_country
    FROM contacts WHERE workspace_id = ${workspaceId}
  ` as Array<{
    id:                   number
    persona:              string | null
    job_title:            string | null
    icp_group:            string | null
    company_employees_min: number | null
    company_employees_max: number | null
    company_country:       string | null
  }>

  // Group contact ids by the persona they should land on. One UPDATE per
  // group instead of one UPDATE per contact — so 1380 contacts collapse
  // into ~N+1 SQL round-trips (where N = number of personas) regardless of
  // workspace size. The IS DISTINCT FROM check stays on each statement so
  // we still skip rows that already have the right value.
  const byTarget = new Map<string | null, { ids: number[]; touched: boolean }>()
  for (const r of rows) {
    const matched = pickPersona(r.job_title, r.icp_group, personas, {
      companyEmployeesMin: r.company_employees_min,
      companyEmployeesMax: r.company_employees_max,
      companyCountry:      r.company_country,
    })
    const next = matched?.name?.trim() || null
    if ((r.persona ?? null) === next) continue   // skip no-op rows entirely
    const bucket = byTarget.get(next) ?? { ids: [], touched: true }
    bucket.ids.push(r.id)
    byTarget.set(next, bucket)
  }

  let updated = 0
  for (const [target, { ids }] of byTarget) {
    if (ids.length === 0) continue
    const out = await db`
      UPDATE contacts SET persona = ${target}
      WHERE id = ANY(${ids}::bigint[])
        AND persona IS DISTINCT FROM ${target}
      RETURNING id
    `
    updated += out.length
  }
  return updated
}
