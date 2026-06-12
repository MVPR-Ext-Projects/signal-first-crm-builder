/**
 * Writing-style fingerprint store.
 *
 * Wraps the style_fingerprints + style_samples tables. The "cell" in this
 * module's API is a (workspace_id, scope, channel, persona_id) tuple:
 *
 *   - scope='corporate'        => channel + personaId are null. One active
 *                                 row per workspace.
 *   - scope='channel'          => channel set, personaId null. One active
 *                                 row per channel. The Action-Set-level
 *                                 umbrella voice that applies when there's
 *                                 no persona-specific fingerprint.
 *   - scope='channel_persona'  => both set. One active row per (channel,
 *                                 persona) pair. channel in
 *                                 {'linkedin_dm', 'email'} for v1.
 *
 * Resolution at draft time (see lib/style/fetch-fingerprints.ts) stacks
 * the three layers from least to most specific: corporate < channel <
 * channel_persona. Most-specific available wins.
 *
 * Versioning: every save creates a new row and deactivates the prior
 * active one in two consecutive statements. A draft request that lands in
 * the millisecond between the deactivate and the insert sees no active
 * fingerprint for that cell and falls back to the next-less-specific
 * layer. Acceptable for v1; the alternative is wrapping both writes in a
 * transaction via the raw Pool client, which the rest of the codebase
 * doesn't do.
 */

import type { StyleProfile } from "../style/types"
import { sql, isDbConfigured } from "./index"

export type StyleScope    = "corporate" | "channel" | "channel_persona" | "campaign"
export type StyleChannel  = "linkedin_dm" | "email"
export type StyleSource   = "manual_upload" | "mined_from_outreach_log" | "auto_refit" | "seed"
export type SampleSource  = "auto_send"     | "manual_upload" | "mined_from_outreach_log"

export interface StoredFingerprint {
  id:          number
  version:     number
  fingerprint: StyleProfile
  createdAt:   string
  /** sample_count_pos from the row. Surfaced for the Actions-page panel. */
  samplePos:   number
  /** sample_count_neg from the row. */
  sampleNeg:   number
}

interface CellKey {
  workspaceId: string
  scope:       StyleScope
  /** Must be null when scope='corporate'. Set otherwise. */
  channel:     StyleChannel | null
  /** Set only when scope='channel_persona'. Null for 'corporate', 'channel', 'campaign'. */
  personaId:   string       | null
  /** Set only when scope='campaign'. Null otherwise. */
  campaignId?: string       | null
}

/**
 * Return the currently-active fingerprint for a cell, or null when none has
 * been generated yet.
 */
export async function getActiveFingerprint(key: CellKey): Promise<StoredFingerprint | null> {
  if (!isDbConfigured()) return null
  const db = sql()
  const campaignId = key.campaignId ?? null
  const rows = await db<{
    id: number; version: number; fingerprint: StyleProfile; created_at: Date;
    sample_count_pos: number; sample_count_neg: number;
  }>`
    SELECT id, version, fingerprint, created_at, sample_count_pos, sample_count_neg
    FROM style_fingerprints
    WHERE workspace_id = ${key.workspaceId}
      AND scope        = ${key.scope}
      AND channel      IS NOT DISTINCT FROM ${key.channel}
      AND persona_id   IS NOT DISTINCT FROM ${key.personaId}
      AND campaign_id  IS NOT DISTINCT FROM ${campaignId}
      AND is_active    = TRUE
    LIMIT 1
  `
  const row = rows[0]
  if (!row) return null
  return {
    id:          row.id,
    version:     row.version,
    fingerprint: row.fingerprint,
    createdAt:   row.created_at.toISOString(),
    samplePos:   row.sample_count_pos,
    sampleNeg:   row.sample_count_neg,
  }
}

/**
 * Insert a new fingerprint version and deactivate the prior active one for
 * the cell. Returns the new row's id + version.
 */
export async function saveNewFingerprintVersion(args: CellKey & {
  fingerprint: StyleProfile
  samplePos:   number
  sampleNeg:   number
  source:      StyleSource
}): Promise<{ id: number; version: number }> {
  const db = sql()

  const campaignId = args.campaignId ?? null

  // 1. Deactivate any current active row for this cell.
  await db`
    UPDATE style_fingerprints
    SET is_active = FALSE
    WHERE workspace_id = ${args.workspaceId}
      AND scope        = ${args.scope}
      AND channel      IS NOT DISTINCT FROM ${args.channel}
      AND persona_id   IS NOT DISTINCT FROM ${args.personaId}
      AND campaign_id  IS NOT DISTINCT FROM ${campaignId}
      AND is_active    = TRUE
  `

  // 2. Compute the next version (max across history, +1).
  const [vRow] = await db<{ next_version: number }>`
    SELECT COALESCE(MAX(version), 0) + 1 AS next_version
    FROM style_fingerprints
    WHERE workspace_id = ${args.workspaceId}
      AND scope        = ${args.scope}
      AND channel      IS NOT DISTINCT FROM ${args.channel}
      AND persona_id   IS NOT DISTINCT FROM ${args.personaId}
      AND campaign_id  IS NOT DISTINCT FROM ${campaignId}
  `
  const nextVersion = vRow?.next_version ?? 1

  // 3. Insert the new active row.
  const [row] = await db<{ id: number; version: number }>`
    INSERT INTO style_fingerprints (
      workspace_id, scope, channel, persona_id, campaign_id, version, is_active,
      fingerprint, sample_count_pos, sample_count_neg, source
    )
    VALUES (
      ${args.workspaceId}, ${args.scope}, ${args.channel}, ${args.personaId}, ${campaignId},
      ${nextVersion}, TRUE,
      ${JSON.stringify(args.fingerprint)}::jsonb,
      ${args.samplePos}, ${args.sampleNeg}, ${args.source}
    )
    RETURNING id, version
  `

  return { id: row.id, version: row.version }
}
