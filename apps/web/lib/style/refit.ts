/**
 * Refit pipeline (cozy-tiger Phase 4).
 *
 * Two phases, both driven by the daily cron at /api/cron/refit-fingerprints:
 *
 *   A. PROJECTION
 *      Every outreach_log row stamped with a fingerprint_version_id is a
 *      voice sample waiting for its outcome to resolve. This phase scans
 *      recent outreach_log rows that don't yet have a matching style_samples
 *      entry, scores each via the locked outcome rubric, and inserts a
 *      style_samples row when the outcome has resolved (a strong signal
 *      landed, or the 14-day no-signal window closed).
 *
 *   B. REFIT
 *      For each (workspace, channel, persona_id) cell that has accumulated
 *      >= REFIT_THRESHOLD fresh resolved samples (contributed_to_fp_version
 *      IS NULL), re-run the 63-dim analyzer on the positive bucket (score
 *      >= 1). Land a new active style_fingerprints row, deactivate the
 *      prior one, and stamp every consumed sample's
 *      contributed_to_fp_version to mark it as spent.
 */

import { sql, isDbConfigured } from "@/lib/db"
import type { WorkspaceConfig } from "@/lib/workspace-config"
import { scoreSendOutcome } from "./outcome-scorer"
import { generateFingerprint } from "./generator"
import {
  saveNewFingerprintVersion,
  type StyleChannel,
} from "@/lib/db/style-store"

const PROJECTION_WINDOW_DAYS = 90
const PROJECTION_BATCH_LIMIT = 500
const REFIT_THRESHOLD         = 20

/** outreach_log.channel -> style_fingerprints.channel mapping. */
function styleChannel(outreachChannel: string | null): StyleChannel | null {
  if (outreachChannel === "dm")    return "linkedin_dm"
  if (outreachChannel === "email") return "email"
  return null
}

/**
 * Phase A. Walk every outreach_log row in the recent window that's stamped
 * with a fingerprint_version_id and doesn't yet have a corresponding
 * style_samples row. Score it; if resolved, insert. Returns the count of
 * new style_samples rows inserted.
 */
export async function projectPendingSamples(
  workspaceId: string,
  config:      WorkspaceConfig,
): Promise<{ projected: number; skipped: number; unresolved: number }> {
  if (!isDbConfigured()) {
    return { projected: 0, skipped: 0, unresolved: 0 }
  }
  const db = sql()

  const personaByName = new Map<string, string>()
  for (const p of config.messaging?.personas ?? []) {
    if (p.id && p.name) personaByName.set(p.name, p.id)
  }

  const pending = await db<{
    id:              number
    contact_id:      number
    channel:         string | null
    persona:         string | null
    message_preview: string | null
    occurred_at:     Date
  }>`
    SELECT ol.id, ol.contact_id, ol.channel, ol.persona,
           ol.message_preview, ol.occurred_at
    FROM   outreach_log ol
    LEFT JOIN style_samples ss ON ss.outreach_log_id = ol.id
    WHERE  ol.workspace_id           = ${workspaceId}
      AND  ol.fingerprint_version_id IS NOT NULL
      AND  ol.occurred_at            > NOW() - INTERVAL '${PROJECTION_WINDOW_DAYS} days'
      AND  ol.message_preview        IS NOT NULL
      AND  ss.id                     IS NULL
    ORDER BY ol.occurred_at DESC
    LIMIT ${PROJECTION_BATCH_LIMIT}
  `

  let projected  = 0
  let skipped    = 0
  let unresolved = 0

  for (const row of pending) {
    if (!row.message_preview) { skipped++; continue }
    const channel = styleChannel(row.channel)
    if (!channel) { skipped++; continue }
    // persona_id resolves through the workspace config because outreach_log
    // stored the persona's display name, not its UUID, at send time.
    const personaId = row.persona ? personaByName.get(row.persona) ?? null : null

    const scored = await scoreSendOutcome({
      workspaceId,
      contactId: row.contact_id,
      sentAt:    row.occurred_at,
    })
    if (!scored.resolved) { unresolved++; continue }

    await db`
      INSERT INTO style_samples (
        workspace_id, channel, persona_id, contact_id, source, content,
        outcome_score, outcome_resolved_at, outreach_log_id
      )
      VALUES (
        ${workspaceId}, ${channel}, ${personaId}, ${row.contact_id},
        'auto_send',
        ${row.message_preview},
        ${scored.score}, ${scored.resolvedAt}, ${row.id}
      )
    `
    projected++
  }

  return { projected, skipped, unresolved }
}

export interface CellRefitResult {
  channel:     StyleChannel
  personaId:   string
  positives:   number
  negatives:   number
  version:     number
  fingerprintId: number
}

/**
 * Phase B. For one workspace, find (channel, persona) cells with enough
 * fresh resolved samples and refit each. Returns a per-cell summary.
 */
export async function refitEligibleCells(
  workspaceId: string,
): Promise<CellRefitResult[]> {
  if (!isDbConfigured()) return []
  const db = sql()

  const cells = await db<{
    channel:      string
    persona_id:   string
    sample_count: number
  }>`
    SELECT channel, persona_id, COUNT(*)::int AS sample_count
    FROM   style_samples
    WHERE  workspace_id              = ${workspaceId}
      AND  contributed_to_fp_version IS NULL
      AND  outcome_resolved_at       IS NOT NULL
      AND  persona_id                IS NOT NULL
      AND  channel                   IN ('linkedin_dm', 'email')
    GROUP BY channel, persona_id
    HAVING COUNT(*) >= ${REFIT_THRESHOLD}
  `

  const results: CellRefitResult[] = []

  for (const cell of cells) {
    const channel = cell.channel as StyleChannel

    const samples = await db<{
      id: number; content: string; outcome_score: string | number | null
    }>`
      SELECT id, content, outcome_score
      FROM   style_samples
      WHERE  workspace_id              = ${workspaceId}
        AND  channel                   = ${channel}
        AND  persona_id                = ${cell.persona_id}
        AND  contributed_to_fp_version IS NULL
        AND  outcome_resolved_at       IS NOT NULL
    `

    const pos: typeof samples = []
    const neg: typeof samples = []
    for (const s of samples) {
      const score = typeof s.outcome_score === "string"
        ? Number(s.outcome_score)
        : (s.outcome_score ?? 0)
      if (score >= 1) pos.push(s)
      else if (score <= -1) neg.push(s)
    }

    if (pos.length === 0) continue // need positives to define voice

    const fingerprint = await generateFingerprint({
      workspaceId,
      samples:    pos.map(p => p.content),
      authorName: `cell:${channel}/${cell.persona_id}`,
      metadata:   {
        scope:        "channel_persona",
        channel,
        persona_id:   cell.persona_id,
        source:       "auto_refit",
        positives:    pos.length,
        negatives:    neg.length,
      },
    })

    const saved = await saveNewFingerprintVersion({
      workspaceId,
      scope:       "channel_persona",
      channel,
      personaId:   cell.persona_id,
      fingerprint,
      samplePos:   pos.length,
      sampleNeg:   neg.length,
      source:      "auto_refit",
    })

    // Mark every sample consumed in this fit as contributed.
    const consumedIds = [...pos, ...neg].map(s => s.id)
    if (consumedIds.length > 0) {
      await db`
        UPDATE style_samples
        SET    contributed_to_fp_version = ${saved.version}
        WHERE  id = ANY(${consumedIds})
      `
    }

    results.push({
      channel,
      personaId:     cell.persona_id,
      positives:     pos.length,
      negatives:     neg.length,
      version:       saved.version,
      fingerprintId: saved.id,
    })
  }

  return results
}
