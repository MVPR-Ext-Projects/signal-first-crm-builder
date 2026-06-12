/**
 * Resend inbound webhook handler → gtm-os.
 *
 * Subscribes to email.received events from Resend (configured separately
 * from the outbound resend-webhook.ts endpoint). When a prospect replies
 * to one of our outbound emails, this handler:
 *
 *   1. Verifies the svix signature.
 *   2. Parses the sender's email from data.from (format "Name <email>").
 *   3. Looks up the matching gtm-os contact.
 *   4. Fetches the email body via Resend's GET /emails/{id} API
 *      (webhook payload only carries metadata, not body).
 *   5. Records a replied_email signal at the workspace-configured score.
 *   6. POSTs to apps/web /api/internal/classify-reply so the reply-intent
 *      classifier can run and set Do-Not-Contact if the intent is
 *      negative (not_interested / unsubscribe / wrong_person).
 *
 * Why call out to apps/web for the classifier? The AI SDK + workspace
 * config + DNC mutation code all live there. Mirroring them into the
 * attribution app would be duplicated infrastructure for a single
 * call. The call-out keeps the classifier as one source of truth.
 *
 * Resend dashboard config: subscribe to `email.received` and route to
 *   https://<attribution-host>/api/resend-inbound
 *
 * Env vars required:
 *   RESEND_API_KEY            - to fetch email bodies via Resend API.
 *   RESEND_INBOUND_SECRET     - svix signing secret for inbound webhook.
 *                               If unset (local dev) signature check is
 *                               skipped.
 *   GTMOS_URL                 - base URL of the apps/web deployment
 *                               (e.g. https://your-app.vercel.app). Defaults
 *                               to your-app.vercel.app.
 *   INTERNAL_API_SECRET       - shared secret for the
 *                               /api/internal/classify-reply call.
 *   DATABASE_URL              - same Neon as the outbound webhook.
 *   WORKSPACE_ID              - default workspace id.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node"
import { createHmac } from "crypto"
import {
  findContactByEmail,
  recordAttributionSignal,
  defaultWorkspaceId,
} from "../lib/signal-ingest.js"

const RESEND_API_BASE     = "https://api.resend.com"
const RESEND_API_KEY      = process.env.RESEND_API_KEY
const INBOUND_SECRET      = process.env.RESEND_INBOUND_SECRET
const GTMOS_URL           = process.env.GTMOS_URL ?? "https://your-app.vercel.app"
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET

// ─── Payload type ───────────────────────────────────────────────────────────

interface ResendInboundEvent {
  type: "email.received"
  created_at: string
  data: {
    email_id:    string
    from:        string                // "Name <email@host>"
    to:          string[]
    subject?:    string
    message_id?: string
    tags?:       Array<{ name: string; value: string }>
  }
}

// ─── Signature verification (same shape as resend-webhook.ts) ───────────────

function verifySignature(req: VercelRequest, rawBody: string): boolean {
  if (!INBOUND_SECRET) return true   // local dev
  const sig          = req.headers["svix-signature"] as string | undefined
  const msgId        = req.headers["svix-id"]        as string | undefined
  const msgTimestamp = req.headers["svix-timestamp"] as string | undefined
  if (!sig || !msgId || !msgTimestamp) return false

  const toSign = `${msgId}.${msgTimestamp}.${rawBody}`
  const secret = INBOUND_SECRET.startsWith("whsec_")
    ? Buffer.from(INBOUND_SECRET.slice(6), "base64")
    : Buffer.from(INBOUND_SECRET)
  const computed = createHmac("sha256", secret).update(toSign).digest("base64")
  const expected = `v1,${computed}`
  return sig.split(" ").some((s) => s === expected)
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract bare email from `data.from`. Resend gives "Display Name <addr@host>"
 * when the sender has a display name, or just "addr@host" otherwise.
 */
function parseSenderEmail(from: string): string | null {
  if (!from) return null
  const m = from.match(/<([^>]+)>/)
  return (m?.[1] ?? from).trim().toLowerCase()
}

/**
 * Pull the full email body via Resend's Retrieve Received Email API.
 * Falls back to empty string on error so we don't drop the signal
 * write - the classifier just gets no text to work with.
 */
async function fetchEmailBody(emailId: string): Promise<string> {
  if (!RESEND_API_KEY) return ""
  try {
    const res = await fetch(`${RESEND_API_BASE}/emails/${emailId}`, {
      headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
    })
    if (!res.ok) {
      console.warn(`[resend-inbound] body fetch ${emailId} -> ${res.status}`)
      return ""
    }
    const data = await res.json() as { text?: string; html?: string; body?: string }
    return (data.text ?? data.body ?? data.html ?? "").toString()
  } catch (err) {
    console.warn(`[resend-inbound] body fetch error ${emailId}:`, err)
    return ""
  }
}

async function classifyAndDnc(args: {
  workspaceId: string
  contactId:   number
  replyText:   string
}): Promise<{ intent?: string; dncSet?: boolean }> {
  if (!INTERNAL_API_SECRET) {
    console.warn("[resend-inbound] INTERNAL_API_SECRET not set; skipping classifier")
    return {}
  }
  try {
    const res = await fetch(`${GTMOS_URL}/api/internal/classify-reply`, {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${INTERNAL_API_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: args.workspaceId,
        contactId:   args.contactId,
        replyText:   args.replyText,
        channel:     "email",
      }),
    })
    if (!res.ok) {
      console.warn(`[resend-inbound] classify call ${res.status}`)
      return {}
    }
    const data = await res.json() as { intent?: string; dncSet?: boolean }
    return { intent: data.intent, dncSet: data.dncSet }
  } catch (err) {
    console.warn(`[resend-inbound] classify call failed:`, err)
    return {}
  }
}

// ─── Main handler ───────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as ArrayBuffer))
  const rawBody = Buffer.concat(chunks).toString("utf8")

  if (!verifySignature(req, rawBody)) {
    return res.status(401).json({ error: "Invalid signature" })
  }

  let event: ResendInboundEvent
  try { event = JSON.parse(rawBody) as ResendInboundEvent } catch {
    return res.status(400).json({ error: "Invalid JSON" })
  }

  if (event.type !== "email.received") {
    return res.status(200).json({ ok: true, skipped: true, reason: `event=${event.type}` })
  }

  const workspaceId = defaultWorkspaceId()
  if (!workspaceId) return res.status(500).json({ error: "WORKSPACE_ID not set" })

  const senderEmail = parseSenderEmail(event.data.from)
  if (!senderEmail) {
    return res.status(200).json({ ok: true, skipped: true, reason: "no_sender_email" })
  }

  const contact = await findContactByEmail(workspaceId, senderEmail)
  if (!contact) {
    return res.status(200).json({ ok: true, skipped: true, reason: "no_contact_match", senderEmail })
  }

  const body = await fetchEmailBody(event.data.email_id)

  // Record the replied_email signal. Score defaults to 0 in
  // recordAttributionSignal; the workspace's Engagement Scoring page is
  // the source-of-truth for the actual value but applying it here would
  // require reading WorkspaceConfig from the attribution app, which has
  // no Redis access today. Workspace.scoring tunability for inbound
  // replies is a follow-up. crm_signal_id uses the same shape as
  // outbound resend events for cross-event dedup.
  try {
    await recordAttributionSignal({
      workspaceId:   contact.workspaceId,
      contactId:     contact.id,
      crmSignalId:   `resend:${event.data.email_id}:received`,
      signalVerb:    "replied_email",
      sourceType:    `Email received`,
      description:   [
        `From: ${senderEmail}`,
        event.data.subject ? `Subject: ${event.data.subject}` : null,
        body ? `\n${body.slice(0, 1000)}` : null,
      ].filter(Boolean).join("\n"),
      scoreDelta:    0,
      occurredAt:    new Date(event.created_at),
    })
  } catch (err) {
    console.error(`[resend-inbound] signal write failed for contact=${contact.id}:`, err)
    return res.status(500).json({ error: "Signal write failed" })
  }

  // Classify reply intent + set DNC if negative. Best-effort; failure
  // never blocks the signal write above.
  const classified = body ? await classifyAndDnc({
    workspaceId: contact.workspaceId,
    contactId:   contact.id,
    replyText:   body,
  }) : {}

  return res.status(200).json({
    ok:          true,
    contactId:   contact.id,
    intent:      classified.intent  ?? null,
    dncSet:      classified.dncSet  ?? false,
  })
}
