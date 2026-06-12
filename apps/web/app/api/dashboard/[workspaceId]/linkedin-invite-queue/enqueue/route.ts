/**
 * POST /api/dashboard/[workspaceId]/linkedin-invite-queue/enqueue
 *
 * Body: {
 *   contactId:                number,
 *   note?:                    string,            // <=300 chars; free-tier accounts: ~5 notes/month
 *   scheduledAt?:             string,            // ISO date; default: now
 *   source?:                  string,            // 'manual' | 'auto_signal_threshold' | 'campaign' | 'bulk_import'
 *   triggeredBySignalId?:     number,
 *   requestedByTeamMemberId?: string,
 * }
 *
 * Inserts a 'queued' row in linkedin_invite_queue. The hourly worker at
 * /api/cron/linkedin-invite-queue picks it up, enforces the workspace's
 * dailyInviteCap, and calls Unipile.
 *
 * Validates:
 *   - workspace has Unipile configured (otherwise sending would never work)
 *   - the contact exists in this workspace
 *   - the contact is reachable on linkedin_dm (not DNC'd, URL not inactive)
 *   - no existing open invite for the contact (the DB unique partial index
 *     enforces this too; we just turn the conflict into a clean 409).
 *
 * Auth: same dashboard cookie as the page.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { sql, isDbConfigured } from "@/lib/db"
import { enqueueInvite } from "@/lib/db/linkedin-invite-queue"
import { isContactReachable, explainReason } from "@/lib/outbound/reachable"

const MAX_NOTE_LENGTH = 300

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params

  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Unknown workspace" }, { status: 404 })

  if (config.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  const creds = config.messaging?.unipile
  if (!creds?.apiKey || !creds?.dsn || !creds?.accountId) {
    return NextResponse.json(
      { error: "Unipile is not fully configured for this workspace" },
      { status: 400 },
    )
  }

  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DB not configured" }, { status: 500 })
  }

  let contactId:               number  | undefined
  let note:                    string  | undefined
  let scheduledAt:             Date    | undefined
  let source:                  string  | undefined
  let triggeredBySignalId:     number  | null = null
  let requestedByTeamMemberId: string  | null = null
  try {
    const body = await request.json()
    // Accept contactId as either a number or a numeric string - Neon
    // returns BIGINT as a string, so client code that forwards a row's
    // id will send it stringified even though TS types it as number.
    if (typeof body.contactId === "number" && Number.isFinite(body.contactId)) {
      contactId = body.contactId
    } else if (typeof body.contactId === "string" && /^\d+$/.test(body.contactId)) {
      contactId = Number(body.contactId)
    }
    note                    = typeof body.note === "string" ? body.note : undefined
    source                  = typeof body.source === "string" ? body.source : undefined
    if (typeof body.triggeredBySignalId === "number") triggeredBySignalId = body.triggeredBySignalId
    else if (typeof body.triggeredBySignalId === "string" && /^\d+$/.test(body.triggeredBySignalId)) triggeredBySignalId = Number(body.triggeredBySignalId)
    requestedByTeamMemberId = typeof body.requestedByTeamMemberId === "string" ? body.requestedByTeamMemberId : null
    if (typeof body.scheduledAt === "string") {
      const parsed = new Date(body.scheduledAt)
      if (!Number.isNaN(parsed.getTime())) scheduledAt = parsed
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }

  if (contactId === undefined) {
    return NextResponse.json({ error: "contactId is required" }, { status: 400 })
  }
  if (note !== undefined && note.length > MAX_NOTE_LENGTH) {
    return NextResponse.json(
      { error: `note too long (max ${MAX_NOTE_LENGTH} chars)` },
      { status: 400 },
    )
  }

  const db = sql()
  const rows = await db<{
    id:                   number
    linkedin_url:         string | null
    do_not_contact_until: Date | null
    linkedin_url_status:  string | null
    linkedin_connected:   boolean | null
  }>`
    SELECT id, linkedin_url, do_not_contact_until, linkedin_url_status, linkedin_connected
    FROM   contacts
    WHERE  id           = ${contactId}
      AND  workspace_id = ${workspaceId}
    LIMIT 1
  `
  const contact = rows[0]
  if (!contact) {
    return NextResponse.json({ error: "Contact not found in this workspace" }, { status: 404 })
  }
  if (!contact.linkedin_url) {
    return NextResponse.json({ error: "Contact has no LinkedIn URL on file" }, { status: 400 })
  }
  if (contact.linkedin_connected === true) {
    return NextResponse.json(
      { error: "Already connected on LinkedIn - no invite needed" },
      { status: 409 },
    )
  }

  const reach = isContactReachable(
    {
      doNotContactUntil:    contact.do_not_contact_until,
      linkedinUrlStatus:    contact.linkedin_url_status,
      corporateEmailStatus: null,
      email:                null,
    },
    "linkedin_dm",
  )
  if (!reach.ok) {
    return NextResponse.json(
      { error: reach.reasons.map(explainReason).join(" "), reasons: reach.reasons },
      { status: 403 },
    )
  }

  const result = await enqueueInvite({
    workspaceId,
    contactId,
    note,
    scheduledAt,
    source,
    triggeredBySignalId,
    requestedByTeamMemberId,
  })
  if (!result.ok) {
    if (result.reason === "already_open") {
      return NextResponse.json(
        { error: "An invite for this contact is already queued, in flight, or awaiting acceptance" },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: "Failed to enqueue invite" }, { status: 500 })
  }

  return NextResponse.json({ ok: true, invite: result.row })
}
