/**
 * Unipile webhook handler — receives LinkedIn DM events.
 *
 * Phase 1 scope (this commit): inbound messages only — those land as
 * `replied_dm` signals. Outbound is already captured at write-time by
 * apps/web/app/api/dashboard/[workspaceId]/send-dm/route.ts, so we drop
 * outbound here to avoid double-counting.
 *
 * Phase 3+ work (deferred): split replied_dm into _initial / _subsequent
 * based on thread position; AI classify the first reply for "not
 * interested" intent → set the DNC marker on the contact. Both layer on
 * top of this handler once the supporting schema + AI utility ship.
 *
 * Dedup: `crmSignalId = unipile:msg:<message_id>` — same key the existing
 * send-dm route uses, so the existing crmSignalId early-return in
 * recordSignal collapses any cross-path duplicates.
 *
 * Auth: shared-secret in the `Unipile-Auth` header, configured via
 * config.webhookSecrets.unipile. Register the webhook with Unipile's API:
 *
 *   POST https://<dsn>/api/v1/webhooks
 *   {
 *     "request_url": "https://your-app.vercel.app/api/webhooks/<workspaceId>/unipile",
 *     "source":      "messaging",
 *     "headers":     [{ "key": "Unipile-Auth", "value": "<shared secret>" }]
 *   }
 *
 * Reference: https://developer.unipile.com/docs/new-messages-webhook
 */

import { NextRequest, NextResponse } from "next/server"
import { timingSafeEqual } from "crypto"
import { getWorkspaceConfig, resolveVerbWeight } from "@/lib/workspace-config"
import { recordSignal, isDbConfigured, upsertContact, setDoNotContact, confirmLinkedinUrl } from "@/lib/db/contact-store"
import { sql } from "@/lib/db"
import { normalizeLinkedinProfileUrl } from "@/lib/normalize/linkedin-url"
import { classifyReplyIntent } from "@/lib/ai/classifier"

// ─── Payload type ────────────────────────────────────────────────────────────

interface UnipilePayload {
  /**
   * Event name. We act on `message_received`; reactions / edits / read
   * receipts are ignored.
   */
  event?: string
  /** Internal message id — used as the dedup key alongside other paths. */
  message_id?: string
  /** Conversation / thread id. */
  chat_id?: string
  /** Connected Unipile account id. */
  account_id?: string
  /** Identifies the workspace's connected LinkedIn account on the platform. */
  account_info?: {
    user_id?: string
  }
  /** The message sender. */
  sender?: {
    attendee_provider_id?: string
    attendee_profile_url?: string
    /** Display name as Unipile resolved it (e.g. "Jane Smith"). Optional. */
    attendee_name?: string
  }
  /** Message body. */
  message?: string
  /** ISO 8601. */
  timestamp?: string
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Compare two strings in constant time. Returns false on length mismatch
 * or empty inputs rather than throwing — caller treats false as a 401.
 */
function safeCompare(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  try { return timingSafeEqual(ba, bb) } catch { return false }
}

/**
 * Look up a contact by their LinkedIn profile URL, comparing on the
 * normalized form so trailing slashes / `www.` / scheme differences
 * don't break the match.
 */
async function findContactByLinkedinNormalized(
  workspaceId: string,
  linkedinUrl: string,
): Promise<number | null> {
  const normalized = normalizeLinkedinProfileUrl(linkedinUrl)
  if (!normalized) return null
  const db = sql()
  const rows = await db<{ id: number }>`
    SELECT id FROM contacts
    WHERE workspace_id = ${workspaceId}
      AND linkedin_url IS NOT NULL
      AND lower(
            regexp_replace(
              regexp_replace(linkedin_url, '^https?://(www\\.)?', ''),
              '/+$', ''
            )
          ) = ${normalized}
    LIMIT 1
  `
  return rows[0]?.id ?? null
}

// ─── Route handler ──────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params
  const rawBody = await req.text()

  const config = await getWorkspaceConfig(workspaceId)
  if (!config) {
    return NextResponse.json({ error: "Unknown workspace" }, { status: 404 })
  }

  // ── Auth — Unipile-Auth shared-secret header ──────────────────────────
  const expected = config.webhookSecrets?.unipile
  if (expected) {
    const provided = req.headers.get("unipile-auth") ?? req.headers.get("Unipile-Auth")
    if (!safeCompare(provided ?? undefined, expected)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  let payload: UnipilePayload
  try {
    payload = JSON.parse(rawBody) as UnipilePayload
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  // ── Filter — only act on new inbound messages ─────────────────────────
  if (payload.event !== "message_received") {
    return NextResponse.json({ ok: true, skipped: true, reason: `event=${payload.event ?? "(unset)"}` })
  }

  const ourUserId    = payload.account_info?.user_id
  const senderUserId = payload.sender?.attendee_provider_id
  const isOutbound   = !!ourUserId && !!senderUserId && ourUserId === senderUserId
  if (isOutbound) {
    // Outbound DM — already recorded at send time by /api/dashboard/.../send-dm.
    // Skipping here to avoid double-counting; crmSignalId dedup would catch
    // it anyway, but the explicit skip is cheaper and clearer in logs.
    return NextResponse.json({ ok: true, skipped: true, reason: "outbound" })
  }

  const senderLinkedinUrl = payload.sender?.attendee_profile_url
  if (!senderLinkedinUrl) {
    return NextResponse.json({ ok: true, skipped: true, reason: "no_sender_linkedin_url" })
  }

  if (!isDbConfigured()) {
    return NextResponse.json({ ok: true, skipped: true, reason: "no_db" })
  }

  // ── Match contact by sender's LinkedIn URL — or auto-create ──────────────
  // Per Task #8: when the sender isn't in the CRM yet, a DM from them is
  // itself a meaningful signal (someone reached out, possibly in response
  // to outbound activity or content). Create the contact and proceed with
  // the signal write. crm_provider="unipile" tags the row's origin so it's
  // easy to spot which contacts came in this way.
  let contactId = await findContactByLinkedinNormalized(workspaceId, senderLinkedinUrl)
  let createdContact = false

  if (contactId === null) {
    const senderName = payload.sender?.attendee_name?.trim() || undefined
    // Stable crm_contact_id: prefer the Unipile provider_id (immutable);
    // fall back to a URL-derived synthetic. Either way the (workspace_id,
    // crm_contact_id) UNIQUE constraint absorbs duplicates if the same
    // sender DMs us twice before the first contact INSERT commits.
    const crmContactId = senderUserId
      ? `unipile:user:${senderUserId}`
      : `unipile:linkedin:${normalizeLinkedinProfileUrl(senderLinkedinUrl) ?? senderLinkedinUrl}`

    try {
      contactId = await upsertContact(workspaceId, "unipile", crmContactId, {
        linkedinUrl:       senderLinkedinUrl,
        // attendee_provider_id is LinkedIn's stable URN. Persist it so
        // future enrichment can resolve this contact even if the slug
        // changes.
        linkedinMemberId:  senderUserId ?? undefined,
        fullName:          senderName,
      })
      createdContact = true
      console.log(
        `[webhook/unipile] auto-created contact for inbound DM: workspace=${workspaceId} contactId=${contactId} linkedin=${senderLinkedinUrl}`,
      )
    } catch (err) {
      console.error(`[webhook/unipile] auto-create contact failed for ${senderLinkedinUrl}:`, err)
      return NextResponse.json({ error: "Failed to create contact" }, { status: 500 })
    }
  }

  // ── Determine thread position — initial vs subsequent ────────────────────
  // Task #10 (DM verb split): the first inbound reply in a thread carries
  // ambiguous intent (could be "not interested"); subsequent replies signal
  // sustained engagement. Per-thread determination via chat_id stored on
  // each replied_dm* signal in engagement_url as `unipile:chat:<id>`.
  // No chat_id on the payload → fall back to per-contact (no prior
  // replied_dm* of any kind = initial).
  const chatEngagementUrl = payload.chat_id ? `unipile:chat:${payload.chat_id}` : null
  let hasPriorReply = false
  try {
    const db = sql()
    const priorRows = chatEngagementUrl
      ? await db<{ id: number }>`
          SELECT id FROM signals
          WHERE workspace_id = ${workspaceId}
            AND contact_id   = ${contactId}
            AND signal_verb LIKE 'replied_dm%'
            AND engagement_url = ${chatEngagementUrl}
          LIMIT 1
        `
      : await db<{ id: number }>`
          SELECT id FROM signals
          WHERE workspace_id = ${workspaceId}
            AND contact_id   = ${contactId}
            AND signal_verb LIKE 'replied_dm%'
          LIMIT 1
        `
    hasPriorReply = priorRows.length > 0
  } catch (err) {
    console.warn(`[webhook/unipile] prior-reply check failed (treating as initial):`, err)
  }
  const verb: "replied_dm_initial" | "replied_dm_subsequent" =
    hasPriorReply ? "replied_dm_subsequent" : "replied_dm_initial"

  // ── Record the signal ─────────────────────────────────────────────────
  const occurredAt = payload.timestamp ? new Date(payload.timestamp) : new Date()
  const preview = (payload.message ?? "").slice(0, 200)
  try {
    await recordSignal(workspaceId, contactId, {
      crmSignalId:   payload.message_id ? `unipile:msg:${payload.message_id}` : undefined,
      sourceType:    "Private Message Received",
      signalVerb:    verb,
      description:   preview,
      engagementUrl: chatEngagementUrl ?? undefined,
      scoreDelta:    resolveVerbWeight(config, verb),
      occurredAt,
    })
  } catch (err) {
    console.error(`[webhook/unipile] recordSignal failed for workspace=${workspaceId} contact=${contactId}:`, err)
    return NextResponse.json({ error: "Failed to record signal" }, { status: 500 })
  }

  // ── LinkedIn URL lifecycle (Task #18) ──
  // An inbound reply from this profile confirms the URL is reachable.
  // Side-effects: linkedin_url_status='active', linkedin_url_confirmed_at=NOW().
  // Best-effort; never blocks the signal write.
  try {
    await confirmLinkedinUrl(workspaceId, contactId)
  } catch (err) {
    console.warn(`[webhook/unipile] confirmLinkedinUrl failed for contact=${contactId}:`, err)
  }

  // ── DNC classifier (Task #17) - only on the first reply in a thread ──
  // First inbound reply carries ambiguous intent: it could be genuine
  // interest or a soft / firm refusal. We classify and, if the prospect
  // is declining, mark them Do-Not-Contact so outbound campaigns skip
  // them. Subsequent replies aren't classified - by definition they're
  // sustained engagement; if they reverse course later, the explicit
  // override in the dashboard is the right tool.
  let dncSet = false
  if (verb === "replied_dm_initial" && payload.message && payload.message.trim()) {
    try {
      const intent = await classifyReplyIntent({
        workspaceId,
        replyText: payload.message,
        channel:   "linkedin_dm",
      })
      if (intent.intent !== "neutral_or_positive") {
        await setDoNotContact(workspaceId, contactId, {
          classification: intent.intent,
          snippet:        intent.snippet.slice(0, 200),
          source:         "linkedin_dm",
        })
        dncSet = true
      }
    } catch (err) {
      // Classifier failures must not break the signal write; the contact
      // simply doesn't get auto-DNC'd this round. A manual override is
      // always available from the dashboard.
      console.warn(`[webhook/unipile] DNC classifier failed for contact=${contactId}:`, err)
    }
  }

  console.log(
    `[webhook/unipile] workspace=${workspaceId} chat=${payload.chat_id} msg=${payload.message_id} contact=${contactId} created=${createdContact} verb=${verb} dnc=${dncSet}`,
  )

  return NextResponse.json({ ok: true, contactId, createdContact, verb, dncSet })
}
