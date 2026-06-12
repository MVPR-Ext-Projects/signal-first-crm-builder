/**
 * Contact store — reads and writes to the Postgres contacts/signals projection.
 *
 * This is the authoritative store for computed fields (signal_score, funnel_stage).
 * The configured CRM (HubSpot) is the system of record for everything else.
 * The adapters sync computed fields back to the CRM after every write here.
 */

import { sql, isDbConfigured } from "./index"
export { isDbConfigured } from "./index"
import { getWorkspaceConfig, resolveVerbWeight, resolveThresholds } from "../workspace-config"
import { fetchMozMetrics, normaliseDomain } from "../moz"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ContactUpsertData {
  crmUrl?: string
  email?: string
  linkedinUrl?: string
  /** LinkedIn URN ("ACoAAA..."). Stable id - the slug part of linkedin_url is vanity and can change; this can't. Sourced from Unipile + enrichment webhooks that surface it. */
  linkedinMemberId?: string
  firstName?: string
  lastName?: string
  fullName?: string
  jobTitle?: string
  companyName?: string
  /** linkedin.com/company/<slug> — captured from TF webhook payloads. Used by the Companies tab to trigger Apify enrichment. */
  companyLinkedinUrl?: string
  /** x.com/<handle> — sourced from the CRM record or downstream enrichment. Powers the per-contact X-following scrape. */
  twitterUrl?: string
  avatarUrl?: string
  location?: string
  // Company-level metadata captured from TF webhook payloads
  companyIndustries?: string[]
  companyEmployeesMin?: number
  companyEmployeesMax?: number
  companyCountry?: string
  companyType?: string
  // ICP group classification (e.g. "Issuer", "Liquidity Provider")
  icpGroup?: string
  linkedinFollowersCount?: number
  linkedinConnectionsCount?: number
  // Phase 0 of the dedup work — captured from webhook payloads (Teamfluence
  // company.domain / company.website, Dripify companyWebsite). Used by the
  // Companies waterfall to look up by domain.
  companyDomain?: string
  companyWebsite?: string
  // FK to the gtm-os internal companies table. Populated from the result of
  // findOrCreateCompany. Distinct from the legacy `companyId` column used by
  // Surfe / CRM enrichment paths.
  gtmCompanyId?: number
  // Contact-level enrichment fields
  /** Phone number (mobile preferred). Populated by Surfe enrichment. */
  phone?: string
  /** Self-reported LinkedIn industry (from Dripify). Distinct from company_industries. */
  contactIndustry?: string
  /** LinkedIn Premium subscription flag (from Dripify). */
  linkedinPremium?: boolean
  // Extended company-level fields
  /** Company page follower count (from TF company.followers / Dripify numberOfCompanyFollowers). */
  companyFollowersCount?: number
  /** Company specialty tags (from TF company.specialties). */
  companySpecialties?: string[]
  /** Company HQ city/location (from TF company.headquarters or company.location). */
  companyHeadquarters?: string
  /** Year the company was founded (from TF company.founded_year). */
  companyFoundedYear?: number
  /** TRUE once confirmed 1st-degree LinkedIn connection. NULL = unknown; FALSE = not connected. */
  linkedinConnected?: boolean
}

export interface SignalUpsertData {
  crmSignalId?: string
  sourceType?: string
  engagementUrl?: string
  description?: string
  signalVerb?: string
  signalActor?: string
  signalObject?: string
  verbDescription?: string
  scoreDelta: number
  occurredAt?: Date
}

export interface RecentSignal {
  id: number | null
  sourceType: string | null
  engagementUrl: string | null
  description: string | null
  occurredAt: string | null
  signalVerb: string | null
  signalActor: string | null
  signalObject: string | null
  verbDescription: string | null
  scoreDelta: number
}

export interface LeadRow {
  id: number
  crmProvider: string
  crmContactId: string
  crmUrl: string | null
  email: string | null
  linkedinUrl: string | null
  twitterUrl: string | null
  fullName: string | null
  jobTitle: string | null
  companyName: string | null
  icpGroup: string | null
  /** Effective persona — COALESCE(manual_persona, persona). What the row displays. */
  persona: string | null
  /** Auto-classified persona from job-title rules. May differ from persona when overridden. */
  autoPersona: string | null
  /** Manual override set via the row's persona pill. NULL when the user hasn't overridden. */
  manualPersona: string | null
  signalScore: number
  signalCount: number
  /** Auto-derived from signal_score (Prospect / Signal Found / Engaged / High Signal). */
  funnelStage: string
  /** Manual override (e.g. "Discovery Call"). Takes precedence over funnelStage when set. */
  manualStage: string | null
  /** COALESCE(manualStage, funnelStage) — what the dashboard should display. */
  effectiveStage: string
  /** Timestamp of the contact's most recent signal. Drives the default "recent first" sort. */
  lastSignalAt: string | Date | null
  /** Team Filters: explicit per-contact assignment (null when only rules apply). */
  assignedTeamMemberId: string | null
  /**
   * Status of the most recent Surfe enrichment attempt, or null if never
   * tried. "enriched" / "no_match" / "internal_purged". Surfaced on the
   * For-enrichment tab so users can see which contacts actually got
   * looked up but came back empty (vs. ones that haven't been tried).
   */
  lastEnrichmentStatus: string | null
  /** When the most recent Surfe enrichment ran, or null if never tried. */
  lastEnrichmentAt: string | Date | null
  recentSignals: RecentSignal[]
  /** Recent notes (Task #12 — notes live in their own table, not signals). */
  recentNotes: NoteRow[]
  /**
   * Do-Not-Contact decay timestamp (Task #17). NULL when the contact
   * isn't flagged. When non-NULL and in the future, outbound campaigns
   * skip the contact; when in the past, the marker is decayed and the
   * UI treats it as inactive.
   */
  doNotContactUntil: string | Date | null
  /**
   * Authoritative LinkedIn connection flag. TRUE = confirmed connected
   * (either by signal sweep or manual override). FALSE = explicitly not
   * connected. NULL = derive from recent signal window (legacy behaviour).
   */
  linkedinConnected: boolean | null
}

/**
 * SDR dashboard sort modes.
 *   - "recent-desc" — newest signal first (default). Surfaces hot leads.
 *   - "recent-asc"  — oldest signal first. Useful for digging into stale leads.
 *   - "score-desc"  — highest score first. Surfaces accumulated engagement.
 *   - "score-asc"   — lowest score first. Useful for digging into long-tail.
 *
 * Legacy "recent" is treated as "recent-desc" by URL parsing for back-compat.
 */
export type SortMode = "recent-desc" | "recent-asc" | "score-desc" | "score-asc" | "score-then-recent" | "recent-then-score"

export const SIZE_BUCKETS = [
  { label: "1–10",    min: 1,    max: 10   },
  { label: "11–50",   min: 11,   max: 50   },
  { label: "51–200",  min: 51,   max: 200  },
  { label: "201–500", min: 201,  max: 500  },
  { label: "501–1k",  min: 501,  max: 1000 },
  { label: "1k+",     min: 1001, max: null },
] as const
export type SizeBucketLabel = (typeof SIZE_BUCKETS)[number]["label"]

/**
 * Server-side shape of a Team Filter query parameter. Filters contacts to
 * those at companies manually assigned to a specific team member.
 * Assignment lives on `company_tags.assigned_team_member_id`; pass the
 * member id from WorkspaceConfig.teamMembers.
 *
 * No filter (the page-level "All SDRs") = pass undefined; don't construct
 * an empty TeamFilter.
 */
export interface TeamFilter {
  /** The team member's id; matched against company_tags.assigned_team_member_id. */
  assignedTo: string
}

/**
 * Build a SQL fragment that returns true when a contact's company is
 * assigned to the supplied team member. Used inline in WHERE clauses
 * across getLeads / countLeads / etc.
 *
 * The fragment is parameter-free string concatenation, so it MUST only be
 * called with server-controlled inputs (workspace config + URL-validated
 * member ids). Never feed raw user input here.
 *
 * Queries that use this clause already LEFT JOIN company_tags AS t —
 * unassigned companies have no row (or NULL assigned_team_member_id),
 * which fails the equality and so they're correctly excluded from a
 * filtered view. Returns "TRUE" when no filter is supplied.
 */
function teamFilterClause(filter: TeamFilter | undefined): string {
  if (!filter) return "TRUE"
  return `t.assigned_team_member_id = ${literal(filter.assignedTo)}`
}

/**
 * Escape a string for safe inline embedding in SQL. Only used inside
 * teamFilterClause where parameter binding isn't available because the
 * fragment must compose into existing tagged-template queries.
 */
function literal(s: string): string {
  return "'" + String(s).replace(/'/g, "''") + "'"
}

/**
 * Flatten and dedupe a JSON-array-of-arrays of industry strings, capped at
 * 6 unique values. The Companies query uses jsonb_agg over the per-contact
 * company_industries because direct array_agg over text[] errors when the
 * contained arrays have different lengths (2202E "cannot accumulate arrays
 * of different dimensionality").
 */
function flattenIndustries(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const arr of raw) {
    if (!Array.isArray(arr)) continue
    for (const v of arr) {
      if (typeof v !== "string") continue
      if (seen.has(v)) continue
      seen.add(v)
      out.push(v)
      if (out.length >= 6) return out
    }
  }
  return out
}

// ─── Merge duplicates ────────────────────────────────────────────────────────

/**
 * Merge `sourceIds` into `targetId` within a single workspace. Reparents
 * signals / notes / outreach_log / linkedin_send_failures
 * onto the target, hands over linkedin_interests / x_interests when the
 * target doesn't already have one (UNIQUE constraint blocks otherwise),
 * deletes the source contact rows, and recomputes signal_score /
 * signal_count / last_signal_at on the target. Mirrors the logic in
 * scripts/dedup-mvpr-contacts.mjs.
 *
 * All source ids must belong to the same workspaceId as the target.
 * Returns the count of merged rows.
 */
export async function mergeContacts(
  workspaceId: string,
  targetId: number,
  sourceIds: number[],
): Promise<{ merged: number }> {
  if (!isDbConfigured()) throw new Error("Database not configured")
  if (sourceIds.length === 0) return { merged: 0 }
  if (sourceIds.includes(targetId)) throw new Error("Target id cannot be a source")

  const db = sql()
  // Verify both target and sources live in this workspace before touching anything.
  const [target] = await db<{ id: number }>`
    SELECT id FROM contacts WHERE workspace_id = ${workspaceId} AND id = ${targetId}
  `
  if (!target) throw new Error(`Target contact ${targetId} not found in workspace`)
  const sourceRows = await db<{ id: number }>`
    SELECT id FROM contacts WHERE workspace_id = ${workspaceId} AND id = ANY(${sourceIds}::bigint[])
  `
  if (sourceRows.length !== sourceIds.length) {
    throw new Error(`Some source contacts not in workspace; expected ${sourceIds.length}, found ${sourceRows.length}`)
  }

  let merged = 0
  for (const dupId of sourceIds) {
    await db`UPDATE signals               SET contact_id = ${targetId} WHERE contact_id = ${dupId}`
    await db`UPDATE notes                 SET contact_id = ${targetId} WHERE contact_id = ${dupId}`
    await db`UPDATE outreach_log          SET contact_id = ${targetId} WHERE contact_id = ${dupId}`
    await db`UPDATE linkedin_send_failures SET contact_id = ${targetId} WHERE contact_id = ${dupId}`
    // UNIQUE (workspace_id, contact_id) on these tables - reparent only
    // when the target doesn't already have its own row; the duplicate
    // gets deleted via CASCADE when the contact row is removed.
    await db`
      UPDATE linkedin_interests SET contact_id = ${targetId}
      WHERE contact_id = ${dupId}
        AND NOT EXISTS (SELECT 1 FROM linkedin_interests WHERE contact_id = ${targetId})
    `
    await db`
      UPDATE x_interests SET contact_id = ${targetId}
      WHERE contact_id = ${dupId}
        AND NOT EXISTS (SELECT 1 FROM x_interests WHERE contact_id = ${targetId})
    `
    await db`DELETE FROM contacts WHERE id = ${dupId} AND workspace_id = ${workspaceId}`
    merged++
  }
  // Recompute aggregates on the target from the union of all merged signals.
  await db`
    UPDATE contacts c
    SET    signal_score = COALESCE((SELECT SUM(score_delta) FROM signals WHERE contact_id = ${targetId}), 0),
           signal_count = COALESCE((SELECT COUNT(*)         FROM signals WHERE contact_id = ${targetId}), 0),
           last_signal_at = (SELECT MAX(occurred_at)        FROM signals WHERE contact_id = ${targetId}),
           updated_at = NOW()
    WHERE  c.id = ${targetId}
  `
  return { merged }
}

// ─── Funnel stage ─────────────────────────────────────────────────────────────

/**
 * People thresholds — tighter than companies because a single person rarely
 * accumulates many signals. Aligned with workspace-config.ts resolveThresholds.
 *   Prospect       0-2
 *   Signal Found   3-5
 *   Engaged        6-25
 *   High Signal    26+
 */
function deriveFunnelStage(score: number): string {
  if (score >= 26) return "High Signal"
  if (score >= 6)  return "Engaged"
  if (score >= 3)  return "Signal Found"
  return "Prospect"
}

/**
 * Company thresholds — looser than people because aggregated company scores
 * pile up faster (multiple contacts contributing). Aligned with
 * workspace-config.ts resolveCompanyThresholds.
 *   Prospect       0-4
 *   Signal Found   5-19
 *   Engaged        20-49
 *   High Signal    50+
 */
export function deriveCompanyStage(score: number): string {
  if (score >= 50) return "High Signal"
  if (score >= 20) return "Engaged"
  if (score >= 5)  return "Signal Found"
  return "Prospect"
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/**
 * Insert or update a contact row.
 * Existing fields are only overwritten when the incoming value is non-null —
 * so a partial update (e.g. from enrichment) won't clear fields set earlier.
 *
 * Returns the internal contact id.
 */
export async function upsertContact(
  workspaceId: string,
  crmProvider: string,
  crmContactId: string,
  data: ContactUpsertData,
): Promise<number> {
  const db = sql()
  const rows = await db`
    INSERT INTO contacts (
      workspace_id, crm_provider, crm_contact_id,
      crm_url, email, linkedin_url, linkedin_member_id,
      first_name, last_name, full_name,
      job_title, company_name, company_linkedin_url, twitter_url, avatar_url, location,
      company_industries, company_employees_min, company_employees_max,
      company_country, company_type, icp_group,
      linkedin_followers_count, linkedin_connections_count,
      company_domain, company_website, gtm_company_id,
      phone, contact_industry, linkedin_premium,
      company_followers_count, company_specialties, company_headquarters, company_founded_year,
      linkedin_connected,
      updated_at
    ) VALUES (
      ${workspaceId}, ${crmProvider}, ${crmContactId},
      ${data.crmUrl ?? null}, ${data.email ?? null}, ${data.linkedinUrl ?? null}, ${data.linkedinMemberId ?? null},
      ${data.firstName ?? null}, ${data.lastName ?? null}, ${data.fullName ?? null},
      ${data.jobTitle ?? null}, ${data.companyName ?? null}, ${data.companyLinkedinUrl ?? null}, ${data.twitterUrl ?? null}, ${data.avatarUrl ?? null}, ${data.location ?? null},
      ${data.companyIndustries ?? null}, ${data.companyEmployeesMin ?? null}, ${data.companyEmployeesMax ?? null},
      ${data.companyCountry ?? null}, ${data.companyType ?? null}, ${data.icpGroup ?? null},
      ${data.linkedinFollowersCount ?? null}, ${data.linkedinConnectionsCount ?? null},
      ${data.companyDomain ?? null}, ${data.companyWebsite ?? null}, ${data.gtmCompanyId ?? null},
      ${data.phone ?? null}, ${data.contactIndustry ?? null}, ${data.linkedinPremium ?? null},
      ${data.companyFollowersCount ?? null}, ${data.companySpecialties ?? null}, ${data.companyHeadquarters ?? null}, ${data.companyFoundedYear ?? null},
      ${data.linkedinConnected ?? null},
      NOW()
    )
    ON CONFLICT (workspace_id, crm_contact_id) DO UPDATE SET
      crm_url               = COALESCE(EXCLUDED.crm_url,               contacts.crm_url),
      email                 = COALESCE(EXCLUDED.email,                 contacts.email),
      linkedin_url          = COALESCE(EXCLUDED.linkedin_url,          contacts.linkedin_url),
      linkedin_member_id    = COALESCE(EXCLUDED.linkedin_member_id,    contacts.linkedin_member_id),
      first_name            = COALESCE(EXCLUDED.first_name,            contacts.first_name),
      last_name             = COALESCE(EXCLUDED.last_name,             contacts.last_name),
      full_name             = COALESCE(EXCLUDED.full_name,             contacts.full_name),
      job_title             = COALESCE(EXCLUDED.job_title,             contacts.job_title),
      company_name          = COALESCE(EXCLUDED.company_name,          contacts.company_name),
      company_linkedin_url  = COALESCE(EXCLUDED.company_linkedin_url,  contacts.company_linkedin_url),
      twitter_url           = COALESCE(EXCLUDED.twitter_url,           contacts.twitter_url),
      avatar_url            = COALESCE(EXCLUDED.avatar_url,            contacts.avatar_url),
      location              = COALESCE(EXCLUDED.location,              contacts.location),
      company_industries    = COALESCE(EXCLUDED.company_industries,    contacts.company_industries),
      company_employees_min = COALESCE(EXCLUDED.company_employees_min, contacts.company_employees_min),
      company_employees_max = COALESCE(EXCLUDED.company_employees_max, contacts.company_employees_max),
      company_country       = COALESCE(EXCLUDED.company_country,       contacts.company_country),
      company_type          = COALESCE(EXCLUDED.company_type,          contacts.company_type),
      icp_group             = COALESCE(EXCLUDED.icp_group,             contacts.icp_group),
      linkedin_followers_count   = COALESCE(EXCLUDED.linkedin_followers_count,   contacts.linkedin_followers_count),
      linkedin_connections_count = COALESCE(EXCLUDED.linkedin_connections_count, contacts.linkedin_connections_count),
      company_domain        = COALESCE(EXCLUDED.company_domain,        contacts.company_domain),
      company_website       = COALESCE(EXCLUDED.company_website,       contacts.company_website),
      gtm_company_id        = COALESCE(EXCLUDED.gtm_company_id,        contacts.gtm_company_id),
      phone                    = COALESCE(EXCLUDED.phone,                    contacts.phone),
      contact_industry         = COALESCE(EXCLUDED.contact_industry,         contacts.contact_industry),
      linkedin_premium         = COALESCE(EXCLUDED.linkedin_premium,         contacts.linkedin_premium),
      company_followers_count  = COALESCE(EXCLUDED.company_followers_count,  contacts.company_followers_count),
      company_specialties      = COALESCE(EXCLUDED.company_specialties,      contacts.company_specialties),
      company_headquarters     = COALESCE(EXCLUDED.company_headquarters,     contacts.company_headquarters),
      company_founded_year     = COALESCE(EXCLUDED.company_founded_year,     contacts.company_founded_year),
      linkedin_connected       = COALESCE(EXCLUDED.linkedin_connected,       contacts.linkedin_connected),
      updated_at            = NOW()
    RETURNING id
  `
  return (rows[0] as { id: number }).id
}

/**
 * Update an existing contact by its internal id. Mirrors upsertContact's
 * fill-only-null semantics: non-null inbound values overwrite, null inbound
 * values keep the existing. Use this when you've found an existing contact
 * via the People dedup waterfall (matched on linkedin_url / email / fuzzy
 * name+company) and need to merge new data into it without minting a fresh
 * crm_contact_id.
 */
export async function updateContactById(
  contactId: number,
  data: ContactUpsertData,
): Promise<void> {
  const db = sql()
  await db`
    UPDATE contacts SET
      crm_url               = COALESCE(${data.crmUrl ?? null},                crm_url),
      email                 = COALESCE(${data.email ?? null},                 email),
      linkedin_url          = COALESCE(${data.linkedinUrl ?? null},           linkedin_url),
      linkedin_member_id    = COALESCE(${data.linkedinMemberId ?? null},      linkedin_member_id),
      first_name            = COALESCE(${data.firstName ?? null},             first_name),
      last_name             = COALESCE(${data.lastName ?? null},              last_name),
      full_name             = COALESCE(${data.fullName ?? null},              full_name),
      job_title             = COALESCE(${data.jobTitle ?? null},              job_title),
      company_name          = COALESCE(${data.companyName ?? null},           company_name),
      company_linkedin_url  = COALESCE(${data.companyLinkedinUrl ?? null},    company_linkedin_url),
      twitter_url           = COALESCE(${data.twitterUrl ?? null},            twitter_url),
      avatar_url            = COALESCE(${data.avatarUrl ?? null},             avatar_url),
      location              = COALESCE(${data.location ?? null},              location),
      company_industries    = COALESCE(${data.companyIndustries ?? null},     company_industries),
      company_employees_min = COALESCE(${data.companyEmployeesMin ?? null},   company_employees_min),
      company_employees_max = COALESCE(${data.companyEmployeesMax ?? null},   company_employees_max),
      company_country       = COALESCE(${data.companyCountry ?? null},        company_country),
      company_type          = COALESCE(${data.companyType ?? null},           company_type),
      icp_group             = COALESCE(${data.icpGroup ?? null},              icp_group),
      linkedin_followers_count   = COALESCE(${data.linkedinFollowersCount ?? null},   linkedin_followers_count),
      linkedin_connections_count = COALESCE(${data.linkedinConnectionsCount ?? null}, linkedin_connections_count),
      company_domain           = COALESCE(${data.companyDomain ?? null},          company_domain),
      company_website          = COALESCE(${data.companyWebsite ?? null},         company_website),
      gtm_company_id           = COALESCE(${data.gtmCompanyId ?? null},           gtm_company_id),
      phone                    = COALESCE(${data.phone ?? null},                   phone),
      contact_industry         = COALESCE(${data.contactIndustry ?? null},         contact_industry),
      linkedin_premium         = COALESCE(${data.linkedinPremium ?? null},         linkedin_premium),
      company_followers_count  = COALESCE(${data.companyFollowersCount ?? null},   company_followers_count),
      company_specialties      = COALESCE(${data.companySpecialties ?? null},      company_specialties),
      company_headquarters     = COALESCE(${data.companyHeadquarters ?? null},     company_headquarters),
      company_founded_year     = COALESCE(${data.companyFoundedYear ?? null},      company_founded_year),
      linkedin_connected       = COALESCE(${data.linkedinConnected ?? null},       linkedin_connected),
      updated_at            = NOW()
    WHERE id = ${contactId}
  `
}

const CONNECTION_VERBS = ["connected", "accepted_our_connection", "sent_connection_request"]
const FOLLOW_TEAM_VERB  = "followed_our_team_member"
const DEDUP_WINDOW_MS   = 4 * 60 * 60 * 1000  // 4 hours — TF webhook delivery can lag significantly

/**
 * When a connection signal arrives after a follow signal for the same contact
 * within the dedup window, DELETE the companion follow row(s) — the follow
 * was a LinkedIn auto-follow side-effect of the connection, not a real
 * engagement signal. Per Task #11 (master plan): row-delete replaces the
 * old score-zero behaviour so the timeline doesn't carry a misleading
 * zero-scored "Followed team member" entry next to the connection.
 *
 * Recomputes signal_score (from scratch over remaining signals) and
 * signal_count (decremented by the number of rows deleted) on the contact.
 */
async function deleteCompanionFollow(
  db: ReturnType<typeof sql>,
  workspaceId: string,
  contactId: number,
  occurredAt: Date,
  thresholds: { signalFound: number; engaged: number; highSignal: number },
): Promise<void> {
  const windowStart = new Date(occurredAt.getTime() - DEDUP_WINDOW_MS)
  const windowEnd   = new Date(occurredAt.getTime() + DEDUP_WINDOW_MS)

  const deleted = await db`
    DELETE FROM signals
    WHERE  workspace_id = ${workspaceId}
      AND  contact_id   = ${contactId}
      AND  signal_verb  = ${FOLLOW_TEAM_VERB}
      AND  occurred_at  BETWEEN ${windowStart.toISOString()} AND ${windowEnd.toISOString()}
    RETURNING id
  `
  const deletedCount = (deleted as unknown[]).length
  if (deletedCount > 0) {
    // Recompute aggregates from the surviving signals.
    await db`
      UPDATE contacts SET
        signal_score = GREATEST(0, (
          SELECT COALESCE(SUM(score_delta), 0) FROM signals
          WHERE contact_id = ${contactId}
        )),
        signal_count = (
          SELECT COUNT(*)::int FROM signals
          WHERE contact_id = ${contactId}
        ),
        funnel_stage = CASE
          WHEN (SELECT COALESCE(SUM(score_delta),0) FROM signals WHERE contact_id=${contactId}) >= ${thresholds.highSignal}  THEN 'High Signal'
          WHEN (SELECT COALESCE(SUM(score_delta),0) FROM signals WHERE contact_id=${contactId}) >= ${thresholds.engaged}     THEN 'Engaged'
          WHEN (SELECT COALESCE(SUM(score_delta),0) FROM signals WHERE contact_id=${contactId}) >= ${thresholds.signalFound} THEN 'Signal Found'
          ELSE 'Prospect'
        END,
        updated_at = NOW()
      WHERE id = ${contactId}
    `
  }
}

/**
 * Record a signal event on a contact and atomically update their score and stage.
 * Skips silently if the database is not configured.
 *
 * Follow ↔ connection collision rule (Task #11): when a LinkedIn connection
 * and a team-member follow land within ±4h for the same contact, the follow
 * is an auto-follow artifact of the connection accept, not a real engagement
 * signal. We DROP the follow:
 *   - Follow arriving after connection → skip the INSERT entirely.
 *   - Connection arriving after follow → DELETE the prior follow row(s)
 *     and recompute the contact's aggregates.
 * Either way, the timeline only shows the connection.
 */
export async function recordSignal(
  workspaceId: string,
  contactId: number,
  signal: SignalUpsertData,
): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()

  // Per-workspace stage thresholds (Prospect / Signal Found / Engaged / High
  // Signal). Read from WorkspaceConfig.scoring.thresholds; falls back to the
  // historic 3 / 6 / 26 defaults when the workspace hasn't customised them.
  // See BILLING.md and CLAUDE.md "Funnel-stage thresholds are per-workspace".
  const workspaceConfig = await getWorkspaceConfig(workspaceId)
  const thresholds = workspaceConfig
    ? resolveThresholds(workspaceConfig)
    : { signalFound: 3, engaged: 6, highSignal: 26 }

  // Clamp future-dated occurred_at to now. Some integrations (e.g. an
  // external Zapier polling job for "booked a discovery call") were
  // writing the *meeting time* into occurred_at, which then sorted to
  // the top of the engagement timeline and rendered as "just now" via
  // the negative-ms branch of fmtRelative. The intent of occurred_at
  // is "when did the signal action happen" - clamp anything in the
  // future to now so the timeline reads correctly.
  if (signal.occurredAt && signal.occurredAt.getTime() > Date.now()) {
    signal.occurredAt = new Date()
  }

  if (signal.crmSignalId) {
    const exists = await signalExistsInDb(workspaceId, contactId, signal.crmSignalId)
    if (exists) return
  }

  // Case 0 — second (or later) discovery call booking: only the first ever earns points.
  // Covers both the native signal_verb='booked_meeting' form and legacy imported signals
  // whose description matches '%booked a discovery call%'.
  let effectiveDelta = signal.scoreDelta
  const isBookedMeeting =
    signal.signalVerb === "booked_meeting" ||
    (signal.description ?? "").toLowerCase().includes("booked a discovery call")
  if (isBookedMeeting && effectiveDelta > 0) {
    const prior = await db`
      SELECT 1 FROM signals
      WHERE workspace_id = ${workspaceId}
        AND contact_id   = ${contactId}
        AND (
          signal_verb = 'booked_meeting'
          OR description ILIKE '%booked a discovery call%'
        )
        AND score_delta  > 0
      LIMIT 1
    `
    if ((prior as unknown[]).length > 0) effectiveDelta = 0
  }

  // Case 1 — follow arriving after a connection: skip the INSERT entirely.
  // LinkedIn auto-follows when a connection accepts; the follow row is an
  // artifact, not a real engagement signal. Dropping it keeps the timeline
  // clean and avoids carrying a zero-scored row.
  if (signal.signalVerb === FOLLOW_TEAM_VERB) {
    const occurredAt  = signal.occurredAt ?? new Date()
    const windowStart = new Date(occurredAt.getTime() - DEDUP_WINDOW_MS)
    const windowEnd   = new Date(occurredAt.getTime() + DEDUP_WINDOW_MS)
    const verbList    = CONNECTION_VERBS
    const existing = await db`
      SELECT 1 FROM signals
      WHERE workspace_id = ${workspaceId}
        AND contact_id   = ${contactId}
        AND signal_verb  = ANY(${verbList})
        AND occurred_at  BETWEEN ${windowStart.toISOString()} AND ${windowEnd.toISOString()}
      LIMIT 1
    `
    if ((existing as unknown[]).length > 0) return
  }

  await db`
    INSERT INTO signals (
      workspace_id, contact_id, crm_signal_id,
      source_type, engagement_url, description,
      signal_verb, signal_actor, signal_object, verb_description,
      score_delta, occurred_at
    ) VALUES (
      ${workspaceId}, ${contactId}, ${signal.crmSignalId ?? null},
      ${signal.sourceType ?? null}, ${signal.engagementUrl ?? null}, ${signal.description ?? null},
      ${signal.signalVerb ?? null}, ${signal.signalActor ?? null}, ${signal.signalObject ?? null}, ${signal.verbDescription ?? null},
      ${effectiveDelta}, ${signal.occurredAt ?? new Date()}
    )
  `

  // Update the contact score and re-derive funnel stage. funnel_stage is the
  // auto-derived value; manual_stage (when set) wins at read time via
  // COALESCE in getLeads, so we don't touch manual_stage here.
  await db`
    UPDATE contacts SET
      signal_score   = signal_score + ${effectiveDelta},
      signal_count   = signal_count + 1,
      last_signal_at = NOW(),
      funnel_stage   = CASE
        WHEN signal_score + ${effectiveDelta} >= ${thresholds.highSignal}  THEN 'High Signal'
        WHEN signal_score + ${effectiveDelta} >= ${thresholds.engaged}     THEN 'Engaged'
        WHEN signal_score + ${effectiveDelta} >= ${thresholds.signalFound} THEN 'Signal Found'
        ELSE 'Prospect'
      END,
      updated_at = NOW()
    WHERE id = ${contactId}
  `

  // Case 2 — connection arriving after a follow was already stored: DELETE
  // the prior follow row(s) and recompute the contact total.
  if (CONNECTION_VERBS.includes(signal.signalVerb ?? "")) {
    await deleteCompanionFollow(db, workspaceId, contactId, signal.occurredAt ?? new Date(), thresholds)
  }

  // Mark contact as confirmed-connected when the signal verb is an actual
  // accepted connection (not just a sent request). Skips contacts already
  // set TRUE or explicitly overridden to FALSE by the user.
  if (signal.signalVerb === "connected" || signal.signalVerb === "accepted_our_connection") {
    await db`
      UPDATE contacts SET linkedin_connected = TRUE, updated_at = NOW()
      WHERE id = ${contactId} AND (linkedin_connected IS NULL OR linkedin_connected = FALSE)
    `
  }

  if (effectiveDelta > 0) {
    const signalFound = await maybeLogCompanyTransition(db, workspaceId, contactId, effectiveDelta)
    if (signalFound?.websiteDomain) {
      autoFetchMoz(workspaceId, signalFound.websiteDomain).catch(() => undefined)
    }
  }

  // DNC release (Task #17): inbound engagement on a DNC'd contact signals
  // renewed interest, so the marker is cleared. Only fires when the verb is
  // one of the recognised inbound-engagement verbs and the contact actually
  // has an active DNC (the WHERE clause in releaseDoNotContact is a no-op
  // otherwise, but the verb check saves the round-trip).
  if (signal.signalVerb && INBOUND_ENGAGEMENT_VERBS.has(signal.signalVerb)) {
    try {
      await releaseDoNotContact(workspaceId, contactId)
    } catch (err) {
      // Best-effort - never let the DNC release block the main signal write.
      console.warn(`[recordSignal] DNC release failed for contact=${contactId}:`, err)
    }
  }

  // When a meeting is booked, link it to the most recent open outreach_log entry
  if (signal.signalVerb === "booked_meeting") {
    try {
      await db`
        UPDATE outreach_log
        SET booking_at = ${signal.occurredAt ?? new Date()}
        WHERE id = (
          SELECT id FROM outreach_log
          WHERE contact_id = ${contactId}
            AND booking_at IS NULL
            AND occurred_at <= ${signal.occurredAt ?? new Date()}
          ORDER BY occurred_at DESC
          LIMIT 1
        )
      `
    } catch {
      // best-effort — never break the main signal write
    }
  }
}

export async function updateSignalDescription(
  workspaceId: string,
  signalId: number,
  description: string,
): Promise<boolean> {
  if (!isDbConfigured()) return false
  const db = sql()
  const res = await db`
    UPDATE signals SET description = ${description}
    WHERE id = ${signalId} AND workspace_id = ${workspaceId}
  `
  return (res as unknown as { count: number }).count > 0
}

export async function deleteSignal(
  workspaceId: string,
  signalId: number,
): Promise<boolean> {
  if (!isDbConfigured()) return false
  const db = sql()
  const res = await db`
    DELETE FROM signals WHERE id = ${signalId} AND workspace_id = ${workspaceId}
  `
  return (res as unknown as { count: number }).count > 0
}

// ─── Do-Not-Contact marker (Task #17) ────────────────────────────────────────

/**
 * Verbs that count as a prospect-originated engagement signal. When one of
 * these lands on a DNC'd contact, the marker is released - the contact is
 * indicating renewed interest. Outbound verbs (sent_dm / sent_email / etc)
 * and negative verbs (email_bounced / email_complained) are deliberately
 * excluded.
 */
const INBOUND_ENGAGEMENT_VERBS = new Set([
  "liked_post",
  "commented_post",
  "viewed_profile",
  "followed_our_team_member",
  "followed_our_company",
  "accepted_our_connection",
  "connected",
  "replied_dm",
  "replied_dm_initial",
  "replied_dm_subsequent",
  "replied_email",
  "email_opened",
  "email_clicked",
  "clicked_link",
  "ai_search",
])

/** Default DNC duration. Decays after 6 months unless released earlier by inbound engagement. */
const DNC_DURATION_MS = 6 * 30 * 24 * 60 * 60 * 1000  // ~6 months

export async function setDoNotContact(
  workspaceId: string,
  contactId: number,
  args: {
    classification: string
    snippet:        string
    source:         string
    durationMs?:    number
  },
): Promise<void> {
  if (!isDbConfigured()) return
  const until = new Date(Date.now() + (args.durationMs ?? DNC_DURATION_MS))
  const db = sql()
  await db`
    UPDATE contacts SET
      do_not_contact                       = TRUE,
      do_not_contact_until                 = ${until.toISOString()},
      do_not_contact_reason_classification = ${args.classification},
      do_not_contact_reason_snippet        = ${args.snippet},
      do_not_contact_source                = ${args.source},
      updated_at                           = NOW()
    WHERE id = ${contactId} AND workspace_id = ${workspaceId}
  `
}

export async function releaseDoNotContact(
  workspaceId: string,
  contactId:   number,
): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  await db`
    UPDATE contacts SET
      do_not_contact        = FALSE,
      do_not_contact_until  = NULL,
      updated_at            = NOW()
    WHERE id = ${contactId}
      AND workspace_id = ${workspaceId}
      AND do_not_contact_until IS NOT NULL
  `
}

// ─── Corporate-email + LinkedIn-URL lifecycle (Task #18) ─────────────────────

/**
 * Confirm the corporate email on a contact after Surfe enrichment validates
 * it. Skipped when the email is in the personal-provider blocklist - we
 * only confirm corporate addresses (the freshness cron + Resend bounce
 * handler both operate on confirmed corporate emails).
 */
export async function confirmCorporateEmail(
  workspaceId: string,
  contactId:   number,
  email:       string,
): Promise<void> {
  if (!isDbConfigured()) return
  const { isPersonalEmail } = await import("../email/personal-providers")
  if (isPersonalEmail(email)) return
  const db = sql()
  await db`
    UPDATE contacts SET
      corporate_email                = ${email.toLowerCase()},
      corporate_email_status         = 'confirmed',
      corporate_email_confirmed_at   = NOW(),
      corporate_email_invalidated_at = NULL,
      updated_at                     = NOW()
    WHERE id = ${contactId} AND workspace_id = ${workspaceId}
  `
}

/**
 * Mark the corporate email as invalid - called on Resend bounce or when
 * an enrichment pass returns no email. The address is preserved on
 * corporate_email so we know what's known-bad; status flips to
 * 'not_found' and the contact gets flagged for re-enrichment.
 */
export async function invalidateCorporateEmail(
  workspaceId: string,
  contactId:   number,
  reason:      string,
): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  await db`
    UPDATE contacts SET
      corporate_email_status         = 'not_found',
      corporate_email_invalidated_at = NOW(),
      needs_enrichment               = TRUE,
      enrichment_reason              = ${reason},
      updated_at                     = NOW()
    WHERE id = ${contactId} AND workspace_id = ${workspaceId}
  `
}

/**
 * Mark a LinkedIn URL active on the contact - called when an outbound DM
 * sends cleanly or when we receive an inbound reply (either confirms the
 * URL is reachable). Idempotent; only updates the timestamp + status,
 * never clears anything.
 */
export async function confirmLinkedinUrl(
  workspaceId: string,
  contactId:   number,
): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  await db`
    UPDATE contacts SET
      linkedin_url_status         = 'active',
      linkedin_url_confirmed_at   = NOW(),
      linkedin_url_invalidated_at = NULL,
      updated_at                  = NOW()
    WHERE id = ${contactId} AND workspace_id = ${workspaceId}
  `
}

/**
 * LinkedIn URL invalidation policy: 2 hard fails inside a 48h window ->
 * mark the URL inactive + queue the contact for enrichment so an SDR can
 * source a new URL. Single fails alone don't invalidate (transient
 * Unipile errors are common).
 *
 * Logs the current failure to linkedin_send_failures first, then queries
 * for the count of fails in the window; if 2+ the contact's URL is
 * marked inactive.
 *
 * Returns true when the invalidation fired (caller can surface the state
 * to the user); false when this is a single fail and we kept waiting.
 */
const LINKEDIN_FAIL_WINDOW_MS = 48 * 60 * 60 * 1000

export async function recordLinkedinSendFailure(
  workspaceId: string,
  contactId:   number,
  linkedinUrl: string,
  reason:      string,
): Promise<{ invalidated: boolean }> {
  if (!isDbConfigured()) return { invalidated: false }
  const db = sql()

  await db`
    INSERT INTO linkedin_send_failures (workspace_id, contact_id, linkedin_url, reason)
    VALUES (${workspaceId}, ${contactId}, ${linkedinUrl}, ${reason})
  `

  const windowStart = new Date(Date.now() - LINKEDIN_FAIL_WINDOW_MS)
  const recent = await db<{ count: number }>`
    SELECT COUNT(*)::int AS count FROM linkedin_send_failures
    WHERE workspace_id = ${workspaceId}
      AND contact_id   = ${contactId}
      AND occurred_at  > ${windowStart.toISOString()}
  `
  const count = recent[0]?.count ?? 0

  if (count >= 2) {
    await db`
      UPDATE contacts SET
        linkedin_url_status         = 'inactive',
        linkedin_url_invalidated_at = NOW(),
        needs_enrichment            = TRUE,
        enrichment_reason           = ${`LinkedIn URL marked inactive after ${count} send failures in 48h.`},
        updated_at                  = NOW()
      WHERE id = ${contactId} AND workspace_id = ${workspaceId}
    `
    return { invalidated: true }
  }
  return { invalidated: false }
}

// ─── Outbound exclusion listings (Task #20 - Actions-page DNC list) ──────────

export interface DncContactRow {
  id:               number
  fullName:         string | null
  jobTitle:         string | null
  companyName:      string | null
  classification:   string | null
  snippet:          string | null
  source:           string | null
  doNotContactUntil: string
}

/**
 * Lists contacts currently flagged Do-Not-Contact for a workspace. "Currently"
 * means do_not_contact_until > now() - decayed markers are excluded. Ordered
 * by remaining time (longest-DNC first) so the most-recently-flagged surface
 * at the top.
 */
export async function getDncContacts(
  workspaceId: string,
  limit = 100,
): Promise<DncContactRow[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const rows = await db<{
    id:                                  number
    full_name:                           string | null
    first_name:                          string | null
    last_name:                           string | null
    job_title:                           string | null
    company_name:                        string | null
    do_not_contact_reason_classification: string | null
    do_not_contact_reason_snippet:        string | null
    do_not_contact_source:                string | null
    do_not_contact_until:                 Date
  }>`
    SELECT
      id, full_name, first_name, last_name, job_title, company_name,
      do_not_contact_reason_classification,
      do_not_contact_reason_snippet,
      do_not_contact_source,
      do_not_contact_until
    FROM contacts
    WHERE workspace_id = ${workspaceId}
      AND do_not_contact_until IS NOT NULL
      AND do_not_contact_until > NOW()
    ORDER BY do_not_contact_until DESC
    LIMIT ${limit}
  `
  return rows.map(r => ({
    id:                r.id,
    fullName:          r.full_name?.trim()
                      || [r.first_name, r.last_name].filter(Boolean).join(" ").trim()
                      || null,
    jobTitle:          r.job_title,
    companyName:       r.company_name,
    classification:    r.do_not_contact_reason_classification,
    snippet:           r.do_not_contact_reason_snippet,
    source:            r.do_not_contact_source,
    doNotContactUntil: r.do_not_contact_until.toISOString(),
  }))
}

export interface PersonalEmailContactRow {
  id:          number
  fullName:    string | null
  jobTitle:    string | null
  companyName: string | null
  email:       string
}

/**
 * Lists contacts whose only email is a personal-provider address. Surfaced
 * on the Actions page alongside the DNC list so users can see who's
 * excluded from email-channel campaigns and why. The matching is done in
 * memory via isPersonalEmail; we pull a generous page of email-bearing
 * contacts and filter. For workspaces with very large contact tables this
 * could become a perf issue; the limit keeps it bounded.
 */
export async function getPersonalEmailContacts(
  workspaceId: string,
  limit = 200,
): Promise<PersonalEmailContactRow[]> {
  if (!isDbConfigured()) return []
  const { isPersonalEmail } = await import("../email/personal-providers")
  const db = sql()
  const rows = await db<{
    id:           number
    full_name:    string | null
    first_name:   string | null
    last_name:    string | null
    job_title:    string | null
    company_name: string | null
    email:        string
  }>`
    SELECT id, full_name, first_name, last_name, job_title, company_name, email
    FROM contacts
    WHERE workspace_id = ${workspaceId}
      AND email IS NOT NULL
      AND email != ''
    ORDER BY updated_at DESC
    LIMIT ${limit * 4}
  `
  const filtered = rows.filter(r => isPersonalEmail(r.email))
  return filtered.slice(0, limit).map(r => ({
    id:          r.id,
    fullName:    r.full_name?.trim()
                || [r.first_name, r.last_name].filter(Boolean).join(" ").trim()
                || null,
    jobTitle:    r.job_title,
    companyName: r.company_name,
    email:       r.email,
  }))
}

/**
 * Log a manual note or call against a contact. Routing:
 *   - "Manual Note"   -> recordNote (notes table, not a signal)         (Task #12)
 *   - "Call" / "Call (Voicemail)" -> recordCallNote (AI-classified)     (Task #16)
 *
 * Call notes used to write a zero-scored signal with sourceType='Call'.
 * Now the AI classifier (Haiku 4.5) labels the note as not_answered /
 * answered / answered_problem_fit and recordCallNote writes the right
 * verb at the configured score. The voicemail toggle on the UI becomes
 * a strong hint to the classifier rather than a hard outcome.
 */
export async function recordManualActivity(
  workspaceId: string,
  contactId: number,
  sourceType: "Manual Note" | "Call" | "Call (Voicemail)",
  description: string,
  occurredAt?: Date,
): Promise<void> {
  if (sourceType === "Manual Note") {
    await recordNote(workspaceId, contactId, description, occurredAt)
    return
  }
  await recordCallNote(workspaceId, contactId, {
    body:           description,
    voicemailHint:  sourceType === "Call (Voicemail)",
    occurredAt:     occurredAt ?? new Date(),
  })
}

/**
 * Record a call note - runs the AI classifier on the note text, maps the
 * outcome to one of three verbs (call_not_answered / call_answered /
 * call_answered_problem_fit), and writes a signal at the workspace-
 * configured score. When the classifier flags "no longer at this
 * company", we also flip the contact's company_status to 'departed'
 * and set needs_enrichment so they surface on the Enrichment Candidates
 * page for a re-targeting pass.
 *
 * If the classifier fails (network, parse error), we fall back to a
 * zero-scored "Call" signal so the note isn't lost - same shape as the
 * pre-Task-16 behaviour.
 */
export async function recordCallNote(
  workspaceId: string,
  contactId:   number,
  args: {
    body:           string
    voicemailHint?: boolean
    occurredAt?:    Date
  },
): Promise<void> {
  if (!isDbConfigured()) return
  const occurredAt = args.occurredAt ?? new Date()

  const config = await getWorkspaceConfig(workspaceId)
  // getWorkspaceConfig is annotated to return WorkspaceConfig | null but in
  // practice an unknown workspace would have failed long before this point;
  // the auth check on every caller guarantees it. Still guard so a missing
  // config falls through to the safe zero-scored path.
  let outcomeVerb: "call_not_answered" | "call_answered" | "call_answered_problem_fit" | null = null
  let noLongerAtCompany = false
  let classifierReason: string | null = null

  try {
    const { classifyCallNote } = await import("../ai/classifier")
    const classification = await classifyCallNote({
      workspaceId,
      noteText:      args.body,
      voicemailHint: args.voicemailHint,
    })
    outcomeVerb       = classification.outcome === "not_answered"        ? "call_not_answered"
                      : classification.outcome === "answered_problem_fit" ? "call_answered_problem_fit"
                      : "call_answered"
    noLongerAtCompany = classification.noLongerAtCompany
    classifierReason  = classification.reason
  } catch (err) {
    console.error("[recordCallNote] classifier failed, falling back to zero-scored signal:", err)
  }

  if (outcomeVerb && config) {
    const scoreDelta = resolveVerbWeight(config, outcomeVerb)
    await recordSignal(workspaceId, contactId, {
      sourceType:      args.voicemailHint ? "Call (Voicemail)" : "Call",
      description:     args.body,
      signalVerb:      outcomeVerb,
      verbDescription: classifierReason ?? undefined,
      scoreDelta,
      occurredAt,
    })
  } else {
    // Classifier unavailable or workspace config missing - fall back to
    // a zero-scored Call signal so the note still lands on the timeline.
    await recordSignal(workspaceId, contactId, {
      sourceType:  args.voicemailHint ? "Call (Voicemail)" : "Call",
      description: args.body,
      scoreDelta:  0,
      occurredAt,
    })
  }

  // "No longer at this company" detection mutates the contact directly so
  // the Enrichment Candidates page can pick them up and targeting de-
  // prioritises the (now-stale) company link. The reason string is the
  // classifier's quoted justification so the audit trail is preserved.
  if (noLongerAtCompany) {
    const db = sql()
    await db`
      UPDATE contacts SET
        company_status    = 'departed',
        needs_enrichment  = TRUE,
        enrichment_reason = ${classifierReason ?? "Flagged as no longer at this company by a call note."},
        updated_at        = NOW()
      WHERE id = ${contactId}
    `
  }
}

// ─── Notes (separated from signals per Task #12) ─────────────────────────────

export interface NoteRow {
  id:          number
  body:        string
  createdBy:   string | null
  occurredAt:  string
}

/**
 * Insert a free-text note against a contact. Notes are stored in the dedicated
 * `notes` table (not `signals`) so they don't roll into engagement score or
 * signal_count. They still surface in the contact's engagement timeline UI,
 * just sourced from a different table.
 */
export async function recordNote(
  workspaceId: string,
  contactId: number,
  body: string,
  occurredAt?: Date,
  createdBy?: string,
): Promise<number | null> {
  if (!isDbConfigured()) return null
  const db = sql()
  const rows = await db<{ id: number }>`
    INSERT INTO notes (workspace_id, contact_id, body, created_by, occurred_at)
    VALUES (
      ${workspaceId}, ${contactId}, ${body},
      ${createdBy ?? null},
      ${(occurredAt ?? new Date()).toISOString()}
    )
    RETURNING id
  `
  return rows[0]?.id ?? null
}

export async function updateNoteBody(
  workspaceId: string,
  noteId: number,
  body: string,
): Promise<boolean> {
  if (!isDbConfigured()) return false
  const db = sql()
  const res = await db`
    UPDATE notes SET body = ${body}, updated_at = NOW()
    WHERE id = ${noteId} AND workspace_id = ${workspaceId}
  `
  return (res as unknown as { count: number }).count > 0
}

export async function deleteNote(
  workspaceId: string,
  noteId: number,
): Promise<boolean> {
  if (!isDbConfigured()) return false
  const db = sql()
  const res = await db`
    DELETE FROM notes WHERE id = ${noteId} AND workspace_id = ${workspaceId}
  `
  return (res as unknown as { count: number }).count > 0
}

/**
 * Most-recent notes for a contact. Used by the SDR timeline + DM drafter
 * engagement panel to render notes alongside signals.
 */
export async function getNotesForContact(
  workspaceId: string,
  contactId: number,
  limit = 20,
): Promise<NoteRow[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const rows = await db<NoteRow>`
    SELECT
      id,
      body,
      created_by   AS "createdBy",
      occurred_at  AS "occurredAt"
    FROM notes
    WHERE workspace_id = ${workspaceId}
      AND contact_id   = ${contactId}
    ORDER BY occurred_at DESC
    LIMIT ${limit}
  `
  return rows
}

async function autoFetchMoz(workspaceId: string, rawDomain: string): Promise<void> {
  const domain = normaliseDomain(rawDomain)
  if (!domain) return
  const config = await getWorkspaceConfig(workspaceId)
  const apiKey = config?.enrichment?.moz?.apiKey
  if (!apiKey) return
  const metrics = await fetchMozMetrics(domain, apiKey)
  if (!metrics) return
  await saveMozData(workspaceId, domain, metrics)
}

async function maybeLogCompanyTransition(
  db: ReturnType<typeof sql>,
  workspaceId: string,
  contactId: number,
  scoreDelta: number,
): Promise<{ companyName: string; websiteDomain: string | null } | null> {
  // Get company name, manual stage override, website_domain, and the pre-update total company score.
  const rows = await db`
    SELECT
      c.company_name,
      MAX(t.manual_stage)                    AS manual_stage,
      MAX(t.website_domain)                  AS website_domain,
      COALESCE(SUM(c2.signal_score), 0)::int AS total_score
    FROM contacts c
    LEFT JOIN contacts c2
      ON  c2.workspace_id = c.workspace_id
      AND c2.company_name = c.company_name
    LEFT JOIN company_tags t
      ON  t.workspace_id  = c.workspace_id
      AND t.company_name  = c.company_name
    WHERE c.id = ${contactId}
      AND c.workspace_id = ${workspaceId}
    GROUP BY c.company_name
    LIMIT 1
  ` as unknown as Array<{ company_name: string; manual_stage: string | null; website_domain: string | null; total_score: number }>

  if (!rows.length || rows[0].manual_stage) return null  // manual override → don't auto-log

  const { company_name, website_domain, total_score } = rows[0]
  // total_score already includes the scoreDelta because we updated contacts first.
  const newStage  = deriveCompanyStage(total_score)
  const prevStage = deriveCompanyStage(total_score - scoreDelta)
  if (prevStage === newStage) return null

  await db`
    INSERT INTO company_stage_transitions
      (workspace_id, company_name, from_stage, to_stage, trigger)
    VALUES
      (${workspaceId}, ${company_name}, ${prevStage}, ${newStage}, 'auto')
  `

  if (newStage === "Signal Found") {
    return { companyName: company_name, websiteDomain: website_domain }
  }
  return null
}


/**
 * Fetch a single contact by id with the same shape as a row in getLeads.
 * Used by the contact-drawer GET endpoint so the Companies page can show a
 * lightweight summary + clickable stage/persona pills without re-running
 * the full lead-list query.
 */
export async function getContactById(
  workspaceId: string,
  contactId: number,
): Promise<LeadRow | null> {
  if (!isDbConfigured()) return null
  const db = sql()
  const rows = await db`
    SELECT
      c.id,
      c.crm_provider          AS "crmProvider",
      c.crm_contact_id        AS "crmContactId",
      c.crm_url               AS "crmUrl",
      c.email,
      c.linkedin_url          AS "linkedinUrl",
      c.twitter_url           AS "twitterUrl",
      c.full_name             AS "fullName",
      c.job_title             AS "jobTitle",
      c.company_name          AS "companyName",
      c.icp_group             AS "icpGroup",
      COALESCE(c.manual_persona, c.persona) AS "persona",
      c.persona               AS "autoPersona",
      c.manual_persona        AS "manualPersona",
      c.signal_score          AS "signalScore",
      c.signal_count          AS "signalCount",
      c.funnel_stage          AS "funnelStage",
      t.manual_stage          AS "manualStage",
      COALESCE(t.manual_stage, c.funnel_stage) AS "effectiveStage",
      c.last_signal_at        AS "lastSignalAt",
      c.assigned_team_member_id AS "assignedTeamMemberId",
      c.do_not_contact_until  AS "doNotContactUntil",
      c.linkedin_connected    AS "linkedinConnected",
      (SELECT status      FROM enrichment_log WHERE contact_id = c.id ORDER BY occurred_at DESC LIMIT 1) AS "lastEnrichmentStatus",
      (SELECT occurred_at FROM enrichment_log WHERE contact_id = c.id ORDER BY occurred_at DESC LIMIT 1) AS "lastEnrichmentAt",
      COALESCE(
        (
          SELECT json_agg(json_build_object(
            'id',              s.id,
            'sourceType',      s.source_type,
            'engagementUrl',   s.engagement_url,
            'description',     s.description,
            'occurredAt',      s.occurred_at,
            'signalVerb',      s.signal_verb,
            'signalActor',     s.signal_actor,
            'signalObject',    s.signal_object,
            'verbDescription', s.verb_description,
            'scoreDelta',      s.score_delta
          ) ORDER BY s.occurred_at DESC)
          FROM (
            SELECT id, source_type, engagement_url, description, occurred_at,
                   signal_verb, signal_actor, signal_object, verb_description, score_delta
            FROM signals
            WHERE contact_id = c.id
            ORDER BY occurred_at DESC
            LIMIT 10
          ) s
        ),
        '[]'::json
      ) AS "recentSignals",
      COALESCE(
        (
          SELECT json_agg(json_build_object(
            'id',         n.id,
            'body',       n.body,
            'createdBy',  n.created_by,
            'occurredAt', n.occurred_at
          ) ORDER BY n.occurred_at DESC)
          FROM (
            SELECT id, body, created_by, occurred_at
            FROM notes
            WHERE contact_id = c.id
            ORDER BY occurred_at DESC
            LIMIT 10
          ) n
        ),
        '[]'::json
      ) AS "recentNotes"
    FROM contacts c
    LEFT JOIN company_tags t
      ON t.workspace_id = c.workspace_id
     AND t.company_name = c.company_name
    WHERE c.workspace_id = ${workspaceId}
      AND c.id = ${contactId}
    LIMIT 1
  `
  return (rows[0] as LeadRow) ?? null
}

/**
 * Set or clear a contact's manual persona override. Pass `null` to clear and
 * fall back to the auto-classified `persona`. Survives reclassification
 * runs so the human's correction sticks.
 */
export async function setManualPersona(
  workspaceId: string,
  contactId: number,
  persona: string | null,
): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  await db`
    UPDATE contacts SET manual_persona = ${persona}, updated_at = NOW()
    WHERE workspace_id = ${workspaceId} AND id = ${contactId}
  `
}

/**
 * Rename one prospect-type value across every company_tags row in the
 * workspace. Used when the workspace renames an entry in Settings -> Custom
 * Tags so already-tagged companies keep their tag instead of being orphaned
 * with the old label. No-op when from === to.
 */
export async function renameCompanyProspectType(
  workspaceId: string,
  from: string,
  to: string,
): Promise<void> {
  if (!isDbConfigured()) return
  if (from === to) return
  const db = sql()
  await db`
    UPDATE company_tags
    SET prospect_types = array_replace(prospect_types, ${from}, ${to}),
        updated_at     = NOW()
    WHERE workspace_id = ${workspaceId}
      AND ${from} = ANY(prospect_types)
  `
}

/**
 * Replace the prospect_types tag set on a company. Pass an empty array to
 * clear all tags. Upserts the company_tags row so callers don't have to
 * check existence.
 */
export async function setCompanyProspectTypes(
  workspaceId: string,
  companyName: string,
  prospectTypes: string[],
): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  // Normalize: dedup, drop empties
  const seen = new Set<string>()
  const clean: string[] = []
  for (const t of prospectTypes) {
    const v = t?.trim()
    if (v && !seen.has(v)) { seen.add(v); clean.push(v) }
  }
  // Always upsert (no DELETE on empty) — the row may also carry an SDR
  // assignment, which an empty tag list shouldn't wipe.
  await db`
    INSERT INTO company_tags (workspace_id, company_name, prospect_types, updated_at)
    VALUES (${workspaceId}, ${companyName}, ${clean}, NOW())
    ON CONFLICT (workspace_id, company_name) DO UPDATE SET
      prospect_types = EXCLUDED.prospect_types,
      updated_at     = NOW()
  `
}

/**
 * Set or clear a company's manual SDR / team-member assignment. Pass `null`
 * to clear. Upserts the company_tags row so callers don't need to check
 * existence; co-exists with the prospect_types tag set on the same row.
 */
export async function setCompanyAssignment(
  workspaceId: string,
  companyName: string,
  teamMemberId: string | null,
): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  await db`
    INSERT INTO company_tags (workspace_id, company_name, assigned_team_member_id, updated_at)
    VALUES (${workspaceId}, ${companyName}, ${teamMemberId}, NOW())
    ON CONFLICT (workspace_id, company_name) DO UPDATE SET
      assigned_team_member_id = EXCLUDED.assigned_team_member_id,
      updated_at              = NOW()
  `
}

/**
 * Set or clear a company's manual stage override. Pass `null` to clear
 * and fall back to the auto-derived stage from signal_score. The
 * override rolls down to every contact at the company on the SDR page —
 * a "Discovery Call" booking is an account-level fact.
 *
 * Upserts the company_tags row; co-exists with prospect_types and
 * assigned_team_member_id on the same row.
 */
export async function setCompanyStage(
  workspaceId: string,
  companyName: string,
  stage: string | null,
): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()

  // Get current effective stage before overwriting so we can log the transition.
  const currentRows = await db`
    SELECT
      MAX(t.manual_stage)                AS manual_stage,
      COALESCE(SUM(c.signal_score), 0)::int AS total_score
    FROM contacts c
    LEFT JOIN company_tags t
      ON  t.workspace_id = c.workspace_id
      AND t.company_name = c.company_name
    WHERE c.workspace_id = ${workspaceId}
      AND c.company_name = ${companyName}
  ` as unknown as Array<{ manual_stage: string | null; total_score: number }>

  const row         = currentRows[0] ?? { manual_stage: null, total_score: 0 }
  const currentStage = row.manual_stage ?? deriveCompanyStage(row.total_score)

  await db`
    INSERT INTO company_tags (workspace_id, company_name, manual_stage, updated_at)
    VALUES (${workspaceId}, ${companyName}, ${stage}, NOW())
    ON CONFLICT (workspace_id, company_name) DO UPDATE SET
      manual_stage = EXCLUDED.manual_stage,
      updated_at   = NOW()
  `

  // Log the transition when setting a non-null stage that differs from current.
  if (stage !== null && stage !== currentStage) {
    await db`
      INSERT INTO company_stage_transitions
        (workspace_id, company_name, from_stage, to_stage, trigger)
      VALUES
        (${workspaceId}, ${companyName}, ${currentStage}, ${stage}, 'manual')
    `
  }
}

/**
 * Has a signal with this crm_signal_id already been recorded for this contact?
 * Used by ingestion paths (e.g. Teamfluence feed-poll) to skip re-inserts when
 * the cron runs again over the same window.
 */
export async function signalExistsInDb(
  workspaceId: string,
  contactId: number,
  crmSignalId: string,
): Promise<boolean> {
  if (!isDbConfigured()) return false
  const db = sql()
  const rows = await db`
    SELECT 1 FROM signals
    WHERE workspace_id = ${workspaceId}
      AND contact_id   = ${contactId}
      AND crm_signal_id = ${crmSignalId}
    LIMIT 1
  `
  return rows.length > 0
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * Look up a contact by email within a workspace.
 * Returns the internal id, or null if not found.
 */
export async function findContactByEmail(
  workspaceId: string,
  email: string,
): Promise<number | null> {
  const db = sql()
  const rows = await db`
    SELECT id FROM contacts
    WHERE workspace_id = ${workspaceId} AND email = ${email}
    LIMIT 1
  `
  return rows.length ? (rows[0] as { id: number }).id : null
}

/**
 * Look up a contact by LinkedIn URL within a workspace.
 */
export async function findContactByLinkedin(
  workspaceId: string,
  linkedinUrl: string,
): Promise<number | null> {
  const db = sql()
  const rows = await db`
    SELECT id FROM contacts
    WHERE workspace_id = ${workspaceId} AND linkedin_url = ${linkedinUrl}
    LIMIT 1
  `
  return rows.length ? (rows[0] as { id: number }).id : null
}

export type Period = "week" | "month" | "all"

/**
 * Returns the start-of-period Date (UTC) for the given period.
 * For "all" returns null (no filter).
 */
export function periodSince(period: Period): Date | null {
  const now = new Date()
  switch (period) {
    case "week": {
      // ISO week — Monday start
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
      const dayOfWeek = (d.getUTCDay() + 6) % 7  // 0 = Mon, 6 = Sun
      d.setUTCDate(d.getUTCDate() - dayOfWeek)
      return d
    }
    case "month":
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    default:
      return null
  }
}

export type EnrichmentFilter = "any" | "enriched" | "unenriched"

/** Persona filter values: a specific persona name, "__none__" (only NULL persona), or null (no filter). */
/**
 * Persona filter values:
 *   - null         → no filter
 *   - "__matched__" → only contacts with a persona set (persona IS NOT NULL)
 *   - "__none__"    → only contacts without a persona match (persona IS NULL)
 *   - any other string → exact persona name match
 */
export type PersonaFilter = string | "__matched__" | "__none__" | null

/**
 * Fetch all contacts for the SDR dashboard in a single query.
 * Includes up to 5 most recent signals per contact, aggregated as JSON.
 *
 * minScore:          minimum signal_score (default: 5 = Signal Found+)
 * sortMode:          "recent" (default) = last_signal_at DESC, "score-desc" =
 *                    highest score first, "score-asc" = lowest score first
 * since:             optional Date — only contacts active on/after (period filter)
 * enrichmentFilter:  "enriched" = email IS NOT NULL only,
 *                    "unenriched" = email IS NULL only,
 *                    "any" (default) = both
 * stage:             when set, only contacts whose effective stage
 *                    (manual_stage ?? funnel_stage) matches this string.
 *                    "Prospect" overrides the minScore floor so contacts
 *                    with no engagement still show up.
 * personaFilter:     null = any. "__none__" = only contacts with NULL
 *                    persona. Otherwise = only contacts whose persona
 *                    column matches this exact string.
 */
export async function getLeads(
  workspaceId: string,
  minScore = 5,
  sortMode: SortMode = "recent-desc",
  since: Date | null = null,
  enrichmentFilter: EnrichmentFilter = "any",
  stage: string | null = null,
  personaFilter: PersonaFilter = null,
  onlyExcludedCompanies: boolean = false,
  teamFilter?: TeamFilter,
  // Pagination — capped server-side because the LATERAL signal-aggregation
  // is per-row, so unbounded reads scaled poorly on large workspaces. Pass
  // limit + 1 from the caller to detect whether a "next page" exists without
  // a separate COUNT query.
  limit: number = 100,
  offset: number = 0,
  // Free-text search — matches a contact when their full_name OR
  // company_name contains the query (ILIKE, case-insensitive). Empty /
  // whitespace-only = no search filter.
  searchQuery: string | null = null,
): Promise<LeadRow[]> {
  const db = sql()
  const wantEnriched   = enrichmentFilter === "enriched"
  const wantUnenriched = enrichmentFilter === "unenriched"
  // Filtering to Prospect (or any stage that includes pre-engagement contacts)
  // requires dropping the minScore gate — those contacts are below it by
  // definition. The effective-stage filter below already narrows by stage.
  const effectiveMinScore = stage === "Prospect" ? 0 : minScore
  // Persona filter — encoded as three flags for the SQL because the
  // tagged-template builder can't conditionally include WHERE clauses.
  const wantNoPersona  = personaFilter === "__none__"
  const wantAnyMatched = personaFilter === "__matched__"
  const personaName: string | null =
    personaFilter && personaFilter !== "__none__" && personaFilter !== "__matched__"
      ? personaFilter
      : null

  // ORDER BY clause picked from a static map. The keys are the SortMode
  // values themselves, so the lookup is type-safe — no SQL injection risk
  // even though we're concatenating into the query string. The body of the
  // query is identical across modes so we use db.query() with a single
  // template instead of four near-identical tagged-template branches.
  const ORDER_BY: Record<SortMode, string> = {
    "score-asc":          "ORDER BY c.signal_score ASC",
    "score-desc":         "ORDER BY c.signal_score DESC",
    "recent-asc":         "ORDER BY c.last_signal_at ASC NULLS LAST,  c.signal_score DESC",
    "recent-desc":        "ORDER BY c.last_signal_at DESC NULLS LAST, c.signal_score DESC",
    "score-then-recent":  "ORDER BY c.signal_score DESC, c.last_signal_at DESC NULLS LAST",
    "recent-then-score":  "ORDER BY c.last_signal_at DESC NULLS LAST, c.signal_score DESC",
  }

  const queryText = `
    SELECT
      c.id,
      c.crm_provider          AS "crmProvider",
      c.crm_contact_id        AS "crmContactId",
      c.crm_url               AS "crmUrl",
      c.email,
      c.linkedin_url          AS "linkedinUrl",
      c.twitter_url           AS "twitterUrl",
      c.full_name             AS "fullName",
      c.job_title             AS "jobTitle",
      c.company_name          AS "companyName",
      c.icp_group             AS "icpGroup",
      COALESCE(c.manual_persona, c.persona) AS "persona",
      c.persona               AS "autoPersona",
      c.manual_persona        AS "manualPersona",
      c.signal_score          AS "signalScore",
      c.signal_count          AS "signalCount",
      c.funnel_stage          AS "funnelStage",
      -- manual_stage now lives on company_tags (account-level fact: a
      -- "Discovery Call" booking is with the company, all of its people
      -- inherit the override). The LEFT JOIN to t means unassigned
      -- companies pass through to funnel_stage. Wrapped in MAX() because
      -- this query's GROUP BY c.id only carries functional-dependency
      -- through contacts' own columns; t's columns must be aggregated.
      -- One row of t per contact (join key is workspace + company), so
      -- MAX is just picking that single value.
      MAX(t.manual_stage)     AS "manualStage",
      COALESCE(NULLIF(MAX(t.manual_stage), 'Customer Won'), c.funnel_stage) AS "effectiveStage",
      c.last_signal_at        AS "lastSignalAt",
      c.assigned_team_member_id AS "assignedTeamMemberId",
      c.do_not_contact_until  AS "doNotContactUntil",
      c.linkedin_connected    AS "linkedinConnected",
      MAX(el.status)          AS "lastEnrichmentStatus",
      MAX(el.occurred_at)     AS "lastEnrichmentAt",
      COALESCE(
        json_agg(
          json_build_object(
            'id',              s.id,
            'sourceType',      s.source_type,
            'engagementUrl',   s.engagement_url,
            'description',     s.description,
            'occurredAt',      s.occurred_at,
            'signalVerb',      s.signal_verb,
            'signalActor',     s.signal_actor,
            'signalObject',    s.signal_object,
            'verbDescription', s.verb_description,
            'scoreDelta',      s.score_delta
          ) ORDER BY s.occurred_at DESC
        ) FILTER (WHERE s.id IS NOT NULL),
        '[]'::json
      ) AS "recentSignals",
      COALESCE(
        (
          SELECT json_agg(json_build_object(
            'id',         n.id,
            'body',       n.body,
            'createdBy',  n.created_by,
            'occurredAt', n.occurred_at
          ) ORDER BY n.occurred_at DESC)
          FROM (
            SELECT id, body, created_by, occurred_at
            FROM notes
            WHERE contact_id = c.id
            ORDER BY occurred_at DESC
            LIMIT 5
          ) n
        ),
        '[]'::json
      ) AS "recentNotes"
    FROM contacts c
    LEFT JOIN LATERAL (
      SELECT id, source_type, engagement_url, description, occurred_at,
             signal_verb, signal_actor, signal_object, verb_description, score_delta
      FROM signals
      WHERE contact_id = c.id
      ORDER BY occurred_at DESC
      LIMIT 5
    ) s ON true
    LEFT JOIN LATERAL (
      SELECT status, occurred_at
      FROM enrichment_log
      WHERE contact_id = c.id
      ORDER BY occurred_at DESC
      LIMIT 1
    ) el ON true
    LEFT JOIN company_tags t
      ON t.workspace_id = c.workspace_id
     AND t.company_name = c.company_name
    WHERE c.workspace_id = $1
      AND c.signal_score >= $2
      AND ($3::timestamptz IS NULL OR c.last_signal_at >= $3)
      AND (NOT $4   OR c.email IS NOT NULL)
      AND (NOT $5   OR c.email IS NULL)
      AND ($6::text IS NULL OR COALESCE(t.manual_stage, c.funnel_stage) = $6)
      AND (NOT $7   OR COALESCE(c.manual_persona, c.persona) IS NULL)
      AND (NOT $8   OR COALESCE(c.manual_persona, c.persona) IS NOT NULL)
      AND ($9::text IS NULL OR COALESCE(c.manual_persona, c.persona) = $9)
      AND CASE
            WHEN $10::bool THEN ('Excluded' = ANY(COALESCE(t.prospect_types, '{}'::text[])))
            ELSE NOT ('Excluded' = ANY(COALESCE(t.prospect_types, '{}'::text[])))
          END
      AND (${teamFilterClause(teamFilter)})
      AND (
        $13::text IS NULL
        OR c.full_name    ILIKE '%' || $13 || '%'
        OR c.company_name ILIKE '%' || $13 || '%'
        OR c.job_title    ILIKE '%' || $13 || '%'
      )
    GROUP BY c.id
    ${ORDER_BY[sortMode]}
    LIMIT $11 OFFSET $12
  `

  const trimmedQuery = searchQuery?.trim() || null
  const rows = await db.query(queryText, [
    workspaceId,
    effectiveMinScore,
    since ? since.toISOString() : null,
    wantEnriched,
    wantUnenriched,
    stage,
    wantNoPersona,
    wantAnyMatched,
    personaName,
    onlyExcludedCompanies,
    limit,
    offset,
    trimmedQuery,
  ])

  return rows as LeadRow[]
}

// ─── Utility ──────────────────────────────────────────────────────────────────

// ─── Last activity (for "last updated" indicator in dashboard header) ───────

/**
 * Most recent signal occurrence timestamp for the workspace, or null if
 * there are no signals (or DB isn't configured). Used to show "last
 * updated" in the dashboard so SDRs know whether the queue is fresh.
 */
export async function getLatestActivity(workspaceId: string): Promise<Date | null> {
  if (!isDbConfigured()) return null
  const db = sql()
  const rows = await db`
    SELECT MAX(occurred_at) AS max
    FROM signals
    WHERE workspace_id = ${workspaceId}
  `
  const max = (rows[0] as { max: string | Date | null }).max
  return max ? new Date(max) : null
}

// ─── Lead counts (cheap, for tab labels) ─────────────────────────────────────

export async function countLeads(
  workspaceId: string,
  minScore: number,
  since: Date | null,
  enrichmentFilter: EnrichmentFilter,
  stage: string | null = null,
  personaFilter: PersonaFilter = null,
  onlyExcludedCompanies: boolean = false,
  teamFilter?: TeamFilter,
): Promise<number> {
  if (!isDbConfigured()) return 0
  const db = sql()
  const wantEnriched     = enrichmentFilter === "enriched"
  const wantUnenriched   = enrichmentFilter === "unenriched"
  const effectiveMinScore = stage === "Prospect" ? 0 : minScore
  const wantNoPersona  = personaFilter === "__none__"
  const wantAnyMatched = personaFilter === "__matched__"
  const personaName: string | null =
    personaFilter && personaFilter !== "__none__" && personaFilter !== "__matched__"
      ? personaFilter
      : null
  const queryText = `
    SELECT COUNT(*)::int AS n
    FROM contacts c
    LEFT JOIN company_tags t
      ON t.workspace_id = c.workspace_id
     AND t.company_name = c.company_name
    WHERE c.workspace_id = $1
      AND c.signal_score >= $2
      AND ($3::timestamptz IS NULL OR c.last_signal_at >= $3)
      AND (NOT $4   OR c.email IS NOT NULL)
      AND (NOT $5   OR c.email IS NULL)
      AND ($6::text IS NULL OR COALESCE(t.manual_stage, c.funnel_stage) = $6)
      AND (NOT $7   OR COALESCE(c.manual_persona, c.persona) IS NULL)
      AND (NOT $8   OR COALESCE(c.manual_persona, c.persona) IS NOT NULL)
      AND ($9::text IS NULL OR COALESCE(c.manual_persona, c.persona) = $9)
      AND CASE
            WHEN $10::bool THEN ('Excluded' = ANY(COALESCE(t.prospect_types, '{}'::text[])))
            ELSE NOT ('Excluded' = ANY(COALESCE(t.prospect_types, '{}'::text[])))
          END
      AND (${teamFilterClause(teamFilter)})
  `
  const rows = await db.query(queryText, [
    workspaceId,
    effectiveMinScore,
    since ? since.toISOString() : null,
    wantEnriched,
    wantUnenriched,
    stage,
    wantNoPersona,
    wantAnyMatched,
    personaName,
    onlyExcludedCompanies,
  ])
  return (rows[0] as { n: number }).n
}

/**
 * Count contacts whose company carries the "Excluded" prospect-type tag and
 * would otherwise pass the same filter set. Drives the "Excluded N" pill on
 * the SDR page so users can see what's being hidden by default.
 */
export async function countLeadsAtExcludedCompanies(
  workspaceId: string,
  minScore: number,
  since: Date | null,
  enrichmentFilter: EnrichmentFilter,
  stage: string | null = null,
  personaFilter: PersonaFilter = null,
  teamFilter?: TeamFilter,
): Promise<number> {
  if (!isDbConfigured()) return 0
  const db = sql()
  const wantEnriched     = enrichmentFilter === "enriched"
  const wantUnenriched   = enrichmentFilter === "unenriched"
  const effectiveMinScore = stage === "Prospect" ? 0 : minScore
  const wantNoPersona  = personaFilter === "__none__"
  const wantAnyMatched = personaFilter === "__matched__"
  const personaName: string | null =
    personaFilter && personaFilter !== "__none__" && personaFilter !== "__matched__"
      ? personaFilter
      : null
  const queryText = `
    SELECT COUNT(*)::int AS n
    FROM contacts c
    JOIN company_tags t
      ON t.workspace_id = c.workspace_id
     AND t.company_name = c.company_name
    WHERE c.workspace_id = $1
      AND 'Excluded' = ANY(t.prospect_types)
      AND c.signal_score >= $2
      AND ($3::timestamptz IS NULL OR c.last_signal_at >= $3)
      AND (NOT $4   OR c.email IS NOT NULL)
      AND (NOT $5   OR c.email IS NULL)
      AND ($6::text IS NULL OR COALESCE(t.manual_stage, c.funnel_stage) = $6)
      AND (NOT $7   OR COALESCE(c.manual_persona, c.persona) IS NULL)
      AND (NOT $8   OR COALESCE(c.manual_persona, c.persona) IS NOT NULL)
      AND ($9::text IS NULL OR COALESCE(c.manual_persona, c.persona) = $9)
      AND (${teamFilterClause(teamFilter)})
  `
  const rows = await db.query(queryText, [
    workspaceId,
    effectiveMinScore,
    since ? since.toISOString() : null,
    wantEnriched,
    wantUnenriched,
    stage,
    wantNoPersona,
    wantAnyMatched,
    personaName,
  ])
  return (rows[0] as { n: number }).n
}

/**
 * Count contacts grouped by `persona` for the persona filter dropdown. Honours
 * the same filter context as the main lead list (stage, enrichment, period,
 * excluded-company guard) so the count next to each persona matches what the
 * user would see if they applied that filter.
 *
 * Note: this ignores any *active* persona filter — counts always reflect
 * "how many would I see if I picked this persona", not "how many match the
 * currently-selected persona". Otherwise selecting a persona would zero
 * everyone else's count.
 */
export async function countLeadsByPersona(
  workspaceId: string,
  minScore: number,
  since: Date | null,
  enrichmentFilter: EnrichmentFilter,
  stage: string | null = null,
  onlyExcludedCompanies: boolean = false,
  teamFilter?: TeamFilter,
): Promise<Record<string, number>> {
  if (!isDbConfigured()) return {}
  const db = sql()
  const wantEnriched     = enrichmentFilter === "enriched"
  const wantUnenriched   = enrichmentFilter === "unenriched"
  const effectiveMinScore = stage === "Prospect" ? 0 : minScore
  const queryText = `
    SELECT COALESCE(c.manual_persona, c.persona) AS persona, COUNT(*)::int AS n
    FROM contacts c
    LEFT JOIN company_tags t
      ON t.workspace_id = c.workspace_id
     AND t.company_name = c.company_name
    WHERE c.workspace_id = $1
      AND COALESCE(c.manual_persona, c.persona) IS NOT NULL
      AND c.signal_score >= $2
      AND ($3::timestamptz IS NULL OR c.last_signal_at >= $3)
      AND (NOT $4   OR c.email IS NOT NULL)
      AND (NOT $5   OR c.email IS NULL)
      AND ($6::text IS NULL OR COALESCE(t.manual_stage, c.funnel_stage) = $6)
      AND CASE
            WHEN $7::bool THEN ('Excluded' = ANY(COALESCE(t.prospect_types, '{}'::text[])))
            ELSE NOT ('Excluded' = ANY(COALESCE(t.prospect_types, '{}'::text[])))
          END
      AND (${teamFilterClause(teamFilter)})
    GROUP BY 1
  `
  const rows = await db.query(queryText, [
    workspaceId,
    effectiveMinScore,
    since ? since.toISOString() : null,
    wantEnriched,
    wantUnenriched,
    stage,
    onlyExcludedCompanies,
  ])
  const out: Record<string, number> = {}
  for (const r of rows as { persona: string; n: number }[]) out[r.persona] = r.n
  return out
}

/**
 * Count contacts grouped by effective stage (manual_stage ?? funnel_stage)
 * for the 5 stage pills shown in the SDR dashboard header. Honours the
 * existing tab filter (enriched / unenriched) and period filter so the
 * counts match what the active tab actually displays.
 *
 * Prospect is included in the count regardless of minScore — they live below
 * the 5-point floor by definition.
 */
export async function countLeadsByStage(
  workspaceId: string,
  since: Date | null,
  enrichmentFilter: EnrichmentFilter,
  teamFilter?: TeamFilter,
): Promise<Record<string, number>> {
  if (!isDbConfigured()) return {}
  const db = sql()
  const wantEnriched   = enrichmentFilter === "enriched"
  const wantUnenriched = enrichmentFilter === "unenriched"
  const queryText = `
    SELECT COALESCE(t.manual_stage, c.funnel_stage) AS stage, COUNT(*)::int AS n
    FROM contacts c
    LEFT JOIN company_tags t
      ON t.workspace_id = c.workspace_id
     AND t.company_name = c.company_name
    WHERE c.workspace_id = $1
      AND ($2::timestamptz IS NULL OR c.last_signal_at >= $2)
      AND (NOT $3   OR c.email IS NOT NULL)
      AND (NOT $4   OR c.email IS NULL)
      AND (${teamFilterClause(teamFilter)})
    GROUP BY 1
  `
  const rows = await db.query(queryText, [
    workspaceId,
    since ? since.toISOString() : null,
    wantEnriched,
    wantUnenriched,
  ])
  const out: Record<string, number> = {}
  for (const r of rows as { stage: string; n: number }[]) out[r.stage] = r.n
  return out
}

/**
 * One-shot equivalent of countLeads(enriched) + countLeads(unenriched) +
 * countLeadsByStage + countLeadsAtExcludedCompanies, computed in a single
 * round trip via a CTE that does ONE base scan and four aggregations on top.
 *
 * Why this exists: each individual count was ~100ms in steady state on the
 * Pool driver, but firing five queries in parallel (4 counts + getLeads)
 * caused contention at the DB compute level — three of the counts would
 * queue behind the heavy `leads` query and balloon to ~400ms each. Folding
 * all four aggregates into one query eliminates the count-vs-leads
 * contention and removes three round trips.
 *
 * Filter semantics match the original four functions exactly:
 *   - all      = enriched + non-excluded + stageFilter   (minScore 0)
 *   - queue    = unenriched + non-excluded + stageFilter (minScore 1, 0 for Prospect)
 *   - excluded = excluded + stageFilter
 *   - stages   = grouped by effectiveStage, no stageFilter (the breakdown
 *                IS the stage axis), uses tab's enrichment filter,
 *                INCLUDES excluded contacts (matches countLeadsByStage)
 */
export interface SdrPageCounts {
  all:      number
  queue:    number
  excluded: number
  stages:   Record<string, number>
}

export async function getSdrPageCounts(
  workspaceId: string,
  since: Date | null,
  enrichmentFilter: EnrichmentFilter,
  stageFilter: string | null,
  teamFilter?: TeamFilter,
  searchQuery: string | null = null,
): Promise<SdrPageCounts> {
  if (!isDbConfigured()) return { all: 0, queue: 0, excluded: 0, stages: {} }
  const db = sql()
  const wantEnriched   = enrichmentFilter === "enriched"
  const wantUnenriched = enrichmentFilter === "unenriched"
  const trimmedQuery   = searchQuery?.trim() || null
  const queryText = `
    WITH filtered AS (
      SELECT
        c.signal_score,
        c.email IS NOT NULL                                        AS has_email,
        COALESCE(NULLIF(t.manual_stage, 'Customer Won'), c.funnel_stage) AS effective_stage,
        'Excluded' = ANY(COALESCE(t.prospect_types, '{}'::text[])) AS is_excluded
      FROM contacts c
      LEFT JOIN company_tags t
        ON t.workspace_id = c.workspace_id
       AND t.company_name = c.company_name
      WHERE c.workspace_id = $1
        AND ($2::timestamptz IS NULL OR c.last_signal_at >= $2)
        AND (${teamFilterClause(teamFilter)})
        AND (
          $6::text IS NULL
          OR c.full_name    ILIKE '%' || $6 || '%'
          OR c.company_name ILIKE '%' || $6 || '%'
          OR c.job_title    ILIKE '%' || $6 || '%'
        )
    )
    SELECT
      -- Negative signal_score is possible (negative-delta signals e.g.
      -- unsubscribes), and the originals all filter signal_score >= minScore
      -- where minScore is 0 for the all/excluded pills. Match that floor here
      -- so a workspace with unsubscribe signals doesn't see inflated counts.
      (SELECT COUNT(*)::int FROM filtered
        WHERE NOT is_excluded
          AND has_email
          AND signal_score >= 0
          AND ($3::text IS NULL OR effective_stage = $3)
      ) AS count_all,
      (SELECT COUNT(*)::int FROM filtered
        WHERE NOT is_excluded
          AND NOT has_email
          AND signal_score >= (CASE WHEN $3 = 'Prospect' THEN 0 ELSE 1 END)
          AND ($3::text IS NULL OR effective_stage = $3)
      ) AS count_queue,
      (SELECT COUNT(*)::int FROM filtered
        WHERE is_excluded
          AND signal_score >= 0
          AND ($3::text IS NULL OR effective_stage = $3)
      ) AS count_excluded,
      (SELECT COALESCE(jsonb_object_agg(effective_stage, n), '{}'::jsonb)
       FROM (
         SELECT effective_stage, COUNT(*)::int AS n
         FROM filtered
         WHERE (NOT $4 OR has_email)
           AND (NOT $5 OR NOT has_email)
         GROUP BY effective_stage
       ) g
      ) AS stage_counts
  `
  const rows = await db.query(queryText, [
    workspaceId,
    since ? since.toISOString() : null,
    stageFilter,
    wantEnriched,
    wantUnenriched,
    trimmedQuery,
  ])
  const r = rows[0] as {
    count_all:      number
    count_queue:    number
    count_excluded: number
    stage_counts:   Record<string, number> | null
  }
  return {
    all:      r.count_all,
    queue:    r.count_queue,
    excluded: r.count_excluded,
    stages:   r.stage_counts ?? {},
  }
}

// ─── Enrichment stats ─────────────────────────────────────────────────────────

export interface EnrichmentStats {
  calls: number
  enriched: number
  noMatch: number
  internalPurged: number
  emailCredits: number
  mobileCredits: number
  totalCredits: number
}

/**
 * Total credits used + call counts for a workspace, optionally limited to
 * enrichments that occurred on/after `since`.
 */
export async function getEnrichmentStats(
  workspaceId: string,
  since: Date | null = null,
): Promise<EnrichmentStats> {
  if (!isDbConfigured()) {
    return { calls: 0, enriched: 0, noMatch: 0, internalPurged: 0, emailCredits: 0, mobileCredits: 0, totalCredits: 0 }
  }
  const db = sql()
  const rows = await db`
    SELECT
      COUNT(*)::int                                                         AS calls,
      COUNT(*) FILTER (WHERE status = 'enriched')::int                      AS enriched,
      COUNT(*) FILTER (WHERE status = 'no_match')::int                      AS no_match,
      COUNT(*) FILTER (WHERE status = 'internal_purged')::int               AS internal_purged,
      COALESCE(SUM(email_credits), 0)::int                                  AS email_credits,
      COALESCE(SUM(mobile_credits), 0)::int                                 AS mobile_credits,
      COALESCE(SUM(email_credits + mobile_credits), 0)::int                 AS total_credits
    FROM enrichment_log
    WHERE workspace_id = ${workspaceId}
      AND (${since}::timestamptz IS NULL OR occurred_at >= ${since})
  `
  const r = rows[0] as Record<string, number>
  return {
    calls:          r.calls,
    enriched:       r.enriched,
    noMatch:        r.no_match,
    internalPurged: r.internal_purged,
    emailCredits:   r.email_credits,
    mobileCredits:  r.mobile_credits,
    totalCredits:   r.total_credits,
  }
}

// ─── Companies with signals (powers the "Companies" tab) ────────────────────

export interface CompanyRow {
  companyName: string
  companyLinkedinUrl: string | null
  contactCount: number
  signalCount: number
  signalScore: number
  lastSignalAt: string | null
  /** Latest enrichment fetch time, if any — null = never enriched */
  lastEnrichedAt: string | null
  /** How many people the latest Apify run returned (0 = never run) */
  enrichmentCount: number
  /**
   * Effective company stage. "Discovery Call" if any contact at the company
   * has manual_stage='Discovery Call'; otherwise derived from aggregated
   * signal_score via deriveCompanyStage.
   */
  effectiveStage: string
  /** Smallest known min headcount across the company's contacts. */
  employeesMin: number | null
  /** Largest known max headcount across the company's contacts. */
  employeesMax: number | null
  /** ISO-2 country code (most-common across the company's contacts). */
  country: string | null
  /** Distinct industry tags collected across the company's contacts. */
  industries: string[]
  /**
   * Prospect Type tags assigned in the Companies dashboard, e.g.
   * ["Software","Partner"]. Empty array when untagged.
   */
  prospectTypes: string[]
  /**
   * Manual SDR / team-member assignment for the Team Filters feature.
   * Holds the team member's id from WorkspaceConfig.teamMembers, or null
   * when unassigned.
   */
  assignedTeamMemberId: string | null
  /**
   * Manual stage override set at the company level (e.g. "Discovery Call").
   * When non-null, every contact at this company shows this stage on the
   * SDR page regardless of their personal signal_score. NULL = let the
   * auto-derived stage from signal_score win.
   */
  manualStage: string | null
  /** Website domain stored on company_tags (e.g. "example.com"). Used for Moz DA lookups. */
  websiteDomain: string | null
  /** Moz domain authority score (0–100), null if never fetched. */
  domainAuthority: number | null
  /** When Moz DA was last fetched, ISO string. */
  mozFetchedAt: string | null
  /** Monthly recurring revenue on the deal at this company, in the workspace's working currency. Null = no deal value recorded. */
  dealMrr: number | null
}

export interface CompanyFilterOptions {
  /**
   * Tag values to include. If provided, a company appears when its
   * prospect_types array overlaps any of these. Empty array = no tag filter.
   */
  includeProspectTypes?: string[]
  /** Whether to also include companies that carry no tags at all. */
  includeUntagged?: boolean
  /** Sort order — mirrors the /sdr SortMode union. */
  sortMode?: SortMode
  /**
   * Team Filter: restrict to companies whose row in company_tags is
   * assigned to the supplied team member. Omit when no team filter is active.
   */
  teamFilter?: TeamFilter
  /**
   * Free-text search. A company qualifies when its company_name OR any of
   * its contacts' full_name contains the query (ILIKE). Whole company —
   * including all contacts — comes back; the search is just the gate for
   * which companies appear, not a per-row filter. Empty / whitespace-only
   * = no search filter.
   */
  searchQuery?: string
  /**
   * Employee-range buckets to include. Labels must match SIZE_BUCKETS entries.
   * Empty / omitted = no size filter.
   */
  sizeFilter?: string[]
}

/**
 * Aggregate contacts → companies. One row per distinct company_name.
 *
 * Notes:
 *  - Companies without a `company_linkedin_url` still appear (so the user can
 *    see them) but the "Fetch employees" button is disabled in the UI.
 *  - signalScore is summed from contact-level signal_score, not from the
 *    signals table — slightly cheaper, and contacts.signal_score is already
 *    kept up-to-date by recordSignal.
 */
export async function getCompaniesWithSignals(
  workspaceId: string,
  since: Date | null = null,
  filter: CompanyFilterOptions = {},
): Promise<CompanyRow[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const queryText = `
    SELECT
      c.company_name                                  AS "companyName",
      MAX(c.company_linkedin_url)                     AS "companyLinkedinUrl",
      COUNT(DISTINCT c.id)::int                       AS "contactCount",
      COALESCE(SUM(c.signal_count), 0)::int           AS "signalCount",
      COALESCE(SUM(c.signal_score), 0)::int           AS "signalScore",
      MAX(c.last_signal_at)                           AS "lastSignalAt",
      MAX(e.fetched_at)                               AS "lastEnrichedAt",
      COALESCE(MAX(e.raw_count), 0)::int              AS "enrichmentCount",
      MAX(t.manual_stage)                             AS "manualStage",
      MIN(c.company_employees_min)                    AS "employeesMin",
      MAX(c.company_employees_max)                    AS "employeesMax",
      MAX(c.company_country)                          AS "country",
      -- Aggregate as JSON-array-of-arrays then flatten + dedupe in JS.
      -- to_jsonb(c.company_industries) converts each text[] to a jsonb
      -- value per-row first; jsonb_agg then collects them as opaque
      -- scalars. Without the per-row to_jsonb, Postgres aggregates as
      -- text[][] internally and trips "cannot accumulate arrays of
      -- different dimensionality" (2202E) whenever contacts at the same
      -- company carry industry lists of different lengths — which they
      -- do once data lands from multiple sources.
      COALESCE(
        jsonb_agg(to_jsonb(c.company_industries)) FILTER (
          WHERE c.company_industries IS NOT NULL
            AND array_length(c.company_industries, 1) > 0
        ),
        '[]'::jsonb
      )                                                AS "industriesNested",
      COALESCE(MAX(t.prospect_types), '{}'::text[])   AS "prospectTypes",
      MAX(t.assigned_team_member_id)                  AS "assignedTeamMemberId",
      MAX(t.website_domain)                           AS "websiteDomain",
      MAX(t.deal_mrr)                                 AS "dealMrr",
      MAX(m.domain_authority)                         AS "domainAuthority",
      MAX(m.fetched_at)                               AS "mozFetchedAt"
    FROM contacts c
    LEFT JOIN company_enrichments e
      ON e.workspace_id = c.workspace_id
     AND e.company_linkedin_url = c.company_linkedin_url
    LEFT JOIN company_tags t
      ON t.workspace_id = c.workspace_id
     AND t.company_name = c.company_name
    LEFT JOIN company_moz_data m
      ON m.workspace_id = c.workspace_id
     AND m.domain = t.website_domain
    WHERE c.workspace_id = $1
      AND c.company_name IS NOT NULL
      AND ($2::timestamptz IS NULL OR c.last_signal_at >= $2 OR c.last_signal_at IS NULL)
      AND (${teamFilterClause(filter.teamFilter)})
      -- Free-text search: gate on the COMPANY (not the contact), so a
      -- match brings the whole company aggregation along — not just the
      -- people whose names happened to match.
      AND (
        $3::text IS NULL
        OR c.company_name ILIKE '%' || $3 || '%'
        OR c.company_name IN (
          SELECT DISTINCT c2.company_name
          FROM contacts c2
          WHERE c2.workspace_id = $1
            AND (
              c2.full_name    ILIKE '%' || $3 || '%'
              OR c2.company_name ILIKE '%' || $3 || '%'
              OR c2.job_title    ILIKE '%' || $3 || '%'
            )
        )
      )
    -- No HAVING signal-count filter: companies with zero engagement
    -- (just imported, not yet engaged) land in the Prospect column.
    GROUP BY c.company_name
  `
  const trimmedQuery = filter.searchQuery?.trim() || null
  const rows = await db.query(queryText, [workspaceId, since ? since.toISOString() : null, trimmedQuery])
  const all = (rows as unknown as Array<Record<string, unknown>>).map((r) => {
    const score = r.signalScore as number
    const manualStage = (r.manualStage as string | null) ?? null
    const effectiveStage = manualStage ?? deriveCompanyStage(score)
    return {
      companyName:        r.companyName as string,
      companyLinkedinUrl: r.companyLinkedinUrl as string | null,
      contactCount:       r.contactCount as number,
      signalCount:        r.signalCount as number,
      signalScore:        score,
      lastSignalAt:       (r.lastSignalAt as Date | null)?.toISOString?.() ?? (r.lastSignalAt as string | null),
      lastEnrichedAt:     (r.lastEnrichedAt as Date | null)?.toISOString?.() ?? (r.lastEnrichedAt as string | null),
      enrichmentCount:    r.enrichmentCount as number,
      effectiveStage,
      employeesMin:       (r.employeesMin as number | null) ?? null,
      employeesMax:       (r.employeesMax as number | null) ?? null,
      country:            (r.country as string | null) ?? null,
      industries:         flattenIndustries(r.industriesNested),
      prospectTypes:      (r.prospectTypes as string[] | null) ?? [],
      assignedTeamMemberId: (r.assignedTeamMemberId as string | null) ?? null,
      manualStage,
      websiteDomain:    (r.websiteDomain as string | null) ?? null,
      domainAuthority:  (r.domainAuthority as number | null) ?? null,
      mozFetchedAt:     (r.mozFetchedAt as Date | null)?.toISOString?.() ?? (r.mozFetchedAt as string | null) ?? null,
      // Postgres NUMERIC comes back as a string via Neon; coerce to number.
      dealMrr:          r.dealMrr == null ? null : Number(r.dealMrr),
    }
  })
  return applyCompanyFilterAndSort(all, filter)
}

/**
 * Filter + sort helper shared by getCompaniesWithSignals and
 * getCompaniesWithContacts. Keeping this in JS rather than SQL keeps the
 * tagged-template queries above readable; result sets here are workspace-sized
 * (low thousands at most) so the cost is negligible.
 */
function applyCompanyFilterAndSort(rows: CompanyRow[], filter: CompanyFilterOptions): CompanyRow[] {
  const { includeProspectTypes, includeUntagged, sortMode = "recent-desc", sizeFilter } = filter
  let filtered = !includeProspectTypes && includeUntagged === undefined
    ? rows
    : rows.filter(r => {
        const isUntagged = !r.prospectTypes || r.prospectTypes.length === 0
        if (isUntagged) return includeUntagged ?? true
        if (!includeProspectTypes || includeProspectTypes.length === 0) return false
        return r.prospectTypes.some(pt => includeProspectTypes.includes(pt))
      })

  if (sizeFilter && sizeFilter.length > 0) {
    filtered = filtered.filter(r => {
      const cMin = r.employeesMin
      const cMax = r.employeesMax
      if (cMin === null && cMax === null) return false
      return sizeFilter.some(label => {
        const bucket = SIZE_BUCKETS.find(b => b.label === label)
        if (!bucket) return false
        const compMin = cMin ?? 0
        const compMax = cMax ?? Number.MAX_SAFE_INTEGER
        const bMax    = bucket.max ?? Number.MAX_SAFE_INTEGER
        return compMin <= bMax && compMax >= bucket.min
      })
    })
  }
  const cmpScoreDesc = (a: CompanyRow, b: CompanyRow) =>
    b.signalScore - a.signalScore || b.signalCount - a.signalCount
  const recentTime = (r: CompanyRow) => {
    const t = r.lastSignalAt
    return t ? new Date(t).getTime() : 0
  }
  const sorted = [...filtered]
  switch (sortMode) {
    case "score-asc":
      sorted.sort((a, b) => a.signalScore - b.signalScore || a.signalCount - b.signalCount)
      break
    case "score-desc":
      sorted.sort(cmpScoreDesc)
      break
    case "recent-asc":
      sorted.sort((a, b) => {
        const ta = recentTime(a), tb = recentTime(b)
        if (!ta && !tb) return cmpScoreDesc(a, b)
        if (!ta) return 1
        if (!tb) return -1
        return ta - tb || cmpScoreDesc(a, b)
      })
      break
    case "score-then-recent":
      sorted.sort((a, b) => {
        const scoreDiff = b.signalScore - a.signalScore || b.signalCount - a.signalCount
        if (scoreDiff !== 0) return scoreDiff
        const ta = recentTime(a), tb = recentTime(b)
        if (!ta && !tb) return 0
        if (!ta) return 1
        if (!tb) return -1
        return tb - ta
      })
      break
    case "recent-then-score":
      sorted.sort((a, b) => {
        const ta = recentTime(a), tb = recentTime(b)
        if (ta !== tb) {
          if (!ta) return 1
          if (!tb) return -1
          return tb - ta
        }
        return b.signalScore - a.signalScore || b.signalCount - a.signalCount
      })
      break
    case "recent-desc":
    default:
      sorted.sort((a, b) => {
        const ta = recentTime(a), tb = recentTime(b)
        if (!ta && !tb) return cmpScoreDesc(a, b)
        if (!ta) return 1
        if (!tb) return -1
        return tb - ta || cmpScoreDesc(a, b)
      })
  }
  return sorted
}

// ─── Companies with contacts (drives the Companies page unfurl view) ───────

export interface CompanyContactRow {
  id:           number
  fullName:     string | null
  jobTitle:     string | null
  linkedinUrl:  string | null
  twitterUrl:   string | null
  email:        string | null
  companyName:  string | null
  linkedinConnected: boolean | null
  /** True while a connect request is open: queued, sending, or sent (i.e.
   *  the worker has dispatched it but the recipient has not yet accepted
   *  or declined). Mirrors the DB partial unique index on linkedin_invite_queue
   *  so the UI shows the pending badge across the full open-invite window and
   *  doesn't prompt the user to re-invite contacts who already have one in
   *  flight. Used by the LinkedIn status chip to render the yellow up-arrow. */
  linkedinInvitePending: boolean
  signalScore:  number
  signalCount:  number
  lastSignalAt: string | Date | null
  /** The most recent signal's source_type (e.g. "Post Reaction"). null when the contact has no signals. */
  lastSignalType:  string | null
  lastSignalDescription: string | null
  /** Verb context for the most recent signal - lets the row render
   *  "Tom followed" instead of a bare source_type. */
  lastSignalVerb:        string | null
  lastSignalActor:       string | null
  lastSignalObject:      string | null
  lastVerbDescription:   string | null
  lastEngagementUrl:     string | null
  /** True for the contact at this company with the most signals — surfaced as a "Champion" pill. */
  isChampion: boolean
  doNotContactUntil: string | Date | null
}

export interface CompanyWithContactsRow extends CompanyRow {
  contacts: CompanyContactRow[]
}

/**
 * Attach a contacts[] array to each company in the supplied list. Pass
 * the slice you actually want to render — the LATERAL signal lookup
 * runs once per row, so unbounded inputs scaled poorly on workspaces
 * with thousands of companies. Companies dashboard composes this with
 * getCompaniesWithSignals and a JS-side slice for pagination.
 */
export async function attachContactsToCompanies(
  workspaceId: string,
  companies: CompanyRow[],
  since: Date | null = null,
  teamFilter?: TeamFilter,
): Promise<CompanyWithContactsRow[]> {
  if (!isDbConfigured() || companies.length === 0) {
    return companies.map(c => ({ ...c, contacts: [] }))
  }

  const db = sql()
  const names = companies.map(c => c.companyName)
  // Latest signal per contact via LATERAL JOIN. Inner contact list also
  // respects the team filter so an unfurled card only shows contacts the
  // selected team member should be looking at.
  const contactQueryText = `
    SELECT
      c.id,
      c.company_name      AS "companyName",
      c.full_name         AS "fullName",
      c.job_title         AS "jobTitle",
      c.linkedin_url      AS "linkedinUrl",
      c.twitter_url       AS "twitterUrl",
      c.email,
      c.linkedin_connected    AS "linkedinConnected",
      EXISTS (
        SELECT 1 FROM linkedin_invite_queue q
        WHERE q.workspace_id = c.workspace_id
          AND q.contact_id   = c.id
          AND q.status       IN ('queued', 'sending', 'sent')
      )                       AS "linkedinInvitePending",
      c.signal_score          AS "signalScore",
      c.signal_count          AS "signalCount",
      c.last_signal_at        AS "lastSignalAt",
      c.do_not_contact_until  AS "doNotContactUntil",
      s.source_type           AS "lastSignalType",
      s.description           AS "lastSignalDescription",
      s.signal_verb           AS "lastSignalVerb",
      s.signal_actor          AS "lastSignalActor",
      s.signal_object         AS "lastSignalObject",
      s.verb_description      AS "lastVerbDescription",
      s.engagement_url        AS "lastEngagementUrl"
    FROM contacts c
    LEFT JOIN company_tags t
      ON t.workspace_id = c.workspace_id
     AND t.company_name = c.company_name
    LEFT JOIN LATERAL (
      SELECT source_type, description, signal_verb, signal_actor, signal_object, verb_description, engagement_url
      FROM signals
      WHERE contact_id = c.id
      ORDER BY occurred_at DESC
      LIMIT 1
    ) s ON true
    WHERE c.workspace_id = $1
      AND c.company_name = ANY($2::text[])
      AND ($3::timestamptz IS NULL OR c.last_signal_at >= $3 OR c.last_signal_at IS NULL)
      AND (${teamFilterClause(teamFilter)})
    ORDER BY c.last_signal_at DESC NULLS LAST, c.signal_score DESC
  `
  const contactRows = await db.query(contactQueryText, [
    workspaceId,
    names,
    since ? since.toISOString() : null,
  ])

  type Row = {
    id: number
    companyName: string
    fullName: string | null
    jobTitle: string | null
    linkedinUrl: string | null
    twitterUrl: string | null
    email: string | null
    linkedinConnected: boolean | null
    linkedinInvitePending: boolean
    signalScore: number
    signalCount: number
    lastSignalAt: string | Date | null
    doNotContactUntil: string | Date | null
    lastSignalType: string | null
    lastSignalDescription: string | null
    lastSignalVerb: string | null
    lastSignalActor: string | null
    lastSignalObject: string | null
    lastVerbDescription: string | null
    lastEngagementUrl: string | null
  }
  const byCompany = new Map<string, CompanyContactRow[]>()
  for (const r of contactRows as unknown as Row[]) {
    const arr = byCompany.get(r.companyName) ?? []
    arr.push({
      id:                    r.id,
      fullName:              r.fullName,
      jobTitle:              r.jobTitle,
      linkedinUrl:           r.linkedinUrl,
      twitterUrl:            r.twitterUrl,
      email:                 r.email,
      companyName:           r.companyName,
      linkedinConnected:     r.linkedinConnected,
      linkedinInvitePending: r.linkedinInvitePending,
      signalScore:           r.signalScore,
      signalCount:           r.signalCount,
      lastSignalAt:          r.lastSignalAt,
      doNotContactUntil:     r.doNotContactUntil,
      lastSignalType:        r.lastSignalType,
      lastSignalDescription: r.lastSignalDescription,
      lastSignalVerb:        r.lastSignalVerb,
      lastSignalActor:       r.lastSignalActor,
      lastSignalObject:      r.lastSignalObject,
      lastVerbDescription:   r.lastVerbDescription,
      lastEngagementUrl:     r.lastEngagementUrl,
      isChampion:            false,
    })
    byCompany.set(r.companyName, arr)
  }

  // Mark the Champion at each company — the contact with the highest
  // signal_count, tie-broken by signal_score then by most-recent activity.
  // One champion per company. Only marked when the company has 2+ contacts:
  // a sole contact can't be the "most engaged" since there's no comparison.
  for (const list of byCompany.values()) {
    if (list.length < 2) continue
    let champ: CompanyContactRow | null = null
    for (const c of list) {
      if (c.signalCount <= 0) continue
      if (!champ
        || c.signalCount > champ.signalCount
        || (c.signalCount === champ.signalCount && c.signalScore > champ.signalScore)
      ) {
        champ = c
      }
    }
    if (champ) champ.isChampion = true
  }

  return companies.map(c => ({
    ...c,
    contacts: byCompany.get(c.companyName) ?? [],
  }))
}

// ─── Recent signals (drives the Signals page) ───────────────────────────────

export interface RecentSignalRow {
  id:             number
  occurredAt:     string | Date | null
  sourceType:     string | null
  description:    string | null
  engagementUrl:  string | null
  scoreDelta:     number
  signalVerb:     string | null
  signalActor:    string | null
  signalObject:   string | null
  verbDescription: string | null
  contactId:      number | null
  contactName:    string | null
  jobTitle:       string | null
  companyName:    string | null
  linkedinUrl:    string | null
}

/**
 * Latest signals across the workspace, joined with the parent contact.
 * Used by the Signals page so users can confirm ingestion is working without
 * scrolling through every contact.
 */
export async function getRecentSignals(
  workspaceId: string,
  limit = 200,
  onlyExcludedCompanies: boolean = false,
  teamFilter?: TeamFilter,
  offset: number = 0,
  verbFilter: string | null = null,
): Promise<RecentSignalRow[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const queryText = `
    SELECT
      s.id,
      s.occurred_at      AS "occurredAt",
      s.source_type      AS "sourceType",
      s.description,
      s.engagement_url   AS "engagementUrl",
      s.score_delta      AS "scoreDelta",
      s.signal_verb      AS "signalVerb",
      s.signal_actor     AS "signalActor",
      s.signal_object    AS "signalObject",
      s.verb_description AS "verbDescription",
      c.id               AS "contactId",
      c.full_name        AS "contactName",
      c.job_title        AS "jobTitle",
      c.company_name     AS "companyName",
      c.linkedin_url     AS "linkedinUrl"
    FROM signals s
    LEFT JOIN contacts c ON c.id = s.contact_id
    LEFT JOIN company_tags t
      ON t.workspace_id = c.workspace_id
     AND t.company_name = c.company_name
    WHERE s.workspace_id = $1
      AND CASE
            WHEN $2::bool THEN ('Excluded' = ANY(COALESCE(t.prospect_types, '{}'::text[])))
            ELSE NOT ('Excluded' = ANY(COALESCE(t.prospect_types, '{}'::text[])))
          END
      AND ($5::text IS NULL OR s.signal_verb = $5)
      AND (${teamFilterClause(teamFilter)})
    ORDER BY s.occurred_at DESC
    LIMIT $3 OFFSET $4
  `
  const rows = await db.query(queryText, [workspaceId, onlyExcludedCompanies, limit, offset, verbFilter])
  return rows as unknown as RecentSignalRow[]
}

/**
 * Count signals whose contact's company carries the "Excluded" prospect-type
 * tag. Workspace-wide — drives the "Excluded N" pill on the Signals page so
 * users can see what's being hidden by default.
 */
export async function countSignalsAtExcludedCompanies(
  workspaceId: string,
): Promise<number> {
  if (!isDbConfigured()) return 0
  const db = sql()
  const rows = await db`
    SELECT COUNT(*)::int AS n
    FROM signals s
    JOIN contacts c ON c.id = s.contact_id
    JOIN company_tags t
      ON t.workspace_id = c.workspace_id
     AND t.company_name = c.company_name
    WHERE s.workspace_id = ${workspaceId}
      AND 'Excluded' = ANY(t.prospect_types)
  `
  return (rows[0] as { n: number }).n
}

/**
 * Count signals matching the same filter set as getRecentSignals. Drives
 * the workspace-wide total pill on the Signals page (the page renders one
 * paginated chunk; this gives the user the full count).
 */
export async function countRecentSignals(
  workspaceId: string,
  onlyExcludedCompanies: boolean = false,
  teamFilter?: TeamFilter,
  verbFilter: string | null = null,
): Promise<number> {
  if (!isDbConfigured()) return 0
  const db = sql()
  const queryText = `
    SELECT COUNT(*)::int AS n
    FROM signals s
    LEFT JOIN contacts c ON c.id = s.contact_id
    LEFT JOIN company_tags t
      ON t.workspace_id = c.workspace_id
     AND t.company_name = c.company_name
    WHERE s.workspace_id = $1
      AND CASE
            WHEN $2::bool THEN ('Excluded' = ANY(COALESCE(t.prospect_types, '{}'::text[])))
            ELSE NOT ('Excluded' = ANY(COALESCE(t.prospect_types, '{}'::text[])))
          END
      AND ($3::text IS NULL OR s.signal_verb = $3)
      AND (${teamFilterClause(teamFilter)})
  `
  const rows = await db.query(queryText, [workspaceId, onlyExcludedCompanies, verbFilter])
  return (rows[0] as { n: number }).n
}

/**
 * Monthly signal aggregates for the Signals page trend chart. Returns
 * up to `months` consecutive month buckets ending at the current month,
 * each with a count of signal events and the summed score_delta. Months
 * with zero events are filled in JS so the X-axis stays continuous.
 *
 * Honours the same Excluded-companies gate as the listing query so the
 * chart matches what's visible below it.
 */
export interface SignalMonthBucket {
  month:    string  // YYYY-MM
  count:    number
  scoreSum: number
}

export async function getSignalsByMonth(
  workspaceId: string,
  months: number = 12,
  onlyExcludedCompanies: boolean = false,
  teamFilter?: TeamFilter,
  verbFilter: string | null = null,
): Promise<SignalMonthBucket[]> {
  if (!isDbConfigured()) return fillMonths(new Map(), months)
  const db = sql()
  const queryText = `
    SELECT
      to_char(date_trunc('month', s.occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month,
      COUNT(*)::int                             AS count,
      COALESCE(SUM(s.score_delta), 0)::int      AS score_sum
    FROM signals s
    LEFT JOIN contacts c ON c.id = s.contact_id
    LEFT JOIN company_tags t
      ON t.workspace_id = c.workspace_id
     AND t.company_name = c.company_name
    WHERE s.workspace_id = $1
      AND s.occurred_at >= date_trunc('month', NOW() AT TIME ZONE 'UTC') - ($2::int - 1) * INTERVAL '1 month'
      AND CASE
            WHEN $3::bool THEN ('Excluded' = ANY(COALESCE(t.prospect_types, '{}'::text[])))
            ELSE NOT ('Excluded' = ANY(COALESCE(t.prospect_types, '{}'::text[])))
          END
      AND ($4::text IS NULL OR s.signal_verb = $4)
      AND (${teamFilterClause(teamFilter)})
    GROUP BY 1
    ORDER BY 1
  `
  const rows = await db.query(queryText, [workspaceId, months, onlyExcludedCompanies, verbFilter])
  const byMonth = new Map<string, SignalMonthBucket>()
  for (const r of rows as unknown as Array<{ month: string; count: number; score_sum: number }>) {
    byMonth.set(r.month, { month: r.month, count: r.count, scoreSum: r.score_sum })
  }
  return fillMonths(byMonth, months)
}

/**
 * Distinct signal_verb values present in the workspace's signals, with
 * counts. Drives the filter dropdown on the Signals page. Using verb
 * rather than source_type keeps the options consistent with the
 * human-readable labels shown in the table.
 */
export interface SignalVerbCount {
  signalVerb: string
  count:      number
}

export async function listSignalVerbs(
  workspaceId: string,
  onlyExcludedCompanies: boolean = false,
): Promise<SignalVerbCount[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const queryText = `
    SELECT s.signal_verb AS "signalVerb", COUNT(*)::int AS count
    FROM signals s
    LEFT JOIN contacts c ON c.id = s.contact_id
    LEFT JOIN company_tags t
      ON t.workspace_id = c.workspace_id
     AND t.company_name = c.company_name
    WHERE s.workspace_id = $1
      AND s.signal_verb IS NOT NULL
      AND CASE
            WHEN $2::bool THEN ('Excluded' = ANY(COALESCE(t.prospect_types, '{}'::text[])))
            ELSE NOT ('Excluded' = ANY(COALESCE(t.prospect_types, '{}'::text[])))
          END
    GROUP BY 1
    ORDER BY count DESC
  `
  const rows = await db.query(queryText, [workspaceId, onlyExcludedCompanies])
  return rows as unknown as SignalVerbCount[]
}

function fillMonths(byMonth: Map<string, SignalMonthBucket>, months: number): SignalMonthBucket[] {
  const out: SignalMonthBucket[] = []
  const now = new Date()
  // Start at (months - 1) months ago, end at the current month.
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
    out.push(byMonth.get(key) ?? { month: key, count: 0, scoreSum: 0 })
  }
  return out
}

// ─── Company enrichments cache (Apify scrape results) ───────────────────────

export interface ApifyEmployee {
  fullName: string | null
  firstName: string | null
  lastName: string | null
  title: string
  linkedinUrl: string | null
  /** True when the title matched any configured persona pattern at fetch time (or the founder fallback regex). */
  titleMatch: boolean
  /** Name of the persona whose matchPatterns matched this title; null when no persona matched (or the workspace had none configured). */
  matchedPersona?: string | null
}

export interface CompanyEnrichmentRow {
  companyLinkedinUrl: string
  companyName: string | null
  fetchedAt: string
  rawCount: number
  matchCount: number
  employees: ApifyEmployee[]
}

export async function getCompanyEnrichment(
  workspaceId: string,
  companyLinkedinUrl: string,
): Promise<CompanyEnrichmentRow | null> {
  if (!isDbConfigured()) return null
  const db = sql()
  const rows = await db`
    SELECT
      company_linkedin_url AS "companyLinkedinUrl",
      company_name         AS "companyName",
      fetched_at           AS "fetchedAt",
      raw_count            AS "rawCount",
      match_count          AS "matchCount",
      employees
    FROM company_enrichments
    WHERE workspace_id = ${workspaceId}
      AND company_linkedin_url = ${companyLinkedinUrl}
    LIMIT 1
  `
  if (!rows.length) return null
  const r = rows[0] as Record<string, unknown>
  return {
    companyLinkedinUrl: r.companyLinkedinUrl as string,
    companyName:        (r.companyName as string | null) ?? null,
    fetchedAt:          (r.fetchedAt as Date)?.toISOString?.() ?? (r.fetchedAt as string),
    rawCount:           r.rawCount as number,
    matchCount:         r.matchCount as number,
    employees:          (r.employees as ApifyEmployee[]) ?? [],
  }
}

export async function saveCompanyEnrichment(
  workspaceId: string,
  data: {
    companyLinkedinUrl: string
    companyName?: string | null
    rawCount: number
    matchCount: number
    employees: ApifyEmployee[]
  },
): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  await db`
    INSERT INTO company_enrichments (
      workspace_id, company_linkedin_url, company_name,
      raw_count, match_count, employees, fetched_at
    ) VALUES (
      ${workspaceId}, ${data.companyLinkedinUrl}, ${data.companyName ?? null},
      ${data.rawCount}, ${data.matchCount}, ${JSON.stringify(data.employees)}::jsonb, NOW()
    )
    ON CONFLICT (workspace_id, company_linkedin_url) DO UPDATE SET
      company_name = COALESCE(EXCLUDED.company_name, company_enrichments.company_name),
      raw_count    = EXCLUDED.raw_count,
      match_count  = EXCLUDED.match_count,
      employees    = EXCLUDED.employees,
      fetched_at   = NOW()
  `
}

// ─── Moz domain data ──────────────────────────────────────────────────────────

export async function saveMozData(
  workspaceId: string,
  domain: string,
  data: {
    domainAuthority: number | null
    pageAuthority: number | null
    backlinks: number | null
    rootDomains: number | null
    spamScore: number | null
  },
): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  await db`
    INSERT INTO company_moz_data
      (workspace_id, domain, domain_authority, page_authority, backlinks, root_domains, spam_score, fetched_at)
    VALUES
      (${workspaceId}, ${domain}, ${data.domainAuthority ?? null}, ${data.pageAuthority ?? null},
       ${data.backlinks ?? null}, ${data.rootDomains ?? null}, ${data.spamScore ?? null}, NOW())
    ON CONFLICT (workspace_id, domain) DO UPDATE SET
      domain_authority = EXCLUDED.domain_authority,
      page_authority   = EXCLUDED.page_authority,
      backlinks        = EXCLUDED.backlinks,
      root_domains     = EXCLUDED.root_domains,
      spam_score       = EXCLUDED.spam_score,
      fetched_at       = NOW()
  `
  await db`
    INSERT INTO company_moz_history
      (workspace_id, domain, domain_authority, page_authority, backlinks, root_domains, spam_score, fetched_at)
    VALUES
      (${workspaceId}, ${domain}, ${data.domainAuthority ?? null}, ${data.pageAuthority ?? null},
       ${data.backlinks ?? null}, ${data.rootDomains ?? null}, ${data.spamScore ?? null}, NOW())
  `
}

/** Upserts company_tags.website_domain for a given company. */
export async function saveCompanyWebsiteDomain(
  workspaceId: string,
  companyName: string,
  websiteDomain: string | null,
): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  await db`
    INSERT INTO company_tags (workspace_id, company_name, website_domain, updated_at)
    VALUES (${workspaceId}, ${companyName}, ${websiteDomain}, NOW())
    ON CONFLICT (workspace_id, company_name) DO UPDATE SET
      website_domain = EXCLUDED.website_domain,
      updated_at     = NOW()
  `
}

// ─── Contact interests cache (Apify LinkedIn-Interests scrape results) ─────

export interface FollowedAccountRow {
  name: string
  linkedinUrl: string | null
  tagline: string | null
  followerCount: number | null
}

export interface LinkedinInterestsRow {
  contactId: number
  fetchedAt: string
  totalCount: number
  topVoices:   FollowedAccountRow[]
  companies:   FollowedAccountRow[]
  groups:      FollowedAccountRow[]
  newsletters: FollowedAccountRow[]
}

interface InterestsBlob {
  topVoices?:   FollowedAccountRow[]
  companies?:   FollowedAccountRow[]
  groups?:      FollowedAccountRow[]
  newsletters?: FollowedAccountRow[]
}

export async function getLinkedinInterests(
  workspaceId: string,
  contactId: number,
): Promise<LinkedinInterestsRow | null> {
  if (!isDbConfigured()) return null
  const db = sql()
  const rows = await db`
    SELECT
      contact_id    AS "contactId",
      fetched_at    AS "fetchedAt",
      total_count   AS "totalCount",
      interests
    FROM linkedin_interests
    WHERE workspace_id = ${workspaceId}
      AND contact_id   = ${contactId}
    LIMIT 1
  `
  if (!rows.length) return null
  const r = rows[0] as Record<string, unknown>
  const blob = (r.interests ?? {}) as InterestsBlob
  return {
    contactId:   r.contactId as number,
    fetchedAt:   (r.fetchedAt as Date)?.toISOString?.() ?? (r.fetchedAt as string),
    totalCount:  r.totalCount as number,
    topVoices:   blob.topVoices   ?? [],
    companies:   blob.companies   ?? [],
    groups:      blob.groups      ?? [],
    newsletters: blob.newsletters ?? [],
  }
}

export async function saveLinkedinInterests(
  workspaceId: string,
  contactId: number,
  data: {
    totalCount: number
    topVoices:   FollowedAccountRow[]
    companies:   FollowedAccountRow[]
    groups:      FollowedAccountRow[]
    newsletters: FollowedAccountRow[]
  },
): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  const blob: InterestsBlob = {
    topVoices:   data.topVoices,
    companies:   data.companies,
    groups:      data.groups,
    newsletters: data.newsletters,
  }
  await db`
    INSERT INTO linkedin_interests (
      workspace_id, contact_id, total_count, interests, fetched_at
    ) VALUES (
      ${workspaceId}, ${contactId}, ${data.totalCount}, ${JSON.stringify(blob)}::jsonb, NOW()
    )
    ON CONFLICT (workspace_id, contact_id) DO UPDATE SET
      total_count = EXCLUDED.total_count,
      interests   = EXCLUDED.interests,
      fetched_at  = NOW()
  `
}

// ─── X (Twitter) interests ──────────────────────────────────────────────────

export interface XInterestAccountRow {
  name:           string
  handle:         string
  profileUrl:     string | null
  bio:            string | null
  followerCount:  number | null
  verified:       boolean
}

export interface XInterestsRow {
  contactId:  number
  fetchedAt:  string
  totalCount: number
  /** Accounts the contact follows on X. Flat list — X doesn't categorise. */
  accounts:   XInterestAccountRow[]
}

interface XInterestsBlob {
  accounts?: XInterestAccountRow[]
}

/**
 * Resolve a contact by either a full twitter/x URL or a bare handle. We
 * normalise on both ends — strip trailing slashes from the URL form, strip
 * `@` from the handle form — so callers don't have to canonicalise.
 */
export async function findContactByTwitterUrl(
  workspaceId: string,
  twitterUrlOrHandle: string,
): Promise<number | null> {
  if (!isDbConfigured()) return null
  const db = sql()
  const trimmed = twitterUrlOrHandle.trim().replace(/^@/, "")
  const handle = (() => {
    if (!trimmed.includes("/") && !trimmed.includes(" ")) return trimmed
    const m = trimmed.match(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,15})/i)
    return m ? m[1] : null
  })()
  if (!handle) return null
  const norm = handle.toLowerCase()
  const rows = await db`
    SELECT id FROM contacts
    WHERE workspace_id = ${workspaceId}
      AND (
        LOWER(REGEXP_REPLACE(twitter_url, '/$', '')) = ${"https://x.com/" + norm}
        OR LOWER(REGEXP_REPLACE(twitter_url, '/$', '')) = ${"https://twitter.com/" + norm}
        OR LOWER(REGEXP_REPLACE(twitter_url, '/$', '')) = ${"https://www.x.com/" + norm}
        OR LOWER(REGEXP_REPLACE(twitter_url, '/$', '')) = ${"https://www.twitter.com/" + norm}
        OR LOWER(twitter_url) LIKE ${"%/" + norm}
      )
    LIMIT 1
  `
  return rows.length ? (rows[0] as { id: number }).id : null
}

export async function getXInterests(
  workspaceId: string,
  contactId: number,
): Promise<XInterestsRow | null> {
  if (!isDbConfigured()) return null
  const db = sql()
  const rows = await db`
    SELECT
      contact_id    AS "contactId",
      fetched_at    AS "fetchedAt",
      total_count   AS "totalCount",
      interests
    FROM x_interests
    WHERE workspace_id = ${workspaceId}
      AND contact_id   = ${contactId}
    LIMIT 1
  `
  if (!rows.length) return null
  const r = rows[0] as Record<string, unknown>
  const blob = (r.interests ?? {}) as XInterestsBlob
  return {
    contactId:  r.contactId as number,
    fetchedAt:  (r.fetchedAt as Date)?.toISOString?.() ?? (r.fetchedAt as string),
    totalCount: r.totalCount as number,
    accounts:   blob.accounts ?? [],
  }
}

export async function saveXInterests(
  workspaceId: string,
  contactId: number,
  data: { totalCount: number; accounts: XInterestAccountRow[] },
): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  const blob: XInterestsBlob = { accounts: data.accounts }
  await db`
    INSERT INTO x_interests (
      workspace_id, contact_id, total_count, interests, fetched_at
    ) VALUES (
      ${workspaceId}, ${contactId}, ${data.totalCount}, ${JSON.stringify(blob)}::jsonb, NOW()
    )
    ON CONFLICT (workspace_id, contact_id) DO UPDATE SET
      total_count = EXCLUDED.total_count,
      interests   = EXCLUDED.interests,
      fetched_at  = NOW()
  `
}

/** Silently skips if DB not configured — safe to call unconditionally. */
export async function safeUpsertContact(
  workspaceId: string,
  crmProvider: string,
  crmContactId: string,
  data: ContactUpsertData,
): Promise<number | null> {
  if (!isDbConfigured()) return null
  try {
    return await upsertContact(workspaceId, crmProvider, crmContactId, data)
  } catch (err) {
    console.error("[contact-store] upsertContact failed:", err)
    return null
  }
}

export interface PromoteApifyMatchesResult {
  /** Total matched profiles considered for promotion (input filter). */
  considered: number
  /** Newly inserted contacts (no existing linkedin_url match in this workspace). */
  promoted:   number
  /** Profiles skipped because they already exist as a contact (linkedin_url match). */
  alreadyContact: number
  /** Profiles skipped because they had no linkedin_url to dedupe on. */
  skippedNoLinkedin: number
}

/**
 * Promote Apify-fetched matched profiles to contacts in the Prospect stage.
 *
 * Called after a successful Fetch Employees run. Each profile whose title
 * matched one of the workspace's persona patterns becomes a contact with:
 *   • crm_provider = "apify-scrape" (so we know the source)
 *   • crm_contact_id = "apify:<linkedin slug>" (stable across refetches)
 *   • signal_count / signal_score = 0 (lands in Prospect)
 *   • persona = the matched persona name (set inline rather than waiting
 *     for the async classifier — we already know the answer)
 *
 * Skips profiles already present in the workspace under any provider
 * (looked up by linkedin_url). Skips profiles without a LinkedIn URL — we
 * can't dedupe them and don't want to risk duplicating people the SDR
 * already has from another source.
 */
export async function promoteApifyMatchesToContacts(
  workspaceId: string,
  context: {
    companyName?:        string | null
    companyLinkedinUrl?: string | null
  },
  profiles: Array<{
    fullName?:        string | null
    firstName?:       string | null
    lastName?:        string | null
    title?:           string
    linkedinUrl?:     string | null
    /** Apify-returned slug. Used in the crm_contact_id when present, falls back to URL-derived slug. */
    publicIdentifier?: string | null
    titleMatch?:      boolean
    matchedPersona?:  string | null
  }>,
): Promise<PromoteApifyMatchesResult> {
  const result: PromoteApifyMatchesResult = {
    considered:         0,
    promoted:           0,
    alreadyContact:     0,
    skippedNoLinkedin:  0,
  }
  if (!isDbConfigured()) return result

  for (const p of profiles) {
    if (!p.titleMatch) continue
    result.considered++

    const linkedinUrl = p.linkedinUrl?.trim() || null
    if (!linkedinUrl) {
      result.skippedNoLinkedin++
      continue
    }

    // Cheap dedupe: any provider's contact with this linkedin_url already
    // covers this person. Don't write a duplicate row.
    const existing = await findContactByLinkedin(workspaceId, linkedinUrl)
    if (existing != null) {
      result.alreadyContact++
      continue
    }

    // Stable id keyed on the LinkedIn slug so re-running Fetch Employees
    // for the same company is idempotent (becomes an UPDATE rather than
    // a duplicate INSERT). Prefer the slug Apify reported directly over
    // parsing it back out of the URL - they should agree, but the
    // direct value avoids subtle differences (case, trailing /).
    const slug = (
      p.publicIdentifier?.toLowerCase()
      ?? linkedinUrl.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//i, "").replace(/\/$/, "").toLowerCase()
    )
    const crmContactId = `apify:${slug || linkedinUrl.toLowerCase()}`

    const id = await safeUpsertContact(workspaceId, "apify-scrape", crmContactId, {
      linkedinUrl,
      firstName:          p.firstName ?? undefined,
      lastName:           p.lastName ?? undefined,
      fullName:           p.fullName ?? undefined,
      jobTitle:           p.title?.trim() || undefined,
      companyName:        context.companyName        ?? undefined,
      companyLinkedinUrl: context.companyLinkedinUrl ?? undefined,
    })
    if (id == null) continue
    result.promoted++

    // Set persona inline since we already know the match. Saves a round-trip
    // through the async classifier and survives re-classification because
    // the classifier writes the same column with the same logic.
    if (p.matchedPersona) {
      const db = sql()
      await db`UPDATE contacts SET persona = ${p.matchedPersona} WHERE id = ${id}`
    }
  }

  return result
}

// ─── Reports: funnel velocity ─────────────────────────────────────────────────

export interface StageTransitionRow {
  companyName:    string
  fromStage:      string | null
  toStage:        string
  transitionedAt: string
  trigger:        string
}

export interface StageVelocityRow {
  fromStage:    string
  toStage:      string
  totalCount:   number
  last30Days:   number
  avgDays:      number | null
}

export interface StageSummaryRow {
  stage:   string
  netNew:  number        // companies that entered this stage in the last 30 days
  avgDays: number | null // avg days companies spent (or have been) in this stage
}

export interface CompanyFunnelMetric {
  stage:                   string
  companyCount:            number   // companies currently at this stage
  mrrTotal:                number   // sum of deal_mrr across companies currently at this stage
  conversionToWonPct:      number | null  // % of companies ever-at-this-stage that are now at Customer Won
  everCount:               number   // companies that have ever been at this stage (transitions + current)
  wonOfEver:               number   // of the above, how many are now at Customer Won
}

/**
 * Per-stage funnel report metrics used on the Reports page header:
 *   - companyCount: companies currently at the stage
 *   - mrrTotal: accumulated deal_mrr for those companies
 *   - conversionToWonPct: of companies that *ever* reached this stage
 *     (via company_stage_transitions.to_stage = X, plus any currently
 *     at X), what fraction are now at Customer Won. Customer Won itself
 *     returns null - the conversion is trivially 100% by definition.
 *
 * Companies are derived from `contacts` aggregated by company_name
 * (same caveat as the Companies page); their effective stage is
 * COALESCE(company_tags.manual_stage, deriveCompanyStage(signal_score)).
 */
export async function getCompanyFunnelMetrics(workspaceId: string): Promise<CompanyFunnelMetric[]> {
  if (!isDbConfigured()) return []
  const db = sql()

  // Current state: per company, what's their effective stage and MRR?
  const currentRows = await db<{ company_name: string; manual_stage: string | null; signal_score: number; deal_mrr: string | null }>`
    SELECT c.company_name,
           MAX(t.manual_stage)            AS manual_stage,
           COALESCE(SUM(c.signal_score), 0)::int AS signal_score,
           MAX(t.deal_mrr)::text          AS deal_mrr
    FROM   contacts c
    LEFT JOIN company_tags t
           ON t.workspace_id = c.workspace_id
          AND t.company_name = c.company_name
    WHERE  c.workspace_id = ${workspaceId}
      AND  c.company_name IS NOT NULL AND c.company_name <> ''
    GROUP  BY c.company_name
  `

  type Current = { stage: string; mrr: number }
  const currentByCompany = new Map<string, Current>()
  for (const r of currentRows) {
    const effective = r.manual_stage ?? deriveCompanyStage(r.signal_score)
    currentByCompany.set(r.company_name, {
      stage: effective,
      mrr:   r.deal_mrr == null ? 0 : Number(r.deal_mrr),
    })
  }

  // Transition history: which stages has each company ever been at?
  const transitionRows = await db<{ company_name: string; to_stage: string }>`
    SELECT DISTINCT company_name, to_stage
    FROM   company_stage_transitions
    WHERE  workspace_id = ${workspaceId}
      AND  to_stage IS NOT NULL
  `

  const everByStage = new Map<string, Set<string>>()
  for (const r of transitionRows) {
    if (!everByStage.has(r.to_stage)) everByStage.set(r.to_stage, new Set())
    everByStage.get(r.to_stage)!.add(r.company_name)
  }
  // Add currents into ever as well - a company currently at X has been at X.
  for (const [name, c] of currentByCompany) {
    if (!everByStage.has(c.stage)) everByStage.set(c.stage, new Set())
    everByStage.get(c.stage)!.add(name)
  }

  // Stages we report on - one per company funnel position.
  const STAGES = [
    "Prospect", "Signal Found", "Engaged", "High Signal", "Discovery Call",
    "Requested Information", "Sent Information", "Follow Up Call",
    "Diligence", "Contract Negotiation", "Customer Won",
  ]

  // Currently-at-Customer-Won companies (used in conversion calculation).
  const wonNow = new Set<string>()
  for (const [name, c] of currentByCompany) {
    if (c.stage === "Customer Won") wonNow.add(name)
  }

  const out: CompanyFunnelMetric[] = []
  for (const stage of STAGES) {
    let companyCount = 0
    let mrrTotal = 0
    for (const c of currentByCompany.values()) {
      if (c.stage === stage) { companyCount++; mrrTotal += c.mrr }
    }
    const everSet = everByStage.get(stage) ?? new Set()
    const everCount = everSet.size
    let wonOfEver = 0
    for (const name of everSet) if (wonNow.has(name)) wonOfEver++

    const conversion = stage === "Customer Won"
      ? null
      : (everCount > 0 ? (wonOfEver / everCount) * 100 : null)

    out.push({
      stage,
      companyCount,
      mrrTotal,
      conversionToWonPct: conversion,
      everCount,
      wonOfEver,
    })
  }
  return out
}

/**
 * Per-stage summary: net-new entrants in the last 30 days and average time
 * spent in each stage, computed from the transitions log.
 */
export async function getStageSummary(workspaceId: string): Promise<StageSummaryRow[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const rows = await db`
    WITH entries AS (
      SELECT
        to_stage                                                AS stage,
        transitioned_at                                         AS entered_at,
        LEAD(transitioned_at) OVER (
          PARTITION BY workspace_id, company_name
          ORDER BY transitioned_at
        )                                                       AS exited_at
      FROM company_stage_transitions
      WHERE workspace_id = ${workspaceId}
    )
    SELECT
      stage,
      COUNT(*) FILTER (
        WHERE entered_at >= NOW() - INTERVAL '30 days'
      )::int                                                    AS "netNew",
      ROUND(
        AVG(
          EXTRACT(EPOCH FROM (COALESCE(exited_at, NOW()) - entered_at))
          / 86400.0
        )::numeric, 1
      )                                                         AS "avgDays"
    FROM entries
    WHERE stage IS NOT NULL
    GROUP BY stage
  `
  return (rows as unknown as Array<{ stage: string; netNew: number; avgDays: string | null }>).map(r => ({
    stage:   r.stage,
    netNew:  r.netNew,
    avgDays: r.avgDays !== null ? Number(r.avgDays) : null,
  }))
}

/** Most recent N stage transitions for a workspace. */
export async function getRecentStageTransitions(
  workspaceId: string,
  limit = 20,
): Promise<StageTransitionRow[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const rows = await db`
    SELECT
      company_name    AS "companyName",
      from_stage      AS "fromStage",
      to_stage        AS "toStage",
      transitioned_at AS "transitionedAt",
      trigger
    FROM company_stage_transitions
    WHERE workspace_id = ${workspaceId}
    ORDER BY transitioned_at DESC
    LIMIT ${limit}
  `
  return rows as unknown as StageTransitionRow[]
}

/**
 * Per-transition-pair velocity metrics.
 * avg_days is the mean time (in days) a company spent in from_stage before
 * progressing, computed by pairing each transition with the immediately
 * preceding transition for the same company.
 */
export async function getStageTransitionVelocity(
  workspaceId: string,
): Promise<StageVelocityRow[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const rows = await db`
    WITH ordered AS (
      SELECT
        company_name,
        from_stage,
        to_stage,
        transitioned_at,
        LAG(transitioned_at) OVER (
          PARTITION BY workspace_id, company_name
          ORDER BY transitioned_at
        ) AS prev_at
      FROM company_stage_transitions
      WHERE workspace_id = ${workspaceId}
        AND from_stage IS NOT NULL
    )
    SELECT
      from_stage                                                        AS "fromStage",
      to_stage                                                          AS "toStage",
      COUNT(*)::int                                                     AS "totalCount",
      COUNT(*) FILTER (
        WHERE transitioned_at >= NOW() - INTERVAL '30 days'
      )::int                                                            AS "last30Days",
      ROUND(
        AVG(
          EXTRACT(EPOCH FROM (transitioned_at - prev_at)) / 86400.0
        )::numeric,
        1
      )                                                                 AS "avgDays"
    FROM ordered
    WHERE from_stage IS NOT NULL
    GROUP BY from_stage, to_stage
    ORDER BY from_stage, to_stage
  `
  return (rows as unknown as Array<{
    fromStage: string
    toStage:   string
    totalCount: number
    last30Days: number
    avgDays: string | null
  }>).map(r => ({
    fromStage:  r.fromStage,
    toStage:    r.toStage,
    totalCount: r.totalCount,
    last30Days: r.last30Days,
    avgDays:    r.avgDays !== null ? Number(r.avgDays) : null,
  }))
}

export interface FunnelConversionRow {
  stage:          string
  entered:        number  // distinct companies that entered this stage
  convertedToDc:  number  // of those, how many eventually reached Discovery Call
  conversionPct:  number | null
  stalled:        number  // companies whose highest stage is still this one
}

/**
 * Conversion funnel: for each funnel stage, how many companies entered it,
 * how many eventually reached Discovery Call, and how many are stalled there.
 */
export async function getFunnelConversion(workspaceId: string): Promise<FunnelConversionRow[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const rows = await db`
    WITH
    -- Distinct (company, stage) pairs — each company counted once per stage
    entered AS (
      SELECT DISTINCT company_name, to_stage AS stage
      FROM company_stage_transitions
      WHERE workspace_id = ${workspaceId}
        AND to_stage IN ('Prospect', 'Signal Found', 'Engaged', 'High Signal')
    ),
    -- Companies that reached Discovery Call
    reached_dc AS (
      SELECT DISTINCT company_name
      FROM company_stage_transitions
      WHERE workspace_id = ${workspaceId}
        AND to_stage = 'Discovery Call'
    ),
    -- Each company's highest stage rank
    company_max AS (
      SELECT
        company_name,
        MAX(CASE to_stage
          WHEN 'Prospect'       THEN 1
          WHEN 'Signal Found'   THEN 2
          WHEN 'Engaged'        THEN 3
          WHEN 'High Signal'    THEN 4
          WHEN 'Discovery Call' THEN 5
          ELSE 0
        END) AS max_rank
      FROM company_stage_transitions
      WHERE workspace_id = ${workspaceId}
      GROUP BY company_name
    ),
    stage_ranks(stage, rank) AS (
      VALUES
        ('Prospect',     1),
        ('Signal Found', 2),
        ('Engaged',      3),
        ('High Signal',  4)
    )
    SELECT
      sr.stage,
      COUNT(e.company_name)::int                                          AS entered,
      COUNT(r.company_name)::int                                          AS "convertedToDc",
      ROUND(
        COUNT(r.company_name) * 100.0 / NULLIF(COUNT(e.company_name), 0),
        1
      )                                                                   AS "conversionPct",
      COUNT(*) FILTER (WHERE cm.max_rank = sr.rank)::int                  AS stalled
    FROM stage_ranks sr
    LEFT JOIN entered     e  ON e.stage        = sr.stage
    LEFT JOIN reached_dc  r  ON r.company_name = e.company_name
    LEFT JOIN company_max cm ON cm.company_name = e.company_name
    GROUP BY sr.stage, sr.rank
    ORDER BY sr.rank
  `
  return (rows as unknown as Array<{
    stage: string
    entered: number
    convertedToDc: number
    conversionPct: string | null
    stalled: number
  }>).map(r => ({
    stage:         r.stage,
    entered:       r.entered,
    convertedToDc: r.convertedToDc,
    conversionPct: r.conversionPct !== null ? Number(r.conversionPct) : null,
    stalled:       r.stalled,
  }))
}

// ─── Follow campaign stats ────────────────────────────────────────────────────

export interface FollowCampaignRow {
  campaignName:    string
  actor:           string
  totalFollows:    number
  uniqueContacts:  number
  signalFound:     number
  engaged:         number
  highSignal:      number
  discoveryCall:   number
  customerWon:     number
  firstAt:         string | null
  lastAt:          string | null
}

export async function getFollowCampaignStats(
  workspaceId: string,
  campaigns:   string[],
): Promise<FollowCampaignRow[]> {
  if (!isDbConfigured() || campaigns.length === 0) return []
  const db = sql()
  const rows = await db<{
    campaign_name:   string
    actor:           string
    total_follows:   number
    unique_contacts: number
    signal_found:    number
    engaged:         number
    high_signal:     number
    discovery_call:  number
    customer_won:    number
    first_at:        string | null
    last_at:         string | null
  }>`
    SELECT
      COALESCE(s.verb_description, 'Unknown')           AS campaign_name,
      COALESCE(s.signal_actor,     'Unknown')           AS actor,
      COUNT(*)::int                                     AS total_follows,
      COUNT(DISTINCT s.contact_id)::int                 AS unique_contacts,
      COUNT(DISTINCT CASE WHEN c.funnel_stage = 'Signal Found'   THEN s.contact_id END)::int AS signal_found,
      COUNT(DISTINCT CASE WHEN c.funnel_stage = 'Engaged'        THEN s.contact_id END)::int AS engaged,
      COUNT(DISTINCT CASE WHEN c.funnel_stage = 'High Signal'    THEN s.contact_id END)::int AS high_signal,
      COUNT(DISTINCT CASE WHEN c.funnel_stage = 'Discovery Call' THEN s.contact_id END)::int AS discovery_call,
      COUNT(DISTINCT CASE WHEN c.funnel_stage = 'Customer Won'   THEN s.contact_id END)::int AS customer_won,
      MIN(s.occurred_at)::text                          AS first_at,
      MAX(s.occurred_at)::text                          AS last_at
    FROM   signals s
    JOIN   contacts c ON c.id = s.contact_id AND c.workspace_id = s.workspace_id
    WHERE  s.workspace_id    = ${workspaceId}
      AND  s.source_type     = 'LinkedIn Follow (Dripify)'
      AND  s.verb_description = ANY(${campaigns})
    GROUP  BY s.verb_description, s.signal_actor
    ORDER  BY total_follows DESC
  `
  return rows.map(r => ({
    campaignName:   r.campaign_name,
    actor:          r.actor,
    totalFollows:   r.total_follows,
    uniqueContacts: r.unique_contacts,
    signalFound:    r.signal_found,
    engaged:        r.engaged,
    highSignal:     r.high_signal,
    discoveryCall:  r.discovery_call,
    customerWon:    r.customer_won,
    firstAt:        r.first_at,
    lastAt:         r.last_at,
  }))
}

// ─── Outreach log helpers ─────────────────────────────────────────────────────

export async function recordOutreach(args: {
  workspaceId:    string
  contactId:      number
  channel:        "dm" | "email"
  messagePreview: string
  persona:        string | null
  stage:          string | null
  templateIds:    string[]
  chatId:         string | null
  messageId:      string | null
  /**
   * style_fingerprints.id whose voice produced this send. NULL when the user
   * typed the message manually / picked a template without running AI.
   * Drives per-version performance attribution + powers the Phase 4 refit
   * loop's outreach-log -> style-samples projection.
   */
  fingerprintVersionId?: number | null
  /**
   * Channels refactor (PR A column, PR D wiring): absolute attribution.
   * When the contact is enrolled in exactly one campaign on the channel,
   * send-dm / send-email auto-derive these so per-campaign stats populate
   * without UI changes. NULL on manual / unenrolled sends.
   */
  campaignId?:      string | null
  coverageMvprId?:  string | null
}): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  await db`
    INSERT INTO outreach_log
      (workspace_id, contact_id, channel, message_preview, persona, stage,
       template_ids, chat_id, message_id, fingerprint_version_id,
       campaign_id, coverage_mvpr_id)
    VALUES
      (${args.workspaceId}, ${args.contactId}, ${args.channel},
       ${args.messagePreview}, ${args.persona}, ${args.stage},
       ${args.templateIds.length > 0 ? args.templateIds : null},
       ${args.chatId}, ${args.messageId},
       ${args.fingerprintVersionId ?? null},
       ${args.campaignId ?? null}, ${args.coverageMvprId ?? null})
  `
}

export async function getLatestUnrespondedOutreach(
  workspaceId: string,
  contactId:   number,
): Promise<{ id: number; occurred_at: string } | null> {
  if (!isDbConfigured()) return null
  const db = sql()
  const rows = await db`
    SELECT id, occurred_at
    FROM outreach_log
    WHERE workspace_id = ${workspaceId}
      AND contact_id   = ${contactId}
      AND responded_at IS NULL
    ORDER BY occurred_at DESC
    LIMIT 1
  `
  const row = rows[0] as { id: number; occurred_at: Date } | undefined
  if (!row) return null
  return {
    id:          row.id,
    occurred_at: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
  }
}

export async function markOutreachResponded(id: number, respondedAt: Date): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  await db`UPDATE outreach_log SET responded_at = ${respondedAt} WHERE id = ${id} AND responded_at IS NULL`
}

export async function markOutreachBooked(contactId: number, bookedAt: Date): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  await db`
    UPDATE outreach_log
    SET booking_at = ${bookedAt}
    WHERE id = (
      SELECT id FROM outreach_log
      WHERE contact_id = ${contactId}
        AND booking_at IS NULL
        AND occurred_at <= ${bookedAt}
      ORDER BY occurred_at DESC
      LIMIT 1
    )
  `
}

export interface OutreachTemplateStatRow {
  templateId: string
  sent:       number
  responded:  number
  booked:     number
}

export async function getOutreachTemplateStats(workspaceId: string): Promise<OutreachTemplateStatRow[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const rows = await db`
    SELECT
      tid                       AS "templateId",
      COUNT(*)::int             AS sent,
      COUNT(responded_at)::int  AS responded,
      COUNT(booking_at)::int    AS booked
    FROM outreach_log, UNNEST(template_ids) AS tid
    WHERE workspace_id = ${workspaceId}
    GROUP BY tid
  `
  return rows as unknown as OutreachTemplateStatRow[]
}

export interface OutreachStatsResult {
  sent:         number
  responded:    number
  booked:       number
  won:          number
  responseRate: number | null
  bookingRate:  number | null
  winRate:      number | null
  byTemplate:   Array<{
    templateId:   string
    sent:         number
    responded:    number
    booked:       number
    won:          number
    responseRate: number | null
    bookingRate:  number | null
    winRate:      number | null
  }>
}

export async function getOutreachStats(
  workspaceId: string,
  since: Date = new Date(0),
  channel = 'dm',
  /** Optional Custom Tag filter. When set, only outreach against contacts
   *  whose company carries this prospect_types entry counts. */
  prospectType?: string | null,
): Promise<OutreachStatsResult> {
  const empty = { sent: 0, responded: 0, booked: 0, won: 0, responseRate: null, bookingRate: null, winRate: null, byTemplate: [] }
  if (!isDbConfigured()) return empty
  const db = sql()
  const tag = prospectType ?? null

  const summaryRows = await db`
    SELECT
      COUNT(*)::int                                                    AS sent,
      COUNT(o.responded_at)::int                                       AS responded,
      COUNT(o.booking_at)::int                                         AS booked,
      COUNT(*) FILTER (
        WHERE t.manual_stage = 'Customer Won'
      )::int                                                           AS won
    FROM outreach_log o
    JOIN contacts c ON c.id = o.contact_id
    LEFT JOIN company_tags t
      ON  t.workspace_id = c.workspace_id
      AND t.company_name = c.company_name
    WHERE o.workspace_id = ${workspaceId}
      AND o.channel      = ${channel}
      AND o.occurred_at >= ${since}
      AND (${tag}::text IS NULL OR ${tag}::text = ANY(t.prospect_types))
  `
  const s = summaryRows[0] as { sent: number; responded: number; booked: number; won: number }
  if (!s) return empty

  const templateRows = await db`
    SELECT
      tid                                              AS "templateId",
      COUNT(*)::int                                    AS sent,
      COUNT(o.responded_at)::int                       AS responded,
      COUNT(o.booking_at)::int                         AS booked,
      COUNT(*) FILTER (
        WHERE t.manual_stage = 'Customer Won'
      )::int                                           AS won
    FROM outreach_log o
    JOIN contacts c ON c.id = o.contact_id
    LEFT JOIN company_tags t
      ON  t.workspace_id = c.workspace_id
      AND t.company_name = c.company_name,
    UNNEST(o.template_ids) AS tid
    WHERE o.workspace_id = ${workspaceId}
      AND o.channel      = ${channel}
      AND o.occurred_at >= ${since}
      AND (${tag}::text IS NULL OR ${tag}::text = ANY(t.prospect_types))
    GROUP BY tid
    ORDER BY COUNT(*) DESC
  `

  const rate = (n: number, d: number) => d > 0 ? Math.round((n / d) * 100) : null

  return {
    sent:         s.sent,
    responded:    s.responded,
    booked:       s.booked,
    won:          s.won,
    responseRate: rate(s.responded, s.sent),
    bookingRate:  rate(s.booked, s.sent),
    winRate:      rate(s.won, s.sent),
    byTemplate:   (templateRows as unknown as Array<OutreachTemplateStatRow & { won: number }>).map(r => ({
      templateId:   r.templateId,
      sent:         r.sent,
      responded:    r.responded,
      booked:       r.booked,
      won:          r.won,
      responseRate: rate(r.responded, r.sent),
      bookingRate:  rate(r.booked, r.sent),
      winRate:      rate(r.won, r.sent),
    })),
  }
}

export interface CallLogRow {
  signalId:        number
  contactId:       number
  fullName:        string | null
  jobTitle:        string | null
  companyName:     string | null
  linkedinUrl:     string | null
  effectiveStage:  string | null
  signalScore:     number
  lastSignalType:  string | null
  lastSignalAt:    string | null
  notes:           string | null
  occurredAt:      string
  sourceType:      string | null
}

export interface CallStatsResult {
  total:       number  // connected + voicemail
  answered:    number  // source_type = 'Call'
  voicemail:   number  // source_type = 'Call (Voicemail)'
  answerRate:  number | null
  bookingRate: number | null
  winRate:     number | null
  log:         CallLogRow[]
}

/**
 * Workspace-wide call signals grouped into the Companies -> People -> Calls
 * tree the Outbound Calls channel expands to. Mirrors the campaign-unfurl
 * shape (UnfurlCompanyRow / UnfurlContactRow) so the same client component
 * pattern renders both.
 *
 * Calls aren't enrolled in campaigns - they're per-contact signals with
 * source_type IN ('Call', 'Call (Voicemail)'). This helper joins those to
 * contacts, groups by company_name, then attaches the 5 most recent calls
 * per contact.
 */
export interface CallTreeCall {
  signalId:    number
  sourceType:  string
  occurredAt:  string
  notes:       string | null
}

export interface CallTreeContact {
  id:            number
  fullName:      string | null
  jobTitle:      string | null
  linkedinUrl:   string | null
  signalScore:   number
  callCount:     number
  recentCalls:   CallTreeCall[]
}

export interface CallTreeCompany {
  companyName:   string
  contactCount:  number
  contacts:      CallTreeContact[]
}

export async function getCallLogTree(
  workspaceId: string,
  since: Date = new Date(0),
): Promise<CallTreeCompany[]> {
  if (!isDbConfigured()) return []
  const db = sql()

  const calls = await db<{
    signal_id:     number
    source_type:   string
    occurred_at:   Date
    description:   string | null
    contact_id:    number
    full_name:     string | null
    job_title:     string | null
    linkedin_url:  string | null
    signal_score:  number
    company_name:  string | null
    rn:            number
  }>`
    SELECT signal_id, source_type, occurred_at, description, contact_id,
           full_name, job_title, linkedin_url, signal_score, company_name, rn
    FROM (
      SELECT
        s.id          AS signal_id,
        s.source_type,
        s.occurred_at,
        s.description,
        c.id          AS contact_id,
        c.full_name,
        c.job_title,
        c.linkedin_url,
        c.signal_score,
        c.company_name,
        ROW_NUMBER() OVER (PARTITION BY c.id ORDER BY s.occurred_at DESC) AS rn
      FROM signals s
      JOIN contacts c ON c.id = s.contact_id
      WHERE c.workspace_id = ${workspaceId}
        AND s.source_type IN ('Call', 'Call (Voicemail)')
        AND s.occurred_at >= ${since}
    ) t
    WHERE rn <= 5
    ORDER BY contact_id, rn ASC
  `
  if (calls.length === 0) return []

  const contactCallCount = new Map<number, number>()
  const callsByContact   = new Map<number, CallTreeCall[]>()
  const contactMeta      = new Map<number, {
    fullName: string | null; jobTitle: string | null; linkedinUrl: string | null;
    signalScore: number; companyName: string | null
  }>()

  for (const r of calls) {
    if (!contactMeta.has(r.contact_id)) {
      contactMeta.set(r.contact_id, {
        fullName:    r.full_name,
        jobTitle:    r.job_title,
        linkedinUrl: r.linkedin_url,
        signalScore: r.signal_score,
        companyName: r.company_name,
      })
    }
    const list = callsByContact.get(r.contact_id) ?? []
    list.push({
      signalId:   r.signal_id,
      sourceType: r.source_type,
      occurredAt: r.occurred_at.toISOString(),
      notes:      r.description,
    })
    callsByContact.set(r.contact_id, list)
  }

  // Get the true call-count per contact (separate query since the inner
  // window-function caps to 5).
  const counts = await db<{ contact_id: number; n: number }>`
    SELECT s.contact_id, COUNT(*)::int AS n
    FROM signals s
    JOIN contacts c ON c.id = s.contact_id
    WHERE c.workspace_id = ${workspaceId}
      AND s.source_type IN ('Call', 'Call (Voicemail)')
      AND s.occurred_at >= ${since}
    GROUP BY s.contact_id
  `
  for (const r of counts) contactCallCount.set(r.contact_id, r.n)

  const byCompany = new Map<string, CallTreeContact[]>()
  for (const [contactId, meta] of contactMeta.entries()) {
    const companyName = meta.companyName ?? "Unknown company"
    const list = byCompany.get(companyName) ?? []
    list.push({
      id:           contactId,
      fullName:     meta.fullName,
      jobTitle:     meta.jobTitle,
      linkedinUrl:  meta.linkedinUrl,
      signalScore:  meta.signalScore,
      callCount:    contactCallCount.get(contactId) ?? 0,
      recentCalls:  callsByContact.get(contactId) ?? [],
    })
    byCompany.set(companyName, list)
  }

  return Array.from(byCompany.entries())
    .map(([companyName, contacts]) => ({
      companyName,
      contactCount: contacts.length,
      contacts:     contacts.sort((a, b) => b.callCount - a.callCount),
    }))
    .sort((a, b) => b.contactCount - a.contactCount)
}

/** Call stats + recent log for the last N days. */
export async function getCallStats(
  workspaceId: string,
  since: Date = new Date(0),
  limit = 50,
  /** Optional Custom Tag filter (matches company_tags.prospect_types). */
  prospectType?: string | null,
): Promise<CallStatsResult> {
  const empty: CallStatsResult = { total: 0, answered: 0, voicemail: 0, answerRate: null, bookingRate: null, winRate: null, log: [] }
  if (!isDbConfigured()) return empty
  const db = sql()
  const tag = prospectType ?? null

  // Counts by type
  const countRows = await db`
    SELECT s.source_type, COUNT(*)::int AS n
    FROM signals s
    JOIN contacts c ON c.id = s.contact_id
    LEFT JOIN company_tags t
      ON  t.workspace_id = c.workspace_id
      AND t.company_name = c.company_name
    WHERE c.workspace_id = ${workspaceId}
      AND s.source_type IN ('Call', 'Call (Voicemail)')
      AND s.occurred_at >= ${since}
      AND (${tag}::text IS NULL OR ${tag}::text = ANY(t.prospect_types))
    GROUP BY s.source_type
  `
  const counts = countRows as unknown as Array<{ source_type: string; n: number }>
  const answered = counts.find(r => r.source_type === "Call")?.n ?? 0
  const voicemail = counts.find(r => r.source_type === "Call (Voicemail)")?.n ?? 0
  const total = answered + voicemail

  // Booking rate: distinct contacts with a connected call who later booked a meeting
  const bookedRows = await db`
    SELECT COUNT(DISTINCT s.contact_id)::int AS n
    FROM signals s
    JOIN contacts c ON c.id = s.contact_id
    LEFT JOIN company_tags t
      ON  t.workspace_id = c.workspace_id
      AND t.company_name = c.company_name
    WHERE c.workspace_id = ${workspaceId}
      AND s.source_type  = 'Call'
      AND s.occurred_at >= ${since}
      AND (${tag}::text IS NULL OR ${tag}::text = ANY(t.prospect_types))
      AND EXISTS (
        SELECT 1 FROM signals b
        WHERE b.contact_id   = s.contact_id
          AND b.signal_verb  = 'booked_meeting'
          AND b.occurred_at  > s.occurred_at
      )
  `
  const booked = (bookedRows[0] as { n: number })?.n ?? 0

  // Win rate: distinct contacts with a call whose company is Customer Won
  const wonRows = await db`
    SELECT COUNT(DISTINCT s.contact_id)::int AS n
    FROM signals s
    JOIN contacts c ON c.id = s.contact_id
    LEFT JOIN company_tags t
      ON  t.workspace_id = c.workspace_id
      AND t.company_name = c.company_name
    WHERE c.workspace_id = ${workspaceId}
      AND s.source_type IN ('Call', 'Call (Voicemail)')
      AND s.occurred_at >= ${since}
      AND t.manual_stage = 'Customer Won'
      AND (${tag}::text IS NULL OR ${tag}::text = ANY(t.prospect_types))
  `
  const won = (wonRows[0] as { n: number })?.n ?? 0

  // Recent log — enriched with contact context
  const logRows = await db`
    SELECT
      s.id                                                      AS "signalId",
      c.id                                                      AS "contactId",
      c.full_name                                               AS "fullName",
      c.job_title                                               AS "jobTitle",
      c.company_name                                            AS "companyName",
      c.linkedin_url                                            AS "linkedinUrl",
      COALESCE(t.manual_stage, c.funnel_stage)                 AS "effectiveStage",
      c.signal_score                                            AS "signalScore",
      (SELECT source_type FROM signals
       WHERE contact_id = c.id
         AND source_type NOT IN ('Call','Call (Voicemail)','Manual Note')
       ORDER BY occurred_at DESC LIMIT 1)                       AS "lastSignalType",
      (SELECT occurred_at FROM signals
       WHERE contact_id = c.id
         AND source_type NOT IN ('Call','Call (Voicemail)','Manual Note')
       ORDER BY occurred_at DESC LIMIT 1)                       AS "lastSignalAt",
      s.description                                             AS notes,
      s.occurred_at                                             AS "occurredAt",
      s.source_type                                             AS "sourceType"
    FROM signals s
    JOIN contacts c ON c.id = s.contact_id
    LEFT JOIN company_tags t
      ON  t.workspace_id = c.workspace_id
      AND t.company_name = c.company_name
    WHERE c.workspace_id = ${workspaceId}
      AND s.source_type IN ('Call', 'Call (Voicemail)')
      AND s.occurred_at >= ${since}
      AND (${tag}::text IS NULL OR ${tag}::text = ANY(t.prospect_types))
    ORDER BY s.occurred_at DESC
    LIMIT ${limit}
  `
  const rate = (n: number, d: number) => d > 0 ? Math.round((n / d) * 100) : null

  return {
    total,
    answered,
    voicemail,
    answerRate:  rate(answered, total),
    bookingRate: rate(booked, answered),
    winRate:     rate(won, total),
    log: (logRows as unknown as Array<{
      signalId: number; contactId: number; fullName: string | null; jobTitle: string | null
      companyName: string | null; linkedinUrl: string | null; effectiveStage: string | null
      signalScore: number; lastSignalType: string | null; lastSignalAt: Date | null
      notes: string | null; occurredAt: Date; sourceType: string | null
    }>).map(r => ({
      signalId:       r.signalId,
      contactId:      r.contactId,
      fullName:       r.fullName,
      jobTitle:       r.jobTitle,
      companyName:    r.companyName,
      linkedinUrl:    r.linkedinUrl,
      effectiveStage: r.effectiveStage,
      signalScore:    r.signalScore,
      lastSignalType: r.lastSignalType,
      lastSignalAt:   r.lastSignalAt instanceof Date ? r.lastSignalAt.toISOString() : (r.lastSignalAt ? String(r.lastSignalAt) : null),
      notes:          r.notes,
      sourceType:     r.sourceType,
      occurredAt:     r.occurredAt instanceof Date ? r.occurredAt.toISOString() : String(r.occurredAt),
    })),
  }
}

/** @deprecated use getCallStats instead */
export async function getCallLog(
  workspaceId: string,
  since: Date = new Date(0),
  limit = 50,
): Promise<CallLogRow[]> {
  return (await getCallStats(workspaceId, since, limit)).log
}

/**
 * Per-campaign stats for a single campaign (filtered by
 * outreach_log.campaign_id added in PR A). Returns the same shape as
 * getOutreachStats so the same StatCard component can render both.
 *
 * Channel is read from the outreach_log row (some campaigns carry both
 * dm + email sends if the user crosses channels; we count all of them
 * against the campaign).
 *
 * Custom Tag filter joins through contacts -> company_tags.
 */
export interface CampaignStatsResult {
  sent:         number
  responded:    number
  booked:       number
  won:          number
  responseRate: number | null
  bookingRate:  number | null
  winRate:      number | null
}

export async function getStatsByCampaign(
  workspaceId: string,
  campaignId:  string,
  since: Date = new Date(0),
  prospectType?: string | null,
): Promise<CampaignStatsResult> {
  const empty: CampaignStatsResult = { sent: 0, responded: 0, booked: 0, won: 0, responseRate: null, bookingRate: null, winRate: null }
  if (!isDbConfigured()) return empty
  const db = sql()
  const tag = prospectType ?? null

  const rows = await db`
    SELECT
      COUNT(*)::int                                                    AS sent,
      COUNT(o.responded_at)::int                                       AS responded,
      COUNT(o.booking_at)::int                                         AS booked,
      COUNT(*) FILTER (
        WHERE t.manual_stage = 'Customer Won'
      )::int                                                           AS won
    FROM outreach_log o
    JOIN contacts c ON c.id = o.contact_id
    LEFT JOIN company_tags t
      ON  t.workspace_id = c.workspace_id
      AND t.company_name = c.company_name
    WHERE o.workspace_id = ${workspaceId}
      AND o.campaign_id  = ${campaignId}
      AND o.occurred_at >= ${since}
      AND (${tag}::text IS NULL OR ${tag}::text = ANY(t.prospect_types))
  `
  const s = rows[0] as { sent: number; responded: number; booked: number; won: number } | undefined
  if (!s) return empty

  const rate = (n: number, d: number) => d > 0 ? Math.round((n / d) * 100) : null
  return {
    sent:         s.sent,
    responded:    s.responded,
    booked:       s.booked,
    won:          s.won,
    responseRate: rate(s.responded, s.sent),
    bookingRate:  rate(s.booked, s.sent),
    winRate:      rate(s.won, s.sent),
  }
}

/**
 * Per-channel "signal-first lift": outbound performance with coverage
 * attached vs. without. Splits outreach_log by `coverage_mvpr_id IS NULL`
 * - sends stamped with a coverage id (PR D auto-derivation) versus
 * sends stamped without. Answers "does adding earned media to a DM
 * actually move the needle?".
 *
 * Channels here are the legacy enum values (dm | email) because that's
 * what outreach_log carries. Newsletter / Product Updates / Outbound
 * Calls don't go through outreach_log so they don't appear.
 */
export interface ChannelLiftBucket {
  sent:         number
  responseRate: number | null
  bookingRate:  number | null
  winRate:      number | null
}

export interface ChannelLiftRow {
  channel:        "dm" | "email"
  channelLabel:   string
  withCoverage:    ChannelLiftBucket
  withoutCoverage: ChannelLiftBucket
}

export async function getChannelLiftByCoverage(
  workspaceId: string,
  since: Date = new Date(0),
): Promise<ChannelLiftRow[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const rows = await db<{
    channel:    "dm" | "email"
    has_cov:    boolean
    sent:       number
    responded:  number
    booked:     number
    won:        number
  }>`
    SELECT
      o.channel                                          AS channel,
      (o.coverage_mvpr_id IS NOT NULL)                   AS has_cov,
      COUNT(*)::int                                      AS sent,
      COUNT(o.responded_at)::int                         AS responded,
      COUNT(o.booking_at)::int                           AS booked,
      COUNT(*) FILTER (
        WHERE t.manual_stage = 'Customer Won'
      )::int                                             AS won
    FROM outreach_log o
    JOIN contacts c ON c.id = o.contact_id
    LEFT JOIN company_tags t
      ON  t.workspace_id = c.workspace_id
      AND t.company_name = c.company_name
    WHERE o.workspace_id = ${workspaceId}
      AND o.occurred_at >= ${since}
    GROUP BY o.channel, (o.coverage_mvpr_id IS NOT NULL)
  `
  const rate = (n: number, d: number) => d > 0 ? Math.round((n / d) * 100) : null
  const empty: ChannelLiftBucket = { sent: 0, responseRate: null, bookingRate: null, winRate: null }
  const byChannel: Record<string, { with: ChannelLiftBucket; without: ChannelLiftBucket }> = {
    dm:    { with: { ...empty }, without: { ...empty } },
    email: { with: { ...empty }, without: { ...empty } },
  }
  for (const r of rows) {
    const bucket: ChannelLiftBucket = {
      sent:         r.sent,
      responseRate: rate(r.responded, r.sent),
      bookingRate:  rate(r.booked,    r.sent),
      winRate:      rate(r.won,       r.sent),
    }
    if (!byChannel[r.channel]) continue
    if (r.has_cov) byChannel[r.channel].with    = bucket
    else           byChannel[r.channel].without = bucket
  }
  return [
    { channel: "dm",    channelLabel: "LinkedIn DM",  withCoverage: byChannel.dm.with,    withoutCoverage: byChannel.dm.without    },
    { channel: "email", channelLabel: "Direct Email", withCoverage: byChannel.email.with, withoutCoverage: byChannel.email.without },
  ]
}

export interface BroadcastStatsResult {
  sends:       number
  opened:      number
  clicked:     number
  booked:      number
  wonOrUpsold: number
  openRate:        number | null
  clickRate:       number | null
  bookingRate:     number | null
  winOrUpsoldRate: number | null
}

export async function getBroadcastStats(
  workspaceId: string,
  type: 'newsletter' | 'product_update',
  since: Date = new Date(0),
): Promise<BroadcastStatsResult> {
  const empty: BroadcastStatsResult = { sends: 0, opened: 0, clicked: 0, booked: 0, wonOrUpsold: 0, openRate: null, clickRate: null, bookingRate: null, winOrUpsoldRate: null }
  if (!isDbConfigured()) return empty
  const db = sql()

  const rows = await db`
    SELECT
      COUNT(*)::int                    AS sends,
      COALESCE(SUM(emails_sent), 0)::int AS emails_sent,
      COALESCE(SUM(opened), 0)::int    AS opened,
      COALESCE(SUM(clicked), 0)::int   AS clicked,
      COALESCE(SUM(booked), 0)::int    AS booked,
      COALESCE(SUM(won_or_upsold), 0)::int AS won_or_upsold
    FROM broadcast_sends
    WHERE workspace_id = ${workspaceId}
      AND type         = ${type}
      AND sent_at     >= ${since}
  `
  const r = rows[0] as { sends: number; emails_sent: number; opened: number; clicked: number; booked: number; won_or_upsold: number } | undefined
  if (!r || r.emails_sent === 0) return empty

  const rate = (n: number, d: number) => d > 0 ? Math.round((n / d) * 100) : null

  return {
    sends:           r.sends,
    opened:          r.opened,
    clicked:         r.clicked,
    booked:          r.booked,
    wonOrUpsold:     r.won_or_upsold,
    openRate:        rate(r.opened, r.emails_sent),
    clickRate:       rate(r.clicked, r.emails_sent),
    bookingRate:     rate(r.booked, r.emails_sent),
    winOrUpsoldRate: rate(r.won_or_upsold, r.emails_sent),
  }
}

// ─── LinkedIn connected sweep ─────────────────────────────────────────────────

/**
 * Sets linkedin_connected = TRUE for every contact (in the given workspace,
 * or all workspaces when workspaceId is omitted) whose full signal history
 * contains a 'connected' or 'accepted_our_connection' verb but whose
 * linkedin_connected flag is still NULL.
 *
 * Does NOT overwrite explicit FALSE overrides set by the user.
 * Safe to run repeatedly — updates only rows that are still NULL.
 *
 * Returns the number of contacts updated.
 */
export async function sweepLinkedinConnected(workspaceId?: string): Promise<number> {
  if (!isDbConfigured()) return 0
  const db = sql()
  const result = workspaceId
    ? await db`
        UPDATE contacts c
        SET linkedin_connected = TRUE, updated_at = NOW()
        WHERE c.workspace_id = ${workspaceId}
          AND c.linkedin_connected IS NULL
          AND EXISTS (
            SELECT 1 FROM signals s
            WHERE s.contact_id  = c.id
              AND s.signal_verb IN ('connected', 'accepted_our_connection')
          )
      `
    : await db`
        UPDATE contacts c
        SET linkedin_connected = TRUE, updated_at = NOW()
        WHERE c.linkedin_connected IS NULL
          AND EXISTS (
            SELECT 1 FROM signals s
            WHERE s.contact_id  = c.id
              AND s.signal_verb IN ('connected', 'accepted_our_connection')
          )
      `
  return (result as unknown as { count: number }).count ?? 0
}

/**
 * Bulk-flip linkedin_connected = TRUE for every contact in `workspaceId`
 * whose LinkedIn slug appears in `slugs`. Matches on the public_identifier
 * extracted from contacts.linkedin_url (the bit after /in/), so URL formatting
 * differences (http/https, www, trailing slash) don't matter.
 *
 * Does NOT touch explicit FALSE overrides - same safety as the signal-based
 * sweep. Returns the number of rows updated.
 */
export async function markLinkedinConnectedBySlugs(
  workspaceId: string,
  slugs: string[],
): Promise<number> {
  if (!isDbConfigured() || slugs.length === 0) return 0
  const db = sql()
  // Lowercase + dedupe client-side; LinkedIn slugs are case-insensitive.
  const normalised = [...new Set(slugs.map(s => s.toLowerCase()).filter(Boolean))]
  const result = await db`
    UPDATE contacts c
    SET    linkedin_connected = TRUE,
           updated_at         = NOW()
    WHERE  c.workspace_id     = ${workspaceId}
      AND  c.linkedin_connected IS NULL
      AND  c.linkedin_url     IS NOT NULL
      AND  LOWER(
             COALESCE(
               (regexp_match(c.linkedin_url, 'linkedin\\.com/in/([^/?#]+)', 'i'))[1],
               ''
             )
           ) = ANY(${normalised}::text[])
  `
  return (result as unknown as { count: number }).count ?? 0
}

/**
 * Richer variant of the slug-based sweep: takes (slug, memberId) pairs
 * from Unipile's /users/relations and:
 *   1. Stamps contacts.linkedin_member_id for every matching contact
 *      (even already-connected ones - backfills the LinkedIn URN so
 *      future enrichment that resolves to a URN can hit those rows).
 *   2. Flips linkedin_connected = TRUE on the matching contacts whose
 *      flag is still NULL.
 *
 * Returns { rowsStampedMemberId, rowsFlippedConnected }.
 */
export async function syncLinkedinConnectionsFromUnipile(
  workspaceId: string,
  relations: Array<{ slug: string; memberId: string | null }>,
): Promise<{ rowsStampedMemberId: number; rowsFlippedConnected: number }> {
  if (!isDbConfigured() || relations.length === 0) {
    return { rowsStampedMemberId: 0, rowsFlippedConnected: 0 }
  }
  const db = sql()
  // Build a (slug, memberId) pair list for VALUES-driven JOIN. Slugs are
  // case-insensitive on LinkedIn; we lowercase to match the regex output.
  const rows: Array<[string, string | null]> = []
  const seen = new Set<string>()
  for (const r of relations) {
    const s = r.slug?.toLowerCase().trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    rows.push([s, r.memberId ?? null])
  }
  if (rows.length === 0) return { rowsStampedMemberId: 0, rowsFlippedConnected: 0 }

  // Cast to text[]/text[] parallel arrays so the unnest works cross-Postgres-driver.
  const slugs     = rows.map(r => r[0])
  const memberIds = rows.map(r => r[1])

  // 1. Stamp member_id on any matching contact whose member_id is NULL.
  const stamped = await db`
    UPDATE contacts c
    SET    linkedin_member_id = u.member_id,
           updated_at         = NOW()
    FROM   unnest(${slugs}::text[], ${memberIds}::text[]) AS u(slug, member_id)
    WHERE  c.workspace_id        = ${workspaceId}
      AND  c.linkedin_member_id  IS NULL
      AND  u.member_id           IS NOT NULL
      AND  c.linkedin_url        IS NOT NULL
      AND  LOWER(
             COALESCE(
               (regexp_match(c.linkedin_url, 'linkedin\\.com/in/([^/?#]+)', 'i'))[1],
               ''
             )
           ) = u.slug
  `
  // 2. Flip linkedin_connected = TRUE on any matching contact still NULL.
  const flipped = await db`
    UPDATE contacts c
    SET    linkedin_connected = TRUE,
           updated_at         = NOW()
    WHERE  c.workspace_id     = ${workspaceId}
      AND  c.linkedin_connected IS NULL
      AND  c.linkedin_url     IS NOT NULL
      AND  LOWER(
             COALESCE(
               (regexp_match(c.linkedin_url, 'linkedin\\.com/in/([^/?#]+)', 'i'))[1],
               ''
             )
           ) = ANY(${slugs}::text[])
  `
  return {
    rowsStampedMemberId:   (stamped as unknown as { count: number }).count ?? 0,
    rowsFlippedConnected:  (flipped as unknown as { count: number }).count ?? 0,
  }
}
