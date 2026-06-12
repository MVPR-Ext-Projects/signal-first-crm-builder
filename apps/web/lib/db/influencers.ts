/**
 * Influencers store — the influence-graph entity, separate from contacts.
 *
 * An influencer is anyone/anything with influence over prospects:
 *   kind "person"        -> journalist, or an individual a prospect follows
 *   kind "organization"  -> a publisher: publication, news site, podcast
 *
 * Many-to-many with contacts via influencer_influences, read in two named
 * directions that match the field names used across the product + CRM:
 *   getInfluences(influencerId)  -> the influencer's `influences` (contacts)
 *   getInfluencedBy(contactId)   -> the contact's `influenced_by` (influencers)
 *
 * The relational join is the source of truth; contacts.influenced_by JSONB is a
 * denormalized read-cache kept for the existing SDR panel. See ADR-015.
 */

import { sql, isDbConfigured } from "./index"

export type InfluencerKind = "person" | "organization"
export type InfluencerType =
  | "journalist"
  | "publication"
  | "news_site"
  | "podcast"
  | "individual"
  | "other"

export interface InfluencerInput {
  kind:               InfluencerKind
  type:               InfluencerType
  name:               string
  linkedinUrl?:       string | null
  domain?:            string | null
  twitterUrl?:        string | null
  website?:           string | null
  mvprJournalistId?:  string | null
  mvprPublicationId?: string | null
  metadata?:          Record<string, unknown> | null
}

export interface InfluencerRow {
  id:                 number
  workspaceId:        string
  kind:               string
  type:               string
  name:               string
  linkedinUrl:        string | null
  domain:             string | null
  twitterUrl:         string | null
  website:            string | null
  mvprJournalistId:   string | null
  mvprPublicationId:  string | null
  crmInfluencerId:    string | null
}

interface InfluencerDbRow {
  id:                  number
  workspace_id:        string
  kind:                string
  type:                string
  name:                string
  linkedin_url:        string | null
  domain:              string | null
  twitter_url:         string | null
  website:             string | null
  mvpr_journalist_id:  string | null
  mvpr_publication_id: string | null
  crm_influencer_id:   string | null
}

function mapRow(r: InfluencerDbRow): InfluencerRow {
  return {
    id:                r.id,
    workspaceId:       r.workspace_id,
    kind:              r.kind,
    type:              r.type,
    name:              r.name,
    linkedinUrl:       r.linkedin_url,
    domain:            r.domain,
    twitterUrl:        r.twitter_url,
    website:           r.website,
    mvprJournalistId:  r.mvpr_journalist_id,
    mvprPublicationId: r.mvpr_publication_id,
    crmInfluencerId:   r.crm_influencer_id,
  }
}

const normUrl = (u?: string | null) => (u ? u.toLowerCase().replace(/\/$/, "") : null)
const normDomain = (d?: string | null) =>
  d ? d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "") : null

/**
 * Find an influencer by the dedup waterfall: mvpr id > linkedin_url > domain >
 * (type, name). Returns the matched id or null. Mirrors the companies waterfall
 * (ADR-002) but with influencer-appropriate keys.
 */
export async function findInfluencer(workspaceId: string, input: InfluencerInput): Promise<number | null> {
  if (!isDbConfigured()) return null
  const db = sql()
  const linkedin = normUrl(input.linkedinUrl)
  const domain   = normDomain(input.domain)

  if (input.mvprJournalistId) {
    const r = await db<{ id: number }>`SELECT id FROM influencers WHERE workspace_id = ${workspaceId} AND mvpr_journalist_id = ${input.mvprJournalistId} LIMIT 1`
    if (r[0]) return r[0].id
  }
  if (input.mvprPublicationId) {
    const r = await db<{ id: number }>`SELECT id FROM influencers WHERE workspace_id = ${workspaceId} AND mvpr_publication_id = ${input.mvprPublicationId} LIMIT 1`
    if (r[0]) return r[0].id
  }
  if (linkedin) {
    const r = await db<{ id: number }>`SELECT id FROM influencers WHERE workspace_id = ${workspaceId} AND LOWER(REGEXP_REPLACE(linkedin_url, '/$', '')) = ${linkedin} LIMIT 1`
    if (r[0]) return r[0].id
  }
  if (domain) {
    const r = await db<{ id: number }>`SELECT id FROM influencers WHERE workspace_id = ${workspaceId} AND domain = ${domain} LIMIT 1`
    if (r[0]) return r[0].id
  }
  const r = await db<{ id: number }>`SELECT id FROM influencers WHERE workspace_id = ${workspaceId} AND type = ${input.type} AND LOWER(name) = ${input.name.toLowerCase()} LIMIT 1`
  return r[0]?.id ?? null
}

/**
 * Upsert an influencer via the dedup waterfall. Find-then-write (not a single
 * ON CONFLICT) because the waterfall spans several unique keys. Returns the id.
 * Null-coalesces identity fields on update so a thinner later source never wipes
 * a richer earlier one.
 */
export async function upsertInfluencer(workspaceId: string, input: InfluencerInput): Promise<number | null> {
  if (!isDbConfigured()) return null
  const db = sql()
  const linkedin = normUrl(input.linkedinUrl)
  const domain   = normDomain(input.domain)
  const metadata = input.metadata ? JSON.stringify(input.metadata) : null

  const existing = await findInfluencer(workspaceId, input)
  if (existing != null) {
    await db`
      UPDATE influencers SET
        name                = COALESCE(${input.name}, name),
        linkedin_url        = COALESCE(${linkedin}, linkedin_url),
        domain              = COALESCE(${domain}, domain),
        twitter_url         = COALESCE(${input.twitterUrl ?? null}, twitter_url),
        website             = COALESCE(${input.website ?? null}, website),
        mvpr_journalist_id  = COALESCE(${input.mvprJournalistId ?? null}, mvpr_journalist_id),
        mvpr_publication_id = COALESCE(${input.mvprPublicationId ?? null}, mvpr_publication_id),
        metadata            = COALESCE(${metadata}::jsonb, metadata),
        updated_at          = NOW()
      WHERE workspace_id = ${workspaceId} AND id = ${existing}
    `
    return existing
  }

  const inserted = await db<{ id: number }>`
    INSERT INTO influencers (
      workspace_id, kind, type, name, linkedin_url, domain, twitter_url, website,
      mvpr_journalist_id, mvpr_publication_id, metadata
    ) VALUES (
      ${workspaceId}, ${input.kind}, ${input.type}, ${input.name}, ${linkedin}, ${domain},
      ${input.twitterUrl ?? null}, ${input.website ?? null},
      ${input.mvprJournalistId ?? null}, ${input.mvprPublicationId ?? null}, ${metadata}::jsonb
    )
    RETURNING id
  `
  return inserted[0]?.id ?? null
}

/**
 * Link an influencer to a prospect (the M2M edge). Idempotent on
 * (workspace_id, influencer_id, contact_id). `source` records provenance
 * ('mvpr' | 'engagement' | 'manual' | 'import').
 */
export async function linkInfluence(args: {
  workspaceId:   string
  influencerId:  number
  contactId:     number
  source?:       string
  weight?:       number
}): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  await db`
    INSERT INTO influencer_influences (workspace_id, influencer_id, contact_id, source, weight)
    VALUES (${args.workspaceId}, ${args.influencerId}, ${args.contactId}, ${args.source ?? null}, ${args.weight ?? null})
    ON CONFLICT (workspace_id, influencer_id, contact_id) DO UPDATE SET
      source = COALESCE(EXCLUDED.source, influencer_influences.source),
      weight = COALESCE(EXCLUDED.weight, influencer_influences.weight)
  `
}

/**
 * The contact's `influenced_by`: every influencer that influences this prospect.
 * Relational source of truth (the contacts.influenced_by JSONB is the cache).
 */
export async function getInfluencedBy(workspaceId: string, contactId: number): Promise<InfluencerRow[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const rows = await db<InfluencerDbRow>`
    SELECT i.id, i.workspace_id, i.kind, i.type, i.name, i.linkedin_url, i.domain,
           i.twitter_url, i.website, i.mvpr_journalist_id, i.mvpr_publication_id, i.crm_influencer_id
    FROM influencer_influences ii
    JOIN influencers i ON i.id = ii.influencer_id
    WHERE ii.workspace_id = ${workspaceId} AND ii.contact_id = ${contactId}
    ORDER BY i.type, i.name
  `
  return rows.map(mapRow)
}

export interface InfluencedContact {
  contactId:   number
  name:        string | null
  linkedinUrl: string | null
  jobTitle:    string | null
  companyName: string | null
}

/**
 * The influencer's `influences`: every prospect this influencer touches.
 */
export async function getInfluences(workspaceId: string, influencerId: number, limit = 500): Promise<InfluencedContact[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const rows = await db<{
    id: number; full_name: string | null; first_name: string | null; last_name: string | null;
    linkedin_url: string | null; job_title: string | null; company_name: string | null
  }>`
    SELECT c.id, c.full_name, c.first_name, c.last_name, c.linkedin_url, c.job_title, c.company_name
    FROM influencer_influences ii
    JOIN contacts c ON c.id = ii.contact_id
    WHERE ii.workspace_id = ${workspaceId} AND ii.influencer_id = ${influencerId}
    ORDER BY c.full_name NULLS LAST
    LIMIT ${limit}
  `
  return rows.map(r => {
    const composed = [r.first_name, r.last_name].filter(Boolean).join(" ")
    return {
      contactId:   r.id,
      name:        r.full_name ?? (composed || null),
      linkedinUrl: r.linkedin_url,
      jobTitle:    r.job_title,
      companyName: r.company_name,
    }
  })
}
