/**
 * Read helpers for the usage_log table — used by the dashboard cost pills
 * and the per-workspace costs page.
 *
 * Writes go through lib/usage-log.ts; this file is read-only.
 */

import { sql, isDbConfigured } from "./index"

export interface ProviderTotal {
  provider:        string
  /** Sum of `units` across all events for the period. */
  units:           number
  /** Sum of `total_cost_cents`. */
  cents:           number
  /** Number of usage_log rows. */
  events:          number
}

export interface UsageBreakdown {
  byProvider: ProviderTotal[]
  totalCents: number
}

/**
 * Per-provider totals for a workspace within a [since, until) window.
 * Returns an empty breakdown when the DB isn't configured or there are no rows.
 */
export async function getUsageBreakdown(
  workspaceId: string,
  since: Date,
  until: Date | null = null,
): Promise<UsageBreakdown> {
  if (!isDbConfigured()) return { byProvider: [], totalCents: 0 }
  const db = sql()
  const rows = until
    ? await db`
        SELECT provider,
               SUM(units)::numeric            AS units,
               SUM(total_cost_cents)::numeric AS cents,
               COUNT(*)::int                  AS events
        FROM usage_log
        WHERE workspace_id = ${workspaceId}
          AND occurred_at >= ${since.toISOString()}
          AND occurred_at <  ${until.toISOString()}
        GROUP BY provider
        ORDER BY cents DESC
      `
    : await db`
        SELECT provider,
               SUM(units)::numeric            AS units,
               SUM(total_cost_cents)::numeric AS cents,
               COUNT(*)::int                  AS events
        FROM usage_log
        WHERE workspace_id = ${workspaceId}
          AND occurred_at >= ${since.toISOString()}
        GROUP BY provider
        ORDER BY cents DESC
      `

  const byProvider = (rows as unknown as Array<{ provider: string; units: string | number; cents: string | number; events: number }>).map(r => ({
    provider: r.provider,
    units:    Number(r.units),
    cents:    Number(r.cents),
    events:   r.events,
  }))
  const totalCents = byProvider.reduce((s, p) => s + p.cents, 0)
  return { byProvider, totalCents }
}

/** Start of the current UTC month — used as the default "MTD" window. */
export function startOfThisMonth(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

/** [start, end) for the previous full UTC month. */
export function previousMonthWindow(): { start: Date; end: Date } {
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const end   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(),     1))
  return { start, end }
}

export interface EnrichmentLogRow {
  linkedinUrl:  string | null
  fullName:     string | null
  status:       string
  emailCredits: number
  mobileCredits: number
  occurredAt:   string
}

/**
 * Most recent enrichment attempts for a workspace, joined to contacts for
 * the profile name. Capped at 50 rows.
 */
export async function getEnrichmentLog(
  workspaceId: string,
  limit = 50,
): Promise<EnrichmentLogRow[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const rows = await db`
    SELECT
      e.linkedin_url   AS "linkedinUrl",
      c.full_name      AS "fullName",
      e.status,
      e.email_credits  AS "emailCredits",
      e.mobile_credits AS "mobileCredits",
      e.occurred_at    AS "occurredAt"
    FROM enrichment_log e
    LEFT JOIN contacts c ON c.id = e.contact_id
    WHERE e.workspace_id = ${workspaceId}
    ORDER BY e.occurred_at DESC
    LIMIT ${limit}
  `
  return (rows as unknown as EnrichmentLogRow[]).map(r => ({
    linkedinUrl:   r.linkedinUrl,
    fullName:      r.fullName,
    status:        r.status,
    emailCredits:  Number(r.emailCredits),
    mobileCredits: Number(r.mobileCredits),
    occurredAt:    typeof r.occurredAt === "string" ? r.occurredAt : new Date(r.occurredAt as unknown as string).toISOString(),
  }))
}

/**
 * Cross-workspace per-workspace totals for the given period. Used by an
 * admin tracker view (not the per-workspace dashboard).
 */
export async function getWorkspaceTotals(
  since: Date,
  until: Date | null = null,
): Promise<Array<{ workspaceId: string; cents: number; events: number }>> {
  if (!isDbConfigured()) return []
  const db = sql()
  const rows = until
    ? await db`
        SELECT workspace_id,
               SUM(total_cost_cents)::numeric AS cents,
               COUNT(*)::int                  AS events
        FROM usage_log
        WHERE occurred_at >= ${since.toISOString()}
          AND occurred_at <  ${until.toISOString()}
        GROUP BY workspace_id
        ORDER BY cents DESC
      `
    : await db`
        SELECT workspace_id,
               SUM(total_cost_cents)::numeric AS cents,
               COUNT(*)::int                  AS events
        FROM usage_log
        WHERE occurred_at >= ${since.toISOString()}
        GROUP BY workspace_id
        ORDER BY cents DESC
      `
  return (rows as unknown as Array<{ workspace_id: string; cents: string | number; events: number }>).map(r => ({
    workspaceId: r.workspace_id,
    cents:       Number(r.cents),
    events:      r.events,
  }))
}
