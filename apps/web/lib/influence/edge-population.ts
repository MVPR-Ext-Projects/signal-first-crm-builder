/**
 * Influence-edge population — how influencer↔prospect edges get created.
 *
 * The influencers entity (lib/db/influencers.ts, ADR-015) holds the nodes;
 * this module holds the SOURCES that draw edges between an influencer and a
 * prospect. There are several, because we learn "who influences this prospect"
 * in several ways:
 *
 *   1. Coverage engagement (the trust-nested loop). A prospect engages with a
 *      piece of earned coverage that's WRAPPED inside a marketing channel - a
 *      LinkedIn post/ad or a Resend email - usually delivered via a campaign.
 *      The coverage's journalist + publication then influence that prospect.
 *      -> linkCoverageInfluencers / linkCampaignCoverageInfluencers
 *
 *   2. Social follows. Scraping a prospect's social profiles (LinkedIn topVoices,
 *      X/Twitter, and - when wired - Instagram/Facebook) tells us who they
 *      follow. Each followed account is an influencer.
 *      -> linkFollowedInfluencers (+ the linkedinInterests/xAccounts mappers)
 *
 *   3. Publication audience. Scraping the followers of a publication/media page
 *      tells us which of our prospects that publication influences (reverse of
 *      #2, fanned out from the influencer side).
 *      -> linkPublicationAudience
 *
 * Every edge records its `source` so we can tell exposure (#1 at enrollment)
 * from confirmed engagement, follows, and audience scrapes apart later.
 */

import { sql, isDbConfigured } from "../db"
import { upsertInfluencer, linkInfluence, type InfluencerKind, type InfluencerType } from "../db/influencers"

function hostFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase()
  } catch {
    return null
  }
}

// ─── Source 1: coverage engagement (wrapped in a marketing channel) ─────────────

/**
 * Link a prospect to the influencers behind one piece of coverage: its
 * journalist (person) and publication (organization). Idempotent. Returns the
 * number of edges written (0-2).
 */
export async function linkCoverageInfluencers(
  workspaceId: string,
  contactId: number,
  coverageMvprId: string,
  source = "engagement",
): Promise<number> {
  if (!isDbConfigured()) return 0
  const db = sql()
  const rows = await db<{
    journalist_id: string | null; journalist_name: string | null;
    publication_id: string | null; publication_name: string | null; link: string | null
  }>`
    SELECT journalist_id, journalist_name, publication_id, publication_name, link
    FROM mvpr_coverage
    WHERE workspace_id = ${workspaceId} AND mvpr_id = ${coverageMvprId}
    LIMIT 1
  `
  const c = rows[0]
  if (!c) return 0

  let edges = 0
  if (c.journalist_id && c.journalist_name) {
    const id = await upsertInfluencer(workspaceId, {
      kind: "person", type: "journalist", name: c.journalist_name, mvprJournalistId: c.journalist_id,
    })
    if (id != null) { await linkInfluence({ workspaceId, influencerId: id, contactId, source }); edges++ }
  }
  if (c.publication_id && c.publication_name) {
    const id = await upsertInfluencer(workspaceId, {
      kind: "organization", type: "publication", name: c.publication_name,
      mvprPublicationId: c.publication_id, domain: hostFromUrl(c.link),
    })
    if (id != null) { await linkInfluence({ workspaceId, influencerId: id, contactId, source }); edges++ }
  }
  return edges
}

/**
 * Link a prospect to the influencers behind every coverage piece attached to a
 * campaign. This is the channel-agnostic entry point: a prospect enrolled in
 * (or engaging with) a campaign that carries coverage - whether the campaign
 * goes out on LinkedIn, via Resend, or anywhere else - is influenced by that
 * coverage's sources. Returns total edges written.
 */
export async function linkCampaignCoverageInfluencers(
  workspaceId: string,
  contactId: number,
  campaignId: string,
  source = "campaign",
): Promise<number> {
  if (!isDbConfigured()) return 0
  const db = sql()
  const rows = await db<{ coverage_mvpr_id: string }>`
    SELECT coverage_mvpr_id FROM campaign_coverage
    WHERE workspace_id = ${workspaceId} AND campaign_id = ${campaignId}
  `
  let total = 0
  for (const r of rows) {
    total += await linkCoverageInfluencers(workspaceId, contactId, r.coverage_mvpr_id, source)
  }
  return total
}

// ─── Source 2: social follows ───────────────────────────────────────────────────

export interface FollowedInfluencer {
  kind:         InfluencerKind
  type:         InfluencerType
  name:         string
  linkedinUrl?: string | null
  domain?:      string | null
  twitterUrl?:  string | null
  website?:     string | null
}

/**
 * Upsert each followed account as an influencer and link the prospect to it
 * (the prospect's `influenced_by`). Idempotent. Returns edges written.
 */
export async function linkFollowedInfluencers(
  workspaceId: string,
  contactId: number,
  follows: FollowedInfluencer[],
  source = "social_follow",
): Promise<number> {
  if (!isDbConfigured() || follows.length === 0) return 0
  let edges = 0
  for (const f of follows) {
    if (!f.name) continue
    const id = await upsertInfluencer(workspaceId, {
      kind: f.kind, type: f.type, name: f.name,
      linkedinUrl: f.linkedinUrl ?? null, domain: f.domain ?? null,
      twitterUrl: f.twitterUrl ?? null, website: f.website ?? null,
    })
    if (id != null) { await linkInfluence({ workspaceId, influencerId: id, contactId, source }); edges++ }
  }
  return edges
}

/** Map a LinkedIn interests result (FollowedAccount lists) onto influencers. */
export function linkedinInterestsToInfluencers(interests: {
  topVoices?:   Array<{ name: string; linkedinUrl: string | null }>
  companies?:   Array<{ name: string; linkedinUrl: string | null }>
  newsletters?: Array<{ name: string; linkedinUrl: string | null }>
}): FollowedInfluencer[] {
  const out: FollowedInfluencer[] = []
  for (const v of interests.topVoices ?? [])   out.push({ kind: "person",       type: "individual",  name: v.name, linkedinUrl: v.linkedinUrl })
  for (const c of interests.companies ?? [])   out.push({ kind: "organization", type: "other",       name: c.name, linkedinUrl: c.linkedinUrl })
  for (const n of interests.newsletters ?? []) out.push({ kind: "organization", type: "publication", name: n.name, linkedinUrl: n.linkedinUrl })
  return out
}

/** Map an X/Twitter following result onto influencers (followed accounts are people by default). */
export function xAccountsToInfluencers(accounts: Array<{ name: string; handle: string; profileUrl: string | null }>): FollowedInfluencer[] {
  return accounts
    .filter(a => a.name || a.handle)
    .map(a => ({
      kind: "person" as const,
      type: "individual" as const,
      name: a.name || a.handle,
      twitterUrl: a.profileUrl ?? (a.handle ? `https://x.com/${a.handle.replace(/^@/, "")}` : null),
    }))
}

// ─── Source 3: publication audience ─────────────────────────────────────────────

/**
 * Link a batch of prospects to a publication/media influencer - the result of
 * scraping that publication's page followers and matching them to our contacts.
 * `publicationInfluencerId` is an influencers.id of an organization influencer.
 * Returns edges written.
 */
export async function linkPublicationAudience(
  workspaceId: string,
  publicationInfluencerId: number,
  contactIds: number[],
  source = "audience",
): Promise<number> {
  if (!isDbConfigured()) return 0
  let edges = 0
  for (const contactId of contactIds) {
    await linkInfluence({ workspaceId, influencerId: publicationInfluencerId, contactId, source })
    edges++
  }
  return edges
}
