/**
 * POST /api/dashboard/[workspaceId]/send-email
 *
 * Sends an outbound prospect email via Resend, records the action as a
 * sent_email signal + outreach_log row (with fingerprint_version_id when
 * AI was used), and runs the same reachability gate as /send-dm (no
 * sends to DNC'd contacts, no sends to bounced corporate emails).
 *
 * Body: {
 *   linkedinUrl?:           string  // either linkedinUrl OR email required
 *   email?:                 string
 *   subject:                string
 *   body:                   string
 *   fingerprintVersionId?:  number | null
 *   selectedTemplateIds?:   string[]
 * }
 *
 * Auth: same dashboard cookie as the page.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig, resolveVerbWeight } from "@/lib/workspace-config"
import { sql, isDbConfigured } from "@/lib/db"
import { recordSignal, recordOutreach } from "@/lib/db/contact-store"
import { resolveAttributionForSend } from "@/lib/db/campaign-contacts"
import { sendOutboundEmail } from "@/lib/email/send-outbound"
import { isContactReachable, explainReason } from "@/lib/outbound/reachable"

const MAX_BODY_CHARS    = 8_000
const MAX_SUBJECT_CHARS = 200

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

  let linkedinUrl:          string  | undefined
  let email:                string  | undefined
  let subject:              string  | undefined
  let body:                 string  | undefined
  let selectedTemplateIds:  string[] = []
  let fingerprintVersionId: number  | null = null
  try {
    const reqBody = await request.json()
    linkedinUrl          = typeof reqBody.linkedinUrl === "string" ? reqBody.linkedinUrl : undefined
    email                = typeof reqBody.email       === "string" ? reqBody.email       : undefined
    subject              = typeof reqBody.subject     === "string" ? reqBody.subject     : undefined
    body                 = typeof reqBody.body        === "string" ? reqBody.body        : undefined
    selectedTemplateIds  = Array.isArray(reqBody.selectedTemplateIds)
      ? reqBody.selectedTemplateIds.filter((x: unknown) => typeof x === "string")
      : []
    fingerprintVersionId = typeof reqBody.fingerprintVersionId === "number" ? reqBody.fingerprintVersionId : null
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }

  if (!subject?.trim()) return NextResponse.json({ error: "subject is required" }, { status: 400 })
  if (!body?.trim())    return NextResponse.json({ error: "body is required" }, { status: 400 })
  if (subject.length > MAX_SUBJECT_CHARS) {
    return NextResponse.json({ error: `Subject too long (max ${MAX_SUBJECT_CHARS} chars)` }, { status: 400 })
  }
  if (body.length > MAX_BODY_CHARS) {
    return NextResponse.json({ error: `Body too long (max ${MAX_BODY_CHARS} chars)` }, { status: 400 })
  }

  // ── Contact lookup + reachability ──────────────────────────────────────
  // Look up by linkedinUrl when available (canonical id on the lead row),
  // fall back to email. Need to resolve the contact so we can write the
  // signal + outreach_log against it, and check reachability against the
  // corporate-email lifecycle.
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Postgres not configured" }, { status: 500 })
  }
  const db = sql()

  let contact: { id: number; corporate_email: string | null; do_not_contact_until: Date | null; corporate_email_status: string | null; email: string | null } | undefined
  if (linkedinUrl) {
    const norm = linkedinUrl.toLowerCase().replace(/\/$/, "")
    const rows = await db<{
      id: number
      corporate_email: string | null
      do_not_contact_until: Date | null
      corporate_email_status: string | null
      email: string | null
    }>`
      SELECT id, corporate_email, do_not_contact_until, corporate_email_status, email
      FROM contacts
      WHERE workspace_id = ${workspaceId}
        AND LOWER(REGEXP_REPLACE(linkedin_url, '/$', '')) = ${norm}
      LIMIT 1
    `
    contact = rows[0]
  } else if (email) {
    const rows = await db<{
      id: number
      corporate_email: string | null
      do_not_contact_until: Date | null
      corporate_email_status: string | null
      email: string | null
    }>`
      SELECT id, corporate_email, do_not_contact_until, corporate_email_status, email
      FROM contacts
      WHERE workspace_id = ${workspaceId}
        AND (LOWER(email) = ${email.toLowerCase()} OR LOWER(corporate_email) = ${email.toLowerCase()})
      LIMIT 1
    `
    contact = rows[0]
  } else {
    return NextResponse.json({ error: "linkedinUrl or email is required" }, { status: 400 })
  }

  if (!contact) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 })
  }

  // Reachability gate - blocks DNC + bounced corporate emails for the email channel.
  const reach = isContactReachable(
    {
      doNotContactUntil:    contact.do_not_contact_until,
      linkedinUrlStatus:    null,
      corporateEmailStatus: contact.corporate_email_status,
      email:                contact.corporate_email ?? contact.email,
    },
    "email",
  )
  if (!reach.ok) {
    return NextResponse.json(
      { error: reach.reasons.map(explainReason).join(" "), reasons: reach.reasons },
      { status: 403 },
    )
  }

  // Pick the recipient address. Caller-provided email wins; else contact's
  // corporate_email; else contact's email.
  const toAddress = email ?? contact.corporate_email ?? contact.email
  if (!toAddress) {
    return NextResponse.json({ error: "No email address on file for this contact" }, { status: 422 })
  }

  // ── Send via Resend ────────────────────────────────────────────────────
  const result = await sendOutboundEmail({
    config,
    to:       toAddress,
    subject,
    body,
  })
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 })
  }

  // ── Record signal + outreach_log ───────────────────────────────────────
  try {
    await recordSignal(workspaceId, contact.id, {
      crmSignalId:  result.messageId ? `resend:msg:${result.messageId}` : undefined,
      sourceType:   "Email Sent",
      signalVerb:   "sent_email",
      description:  body.length > 200 ? body.slice(0, 200) + "..." : body,
      scoreDelta:   resolveVerbWeight(config, "sent_email"),
    })
    const meta = await db<{ persona: string | null; stage: string | null }>`
      SELECT COALESCE(manual_persona, persona) AS persona,
             COALESCE(manual_stage, funnel_stage) AS stage
      FROM contacts WHERE id = ${contact.id} LIMIT 1
    `
    const m = meta[0] ?? { persona: null, stage: null }
    // Absolute attribution: when the contact is enrolled in exactly one
    // email campaign, stamp both campaign_id + most-recent attached coverage.
    const attribution = await resolveAttributionForSend(workspaceId, contact.id, "email").catch(() => null)
    await recordOutreach({
      workspaceId,
      contactId:            contact.id,
      channel:              "email",
      messagePreview:       body.slice(0, 300),
      persona:              m.persona,
      stage:                m.stage,
      templateIds:          selectedTemplateIds,
      chatId:               null,
      messageId:            result.messageId,
      fingerprintVersionId,
      campaignId:           attribution?.campaignId     ?? null,
      coverageMvprId:       attribution?.coverageMvprId ?? null,
    })
  } catch (err) {
    console.warn(`[send-email] signal/outreach_log write failed:`, err)
  }

  return NextResponse.json({
    ok:        true,
    messageId: result.messageId,
  })
}
