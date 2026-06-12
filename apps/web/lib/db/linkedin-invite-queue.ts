/**
 * linkedin_invite_queue - DB-side operations.
 *
 * The enqueue route inserts a `queued` row; the hourly worker claims due
 * rows under the workspace's rolling-24h cap, calls Unipile, and walks the
 * row to `sent` / `failed` / `cancelled`. Accept/decline are written later
 * by the Unipile webhook handler (out of scope here).
 *
 * Everything is workspace-scoped. The partial unique index on
 * (workspace_id, contact_id) WHERE status IN (queued, sending, sent)
 * enforces "no two open invites for the same contact" at the DB layer; the
 * enqueue helper catches that and returns a typed error so callers can
 * surface a clean message.
 */

import { sql, isDbConfigured } from "./index"

export type InviteStatus =
  | "queued"
  | "sending"
  | "sent"
  | "accepted"
  | "declined"
  | "failed"
  | "cancelled"

export interface InviteRow {
  id:                          number
  workspace_id:                string
  contact_id:                  number
  scheduled_at:                Date
  status:                      InviteStatus
  note:                        string | null
  source:                      string
  triggered_by_signal_id:      number | null
  requested_by_team_member_id: string | null
  unipile_invitation_id:       string | null
  provider_id:                 string | null
  sent_at:                     Date | null
  accepted_at:                 Date | null
  declined_at:                 Date | null
  attempts:                    number
  last_attempt_at:             Date | null
  last_error:                  string | null
  created_at:                  Date
  updated_at:                  Date
}

export type EnqueueResult =
  | { ok: true; row: InviteRow }
  | { ok: false; reason: "already_open" | "db_unconfigured" }

export interface EnqueueArgs {
  workspaceId:                 string
  contactId:                   number
  note?:                       string | null
  scheduledAt?:                Date
  source?:                     string
  triggeredBySignalId?:        number | null
  requestedByTeamMemberId?:    string | null
}

export async function enqueueInvite(args: EnqueueArgs): Promise<EnqueueResult> {
  if (!isDbConfigured()) return { ok: false, reason: "db_unconfigured" }
  const db = sql()

  const rows = await db<InviteRow>`
    INSERT INTO linkedin_invite_queue (
      workspace_id, contact_id, scheduled_at, note, source,
      triggered_by_signal_id, requested_by_team_member_id
    )
    VALUES (
      ${args.workspaceId},
      ${args.contactId},
      ${args.scheduledAt ?? new Date()},
      ${args.note ?? null},
      ${args.source ?? "manual"},
      ${args.triggeredBySignalId ?? null},
      ${args.requestedByTeamMemberId ?? null}
    )
    ON CONFLICT DO NOTHING
    RETURNING *
  `

  if (rows.length === 0) return { ok: false, reason: "already_open" }
  return { ok: true, row: rows[0] }
}

/** Count rows whose sent_at falls inside the rolling 24h window. */
export async function countSentInLast24h(workspaceId: string): Promise<number> {
  if (!isDbConfigured()) return 0
  const db = sql()
  const rows = await db<{ count: string }>`
    SELECT COUNT(*)::text AS count
    FROM   linkedin_invite_queue
    WHERE  workspace_id = ${workspaceId}
      AND  sent_at      > NOW() - INTERVAL '24 hours'
  `
  return Number(rows[0]?.count ?? 0)
}

/**
 * Atomically claim up to `slots` due rows: flip queued -> sending, bump
 * attempts + last_attempt_at, return the rows. Workspace-scoped to keep
 * the cap check honest if multiple workspaces run in parallel.
 */
export async function claimDueInvites(workspaceId: string, slots: number): Promise<InviteRow[]> {
  if (!isDbConfigured() || slots <= 0) return []
  const db = sql()
  const rows = await db<InviteRow>`
    WITH due AS (
      SELECT id
      FROM   linkedin_invite_queue
      WHERE  workspace_id = ${workspaceId}
        AND  status       = 'queued'
        AND  scheduled_at <= NOW()
      ORDER  BY scheduled_at ASC
      FOR    UPDATE SKIP LOCKED
      LIMIT  ${slots}
    )
    UPDATE linkedin_invite_queue q
    SET    status          = 'sending',
           attempts        = q.attempts + 1,
           last_attempt_at = NOW(),
           updated_at      = NOW()
    FROM   due
    WHERE  q.id = due.id
    RETURNING q.*
  `
  return rows
}

export async function markSent(args: {
  id:                  number
  unipileInvitationId: string | null
  providerId:          string
}): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  await db`
    UPDATE linkedin_invite_queue
    SET    status                = 'sent',
           unipile_invitation_id = ${args.unipileInvitationId},
           provider_id           = ${args.providerId},
           sent_at               = NOW(),
           updated_at            = NOW()
    WHERE  id = ${args.id}
  `
}

export async function markFailed(args: {
  id:        number
  error:     string
  /** When true, leave the row terminal ('failed'). When false, bounce back
   *  to 'queued' so the next worker tick retries. */
  terminal:  boolean
}): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  await db`
    UPDATE linkedin_invite_queue
    SET    status     = ${args.terminal ? "failed" : "queued"},
           last_error = ${args.error},
           updated_at = NOW()
    WHERE  id = ${args.id}
  `
}

export async function markCancelled(args: {
  id:     number
  reason: string
}): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  await db`
    UPDATE linkedin_invite_queue
    SET    status     = 'cancelled',
           last_error = ${args.reason},
           updated_at = NOW()
    WHERE  id = ${args.id}
  `
}

/**
 * Workspaces that have at least one due invite. The cron iterates this list
 * so it only loads creds + counts caps for workspaces that need work.
 */
export async function workspacesWithDueInvites(): Promise<string[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const rows = await db<{ workspace_id: string }>`
    SELECT DISTINCT workspace_id
    FROM   linkedin_invite_queue
    WHERE  status       = 'queued'
      AND  scheduled_at <= NOW()
  `
  return rows.map(r => r.workspace_id)
}
