/**
 * campaign_contacts store - enrollment of contacts into campaigns.
 *
 * Each row links a contact to a campaign within a workspace. The UI
 * uses this to show which contacts are in each campaign and to let
 * users enroll / unenroll from the People page chip dropdown.
 */

import { sql, isDbConfigured } from "./index"
import { listCampaigns, createCampaign, type CampaignRow } from "./campaigns"
import { linkCampaignCoverageInfluencers } from "../influence/edge-population"

export interface CampaignWithEnrollment extends CampaignRow {
  enrolled: boolean
  enrolledAt: string | null
}

/** All active campaigns for the workspace, with enrolled flag for a contact. */
export async function listCampaignsForContact(
  workspaceId: string,
  contactId: number,
): Promise<CampaignWithEnrollment[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const [campaigns, enrollments] = await Promise.all([
    listCampaigns(workspaceId),
    db<{ campaign_id: string; enrolled_at: Date }>`
      SELECT campaign_id, enrolled_at
      FROM campaign_contacts
      WHERE workspace_id = ${workspaceId}
        AND contact_id   = ${contactId}
    `,
  ])
  const enrolledMap = new Map(enrollments.map(r => [r.campaign_id, r.enrolled_at.toISOString()]))
  return campaigns.map(c => ({
    ...c,
    enrolled:   enrolledMap.has(c.id),
    enrolledAt: enrolledMap.get(c.id) ?? null,
  }))
}

/** Enroll a contact. No-op (no error) if already enrolled. */
export async function enrollContact(
  workspaceId: string,
  campaignId: string,
  contactId: number,
): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  await db`
    INSERT INTO campaign_contacts (workspace_id, campaign_id, contact_id)
    VALUES (${workspaceId}, ${campaignId}, ${contactId})
    ON CONFLICT (campaign_id, contact_id) DO NOTHING
  `

  // If this campaign carries earned coverage, enrolling the contact exposes
  // them to it (the campaign is the LinkedIn/Resend wrapper around the
  // coverage). Draw the influence edges to that coverage's journalist +
  // publication. Fire-and-forget; source 'campaign' = exposure, distinct from
  // a later confirmed-engagement edge. See ADR-015 / edge-population.ts.
  void linkCampaignCoverageInfluencers(workspaceId, contactId, campaignId, "campaign").catch(() => {})
}

/** Unenroll a contact. No-op if not enrolled. */
export async function unenrollContact(
  workspaceId: string,
  campaignId: string,
  contactId: number,
): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  await db`
    DELETE FROM campaign_contacts
    WHERE workspace_id = ${workspaceId}
      AND campaign_id  = ${campaignId}
      AND contact_id   = ${contactId}
  `
}

/**
 * Resolve a single attributable campaign for a contact on a given channel
 * (dm | email). Used by the send-dm / send-email endpoints to stamp
 * outreach_log.campaign_id automatically when the contact is unambiguously
 * enrolled in one campaign on that channel.
 *
 *   - 0 enrollments OR > 1 enrollments on the channel -> return null
 *     (don't guess; campaign_id stays NULL on the send).
 *   - Exactly 1 enrollment -> return its campaign_id + the most-recent
 *     campaign_coverage attachment so coverage attribution flows too.
 */
export async function resolveAttributionForSend(
  workspaceId: string,
  contactId:   number,
  channel:     "dm" | "email",
): Promise<{ campaignId: string; coverageMvprId: string | null } | null> {
  if (!isDbConfigured()) return null
  const db = sql()
  // Map send channel to the legacy enum the campaigns table carries.
  const enumValues = channel === "dm" ? ["linkedin_dm"] : ["email", "newsletter"]
  const rows = await db<{ campaign_id: string }>`
    SELECT cc.campaign_id
    FROM campaign_contacts cc
    JOIN campaigns c
      ON c.id = cc.campaign_id
    WHERE cc.workspace_id = ${workspaceId}
      AND cc.contact_id   = ${contactId}
      AND c.channel       = ANY(${enumValues}::text[])
      AND c.archived_at IS NULL
  `
  if (rows.length !== 1) return null
  const campaignId = rows[0].campaign_id
  const coverageRows = await db<{ coverage_mvpr_id: string }>`
    SELECT coverage_mvpr_id
    FROM campaign_coverage
    WHERE workspace_id = ${workspaceId}
      AND campaign_id  = ${campaignId}
    ORDER BY attached_at DESC
    LIMIT 1
  `
  return {
    campaignId,
    coverageMvprId: coverageRows[0]?.coverage_mvpr_id ?? null,
  }
}

/**
 * Quick-create a campaign (name only, linkedin_dm channel default) and
 * immediately enroll a contact. Returns the new campaign id.
 */
export async function createAndEnroll(
  workspaceId: string,
  name: string,
  contactId: number,
): Promise<string | null> {
  if (!isDbConfigured()) return null
  const id = await createCampaign({
    workspaceId,
    name:             name.trim(),
    channel:          "linkedin_dm",
    clickedLinkScore: 0,
  })
  if (!id) return null
  await enrollContact(workspaceId, id, contactId)
  return id
}
