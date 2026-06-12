/**
 * Direct Postgres writers for the gtm-os signal projection.
 *
 * Attribution writes land in the gtm-os Postgres projection. This file is
 * the local mirror of the recordSignal logic from
 * apps/web/lib/db/contact-store.ts — minus the score-suppression rules
 * (discovery-call cap, follow ↔ connection collision) that don't apply to
 * clicks or email events.
 *
 * Env vars required:
 *   DATABASE_URL    Neon connection string (same DB as gtm-os).
 *   WORKSPACE_ID    Default workspace id when the inbound payload doesn't
 *                   carry one (the attribution app is single-tenant today).
 *                   Future: add utm_workspace query param + decode workspace
 *                   from there.
 */

import { neon } from "@neondatabase/serverless"

const sql = neon(process.env.DATABASE_URL ?? "")

export function defaultWorkspaceId(): string | null {
  return process.env.WORKSPACE_ID ?? null
}

// ─── Funnel-stage derivation (mirrors deriveFunnelStage in contact-store.ts) ─

function deriveFunnelStage(score: number): string {
  if (score >= 26) return "High Signal"
  if (score >= 6)  return "Engaged"
  if (score >= 3)  return "Signal Found"
  return "Prospect"
}

// ─── Contact lookups ────────────────────────────────────────────────────────

/**
 * Find a contact by CRM record_id (stored on `contacts.crm_contact_id`).
 * Workspace-scoped. Returns the gtm-os internal contact id and workspace id,
 * or null.
 */
export async function findContactByCrmId(
  workspaceId: string,
  crmContactId: string,
): Promise<{ id: number; workspaceId: string } | null> {
  const rows = await sql`
    SELECT id, workspace_id FROM contacts
    WHERE workspace_id = ${workspaceId}
      AND crm_contact_id = ${crmContactId}
    LIMIT 1
  ` as Array<{ id: number; workspace_id: string }>
  if (!rows[0]) return null
  return { id: rows[0].id, workspaceId: rows[0].workspace_id }
}

/**
 * Find a contact by lowercased email within a workspace.
 */
export async function findContactByEmail(
  workspaceId: string,
  email: string,
): Promise<{ id: number; workspaceId: string } | null> {
  const rows = await sql`
    SELECT id, workspace_id FROM contacts
    WHERE workspace_id = ${workspaceId}
      AND lower(email) = ${email.toLowerCase()}
    LIMIT 1
  ` as Array<{ id: number; workspace_id: string }>
  if (!rows[0]) return null
  return { id: rows[0].id, workspaceId: rows[0].workspace_id }
}

// ─── Signal write ───────────────────────────────────────────────────────────

export interface AttributionSignal {
  workspaceId:    string
  contactId:      number
  crmSignalId?:   string  // dedup key — re-runs with same id are no-ops
  signalVerb:     string
  sourceType?:    string
  description?:   string
  scoreDelta:     number
  occurredAt?:    Date
}

/**
 * Record a signal on a contact and atomically update their aggregate score,
 * count, last_signal_at, and funnel_stage. Idempotent via the optional
 * crmSignalId.
 *
 * Skips score-suppression rules from the main recordSignal (discovery-call
 * cap, follow ↔ connection collision) — those don't apply to clicks or
 * email events. If we later need them, fold this into a shared
 * `packages/signal-ingest` workspace package.
 */
export async function recordAttributionSignal(s: AttributionSignal): Promise<void> {
  if (!process.env.DATABASE_URL) return

  // Identity dedup — skip if a row with this crmSignalId already exists.
  if (s.crmSignalId) {
    const existing = await sql`
      SELECT 1 FROM signals
      WHERE workspace_id = ${s.workspaceId}
        AND contact_id   = ${s.contactId}
        AND crm_signal_id = ${s.crmSignalId}
      LIMIT 1
    ` as Array<unknown>
    if (existing.length > 0) return
  }

  const occurredAt = (s.occurredAt ?? new Date()).toISOString()

  await sql`
    INSERT INTO signals (
      workspace_id, contact_id, crm_signal_id,
      source_type, description, signal_verb,
      score_delta, occurred_at
    ) VALUES (
      ${s.workspaceId}, ${s.contactId}, ${s.crmSignalId ?? null},
      ${s.sourceType ?? null}, ${s.description ?? null}, ${s.signalVerb},
      ${s.scoreDelta}, ${occurredAt}
    )
  `

  if (s.scoreDelta !== 0) {
    // Update aggregates. signal_count + 1; signal_score += delta (floored
    // at 0); funnel_stage recomputed from the new score. last_signal_at
    // bumped only when this signal is newer than what's stored.
    await sql`
      UPDATE contacts SET
        signal_score   = GREATEST(0, signal_score + ${s.scoreDelta}),
        signal_count   = signal_count + 1,
        last_signal_at = GREATEST(last_signal_at, ${occurredAt}::timestamptz),
        funnel_stage   = CASE
          WHEN GREATEST(0, signal_score + ${s.scoreDelta}) >= 26 THEN 'High Signal'
          WHEN GREATEST(0, signal_score + ${s.scoreDelta}) >= 6  THEN 'Engaged'
          WHEN GREATEST(0, signal_score + ${s.scoreDelta}) >= 3  THEN 'Signal Found'
          ELSE 'Prospect'
        END,
        updated_at     = NOW()
      WHERE id = ${s.contactId}
    `
  } else {
    // Zero-score signal — bump count + last_signal_at only (no score change,
    // no funnel transition). Keeps the engagement timeline accurate without
    // moving the lead.
    await sql`
      UPDATE contacts SET
        signal_count   = signal_count + 1,
        last_signal_at = GREATEST(last_signal_at, ${occurredAt}::timestamptz),
        updated_at     = NOW()
      WHERE id = ${s.contactId}
    `
  }
}

// deriveFunnelStage is exported for tests / callers that need the same
// scoring thresholds elsewhere in this app.
export { deriveFunnelStage }

/**
 * Look up a campaign's clicked_link_score (Task #23). Returns the score
 * when the campaign exists and isn't archived; null otherwise. The
 * track.ts click handler falls back to scoreDelta=0 on null - matching
 * pre-Task-23 behaviour for clicks whose UTM doesn't resolve to a
 * known campaign.
 */
export async function getCampaignClickScore(
  workspaceId: string,
  campaignId:  string,
): Promise<number | null> {
  if (!process.env.DATABASE_URL) return null
  const rows = await sql`
    SELECT clicked_link_score FROM campaigns
    WHERE id = ${campaignId}
      AND workspace_id = ${workspaceId}
      AND archived_at IS NULL
    LIMIT 1
  ` as Array<{ clicked_link_score: number }>
  return rows[0]?.clicked_link_score ?? null
}

/**
 * Mark the corporate email on a contact as invalid (Task #18) - called
 * from the Resend webhook on email.bounced. Mirrors the gtm-os
 * invalidateCorporateEmail helper but lives here because the attribution
 * app doesn't import from apps/web. The contact also picks up
 * needs_enrichment=TRUE so the Enrichment Candidates page surfaces them
 * for a re-enrichment pass.
 */
export async function invalidateCorporateEmail(
  workspaceId: string,
  contactId:   number,
  reason:      string,
): Promise<void> {
  if (!process.env.DATABASE_URL) return
  await sql`
    UPDATE contacts SET
      corporate_email_status         = 'not_found',
      corporate_email_invalidated_at = NOW(),
      needs_enrichment               = TRUE,
      enrichment_reason              = ${reason},
      updated_at                     = NOW()
    WHERE id = ${contactId} AND workspace_id = ${workspaceId}
  `
}
