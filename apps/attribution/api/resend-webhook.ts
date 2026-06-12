/**
 * Resend webhook handler → gtm-os signals
 *
 * Receives Resend email events (sent, delivered, opened, clicked, bounced,
 * complained, delivery_delayed) and writes them as signals in the gtm-os
 * Postgres projection. CRM mirroring happens downstream via the configured
 * CRM adapter; this handler only touches Postgres.
 *
 * Event → signal_verb mapping:
 *   email.sent             → email_sent
 *   email.delivered        → email_delivered
 *   email.opened           → email_opened
 *   email.clicked          → email_clicked
 *   email.bounced          → email_bounced
 *   email.complained       → email_complained
 *   email.delivery_delayed → email_delivery_delayed
 *
 * Person resolution priority:
 *   1. utm_term (CRM person record id from the clicked link, if any) →
 *      contacts.crm_contact_id lookup.
 *   2. Fallback to email-based lookup on contacts.email.
 *
 * Env vars required:
 *   RESEND_WEBHOOK_SECRET   — Resend dashboard → Webhooks → Signing secret.
 *   DATABASE_URL            — Neon connection string (gtm-os DB).
 *   WORKSPACE_ID            — Default workspace id.
 *
 * Configure: Resend dashboard → Webhooks → add this endpoint, subscribe to
 *   email.sent, email.delivered, email.delivery_delayed, email.bounced,
 *   email.complained, email.clicked, email.opened.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node"
import { createHmac } from "crypto"
import { parseUtmsFromUrl } from "../lib/utm.js"
import {
  findContactByCrmId,
  findContactByEmail,
  recordAttributionSignal,
  invalidateCorporateEmail,
  defaultWorkspaceId,
} from "../lib/signal-ingest.js"

const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET

// ---------------------------------------------------------------------------
// Resend webhook event types
// ---------------------------------------------------------------------------

type ResendEventType =
  | "email.sent"
  | "email.delivered"
  | "email.delivery_delayed"
  | "email.bounced"
  | "email.complained"
  | "email.clicked"
  | "email.opened"

interface ResendWebhookEvent {
  type: ResendEventType
  created_at: string
  data: {
    email_id: string
    from: string
    to: string[]
    subject: string
    // Present on email.clicked events
    click?: {
      link: string
      user_agent?: string
      ip_address?: string
    }
    tags?: Array<{ name: string; value: string }>
  }
}

// Map Resend event type → gtm-os signal verb. Score defaults are workspace
// configurable via the Engagement Scoring settings page; this map only
// names the verb.
const VERB_BY_EVENT: Record<ResendEventType, string> = {
  "email.sent":             "email_sent",
  "email.delivered":        "email_delivered",
  "email.delivery_delayed": "email_delivery_delayed",
  "email.bounced":          "email_bounced",
  "email.complained":       "email_complained",
  "email.clicked":          "email_clicked",
  "email.opened":           "email_opened",
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

function verifySignature(req: VercelRequest, rawBody: string): boolean {
  if (!RESEND_WEBHOOK_SECRET) return true // skip in dev if not set
  const signature = req.headers["svix-signature"] as string | undefined
  const msgId = req.headers["svix-id"] as string | undefined
  const msgTimestamp = req.headers["svix-timestamp"] as string | undefined
  if (!signature || !msgId || !msgTimestamp) return false

  const toSign = `${msgId}.${msgTimestamp}.${rawBody}`
  const secret = RESEND_WEBHOOK_SECRET.startsWith("whsec_")
    ? Buffer.from(RESEND_WEBHOOK_SECRET.slice(6), "base64")
    : Buffer.from(RESEND_WEBHOOK_SECRET)

  const computed = createHmac("sha256", secret).update(toSign).digest("base64")
  const expected = `v1,${computed}`
  return signature.split(" ").some((sig) => sig === expected)
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  // Collect raw body for signature verification
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as ArrayBuffer))
  const rawBody = Buffer.concat(chunks).toString("utf8")

  if (!verifySignature(req, rawBody)) {
    return res.status(401).json({ error: "Invalid signature" })
  }

  let event: ResendWebhookEvent
  try {
    event = JSON.parse(rawBody) as ResendWebhookEvent
  } catch {
    return res.status(400).json({ error: "Invalid JSON" })
  }

  const { type, data, created_at } = event
  const verb = VERB_BY_EVENT[type]
  if (!verb) {
    // Unknown event type — 200 OK so Resend doesn't retry; just don't write.
    return res.status(200).json({ ok: true, skipped: true, reason: `unknown_event_type:${type}` })
  }

  const recipientEmail = data.to[0]
  const workspaceId = defaultWorkspaceId()
  if (!workspaceId) {
    return res.status(500).json({ error: "WORKSPACE_ID env var not set" })
  }

  try {
    // Parse UTMs from the clicked link if present (Resend echoes the
    // original link, with our UTMs intact).
    const utms = data.click?.link ? parseUtmsFromUrl(data.click.link) : {}

    // ──────────────────────────────────────────────────────────────────
    // Resolve contact — prefer utm_term (exact CRM record_id match) over
    // email lookup (can be ambiguous if a person has multiple records).
    // ──────────────────────────────────────────────────────────────────
    let contact = utms.utmTerm
      ? await findContactByCrmId(workspaceId, utms.utmTerm)
      : null
    if (!contact && recipientEmail) {
      contact = await findContactByEmail(workspaceId, recipientEmail)
    }
    if (!contact) {
      console.log(`[resend-webhook] no contact match for ${recipientEmail} / utm_term=${utms.utmTerm ?? "(none)"}`)
      return res.status(200).json({ ok: true, skipped: true, reason: "no_contact_match" })
    }

    const description = [
      `Event: ${type}`,
      `Email ID: ${data.email_id}`,
      `Recipient: ${recipientEmail}`,
      `Subject: ${data.subject}`,
      data.click?.link ? `Link: ${data.click.link}` : null,
      utms.utmSource ? `Channel: ${utms.utmSource}` : null,
      utms.utmMedium ? `Campaign: ${utms.utmMedium}` : null,
      utms.utmContent ? `Content: ${utms.utmContent}` : null,
    ]
      .filter(Boolean)
      .join("\n")

    // Dedup key — Resend retries can repeat the same event. The pair
    // (email_id, event_type) is stable per email per type.
    const crmSignalId = `resend:${data.email_id}:${type}`

    await recordAttributionSignal({
      workspaceId: contact.workspaceId,
      contactId:   contact.id,
      crmSignalId,
      signalVerb:  verb,
      sourceType:  `Email ${type.replace("email.", "")}`,
      description,
      // Default 0 for the wiring pass — workspaces configure real scores
      // via the Engagement Scoring settings page.
      scoreDelta:  0,
      occurredAt:  new Date(created_at),
    })

    // Corporate email lifecycle (Task #18): email.bounced -> mark
    // corporate_email_status='not_found' + needs_enrichment=TRUE so the
    // contact surfaces on the Enrichment Candidates page for a re-source
    // pass. email.complained (spam complaint) is a Phase 6+ DNC trigger
    // and is deferred until the inbound-email DNC classifier path lands.
    if (type === "email.bounced") {
      try {
        await invalidateCorporateEmail(
          contact.workspaceId,
          contact.id,
          `Email ${recipientEmail} bounced via Resend.`,
        )
      } catch (err) {
        console.warn("[resend-webhook] invalidateCorporateEmail failed:", err)
      }
    }

    return res.status(200).json({ ok: true, event: type, contactId: contact.id })
  } catch (err) {
    console.error("[resend-webhook] write failed:", err)
    return res.status(500).json({ error: "Internal error" })
  }
}
