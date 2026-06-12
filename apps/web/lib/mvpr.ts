/**
 * MVPR PR platform REST adapter.
 *
 * Each workspace brings its own MVPR API key + baseUrl. The baseUrl
 * embeds the workspace's MVPR company id in the path (e.g.
 *   https://prd-message-opportunity-domain-service-.../api/v1/companies/<id>/
 * ). Auth is `Authorization: Bearer <api-key>`.
 *
 * Endpoints used by the gtm-os PR sync cron:
 *   GET /coverages?startDate=&endDate=     - list media coverages
 *   GET /announcements                     - list announcements
 *   GET /announcements/{id}                - single announcement (stats, threads, coverages)
 *   GET /threads?page=&pageSize=&intent=   - journalist outreach threads (pitch -> reply -> coverage)
 *
 * Mirrors the lib/unipile.ts pattern: plain functions, typed
 * request/response, `cache: "no-store"`, single creds object passed in.
 */

export interface MvprCreds {
  apiKey:  string
  /** Per-tenant base URL ending in `/` (e.g. `https://.../api/v1/companies/<id>/`). */
  baseUrl: string
}

export interface MvprCoverage {
  id:              string
  title:           string
  link:            string | null
  summary:         string
  publishedAt:     string  // ISO 8601
  createdAt:       string  // ISO 8601
  tier:            string
  topics:          string[]
  isOrganic:       boolean
  image:           string
  /** The outreach thread this coverage came from (links to MvprThread.id). Null for organic/unsourced coverage. */
  threadId:        string | null
  journalist:      {
    id:          string
    name:        string
    publication: {
      id:               string
      name:             string
      domainAuthority:  number | null
    }
  }
}

export type MvprAnnouncementType =
  | "funding-announcement"
  | "partnership-announcement"
  | "product-announcement"
  | "hiring-announcement"
  | "market-announcement"
  | "ma-announcement"
  | "brand-announcement"
  | "ipo-announcement"
  | "other-announcement"

export interface MvprAnnouncementSummary {
  id:               string
  title:            string
  announcementType: MvprAnnouncementType
  startTime:        string  // ISO 8601
  subject:          string
  complete:         boolean
  journalistLists:  string[]
  journalists:      string[]
  objectives:       string[]
  updatedAt:        string  // ISO 8601
  companyId:        string
}

export interface MvprAnnouncementStats {
  coverageRatio:    number
  messagesSent:     number
  messagesReceived: number
  sendReceivedRatio: number
  openRatio:        number
}

export interface MvprAnnouncementDetail
  extends Omit<MvprAnnouncementSummary, "journalistLists" | "journalists" | "objectives"> {
  shareToken:       string | null
  document:         Record<string, unknown>
  coverages:        Record<string, unknown>[]
  threads:          Record<string, unknown>[]
  stats:            MvprAnnouncementStats
  journalistLists?: string[]
  journalists?:     string[]
  objectives?:      string[]
}

/**
 * Journalist outreach thread — the pitch conversation behind a piece of
 * coverage. `intent` is the kind of pitch; `status` advances DRAFT -> OPENED
 * -> ... ; each message carries `isFromJournalist`, which is how we derive a
 * "the journalist replied" response. A thread that produces coverage shows up
 * as `MvprCoverage.threadId`, which is how coverage rate is computed.
 */
export type MvprThreadIntent =
  | "pressRelease"
  | "outreach"
  | "newsjacking"
  | "opEd"
  | "opportunity"
  | "customOpportunity"

export interface MvprThreadMessage {
  isFromJournalist: boolean
  dateCreated:      string  // ISO 8601
  text:             string
}

export interface MvprThread {
  id:               string
  subject:          string
  intent:           MvprThreadIntent
  createdAt:        string  // ISO 8601
  lastActionAt:     string  // ISO 8601
  isArchived:       boolean
  status:           string  // DRAFT | OPENED | ... (platform-defined)
  messageCount:     number
  journalist: {
    id:          string
    name:        string
    jobTitle:    string | null
    publication: {
      id:   string
      name: string
    }
  }
  latestMessages?: MvprThreadMessage[]
}

/**
 * The PR signal verbs MVPR contributes to the funnel. Recorded against the
 * journalist contact (a journalist is a person, so it dedups + companies
 * [= the publication] the same way prospect contacts do). Kept here next to
 * the source so the mapping lives with the data shape it derives from.
 *   - pr_pitch_sent          a thread we sent (outbound; weight 0, like sent_dm)
 *   - pr_journalist_replied  a message with isFromJournalist = true (a response)
 *   - pr_coverage_published  a coverage row went live (the PR "win")
 * See ADR-014 and docs/PR-LinkedIn-Measurement.md.
 */
export type MvprSignalVerb =
  | "pr_pitch_sent"
  | "pr_journalist_replied"
  | "pr_coverage_published"

/** True when a thread has at least one inbound (journalist) message. */
export function threadHasJournalistReply(thread: MvprThread): boolean {
  return (thread.latestMessages ?? []).some(m => m.isFromJournalist)
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
  const tail = path.replace(/^\//, "")
  return `${base}${tail}`
}

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept:        "application/json",
    "Content-Type": "application/json",
  }
}

async function call<T>(creds: MvprCreds, path: string): Promise<T> {
  const url = joinUrl(creds.baseUrl, path)
  const res = await fetch(url, { headers: headers(creds.apiKey), cache: "no-store" })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`MVPR ${path} failed (${res.status}): ${text.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

/**
 * List media coverages, optionally bounded by published-at date range.
 * The sync cron passes startDate = lastSyncedAt - 1 day so late edits
 * to recently-published rows still get picked up.
 */
export async function listCoverages(args: {
  creds:      MvprCreds
  startDate?: string  // ISO 8601
  endDate?:   string  // ISO 8601
}): Promise<MvprCoverage[]> {
  const { creds, startDate, endDate } = args
  const params = new URLSearchParams()
  if (startDate) params.set("startDate", startDate)
  if (endDate)   params.set("endDate",   endDate)
  const path = params.toString() ? `coverages?${params.toString()}` : "coverages"
  const data = await call<MvprCoverage[] | { items?: MvprCoverage[]; data?: MvprCoverage[] }>(creds, path)
  if (Array.isArray(data)) return data
  return data.items ?? data.data ?? []
}

/** List every announcement for the tenant. No date filter exposed by the API. */
export async function listAnnouncements(args: {
  creds: MvprCreds
}): Promise<MvprAnnouncementSummary[]> {
  const data = await call<MvprAnnouncementSummary[] | { items?: MvprAnnouncementSummary[]; data?: MvprAnnouncementSummary[] }>(args.creds, "announcements")
  if (Array.isArray(data)) return data
  return data.items ?? data.data ?? []
}

/** Single announcement with stats + nested coverages + threads. */
export async function getAnnouncement(args: {
  creds: MvprCreds
  id:    string
}): Promise<MvprAnnouncementDetail> {
  return call<MvprAnnouncementDetail>(args.creds, `announcements/${encodeURIComponent(args.id)}`)
}

/**
 * List journalist outreach threads, newest activity first. The sync walks
 * pages until a short page (fewer than pageSize) signals the end. `intent`
 * and `includeArchived` are optional narrowings. Response shape is normalised
 * the same way as listCoverages (bare array or {items}/{data} envelope).
 */
export async function listThreads(args: {
  creds:            MvprCreds
  page?:            number
  pageSize?:        number
  intent?:          MvprThreadIntent
  includeArchived?: boolean
}): Promise<MvprThread[]> {
  const { creds, page = 1, pageSize = 50, intent, includeArchived } = args
  const params = new URLSearchParams()
  params.set("page", String(page))
  params.set("pageSize", String(pageSize))
  if (intent) params.set("intent", intent)
  if (includeArchived) params.set("isArchived", "true")
  const data = await call<MvprThread[] | { items?: MvprThread[]; data?: MvprThread[] }>(
    creds,
    `threads?${params.toString()}`,
  )
  if (Array.isArray(data)) return data
  return data.items ?? data.data ?? []
}
