/**
 * Campaigns store - CRUD + helpers for the `campaigns` table (Task #23).
 *
 * A campaign is a workspace-scoped record of an outbound effort that
 * carries a per-campaign clicked_link_score. UTMs on links in the
 * campaign embed the campaign id (utm_medium); the attribution app's
 * click tracker resolves the score from this table when recording a
 * clicked_link signal.
 *
 * id is a stable string (mint with crypto.randomUUID() on create) so
 * UTMs stamped at content-generation time stay valid across renames.
 */

import { sql, isDbConfigured } from "./index"

export type CampaignChannel = "linkedin_dm" | "email" | "newsletter" | "lead_magnet" | "other"

export interface CampaignRow {
  id:                string
  workspaceId:       string
  name:              string
  channel:           CampaignChannel
  /** FK into channels.id (added in the Channels refactor). NULL on legacy
   *  rows where the channel enum had no seeded mapping (e.g. 'other'). */
  channelId:         string | null
  clickedLinkScore:  number
  createdAt:         string
  archivedAt:        string | null
}

export async function listCampaigns(
  workspaceId: string,
  includeArchived = false,
): Promise<CampaignRow[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const rows = includeArchived
    ? await db<{
        id: string; workspace_id: string; name: string; channel: string;
        channel_id: string | null;
        clicked_link_score: number; created_at: Date; archived_at: Date | null;
      }>`
        SELECT id, workspace_id, name, channel, channel_id, clicked_link_score, created_at, archived_at
        FROM campaigns
        WHERE workspace_id = ${workspaceId}
        ORDER BY created_at DESC
      `
    : await db<{
        id: string; workspace_id: string; name: string; channel: string;
        channel_id: string | null;
        clicked_link_score: number; created_at: Date; archived_at: Date | null;
      }>`
        SELECT id, workspace_id, name, channel, channel_id, clicked_link_score, created_at, archived_at
        FROM campaigns
        WHERE workspace_id = ${workspaceId}
          AND archived_at IS NULL
        ORDER BY created_at DESC
      `
  return rows.map(r => ({
    id:                r.id,
    workspaceId:       r.workspace_id,
    name:              r.name,
    channel:           r.channel as CampaignChannel,
    channelId:         r.channel_id,
    clickedLinkScore:  r.clicked_link_score,
    createdAt:         r.created_at.toISOString(),
    archivedAt:        r.archived_at?.toISOString() ?? null,
  }))
}

export async function createCampaign(args: {
  workspaceId:       string
  name:              string
  channel:           CampaignChannel
  clickedLinkScore:  number
  /** Parent channel FK. Optional for back-compat - new callers should always pass it. */
  channelId?:        string | null
}): Promise<string | null> {
  if (!isDbConfigured()) return null
  const id = crypto.randomUUID()
  const db = sql()
  await db`
    INSERT INTO campaigns (id, workspace_id, name, channel, channel_id, clicked_link_score)
    VALUES (
      ${id}, ${args.workspaceId}, ${args.name}, ${args.channel},
      ${args.channelId ?? null}, ${args.clickedLinkScore}
    )
  `
  return id
}

export async function updateCampaign(args: {
  workspaceId:       string
  id:                string
  name?:             string
  channel?:          CampaignChannel
  clickedLinkScore?: number
}): Promise<boolean> {
  if (!isDbConfigured()) return false
  const db = sql()
  const res = await db`
    UPDATE campaigns SET
      name               = COALESCE(${args.name             ?? null}, name),
      channel            = COALESCE(${args.channel          ?? null}, channel),
      clicked_link_score = COALESCE(${args.clickedLinkScore ?? null}, clicked_link_score)
    WHERE id = ${args.id} AND workspace_id = ${args.workspaceId}
  `
  return (res as unknown as { count: number }).count > 0
}

export async function archiveCampaign(
  workspaceId: string,
  id:          string,
): Promise<boolean> {
  if (!isDbConfigured()) return false
  const db = sql()
  const res = await db`
    UPDATE campaigns SET archived_at = NOW()
    WHERE id = ${id} AND workspace_id = ${workspaceId}
      AND archived_at IS NULL
  `
  return (res as unknown as { count: number }).count > 0
}

/**
 * Look up a single campaign row by id. Returns null when the campaign
 * isn't found in the workspace (or has been archived - archived rows
 * are still returned so the detail page can render for history; callers
 * filter when needed).
 */
export async function getCampaignById(
  workspaceId: string,
  id:          string,
): Promise<CampaignRow | null> {
  if (!isDbConfigured()) return null
  const db = sql()
  const rows = await db<{
    id: string; workspace_id: string; name: string; channel: string;
    channel_id: string | null;
    clicked_link_score: number; created_at: Date; archived_at: Date | null;
  }>`
    SELECT id, workspace_id, name, channel, channel_id, clicked_link_score, created_at, archived_at
    FROM campaigns
    WHERE id = ${id} AND workspace_id = ${workspaceId}
    LIMIT 1
  `
  const r = rows[0]
  if (!r) return null
  return {
    id:                r.id,
    workspaceId:       r.workspace_id,
    name:              r.name,
    channel:           r.channel as CampaignChannel,
    channelId:         r.channel_id,
    clickedLinkScore:  r.clicked_link_score,
    createdAt:         r.created_at.toISOString(),
    archivedAt:        r.archived_at?.toISOString() ?? null,
  }
}

// ─── Unfurl (Companies -> People -> Signals tree) ──────────────────────────

export interface UnfurlSignalRow {
  id:               number
  verb:             string | null
  description:      string | null
  occurredAt:       string
  scoreDelta:       number
}

export interface UnfurlContactRow {
  id:               number
  fullName:         string | null
  jobTitle:         string | null
  linkedinUrl:      string | null
  signalScore:      number
  signalCount:      number
  recentSignals:    UnfurlSignalRow[]
}

export interface UnfurlCompanyRow {
  companyName:      string
  contactCount:     number
  contacts:         UnfurlContactRow[]
}

/**
 * Tree view for a campaign: the companies whose contacts are enrolled
 * via campaign_contacts, expandable down to recent signals per contact.
 * Used by the Channels page row-unfurl pattern.
 *
 * - Companies grouped by contacts.company_name (NULL collapsed under
 *   "Unknown company" so they're still visible).
 * - Recent signals capped at 5 per contact (DESC by occurred_at).
 */
export async function getCampaignUnfurl(
  workspaceId: string,
  campaignId:  string,
): Promise<UnfurlCompanyRow[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const contacts = await db<{
    id:                 number
    full_name:          string | null
    job_title:          string | null
    linkedin_url:       string | null
    company_name:       string | null
    signal_score:       number
    signal_count:       number
  }>`
    SELECT c.id, c.full_name, c.job_title, c.linkedin_url, c.company_name,
           c.signal_score, c.signal_count
    FROM campaign_contacts cc
    JOIN contacts c
      ON c.id = cc.contact_id
    WHERE cc.workspace_id = ${workspaceId}
      AND cc.campaign_id  = ${campaignId}
    ORDER BY c.signal_score DESC, c.signal_count DESC
  `
  if (contacts.length === 0) return []

  // Pull the last 5 signals for the touched contact ids in one round-trip.
  const ids = contacts.map(c => c.id)
  const signals = await db<{
    contact_id:       number
    id:               number
    signal_verb:      string | null
    verb_description: string | null
    occurred_at:      Date
    score_delta:      number
  }>`
    SELECT contact_id, id, signal_verb, verb_description, occurred_at, score_delta
    FROM (
      SELECT contact_id, id, signal_verb, verb_description, occurred_at, score_delta,
             ROW_NUMBER() OVER (PARTITION BY contact_id ORDER BY occurred_at DESC) AS rn
      FROM signals
      WHERE workspace_id = ${workspaceId}
        AND contact_id   = ANY(${ids}::bigint[])
    ) t
    WHERE rn <= 5
  `

  const signalsByContact = new Map<number, UnfurlSignalRow[]>()
  for (const s of signals) {
    const list = signalsByContact.get(s.contact_id) ?? []
    list.push({
      id:          s.id,
      verb:        s.signal_verb,
      description: s.verb_description,
      occurredAt:  s.occurred_at.toISOString(),
      scoreDelta:  s.score_delta,
    })
    signalsByContact.set(s.contact_id, list)
  }

  const grouped = new Map<string, UnfurlContactRow[]>()
  for (const c of contacts) {
    const companyName = c.company_name ?? "Unknown company"
    const list = grouped.get(companyName) ?? []
    list.push({
      id:            c.id,
      fullName:      c.full_name,
      jobTitle:      c.job_title,
      linkedinUrl:   c.linkedin_url,
      signalScore:   c.signal_score,
      signalCount:   c.signal_count,
      recentSignals: signalsByContact.get(c.id) ?? [],
    })
    grouped.set(companyName, list)
  }

  return Array.from(grouped.entries())
    .map(([companyName, contactsOfCompany]) => ({
      companyName,
      contactCount: contactsOfCompany.length,
      contacts:     contactsOfCompany,
    }))
    .sort((a, b) => b.contactCount - a.contactCount)
}

/**
 * Look up a campaign's clicked_link_score by id. Returns null when the
 * campaign isn't found OR is archived. The click tracker uses this to
 * resolve the score for an incoming click event; when null is returned
 * the tracker falls back to scoreDelta=0 (matching the pre-Task-23
 * behaviour).
 */
export async function getCampaignClickScore(
  workspaceId: string,
  id:          string,
): Promise<number | null> {
  if (!isDbConfigured()) return null
  const db = sql()
  const rows = await db<{ clicked_link_score: number }>`
    SELECT clicked_link_score FROM campaigns
    WHERE id = ${id} AND workspace_id = ${workspaceId}
      AND archived_at IS NULL
    LIMIT 1
  `
  return rows[0]?.clicked_link_score ?? null
}
