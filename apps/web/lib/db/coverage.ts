/**
 * mvpr_coverage / mvpr_announcements / mvpr_sync_state store.
 *
 * The /api/cron/mvpr-coverage-sync cron pulls from the MVPR adapter
 * (lib/mvpr.ts) and upserts here. Reads are by workspace_id, indexed
 * on published_at DESC for the dashboard's PR section.
 *
 * PK on both content tables is (workspace_id, mvpr_id) - each MVPR id
 * is unique within a tenant but workspaces never collide.
 */

import { sql, isDbConfigured } from "./index"
import { threadHasJournalistReply } from "../mvpr"
import type {
  MvprCoverage,
  MvprAnnouncementSummary,
  MvprAnnouncementDetail,
  MvprAnnouncementStats,
  MvprAnnouncementType,
  MvprThread,
} from "../mvpr"

// ─── Coverage ─────────────────────────────────────────────────────────────────

export interface CoverageRow {
  workspaceId:     string
  mvprId:          string
  title:           string
  link:            string | null
  summary:         string
  publishedAt:     string
  mvprCreatedAt:   string
  tier:            string
  topics:          string[]
  isOrganic:       boolean
  image:           string | null
  journalistId:    string
  journalistName:  string
  publicationId:   string
  publicationName: string
  domainAuthority: number | null
  syncedAt:        string
}

interface CoverageListFilters {
  topic?:           string
  publicationName?: string
  isOrganic?:       boolean
  limit?:           number
}

export async function upsertCoverage(
  workspaceId: string,
  c:           MvprCoverage,
): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  await db`
    INSERT INTO mvpr_coverage (
      workspace_id, mvpr_id, title, link, summary,
      published_at, mvpr_created_at, tier, topics, is_organic, image,
      journalist_id, journalist_name, publication_id, publication_name,
      domain_authority, thread_id, raw_payload, synced_at
    ) VALUES (
      ${workspaceId}, ${c.id}, ${c.title}, ${c.link}, ${c.summary},
      ${c.publishedAt}, ${c.createdAt}, ${c.tier}, ${c.topics}, ${c.isOrganic}, ${c.image},
      ${c.journalist.id}, ${c.journalist.name},
      ${c.journalist.publication.id}, ${c.journalist.publication.name},
      ${c.journalist.publication.domainAuthority}, ${c.threadId ?? null},
      ${JSON.stringify(c)}, NOW()
    )
    ON CONFLICT (workspace_id, mvpr_id) DO UPDATE SET
      title             = EXCLUDED.title,
      link              = EXCLUDED.link,
      summary           = EXCLUDED.summary,
      published_at      = EXCLUDED.published_at,
      mvpr_created_at   = EXCLUDED.mvpr_created_at,
      tier              = EXCLUDED.tier,
      topics            = EXCLUDED.topics,
      is_organic        = EXCLUDED.is_organic,
      image             = EXCLUDED.image,
      journalist_id     = EXCLUDED.journalist_id,
      journalist_name   = EXCLUDED.journalist_name,
      publication_id    = EXCLUDED.publication_id,
      publication_name  = EXCLUDED.publication_name,
      domain_authority  = EXCLUDED.domain_authority,
      thread_id         = EXCLUDED.thread_id,
      raw_payload       = EXCLUDED.raw_payload,
      synced_at         = NOW()
  `
}

interface CoverageDbRow {
  workspace_id:     string
  mvpr_id:          string
  title:            string
  link:             string | null
  summary:          string
  published_at:     Date
  mvpr_created_at:  Date
  tier:             string
  topics:           string[]
  is_organic:       boolean
  image:            string | null
  journalist_id:    string
  journalist_name:  string
  publication_id:   string
  publication_name: string
  domain_authority: number | null
  synced_at:        Date
}

function mapCoverageRow(r: CoverageDbRow): CoverageRow {
  return {
    workspaceId:     r.workspace_id,
    mvprId:          r.mvpr_id,
    title:           r.title,
    link:            r.link,
    summary:         r.summary,
    publishedAt:     r.published_at.toISOString(),
    mvprCreatedAt:   r.mvpr_created_at.toISOString(),
    tier:            r.tier,
    topics:          r.topics,
    isOrganic:       r.is_organic,
    image:           r.image,
    journalistId:    r.journalist_id,
    journalistName:  r.journalist_name,
    publicationId:   r.publication_id,
    publicationName: r.publication_name,
    domainAuthority: r.domain_authority,
    syncedAt:        r.synced_at.toISOString(),
  }
}

export async function listCoverage(
  workspaceId: string,
  filters:     CoverageListFilters = {},
): Promise<CoverageRow[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const limit = filters.limit ?? 200
  const rows = await db<CoverageDbRow>`
    SELECT workspace_id, mvpr_id, title, link, summary,
           published_at, mvpr_created_at, tier, topics, is_organic, image,
           journalist_id, journalist_name, publication_id, publication_name,
           domain_authority, synced_at
    FROM mvpr_coverage
    WHERE workspace_id = ${workspaceId}
      AND (${filters.topic           ?? null}::text IS NULL OR ${filters.topic           ?? null}::text = ANY(topics))
      AND (${filters.publicationName ?? null}::text IS NULL OR publication_name = ${filters.publicationName ?? null}::text)
      AND (${filters.isOrganic       ?? null}::boolean IS NULL OR is_organic   = ${filters.isOrganic       ?? null}::boolean)
    ORDER BY published_at DESC
    LIMIT ${limit}
  `
  return rows.map(mapCoverageRow)
}

export async function getCoverage(
  workspaceId: string,
  mvprId:      string,
): Promise<CoverageRow | null> {
  if (!isDbConfigured()) return null
  const db = sql()
  const rows = await db<CoverageDbRow>`
    SELECT workspace_id, mvpr_id, title, link, summary,
           published_at, mvpr_created_at, tier, topics, is_organic, image,
           journalist_id, journalist_name, publication_id, publication_name,
           domain_authority, synced_at
    FROM mvpr_coverage
    WHERE workspace_id = ${workspaceId} AND mvpr_id = ${mvprId}
    LIMIT 1
  `
  return rows[0] ? mapCoverageRow(rows[0]) : null
}

// ─── Announcements ───────────────────────────────────────────────────────────

export interface AnnouncementRow {
  workspaceId:      string
  mvprId:           string
  title:            string
  announcementType: MvprAnnouncementType
  startTime:        string
  subject:          string
  complete:         boolean
  shareToken:       string | null
  companyId:        string
  mvprUpdatedAt:    string
  stats:            MvprAnnouncementStats | null
  document:         Record<string, unknown> | null
  coverages:        Record<string, unknown>[] | null
  threads:          Record<string, unknown>[] | null
  journalistLists:  string[] | null
  journalists:      string[] | null
  objectives:       string[] | null
  syncedAt:         string
}

/**
 * Upsert from /announcements (list endpoint). Carries the lightweight
 * journalistLists / journalists / objectives arrays but no document /
 * stats / threads - those land via upsertAnnouncementDetail.
 */
export async function upsertAnnouncementSummary(
  workspaceId: string,
  a:           MvprAnnouncementSummary,
): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  await db`
    INSERT INTO mvpr_announcements (
      workspace_id, mvpr_id, title, announcement_type, start_time, subject,
      complete, journalist_lists, journalists, objectives,
      company_id, mvpr_updated_at, raw_payload, synced_at
    ) VALUES (
      ${workspaceId}, ${a.id}, ${a.title}, ${a.announcementType}, ${a.startTime}, ${a.subject},
      ${a.complete}, ${JSON.stringify(a.journalistLists)}, ${JSON.stringify(a.journalists)}, ${JSON.stringify(a.objectives)},
      ${a.companyId}, ${a.updatedAt}, ${JSON.stringify(a)}, NOW()
    )
    ON CONFLICT (workspace_id, mvpr_id) DO UPDATE SET
      title             = EXCLUDED.title,
      announcement_type = EXCLUDED.announcement_type,
      start_time        = EXCLUDED.start_time,
      subject           = EXCLUDED.subject,
      complete          = EXCLUDED.complete,
      journalist_lists  = EXCLUDED.journalist_lists,
      journalists       = EXCLUDED.journalists,
      objectives        = EXCLUDED.objectives,
      company_id        = EXCLUDED.company_id,
      mvpr_updated_at   = EXCLUDED.mvpr_updated_at,
      raw_payload       = EXCLUDED.raw_payload,
      synced_at         = NOW()
  `
}

/**
 * Upsert from /announcements/{id} (detail endpoint). Brings document,
 * stats, threads, and nested coverages on top of the summary fields.
 */
export async function upsertAnnouncementDetail(
  workspaceId: string,
  a:           MvprAnnouncementDetail,
): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  await db`
    INSERT INTO mvpr_announcements (
      workspace_id, mvpr_id, title, announcement_type, start_time, subject,
      complete, share_token, document, coverages, threads, stats,
      journalist_lists, journalists, objectives,
      company_id, mvpr_updated_at, raw_payload, synced_at
    ) VALUES (
      ${workspaceId}, ${a.id}, ${a.title}, ${a.announcementType}, ${a.startTime}, ${a.subject},
      ${a.complete}, ${a.shareToken ?? null},
      ${JSON.stringify(a.document)}, ${JSON.stringify(a.coverages)}, ${JSON.stringify(a.threads)}, ${JSON.stringify(a.stats)},
      ${JSON.stringify(a.journalistLists ?? null)}, ${JSON.stringify(a.journalists ?? null)}, ${JSON.stringify(a.objectives ?? null)},
      ${a.companyId}, ${a.updatedAt}, ${JSON.stringify(a)}, NOW()
    )
    ON CONFLICT (workspace_id, mvpr_id) DO UPDATE SET
      title             = EXCLUDED.title,
      announcement_type = EXCLUDED.announcement_type,
      start_time        = EXCLUDED.start_time,
      subject           = EXCLUDED.subject,
      complete          = EXCLUDED.complete,
      share_token       = EXCLUDED.share_token,
      document          = EXCLUDED.document,
      coverages         = EXCLUDED.coverages,
      threads           = EXCLUDED.threads,
      stats             = EXCLUDED.stats,
      journalist_lists  = COALESCE(EXCLUDED.journalist_lists, mvpr_announcements.journalist_lists),
      journalists       = COALESCE(EXCLUDED.journalists,      mvpr_announcements.journalists),
      objectives        = COALESCE(EXCLUDED.objectives,       mvpr_announcements.objectives),
      company_id        = EXCLUDED.company_id,
      mvpr_updated_at   = EXCLUDED.mvpr_updated_at,
      raw_payload       = EXCLUDED.raw_payload,
      synced_at         = NOW()
  `
}

interface AnnouncementDbRow {
  workspace_id:      string
  mvpr_id:           string
  title:             string
  announcement_type: string
  start_time:        Date
  subject:           string
  complete:          boolean
  share_token:       string | null
  document:          Record<string, unknown> | null
  coverages:         Record<string, unknown>[] | null
  threads:           Record<string, unknown>[] | null
  stats:             MvprAnnouncementStats | null
  journalist_lists:  string[] | null
  journalists:       string[] | null
  objectives:        string[] | null
  company_id:        string
  mvpr_updated_at:   Date
  synced_at:         Date
}

function mapAnnouncementRow(r: AnnouncementDbRow): AnnouncementRow {
  return {
    workspaceId:      r.workspace_id,
    mvprId:           r.mvpr_id,
    title:            r.title,
    announcementType: r.announcement_type as MvprAnnouncementType,
    startTime:        r.start_time.toISOString(),
    subject:          r.subject,
    complete:         r.complete,
    shareToken:       r.share_token,
    companyId:        r.company_id,
    mvprUpdatedAt:    r.mvpr_updated_at.toISOString(),
    stats:            r.stats,
    document:         r.document,
    coverages:        r.coverages,
    threads:          r.threads,
    journalistLists:  r.journalist_lists,
    journalists:      r.journalists,
    objectives:       r.objectives,
    syncedAt:         r.synced_at.toISOString(),
  }
}

/**
 * Look up the (first) announcement whose nested coverages array contains
 * a coverage with the given mvpr_id. Returns null when there's no match.
 * Used by the coverage-detail surface to surface "this coverage came out
 * of announcement X" when MVPR has linked them.
 */
export async function findAnnouncementForCoverage(
  workspaceId:      string,
  coverageMvprId:   string,
): Promise<AnnouncementRow | null> {
  if (!isDbConfigured()) return null
  const db = sql()
  // MVPR's announcement detail nests an array of coverages; we use a JSONB
  // containment query against `[{"id": "<id>"}]` to find a match. Falls
  // back to checking `coverage_id` and `mvprId` keys in case the actual
  // shape varies.
  const probes = [
    JSON.stringify([{ id: coverageMvprId }]),
    JSON.stringify([{ coverage_id: coverageMvprId }]),
    JSON.stringify([{ mvprId: coverageMvprId }]),
  ]
  for (const probe of probes) {
    const rows = await db<AnnouncementDbRow>`
      SELECT workspace_id, mvpr_id, title, announcement_type, start_time, subject,
             complete, share_token, document, coverages, threads, stats,
             journalist_lists, journalists, objectives,
             company_id, mvpr_updated_at, synced_at
      FROM mvpr_announcements
      WHERE workspace_id = ${workspaceId}
        AND coverages @> ${probe}::jsonb
      LIMIT 1
    `
    if (rows[0]) return mapAnnouncementRow(rows[0])
  }
  return null
}

export async function listAnnouncements(
  workspaceId: string,
  limit:       number = 100,
): Promise<AnnouncementRow[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const rows = await db<AnnouncementDbRow>`
    SELECT workspace_id, mvpr_id, title, announcement_type, start_time, subject,
           complete, share_token, document, coverages, threads, stats,
           journalist_lists, journalists, objectives,
           company_id, mvpr_updated_at, synced_at
    FROM mvpr_announcements
    WHERE workspace_id = ${workspaceId}
    ORDER BY start_time DESC
    LIMIT ${limit}
  `
  return rows.map(mapAnnouncementRow)
}

// ─── Sync state ──────────────────────────────────────────────────────────────

export interface SyncStateRow {
  workspaceId:             string
  lastCoverageSyncAt:      string | null
  lastAnnouncementSyncAt:  string | null
  lastThreadSyncAt:        string | null
  updatedAt:               string
}

export async function getSyncState(workspaceId: string): Promise<SyncStateRow | null> {
  if (!isDbConfigured()) return null
  const db = sql()
  const rows = await db<{
    workspace_id:                string
    last_coverage_sync_at:       Date | null
    last_announcement_sync_at:   Date | null
    last_thread_sync_at:         Date | null
    updated_at:                  Date
  }>`
    SELECT workspace_id, last_coverage_sync_at, last_announcement_sync_at, last_thread_sync_at, updated_at
    FROM mvpr_sync_state
    WHERE workspace_id = ${workspaceId}
    LIMIT 1
  `
  const r = rows[0]
  if (!r) return null
  return {
    workspaceId:            r.workspace_id,
    lastCoverageSyncAt:     r.last_coverage_sync_at?.toISOString() ?? null,
    lastAnnouncementSyncAt: r.last_announcement_sync_at?.toISOString() ?? null,
    lastThreadSyncAt:       r.last_thread_sync_at?.toISOString() ?? null,
    updatedAt:              r.updated_at.toISOString(),
  }
}

// ─── Aggregations (PR report) ────────────────────────────────────────────────

export interface CoverageStats {
  total:           number
  organicCount:    number
  placedCount:     number
  sumDa:           number
  avgDa:           number | null
  tierBreakdown:   Array<{ tier: string; count: number }>
  topPublications: Array<{ name: string; count: number; avgDa: number | null }>
  topTopics:       Array<{ topic: string; count: number }>
}

export async function getCoverageStats(workspaceId: string): Promise<CoverageStats> {
  if (!isDbConfigured()) {
    return {
      total: 0, organicCount: 0, placedCount: 0, sumDa: 0, avgDa: null,
      tierBreakdown: [], topPublications: [], topTopics: [],
    }
  }
  const db = sql()

  const [
    totals,
    tiers,
    publications,
    topics,
  ] = await Promise.all([
    db<{
      total: number; organic_count: number; placed_count: number;
      sum_da: number; avg_da: number | null;
    }>`
      SELECT
        COUNT(*)::int                                         AS total,
        COUNT(*) FILTER (WHERE is_organic)::int               AS organic_count,
        COUNT(*) FILTER (WHERE NOT is_organic)::int           AS placed_count,
        COALESCE(SUM(domain_authority), 0)::int               AS sum_da,
        AVG(domain_authority)::float                          AS avg_da
      FROM mvpr_coverage
      WHERE workspace_id = ${workspaceId}
    `,
    db<{ tier: string; count: number }>`
      SELECT tier, COUNT(*)::int AS count
      FROM mvpr_coverage
      WHERE workspace_id = ${workspaceId}
      GROUP BY tier
      ORDER BY count DESC
    `,
    db<{ publication_name: string; count: number; avg_da: number | null }>`
      SELECT publication_name, COUNT(*)::int AS count, AVG(domain_authority)::float AS avg_da
      FROM mvpr_coverage
      WHERE workspace_id = ${workspaceId}
      GROUP BY publication_name
      ORDER BY count DESC
      LIMIT 10
    `,
    db<{ topic: string; count: number }>`
      SELECT topic, COUNT(*)::int AS count
      FROM (
        SELECT UNNEST(topics) AS topic
        FROM mvpr_coverage
        WHERE workspace_id = ${workspaceId}
      ) t
      GROUP BY topic
      ORDER BY count DESC
      LIMIT 10
    `,
  ])

  const t = totals[0] ?? { total: 0, organic_count: 0, placed_count: 0, sum_da: 0, avg_da: null }

  return {
    total:           t.total,
    organicCount:    t.organic_count,
    placedCount:     t.placed_count,
    sumDa:           t.sum_da,
    avgDa:           t.avg_da,
    tierBreakdown:   tiers.map(r => ({ tier: r.tier, count: r.count })),
    topPublications: publications.map(r => ({
      name:   r.publication_name,
      count:  r.count,
      avgDa:  r.avg_da,
    })),
    topTopics:       topics.map(r => ({ topic: r.topic, count: r.count })),
  }
}

export interface AnnouncementStatsRow {
  mvprId:           string
  title:            string
  announcementType: string
  startTime:        string
  coverageCount:    number
  campaignCount:    number
  stats:            { coverageRatio?: number; messagesSent?: number; messagesReceived?: number; openRatio?: number } | null
}

/**
 * One row per announcement with rolled-up engagement stats + counts of
 * linked coverage (from the announcements.coverages jsonb) and downstream
 * campaigns (from campaign_coverage joined through mvpr_coverage).
 */
export async function getAnnouncementReport(
  workspaceId: string,
  limit:       number = 50,
): Promise<AnnouncementStatsRow[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const rows = await db<{
    mvpr_id:           string
    title:             string
    announcement_type: string
    start_time:        Date
    coverage_count:    number
    campaign_count:    number
    stats:             { coverageRatio?: number; messagesSent?: number; messagesReceived?: number; openRatio?: number } | null
  }>`
    SELECT
      a.mvpr_id,
      a.title,
      a.announcement_type,
      a.start_time,
      COALESCE(jsonb_array_length(a.coverages), 0)::int AS coverage_count,
      (
        SELECT COUNT(DISTINCT cc.campaign_id)::int
        FROM campaign_coverage cc
        JOIN mvpr_coverage mc
          ON  mc.workspace_id = cc.workspace_id
          AND mc.mvpr_id      = cc.coverage_mvpr_id
        WHERE cc.workspace_id = ${workspaceId}
          AND (
            a.coverages @> jsonb_build_array(jsonb_build_object('id', mc.mvpr_id))
            OR a.coverages @> jsonb_build_array(jsonb_build_object('coverage_id', mc.mvpr_id))
            OR a.coverages @> jsonb_build_array(jsonb_build_object('mvprId', mc.mvpr_id))
          )
      ) AS campaign_count,
      a.stats
    FROM mvpr_announcements a
    WHERE a.workspace_id = ${workspaceId}
    ORDER BY a.start_time DESC
    LIMIT ${limit}
  `
  return rows.map(r => ({
    mvprId:           r.mvpr_id,
    title:            r.title,
    announcementType: r.announcement_type,
    startTime:        r.start_time.toISOString(),
    coverageCount:    r.coverage_count,
    campaignCount:    r.campaign_count,
    stats:            r.stats,
  }))
}

/**
 * Per-coverage usage count: how many distinct campaigns have attached
 * this piece. Returns a Map keyed by mvpr_id so callers can decorate
 * their existing CoverageRow lists without an N+1.
 */
export async function getCoverageUsageCounts(
  workspaceId: string,
): Promise<Map<string, number>> {
  if (!isDbConfigured()) return new Map()
  const db = sql()
  const rows = await db<{ coverage_mvpr_id: string; n: number }>`
    SELECT coverage_mvpr_id, COUNT(DISTINCT campaign_id)::int AS n
    FROM campaign_coverage
    WHERE workspace_id = ${workspaceId}
    GROUP BY coverage_mvpr_id
  `
  const map = new Map<string, number>()
  for (const r of rows) map.set(r.coverage_mvpr_id, r.n)
  return map
}

export interface CoverageOutcomeRow {
  mvprId:          string
  title:           string
  publicationName: string
  isOrganic:       boolean
  tier:            string
  domainAuthority: number | null
  campaignCount:   number
  sent:            number
  responded:       number
  booked:          number
  won:             number
  responseRate:    number | null
  bookingRate:     number | null
  winRate:         number | null
}

/**
 * Per-coverage outbound outcomes: joins mvpr_coverage -> outreach_log on
 * outreach_log.coverage_mvpr_id (stamped at send time in PR D when the
 * campaign had this coverage attached). Surfaces sends + responses +
 * bookings + wins per coverage piece so the PR report can rank coverage
 * by booked-meeting rate ("this article is a workhorse").
 *
 * Pre-PR-D sends have coverage_mvpr_id = NULL and won't show here.
 * As new sends accrue, the table fills in.
 */
export async function getCoverageOutcomes(
  workspaceId: string,
  limit:       number = 50,
): Promise<CoverageOutcomeRow[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const rows = await db<{
    mvpr_id:          string
    title:            string
    publication_name: string
    is_organic:       boolean
    tier:             string
    domain_authority: number | null
    campaign_count:   number
    sent:             number
    responded:        number
    booked:           number
    won:              number
  }>`
    SELECT
      mc.mvpr_id,
      mc.title,
      mc.publication_name,
      mc.is_organic,
      mc.tier,
      mc.domain_authority,
      COALESCE((
        SELECT COUNT(DISTINCT cc.campaign_id)::int
        FROM campaign_coverage cc
        WHERE cc.workspace_id     = mc.workspace_id
          AND cc.coverage_mvpr_id = mc.mvpr_id
      ), 0)                                                AS campaign_count,
      COALESCE(o.sent,      0)                             AS sent,
      COALESCE(o.responded, 0)                             AS responded,
      COALESCE(o.booked,    0)                             AS booked,
      COALESCE(o.won,       0)                             AS won
    FROM mvpr_coverage mc
    LEFT JOIN (
      SELECT
        ol.coverage_mvpr_id,
        COUNT(*)::int                AS sent,
        COUNT(ol.responded_at)::int  AS responded,
        COUNT(ol.booking_at)::int    AS booked,
        COUNT(*) FILTER (
          WHERE t.manual_stage = 'Customer Won'
        )::int                       AS won
      FROM outreach_log ol
      JOIN contacts c ON c.id = ol.contact_id
      LEFT JOIN company_tags t
        ON  t.workspace_id = c.workspace_id
        AND t.company_name = c.company_name
      WHERE ol.workspace_id      = ${workspaceId}
        AND ol.coverage_mvpr_id IS NOT NULL
      GROUP BY ol.coverage_mvpr_id
    ) o ON o.coverage_mvpr_id = mc.mvpr_id
    WHERE mc.workspace_id = ${workspaceId}
    ORDER BY o.booked DESC NULLS LAST, o.sent DESC NULLS LAST, mc.published_at DESC
    LIMIT ${limit}
  `
  const rate = (n: number, d: number) => d > 0 ? Math.round((n / d) * 100) : null
  return rows.map(r => ({
    mvprId:          r.mvpr_id,
    title:           r.title,
    publicationName: r.publication_name,
    isOrganic:       r.is_organic,
    tier:            r.tier,
    domainAuthority: r.domain_authority,
    campaignCount:   r.campaign_count,
    sent:            r.sent,
    responded:       r.responded,
    booked:          r.booked,
    won:             r.won,
    responseRate:    rate(r.responded, r.sent),
    bookingRate:     rate(r.booked,    r.sent),
    winRate:         rate(r.won,       r.sent),
  }))
}

export interface CampaignFromCoverageRow {
  campaignId:   string
  campaignName: string
  channel:      string
  coverageMvprId: string
  coverageTitle:  string
  publicationName: string
  attachedAt:   string
}

/** Campaigns that have a coverage attached, with the source-coverage joined in. */
export async function getCampaignsFromCoverage(
  workspaceId: string,
  limit:       number = 50,
): Promise<CampaignFromCoverageRow[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const rows = await db<{
    campaign_id:       string
    campaign_name:     string
    channel:           string
    coverage_mvpr_id:  string
    coverage_title:    string
    publication_name:  string
    attached_at:       Date
  }>`
    SELECT
      c.id            AS campaign_id,
      c.name          AS campaign_name,
      c.channel       AS channel,
      cc.coverage_mvpr_id,
      mc.title        AS coverage_title,
      mc.publication_name,
      cc.attached_at
    FROM campaign_coverage cc
    JOIN campaigns      c
      ON c.id = cc.campaign_id
    JOIN mvpr_coverage  mc
      ON  mc.workspace_id = cc.workspace_id
      AND mc.mvpr_id      = cc.coverage_mvpr_id
    WHERE cc.workspace_id = ${workspaceId}
    ORDER BY cc.attached_at DESC
    LIMIT ${limit}
  `
  return rows.map(r => ({
    campaignId:      r.campaign_id,
    campaignName:    r.campaign_name,
    channel:         r.channel,
    coverageMvprId:  r.coverage_mvpr_id,
    coverageTitle:   r.coverage_title,
    publicationName: r.publication_name,
    attachedAt:      r.attached_at.toISOString(),
  }))
}

export async function updateSyncState(args: {
  workspaceId:             string
  lastCoverageSyncAt?:     string
  lastAnnouncementSyncAt?: string
  lastThreadSyncAt?:       string
}): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  await db`
    INSERT INTO mvpr_sync_state (
      workspace_id, last_coverage_sync_at, last_announcement_sync_at, last_thread_sync_at, updated_at
    ) VALUES (
      ${args.workspaceId},
      ${args.lastCoverageSyncAt ?? null},
      ${args.lastAnnouncementSyncAt ?? null},
      ${args.lastThreadSyncAt ?? null},
      NOW()
    )
    ON CONFLICT (workspace_id) DO UPDATE SET
      last_coverage_sync_at     = COALESCE(EXCLUDED.last_coverage_sync_at,     mvpr_sync_state.last_coverage_sync_at),
      last_announcement_sync_at = COALESCE(EXCLUDED.last_announcement_sync_at, mvpr_sync_state.last_announcement_sync_at),
      last_thread_sync_at       = COALESCE(EXCLUDED.last_thread_sync_at,       mvpr_sync_state.last_thread_sync_at),
      updated_at                = NOW()
  `
}

// ─── Threads + PR-performance tracking ──────────────────────────────────────────

export interface ThreadRow {
  workspaceId:        string
  mvprId:             string
  subject:            string
  intent:             string
  status:             string
  isArchived:         boolean
  messageCount:       number
  hasJournalistReply: boolean
  journalistId:       string
  journalistName:     string
  publicationId:      string | null
  publicationName:    string | null
  mvprCreatedAt:      string
  lastActionAt:       string
}

export async function upsertThread(workspaceId: string, t: MvprThread): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  await db`
    INSERT INTO mvpr_threads (
      workspace_id, mvpr_id, subject, intent, status, is_archived,
      message_count, has_journalist_reply,
      journalist_id, journalist_name, publication_id, publication_name,
      mvpr_created_at, last_action_at, raw_payload, synced_at
    ) VALUES (
      ${workspaceId}, ${t.id}, ${t.subject}, ${t.intent}, ${t.status}, ${t.isArchived},
      ${t.messageCount}, ${threadHasJournalistReply(t)},
      ${t.journalist.id}, ${t.journalist.name},
      ${t.journalist.publication?.id ?? null}, ${t.journalist.publication?.name ?? null},
      ${t.createdAt}, ${t.lastActionAt}, ${JSON.stringify(t)}, NOW()
    )
    ON CONFLICT (workspace_id, mvpr_id) DO UPDATE SET
      subject              = EXCLUDED.subject,
      intent               = EXCLUDED.intent,
      status               = EXCLUDED.status,
      is_archived          = EXCLUDED.is_archived,
      message_count        = EXCLUDED.message_count,
      has_journalist_reply = EXCLUDED.has_journalist_reply,
      journalist_id        = EXCLUDED.journalist_id,
      journalist_name      = EXCLUDED.journalist_name,
      publication_id       = EXCLUDED.publication_id,
      publication_name     = EXCLUDED.publication_name,
      mvpr_created_at      = EXCLUDED.mvpr_created_at,
      last_action_at       = EXCLUDED.last_action_at,
      raw_payload          = EXCLUDED.raw_payload,
      synced_at            = NOW()
  `
}

/**
 * PR-performance metrics. The two headline rates a PR-led GTM team lives by:
 *   responseRate = threads with a journalist reply / threads sent
 *   coverageRate = threads that produced coverage   / threads sent
 * Plus the same two broken down by intent ("which messages land") and by
 * journalist ("who actually engages"). Drafts (status = 'DRAFT', never sent)
 * are excluded from the denominator so unsent pitches don't depress the rate.
 *
 * Deliberately NO open rate: inbox privacy/proxy rules make opens unreliable,
 * so MVPR surfaces lead with response + coverage. (See the pitch-metrics rule.)
 */
export interface PrPerformance {
  threadsSent:    number
  replied:        number
  withCoverage:   number
  responseRate:   number | null   // 0..1, null when threadsSent = 0
  coverageRate:   number | null   // 0..1, null when threadsSent = 0
  byIntent:       Array<{ intent: string; sent: number; replied: number; withCoverage: number; responseRate: number | null; coverageRate: number | null }>
  topJournalists: Array<{ journalistId: string; journalistName: string; publicationName: string | null; sent: number; replied: number; withCoverage: number }>
}

export async function getPrPerformance(workspaceId: string): Promise<PrPerformance> {
  const empty: PrPerformance = {
    threadsSent: 0, replied: 0, withCoverage: 0, responseRate: null, coverageRate: null,
    byIntent: [], topJournalists: [],
  }
  if (!isDbConfigured()) return empty
  const db = sql()

  // A thread "produced coverage" when some mvpr_coverage row points back at it.
  const [totals, byIntent, journalists] = await Promise.all([
    db<{ sent: number; replied: number; with_coverage: number }>`
      SELECT
        COUNT(*)::int                                          AS sent,
        COUNT(*) FILTER (WHERE t.has_journalist_reply)::int    AS replied,
        COUNT(*) FILTER (WHERE c.thread_id IS NOT NULL)::int   AS with_coverage
      FROM mvpr_threads t
      LEFT JOIN LATERAL (
        SELECT 1 AS thread_id FROM mvpr_coverage c
        WHERE c.workspace_id = t.workspace_id AND c.thread_id = t.mvpr_id
        LIMIT 1
      ) c ON TRUE
      WHERE t.workspace_id = ${workspaceId} AND t.status <> 'DRAFT'
    `,
    db<{ intent: string; sent: number; replied: number; with_coverage: number }>`
      SELECT
        t.intent,
        COUNT(*)::int                                          AS sent,
        COUNT(*) FILTER (WHERE t.has_journalist_reply)::int    AS replied,
        COUNT(*) FILTER (WHERE c.thread_id IS NOT NULL)::int   AS with_coverage
      FROM mvpr_threads t
      LEFT JOIN LATERAL (
        SELECT 1 AS thread_id FROM mvpr_coverage c
        WHERE c.workspace_id = t.workspace_id AND c.thread_id = t.mvpr_id
        LIMIT 1
      ) c ON TRUE
      WHERE t.workspace_id = ${workspaceId} AND t.status <> 'DRAFT'
      GROUP BY t.intent
      ORDER BY sent DESC
    `,
    db<{ journalist_id: string; journalist_name: string; publication_name: string | null; sent: number; replied: number; with_coverage: number }>`
      SELECT
        t.journalist_id,
        MAX(t.journalist_name)                                 AS journalist_name,
        MAX(t.publication_name)                                AS publication_name,
        COUNT(*)::int                                          AS sent,
        COUNT(*) FILTER (WHERE t.has_journalist_reply)::int    AS replied,
        COUNT(*) FILTER (WHERE c.thread_id IS NOT NULL)::int   AS with_coverage
      FROM mvpr_threads t
      LEFT JOIN LATERAL (
        SELECT 1 AS thread_id FROM mvpr_coverage c
        WHERE c.workspace_id = t.workspace_id AND c.thread_id = t.mvpr_id
        LIMIT 1
      ) c ON TRUE
      WHERE t.workspace_id = ${workspaceId} AND t.status <> 'DRAFT'
      GROUP BY t.journalist_id
      ORDER BY with_coverage DESC, replied DESC, sent DESC
      LIMIT 10
    `,
  ])

  const rate = (num: number, den: number): number | null => (den > 0 ? num / den : null)
  const tot = totals[0] ?? { sent: 0, replied: 0, with_coverage: 0 }

  return {
    threadsSent:  tot.sent,
    replied:      tot.replied,
    withCoverage: tot.with_coverage,
    responseRate: rate(tot.replied, tot.sent),
    coverageRate: rate(tot.with_coverage, tot.sent),
    byIntent: byIntent.map(r => ({
      intent:       r.intent,
      sent:         r.sent,
      replied:      r.replied,
      withCoverage: r.with_coverage,
      responseRate: rate(r.replied, r.sent),
      coverageRate: rate(r.with_coverage, r.sent),
    })),
    topJournalists: journalists.map(r => ({
      journalistId:    r.journalist_id,
      journalistName:  r.journalist_name,
      publicationName: r.publication_name,
      sent:            r.sent,
      replied:         r.replied,
      withCoverage:    r.with_coverage,
    })),
  }
}
