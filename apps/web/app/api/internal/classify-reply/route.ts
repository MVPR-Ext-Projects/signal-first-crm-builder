/**
 * POST /api/internal/classify-reply
 *
 * Internal endpoint called by the attribution app's resend-inbound
 * webhook handler when an inbound email reply arrives. Runs the
 * reply-intent classifier (Haiku 4.5) and, if a negative intent is
 * detected, sets the Do-Not-Contact marker on the contact.
 *
 * Lives in apps/web (not in apps/attribution) so we don't have to
 * mirror the AI SDK + classifier code into a second deploy. The
 * attribution app POSTs to this URL with a shared secret. Same
 * pattern as the Unipile webhook's inline classifier call for
 * replied_dm_initial.
 *
 * Body: {
 *   workspaceId: string
 *   contactId:   number
 *   replyText:   string
 *   channel:     "email" | "linkedin_dm"
 * }
 *
 * Auth: Bearer INTERNAL_API_SECRET. The secret must be set in both
 * web and attribution Vercel env. When unset (local dev) the endpoint
 * proceeds without auth so local testing is easy.
 *
 * Returns:
 *   { ok: true, intent: "...", dncSet: boolean, snippet: string }
 */

import { NextRequest, NextResponse } from "next/server"
import { classifyReplyIntent } from "@/lib/ai/classifier"
import { setDoNotContact, isDbConfigured } from "@/lib/db/contact-store"

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.INTERNAL_API_SECRET
  if (!secret) return true   // local dev escape hatch
  return req.headers.get("authorization") === `Bearer ${secret}`
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Postgres not configured" }, { status: 500 })
  }

  let body: {
    workspaceId?: string
    contactId?:   number
    replyText?:   string
    channel?:     string
  }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const { workspaceId, contactId, replyText, channel } = body
  if (!workspaceId || !contactId || !replyText || !channel) {
    return NextResponse.json(
      { error: "workspaceId, contactId, replyText, channel required" },
      { status: 400 },
    )
  }
  if (channel !== "email" && channel !== "linkedin_dm") {
    return NextResponse.json({ error: "channel must be email or linkedin_dm" }, { status: 400 })
  }

  try {
    const intent = await classifyReplyIntent({
      workspaceId,
      replyText,
      channel,
    })
    let dncSet = false
    if (intent.intent !== "neutral_or_positive") {
      await setDoNotContact(workspaceId, contactId, {
        classification: intent.intent,
        snippet:        intent.snippet.slice(0, 200),
        source:         channel,
      })
      dncSet = true
    }
    return NextResponse.json({ ok: true, intent: intent.intent, dncSet, snippet: intent.snippet })
  } catch (err) {
    console.error(`[internal/classify-reply] failed for contact=${contactId}:`, err)
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
