/**
 * campaign_coverage join store.
 *
 * Records "this campaign uses this coverage piece". Populated when a
 * user clicks the Use-this-coverage action on the coverage drawer
 * (either spawning a new campaign or attaching to an existing one).
 *
 * /reports/pr (PR 5) will read this to attribute campaign activity
 * back to specific coverage. The new-campaign flow also relies on it
 * to make the linkage discoverable from /settings/campaigns/[id].
 */

import { sql, isDbConfigured } from "./index"

export interface CampaignCoverageRow {
  workspaceId:    string
  campaignId:     string
  coverageMvprId: string
  attachedAt:     string
}

/** Attach a coverage piece to a campaign. No-op when already attached. */
export async function attachCoverageToCampaign(args: {
  workspaceId:    string
  campaignId:     string
  coverageMvprId: string
}): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  await db`
    INSERT INTO campaign_coverage (workspace_id, campaign_id, coverage_mvpr_id)
    VALUES (${args.workspaceId}, ${args.campaignId}, ${args.coverageMvprId})
    ON CONFLICT (workspace_id, campaign_id, coverage_mvpr_id) DO NOTHING
  `
}

/** Detach a coverage piece from a campaign. */
export async function detachCoverageFromCampaign(args: {
  workspaceId:    string
  campaignId:     string
  coverageMvprId: string
}): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  await db`
    DELETE FROM campaign_coverage
    WHERE workspace_id      = ${args.workspaceId}
      AND campaign_id       = ${args.campaignId}
      AND coverage_mvpr_id  = ${args.coverageMvprId}
  `
}

/** Coverage attached to a specific campaign. */
export async function listCoverageForCampaign(
  workspaceId: string,
  campaignId:  string,
): Promise<CampaignCoverageRow[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const rows = await db<{
    workspace_id:      string
    campaign_id:       string
    coverage_mvpr_id:  string
    attached_at:       Date
  }>`
    SELECT workspace_id, campaign_id, coverage_mvpr_id, attached_at
    FROM campaign_coverage
    WHERE workspace_id = ${workspaceId}
      AND campaign_id  = ${campaignId}
    ORDER BY attached_at DESC
  `
  return rows.map(r => ({
    workspaceId:    r.workspace_id,
    campaignId:     r.campaign_id,
    coverageMvprId: r.coverage_mvpr_id,
    attachedAt:     r.attached_at.toISOString(),
  }))
}

/** Campaigns that have this coverage attached. */
export async function listCampaignsForCoverage(
  workspaceId:    string,
  coverageMvprId: string,
): Promise<CampaignCoverageRow[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const rows = await db<{
    workspace_id:      string
    campaign_id:       string
    coverage_mvpr_id:  string
    attached_at:       Date
  }>`
    SELECT workspace_id, campaign_id, coverage_mvpr_id, attached_at
    FROM campaign_coverage
    WHERE workspace_id      = ${workspaceId}
      AND coverage_mvpr_id  = ${coverageMvprId}
    ORDER BY attached_at DESC
  `
  return rows.map(r => ({
    workspaceId:    r.workspace_id,
    campaignId:     r.campaign_id,
    coverageMvprId: r.coverage_mvpr_id,
    attachedAt:     r.attached_at.toISOString(),
  }))
}
