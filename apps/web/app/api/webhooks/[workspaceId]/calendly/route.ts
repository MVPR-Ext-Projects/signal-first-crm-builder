/**
 * Calendly webhook handler - receives invitee.created and invitee.canceled
 * events for a workspace.
 *
 * On invitee.created:
 *   1. Insert a row into calendly_bookings (raw payload preserved)
 *   2. Upsert a contact by invitee email
 *   3. Write a `booked_meeting` signal on the contact (existing verb)
 *
 * On invitee.canceled:
 *   Update calendly_bookings.cancelled_at for the matching event URI.
 *
 * Auth:
 *   HMAC-SHA-256 verification using webhookSecrets.calendly stored on the
 *   workspace config (encrypted at rest). Calendly sends the signature as
 *   the Calendly-Webhook-Signature header in the form "t=<unix>,v1=<hex>".
 *   The signed message is "<unix>.<rawBody>".
 *
 *   If a workspace has no calendly secret configured, every webhook is
 *   rejected 401. Tom registers the webhook via Calendly's API, captures
 *   the returned signing_key, then stores it on the workspace.
 *
 * Event-type slug mapping:
 *   Calendly's webhook payload includes event_type as an opaque URI, not the
 *   URL slug. We maintain a small URI -> slug map for known MVPR event types
 *   so the bookings table is searchable by slug; unknown URIs leave slug null
 *   and the raw_payload still preserves everything for later backfill.
 */

import { NextRequest, NextResponse } from "next/server"
import crypto from "node:crypto"
import { getWorkspaceConfig, resolveVerbWeight } from "@/lib/workspace-config"
import { sql } from "@/lib/db"
import { safeUpsertContact, recordSignal, isDbConfigured } from "@/lib/db/contact-store"
import { nameFromEmail, isJunkName } from "@/lib/name-utils"

// ─── Event-type URI -> slug map ──────────────────────────────────────────────
//
// Calendly webhook payloads carry the event type as an opaque URI. Known MVPR
// event types are mapped here so the bookings table can be filtered by slug.
// Add new entries when Tom adds a new event type in Calendly. Unmapped URIs
// store slug = null; the URI is still preserved on the row.
const EVENT_TYPE_SLUG_BY_URI: Record<string, string> = {
  "https://api.calendly.com/event_types/ECB5TFRXYBL5FNSR":            "consultation",
  "https://api.calendly.com/event_types/d1d26d91-db1b-4e93-9d52-afd978e795b6": "mvpr-demo-call",
  "https://api.calendly.com/event_types/0d46a3fb-8c93-4818-9d2a-6bac0e61bb61": "mvpr-for-agency-teams",
  "https://api.calendly.com/event_types/afda6b8c-e594-4668-93b9-c2a664719b08": "mvpr-software",
  "https://api.calendly.com/event_types/97c1816a-0b41-4586-8dfe-c592e135c058": "freelance-small-agency-demo-mvpr",
  "https://api.calendly.com/event_types/4fa12c01-76e2-4566-8212-38f672e846c0": "intro-mvpr",
  "https://api.calendly.com/event_types/090c10a0-a975-4c0c-9371-2569f7046824": "mvpr-overview",
  "https://api.calendly.com/event_types/bcdf43c1-92d6-475b-a047-205620f99455": "mvpr-software-onboarding",
  "https://api.calendly.com/event_types/cf73e6f3-f4af-4b0f-864d-a1e5cfcea724": "information-gathering",
  "https://api.calendly.com/event_types/17811e6b-cf5b-4df6-a6c4-97fe9da4d5d6": "announcement-information-gathering",
  "https://api.calendly.com/event_types/e68fa2d7-fb80-4068-8d87-00908890bccd": "coffee",
  "https://api.calendly.com/event_types/1adaa054-9913-43da-a3a2-17655bbe0141": "tom-lawrence-mvpr-founder",
}

// ─── Payload types ───────────────────────────────────────────────────────────

interface CalendlyQuestionAnswer {
  question: string
  answer:   string
  position: number
}

interface CalendlyTracking {
  utm_campaign?:    string | null
  utm_source?:      string | null
  utm_medium?:      string | null
  utm_content?:     string | null
  utm_term?:        string | null
  salesforce_uuid?: string | null
}

interface CalendlyScheduledEvent {
  uri:        string
  name:       string
  start_time: string
  end_time:   string
  event_type: string
  location?:  {
    type?:  string
    location?: string
    additional_info?: string
  } | null
}

interface CalendlyInviteePayload {
  uri:              string
  email:            string
  name?:            string
  first_name?:      string
  last_name?:       string
  scheduled_event:  CalendlyScheduledEvent
  questions_and_answers?: CalendlyQuestionAnswer[]
  tracking?:        CalendlyTracking | null
  cancellation?:    {
    canceled_by: string
    reason?:     string | null
    canceler_type?: string
    created_at?: string
  } | null
}

interface CalendlyWebhookBody {
  event:      "invitee.created" | "invitee.canceled" | string
  created_at: string
  payload:    CalendlyInviteePayload
}

// ─── Signature verification ──────────────────────────────────────────────────

function parseSignatureHeader(header: string | null): { t: string; v1: string } | null {
  if (!header) return null
  const parts = header.split(",").map((s) => s.trim())
  let t: string | undefined
  let v1: string | undefined
  for (const part of parts) {
    const [k, v] = part.split("=")
    if (k === "t") t = v
    if (k === "v1") v1 = v
  }
  if (!t || !v1) return null
  return { t, v1 }
}

function verifySignature(rawBody: string, signature: { t: string; v1: string }, signingKey: string): boolean {
  const signedMessage = `${signature.t}.${rawBody}`
  const expected = crypto.createHmac("sha256", signingKey).update(signedMessage).digest("hex")
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature.v1, "hex"))
  } catch {
    return false
  }
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

async function insertBooking(opts: {
  workspaceId:       string
  payload:           CalendlyInviteePayload
  rawBody:           string
  contactId:         number | null
}): Promise<number | null> {
  if (!isDbConfigured()) return null
  const db = sql()
  const { payload, workspaceId, rawBody, contactId } = opts
  const event = payload.scheduled_event
  const slug = EVENT_TYPE_SLUG_BY_URI[event.event_type] ?? null
  const inviteeName = payload.name ?? ([payload.first_name, payload.last_name].filter(Boolean).join(" ") || null)

  const rows = await db`
    INSERT INTO calendly_bookings (
      workspace_id, calendly_event_uri, event_type_uri, event_type_slug, event_type_name,
      invitee_email, invitee_name, scheduled_for, custom_answers, raw_payload, contact_id
    ) VALUES (
      ${workspaceId},
      ${event.uri},
      ${event.event_type},
      ${slug},
      ${event.name},
      ${payload.email},
      ${inviteeName},
      ${event.start_time},
      ${JSON.stringify(payload.questions_and_answers ?? null)}::jsonb,
      ${rawBody}::jsonb,
      ${contactId}
    )
    ON CONFLICT (calendly_event_uri) DO NOTHING
    RETURNING id
  ` as { id: number }[]
  return rows[0]?.id ?? null
}

async function markCancelled(workspaceId: string, eventUri: string, cancelledAt: string): Promise<void> {
  if (!isDbConfigured()) return
  const db = sql()
  await db`
    UPDATE calendly_bookings
       SET cancelled_at = ${cancelledAt}
     WHERE workspace_id      = ${workspaceId}
       AND calendly_event_uri = ${eventUri}
  `
}

// ─── Main handler ────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params
  const rawBody = await req.text()

  console.log(`[webhook/calendly] inbound workspace=${workspaceId} bytes=${rawBody.length}`)

  const config = await getWorkspaceConfig(workspaceId)
  if (!config) {
    return NextResponse.json({ error: "Unknown workspace" }, { status: 404 })
  }

  const signingKey = config.webhookSecrets?.calendly
  if (!signingKey) {
    return NextResponse.json({ error: "Calendly webhook not configured for this workspace" }, { status: 401 })
  }

  const sig = parseSignatureHeader(req.headers.get("calendly-webhook-signature"))
  if (!sig || !verifySignature(rawBody, sig, signingKey)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  }

  let body: CalendlyWebhookBody
  try {
    body = JSON.parse(rawBody) as CalendlyWebhookBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const payload = body.payload
  if (!payload?.scheduled_event?.uri) {
    return NextResponse.json({ ok: true, skipped: true, reason: "no_scheduled_event" })
  }

  // ── invitee.canceled ─────────────────────────────────────────────────────
  if (body.event === "invitee.canceled") {
    const cancelledAt = payload.cancellation?.created_at ?? body.created_at ?? new Date().toISOString()
    try {
      await markCancelled(workspaceId, payload.scheduled_event.uri, cancelledAt)
    } catch (err) {
      console.error(`[webhook/calendly] markCancelled failed workspace=${workspaceId} event=${payload.scheduled_event.uri}:`, err)
      return NextResponse.json({ error: "Cancellation write failed" }, { status: 500 })
    }
    console.log(`[webhook/calendly] canceled workspace=${workspaceId} event=${payload.scheduled_event.uri}`)
    return NextResponse.json({ ok: true, event: "invitee.canceled" })
  }

  // ── invitee.created ──────────────────────────────────────────────────────
  if (body.event !== "invitee.created") {
    return NextResponse.json({ ok: true, skipped: true, reason: "unsupported_event", event: body.event })
  }

  // 1. Upsert contact by email. Use email-derived name when Calendly's name
  //    fields look junky or absent.
  let firstName: string | undefined = isJunkName(payload.first_name) ? undefined : payload.first_name ?? undefined
  let lastName:  string | undefined = isJunkName(payload.last_name)  ? undefined : payload.last_name  ?? undefined
  let fullName:  string | undefined = isJunkName(payload.name)       ? undefined : payload.name       ?? undefined
  if (!firstName && !lastName && payload.email) {
    const fromEmail = nameFromEmail(payload.email)
    if (fromEmail) {
      firstName = fromEmail.firstName
      lastName  = fromEmail.lastName ?? undefined
    }
  }
  fullName = fullName ?? ([firstName, lastName].filter(Boolean).join(" ") || undefined)

  // Use the invitee URI as the stable CRM-side id (gtm-os contacts table
  // accepts any string CRM id and uses it for upsert dedup).
  const crmContactId = payload.uri
  const contactId = await safeUpsertContact(
    workspaceId,
    "calendly",
    crmContactId,
    { email: payload.email, firstName, lastName, fullName },
  )

  // 2. Insert booking row.
  await insertBooking({ workspaceId, payload, rawBody, contactId })

  // 3. Write booked_meeting signal on the contact (existing verb in schema).
  if (contactId) {
    const scoreDelta = resolveVerbWeight(config, "booked_meeting") ?? 0
    const event = payload.scheduled_event
    const answers = payload.questions_and_answers ?? []
    const answersSummary = answers.length
      ? answers.map((qa) => `${qa.question}: ${qa.answer}`).join(" | ")
      : null
    const description = [
      `Event type: ${event.name}`,
      `Scheduled for: ${event.start_time}`,
      answersSummary ? `Answers: ${answersSummary}` : null,
    ].filter(Boolean).join("\n")

    await recordSignal(workspaceId, contactId, {
      crmSignalId:     `calendly:${event.uri}`,
      signalVerb:      "booked_meeting",
      sourceType:      `Calendly (${event.name})`,
      verbDescription: description,
      description,
      scoreDelta,
      occurredAt:      new Date(body.created_at),
    })
  }

  console.log(`[webhook/calendly] created workspace=${workspaceId} event_type=${payload.scheduled_event.name} email=${payload.email} contactId=${contactId}`)
  return NextResponse.json({ ok: true, event: "invitee.created", contactId })
}
