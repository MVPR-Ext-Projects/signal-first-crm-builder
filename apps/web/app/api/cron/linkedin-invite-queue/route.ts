/**
 * Hourly LinkedIn-invite-queue worker.
 *
 * Walks linkedin_invite_queue forward. For each workspace with at least one
 * queued + due row:
 *
 *   1. Pull WorkspaceConfig.messaging.unipile creds + dailyInviteCap.
 *      Skip if unipile not configured (the enqueue endpoint shouldn't have
 *      accepted these rows in the first place, but be defensive).
 *   2. Count rows whose sent_at falls in the rolling 24h window.
 *      slots = dailyInviteCap - sent_count.
 *   3. Atomically claim up to `slots` due rows (FOR UPDATE SKIP LOCKED).
 *   4. For each claimed row, re-check DNC + linkedin_url_status (the row
 *      may have been queued hours ago and the contact's state could have
 *      changed). Trips flip to 'cancelled'.
 *   5. Call Unipile /users/invite. Walk the row to 'sent' / 'failed' /
 *      'queued' (the last is a soft-retry for 429 / 5xx).
 *   6. On success: record a sent_connection_request signal so the lead's
 *      engagement history reflects the action, and write a usage_log row.
 *   7. On URL-resolve failure: feed the existing linkedin_send_failures
 *      table so the "2 hard fails in 48h -> mark URL inactive" rule kicks
 *      in just like it does for DM sends.
 *
 * Schedule: hourly. The cap is enforced as a rolling 24h count of sent_at,
 * not a "burst per hour" - if the queue holds 50 rows and the cap is 20,
 * the first run sends 20 and the rest stay queued until 24h after each
 * earlier send. Smoother pacing can come later via per-row scheduled_at.
 *
 * Auth: Bearer CRON_SECRET. Same pattern as the other crons in this app.
 *
 * Idempotent: claim uses SKIP LOCKED so parallel ticks don't double-send.
 * Failed rows that bounce back to 'queued' will be picked up next tick.
 */

import { NextRequest, NextResponse } from "next/server"
import { isDbConfigured, sql } from "@/lib/db"
import { getWorkspaceConfig, resolveVerbWeight } from "@/lib/workspace-config"
import {
  claimDueInvites,
  countSentInLast24h,
  markCancelled,
  markFailed,
  markSent,
  workspacesWithDueInvites,
} from "@/lib/db/linkedin-invite-queue"
import { sendLinkedInInvite } from "@/lib/unipile"
import {
  confirmLinkedinUrl,
  recordLinkedinSendFailure,
  recordSignal,
} from "@/lib/db/contact-store"
import { isContactReachable } from "@/lib/outbound/reachable"
import { logUsage } from "@/lib/usage-log"
import { UNIPILE_CENTS_PER_MESSAGE } from "@/lib/pricing"

const DEFAULT_DAILY_INVITE_CAP = 20

export async function GET(req: NextRequest) {
  return run(req)
}
export async function POST(req: NextRequest) {
  return run(req)
}

async function run(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DB not configured" }, { status: 500 })
  }

  const workspaceIds = await workspacesWithDueInvites()
  const byWorkspace: Record<string, {
    sent:      number
    failed:    number
    cancelled: number
    skipped:   number
    cap:       number
  }> = {}
  let totalSent = 0
  let totalFailed = 0
  let totalCancelled = 0

  for (const workspaceId of workspaceIds) {
    const config = await getWorkspaceConfig(workspaceId)
    const creds  = config?.messaging?.unipile
    if (!creds?.apiKey || !creds?.dsn || !creds?.accountId) {
      byWorkspace[workspaceId] = { sent: 0, failed: 0, cancelled: 0, skipped: -1, cap: 0 }
      continue
    }
    const cap       = creds.dailyInviteCap ?? DEFAULT_DAILY_INVITE_CAP
    const sentCount = await countSentInLast24h(workspaceId)
    const slots     = Math.max(0, cap - sentCount)
    if (slots === 0) {
      byWorkspace[workspaceId] = { sent: 0, failed: 0, cancelled: 0, skipped: 0, cap }
      continue
    }

    const claimed = await claimDueInvites(workspaceId, slots)
    let sent = 0
    let failed = 0
    let cancelled = 0

    for (const row of claimed) {
      // Re-fetch the contact's current reachability state. The row may have
      // been queued hours (or days) ago and the contact could have been DNC'd
      // or had their LinkedIn URL invalidated in the meantime.
      const db = sql()
      const contactRows = await db<{
        linkedin_url:         string | null
        do_not_contact_until: Date | null
        linkedin_url_status:  string | null
        linkedin_connected:   boolean | null
      }>`
        SELECT linkedin_url, do_not_contact_until, linkedin_url_status, linkedin_connected
        FROM   contacts
        WHERE  id = ${row.contact_id}
        LIMIT 1
      `
      const contact = contactRows[0]
      if (!contact || !contact.linkedin_url) {
        await markCancelled({ id: row.id, reason: "Contact missing or has no LinkedIn URL" })
        cancelled++
        continue
      }
      if (contact.linkedin_connected === true) {
        await markCancelled({ id: row.id, reason: "Already connected on LinkedIn" })
        cancelled++
        continue
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
        await markCancelled({ id: row.id, reason: reach.reasons.join(",") })
        cancelled++
        continue
      }

      const result = await sendLinkedInInvite({
        creds:       { apiKey: creds.apiKey, dsn: creds.dsn, accountId: creds.accountId },
        linkedinUrl: contact.linkedin_url,
        message:     row.note ?? undefined,
      })

      if (!result.ok) {
        await markFailed({ id: row.id, error: result.error, terminal: result.fatal })
        if (result.fatal) {
          try {
            await recordLinkedinSendFailure(
              workspaceId,
              row.contact_id,
              contact.linkedin_url,
              `invite: ${result.error}`,
            )
          } catch (err) {
            console.warn(`[cron/linkedin-invite-queue] recordLinkedinSendFailure failed:`, err)
          }
        }
        failed++
        continue
      }

      await markSent({
        id:                  row.id,
        unipileInvitationId: result.invitationId,
        providerId:          result.providerId,
      })
      sent++

      try {
        await confirmLinkedinUrl(workspaceId, row.contact_id)
      } catch (err) {
        console.warn(`[cron/linkedin-invite-queue] confirmLinkedinUrl failed:`, err)
      }

      try {
        // Resolve who sent it for the signals timeline:
        //   - prefer the team member the enqueue request explicitly named,
        //   - else fall back to the workspace's first team member (in
        //     single-user workspaces that's the inviter by definition).
        const members = config!.teamMembers ?? []
        const explicit = row.requested_by_team_member_id
          ? members.find(m => m.id === row.requested_by_team_member_id)
          : null
        const signalActor = (explicit?.name ?? members[0]?.name) ?? undefined

        await recordSignal(workspaceId, row.contact_id, {
          crmSignalId: result.invitationId ? `unipile:invite:${result.invitationId}` : undefined,
          sourceType:  "Connection Request Sent",
          signalVerb:  "sent_connection_request",
          signalActor,
          description: row.note ? row.note.slice(0, 200) : "Connection request sent",
          scoreDelta:  resolveVerbWeight(config!, "sent_connection_request"),
        })
      } catch (err) {
        console.warn(`[cron/linkedin-invite-queue] recordSignal failed:`, err)
      }

      void logUsage({
        workspaceId,
        category:      "messaging",
        provider:      "unipile",
        units:         1,
        unitCostCents: UNIPILE_CENTS_PER_MESSAGE,
        metadata:      {
          kind:         "invite",
          inviteRowId:  row.id,
          invitationId: result.invitationId,
          providerId:   result.providerId,
        },
      })
    }

    byWorkspace[workspaceId] = { sent, failed, cancelled, skipped: 0, cap }
    totalSent      += sent
    totalFailed    += failed
    totalCancelled += cancelled
  }

  console.log(`[cron/linkedin-invite-queue] sent=${totalSent} failed=${totalFailed} cancelled=${totalCancelled} across ${workspaceIds.length} workspaces`)

  return NextResponse.json({
    ok:           true,
    sent:         totalSent,
    failed:       totalFailed,
    cancelled:    totalCancelled,
    byWorkspace,
  })
}
