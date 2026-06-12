/**
 * POST /api/dashboard/[workspaceId]/send-dm
 *
 * Body: { linkedinUrl: string, message: string }
 *
 * Sends a brand-new LinkedIn DM via Unipile and records the outbound action
 * as a signal so it appears in the lead's engagement history. Score is
 * resolved from the workspace's Engagement Scoring settings (verb=sent_dm,
 * default 0 — outbound action). Users can change the weight via the Scoring
 * settings page; this route picks up whatever's configured.
 *
 * Auth: same dashboard cookie as the page.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig, resolveVerbWeight } from "@/lib/workspace-config"
import { sendLinkedInDm } from "@/lib/unipile"
import { sql, isDbConfigured } from "@/lib/db"
import { recordSignal, recordOutreach, confirmLinkedinUrl, recordLinkedinSendFailure } from "@/lib/db/contact-store"
import { resolveAttributionForSend } from "@/lib/db/campaign-contacts"
import { logUsage } from "@/lib/usage-log"
import { UNIPILE_CENTS_PER_MESSAGE } from "@/lib/pricing"
import { isContactReachable, explainReason } from "@/lib/outbound/reachable"

const MAX_MESSAGE_LENGTH = 1900   // LinkedIn caps at ~2000

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params

  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Unknown workspace" }, { status: 404 })

  // Auth — same cookie check as the dashboard page
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

  let linkedinUrl:       string | undefined
  let message:           string | undefined
  let selectedTemplateIds: string[] = []
  // Non-null when this send started from an AI draft. We pass it through to
  // outreach_log.fingerprint_version_id so the Phase 4 refit cron can
  // attribute outcomes back to the fingerprint version that produced the
  // copy. Null on manual / template-only sends.
  let fingerprintVersionId: number | null = null
  try {
    const body = await request.json()
    linkedinUrl          = typeof body.linkedinUrl === "string" ? body.linkedinUrl : undefined
    message              = typeof body.message     === "string" ? body.message     : undefined
    selectedTemplateIds  = Array.isArray(body.selectedTemplateIds) ? body.selectedTemplateIds.filter((x: unknown) => typeof x === "string") : []
    fingerprintVersionId = typeof body.fingerprintVersionId === "number" ? body.fingerprintVersionId : null
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }

  if (!linkedinUrl) return NextResponse.json({ error: "linkedinUrl is required" }, { status: 400 })
  if (!message?.trim()) return NextResponse.json({ error: "message is required" }, { status: 400 })
  if (message.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json(
      { error: `Message too long (max ${MAX_MESSAGE_LENGTH} chars)` },
      { status: 400 },
    )
  }

  // Reachability check (Task #17): block sends to DNC'd contacts and to
  // contacts whose LinkedIn URL is marked inactive. Looks up the contact
  // by normalized LinkedIn URL; if we don't have them in the DB, the
  // send proceeds (we can't reason about reachability for an unknown
  // contact, and blocking on absence would break first-touch outreach).
  // The contactId from this lookup is also used downstream for the
  // LinkedIn-URL lifecycle markers (Task #18) - confirming on success
  // and logging on hard failure - so we hoist it out of the if/else.
  let preflightContactId: number | undefined
  if (isDbConfigured()) {
    const db   = sql()
    const norm = linkedinUrl.toLowerCase().replace(/\/$/, "")
    const rows = await db<{
      id:                   number
      do_not_contact_until: Date | null
      linkedin_url_status:  string | null
    }>`
      SELECT id, do_not_contact_until, linkedin_url_status
      FROM contacts
      WHERE workspace_id = ${workspaceId}
        AND LOWER(REGEXP_REPLACE(linkedin_url, '/$', '')) = ${norm}
      LIMIT 1
    `
    const row = rows[0]
    if (row) {
      preflightContactId = row.id
      const reach = isContactReachable(
        {
          doNotContactUntil:    row.do_not_contact_until,
          linkedinUrlStatus:    row.linkedin_url_status,
          corporateEmailStatus: null,  // not relevant for LinkedIn DM channel
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
    }
  }

  const result = await sendLinkedInDm({
    creds: { apiKey: creds.apiKey, dsn: creds.dsn, accountId: creds.accountId },
    linkedinUrl,
    message,
  })

  if (!result.ok) {
    // LinkedIn URL lifecycle (Task #18): a Unipile send failure is a hard
    // fail. Record it; if this is the 2nd fail in 48h the helper marks
    // the URL inactive + flags the contact for enrichment. Only runs
    // when we know who the contact is (preflight found a row).
    if (preflightContactId !== undefined) {
      try {
        await recordLinkedinSendFailure(
          workspaceId,
          preflightContactId,
          linkedinUrl,
          result.error ?? "unipile_send_error",
        )
      } catch (err) {
        console.warn(`[send-dm] recordLinkedinSendFailure failed:`, err)
      }
    }
    return NextResponse.json({ error: result.error }, { status: 502 })
  }

  // LinkedIn URL lifecycle (Task #18): successful send confirms the URL
  // is reachable. Idempotent - same as below recordOutreach, runs only
  // when the contact is in our DB.
  if (preflightContactId !== undefined) {
    try {
      await confirmLinkedinUrl(workspaceId, preflightContactId)
    } catch (err) {
      console.warn(`[send-dm] confirmLinkedinUrl failed:`, err)
    }
  }

  // Cost tracking — fire-and-forget. One row per outbound message.
  void logUsage({
    workspaceId,
    category:      "messaging",
    provider:      "unipile",
    units:         1,
    unitCostCents: UNIPILE_CENTS_PER_MESSAGE,
    metadata:      { chatId: result.chatId, messageId: result.messageId },
  })

  // Best-effort: record the outbound DM as a signal so it shows in the lead's
  // engagement history. Verb is `sent_dm`; score is resolved from workspace
  // Engagement Scoring config (default 0 — outbound action, not a buying
  // signal — but workspaces can configure it).
  if (isDbConfigured()) {
    try {
      const db   = sql()
      const norm = linkedinUrl.toLowerCase().replace(/\/$/, "")
      const rows = await db`
        SELECT id FROM contacts
        WHERE workspace_id = ${workspaceId}
          AND LOWER(REGEXP_REPLACE(linkedin_url, '/$', '')) = ${norm}
        LIMIT 1
      `
      const contactId = (rows[0] as { id: number } | undefined)?.id
      if (contactId !== undefined) {
        await recordSignal(workspaceId, contactId, {
          crmSignalId:   result.messageId ? `unipile:msg:${result.messageId}` : undefined,
          sourceType:    "Private Message Sent",
          signalVerb:    "sent_dm",
          description:   message.length > 200 ? message.slice(0, 200) + "…" : message,
          scoreDelta:    resolveVerbWeight(config, "sent_dm"),
        })
        // Fetch contact's current persona + stage for the outreach_log entry
        const contactMeta = await db`
          SELECT COALESCE(manual_persona, persona) AS persona,
                 COALESCE(manual_stage, funnel_stage) AS stage
          FROM contacts WHERE id = ${contactId} LIMIT 1
        `
        const meta = (contactMeta[0] as { persona: string | null; stage: string | null }) ?? {}
        // Absolute attribution: when the contact is enrolled in exactly
        // one DM campaign, stamp both campaign_id + the most-recent
        // attached coverage. Best-effort - falls back to NULL stamps
        // when ambiguous / unenrolled.
        const attribution = await resolveAttributionForSend(workspaceId, contactId, "dm").catch(() => null)
        await recordOutreach({
          workspaceId,
          contactId,
          channel:               "dm",
          messagePreview:        message.slice(0, 300),
          persona:               meta.persona ?? null,
          stage:                 meta.stage   ?? null,
          templateIds:           selectedTemplateIds,
          chatId:                result.chatId,
          messageId:             result.messageId,
          fingerprintVersionId,
          campaignId:            attribution?.campaignId      ?? null,
          coverageMvprId:        attribution?.coverageMvprId  ?? null,
        })
      }
    } catch (err) {
      // Don't fail the request just because the local signal log breaks.
      console.warn(`[send-dm] recordSignal failed:`, err)
    }
  }

  return NextResponse.json({
    ok:        true,
    chatId:    result.chatId,
    messageId: result.messageId,
  })
}
