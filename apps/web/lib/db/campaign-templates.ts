/**
 * campaign_templates store - editable per-campaign message templates.
 *
 * A campaign owns zero or more templates (variants). The drafting
 * pipeline (PR 4) will read getDefaultTemplate() at compose time so the
 * outbound surface picks up the campaign's seeded copy automatically.
 *
 * Shape conventions per channel (channel inherited from the parent
 * campaigns.channel row):
 *   linkedin_dm   - body (plain text), subject + html NULL
 *   email         - subject + html (preferred) + body (text fallback)
 *   newsletter    - same as email (lands when PR 4 adds the channel)
 *   lead_magnet / other - body required; subject/html optional
 */

import { sql, isDbConfigured } from "./index"

export interface CampaignTemplateRow {
  id:           string
  workspaceId:  string
  campaignId:   string
  name:         string
  subject:      string | null
  html:         string | null
  body:         string
  isDefault:    boolean
  createdAt:    string
  updatedAt:    string
}

interface DbRow {
  id:            string
  workspace_id:  string
  campaign_id:   string
  name:          string
  subject:       string | null
  html:          string | null
  body:          string
  is_default:    boolean
  created_at:    Date
  updated_at:    Date
}

function mapRow(r: DbRow): CampaignTemplateRow {
  return {
    id:          r.id,
    workspaceId: r.workspace_id,
    campaignId:  r.campaign_id,
    name:        r.name,
    subject:     r.subject,
    html:        r.html,
    body:        r.body,
    isDefault:   r.is_default,
    createdAt:   r.created_at.toISOString(),
    updatedAt:   r.updated_at.toISOString(),
  }
}

export async function listTemplatesForCampaign(
  workspaceId: string,
  campaignId:  string,
): Promise<CampaignTemplateRow[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const rows = await db<DbRow>`
    SELECT id, workspace_id, campaign_id, name, subject, html, body,
           is_default, created_at, updated_at
    FROM campaign_templates
    WHERE workspace_id = ${workspaceId}
      AND campaign_id  = ${campaignId}
    ORDER BY is_default DESC, created_at ASC
  `
  return rows.map(mapRow)
}

export async function getDefaultTemplate(
  workspaceId: string,
  campaignId:  string,
): Promise<CampaignTemplateRow | null> {
  if (!isDbConfigured()) return null
  const db = sql()
  const rows = await db<DbRow>`
    SELECT id, workspace_id, campaign_id, name, subject, html, body,
           is_default, created_at, updated_at
    FROM campaign_templates
    WHERE workspace_id = ${workspaceId}
      AND campaign_id  = ${campaignId}
      AND is_default   = TRUE
    LIMIT 1
  `
  return rows[0] ? mapRow(rows[0]) : null
}

export async function createTemplate(args: {
  workspaceId: string
  campaignId:  string
  name:        string
  body:        string
  subject?:    string | null
  html?:       string | null
  isDefault?:  boolean
}): Promise<string | null> {
  if (!isDbConfigured()) return null
  const id = crypto.randomUUID()
  const db = sql()

  // If marking default, demote any prior default so the partial-unique
  // index doesn't trip.
  if (args.isDefault) {
    await db`
      UPDATE campaign_templates SET is_default = FALSE
      WHERE workspace_id = ${args.workspaceId}
        AND campaign_id  = ${args.campaignId}
        AND is_default   = TRUE
    `
  }

  await db`
    INSERT INTO campaign_templates (
      id, workspace_id, campaign_id, name, subject, html, body, is_default
    ) VALUES (
      ${id}, ${args.workspaceId}, ${args.campaignId},
      ${args.name}, ${args.subject ?? null}, ${args.html ?? null}, ${args.body},
      ${args.isDefault ?? false}
    )
  `
  return id
}

export async function updateTemplate(args: {
  workspaceId: string
  id:          string
  name?:       string
  subject?:    string | null
  html?:       string | null
  body?:       string
  isDefault?:  boolean
}): Promise<boolean> {
  if (!isDbConfigured()) return false
  const db = sql()

  if (args.isDefault === true) {
    // Find the campaign so we can demote sibling defaults.
    const rows = await db<{ campaign_id: string }>`
      SELECT campaign_id FROM campaign_templates
      WHERE workspace_id = ${args.workspaceId} AND id = ${args.id}
      LIMIT 1
    `
    const campaignId = rows[0]?.campaign_id
    if (campaignId) {
      await db`
        UPDATE campaign_templates SET is_default = FALSE
        WHERE workspace_id = ${args.workspaceId}
          AND campaign_id  = ${campaignId}
          AND id           <> ${args.id}
          AND is_default   = TRUE
      `
    }
  }

  const res = await db`
    UPDATE campaign_templates SET
      name       = COALESCE(${args.name      ?? null}, name),
      subject    = COALESCE(${args.subject   ?? null}, subject),
      html       = COALESCE(${args.html      ?? null}, html),
      body       = COALESCE(${args.body      ?? null}, body),
      is_default = COALESCE(${args.isDefault ?? null}, is_default),
      updated_at = NOW()
    WHERE workspace_id = ${args.workspaceId} AND id = ${args.id}
  `
  return (res as unknown as { count: number }).count > 0
}

export async function deleteTemplate(
  workspaceId: string,
  id:          string,
): Promise<boolean> {
  if (!isDbConfigured()) return false
  const db = sql()
  const res = await db`
    DELETE FROM campaign_templates
    WHERE workspace_id = ${workspaceId} AND id = ${id}
  `
  return (res as unknown as { count: number }).count > 0
}
