/**
 * PATCH /api/dashboard/[workspaceId]/contacts/[contactId]/dnc
 *
 * Body: { action: "set" | "release", reason?: string }
 *
 *   "set"     - manually mark the contact as Do-Not-Contact. Default
 *               6-month decay. The supplied `reason` is stored as the
 *               classification + snippet so it surfaces in audit; source
 *               is "manual".
 *   "release" - clear the DNC marker immediately. Used when the user
 *               wants to re-engage a previously-flagged contact.
 *
 * Auth: same dashboard cookie as the page.
 *
 * Companion to the auto-DNC path in the Unipile webhook (Task #17) and
 * future inbound-email path. Tom's plan called for both paths sharing
 * the same backend representation - this is the manual half.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import {
  setDoNotContact,
  releaseDoNotContact,
  isDbConfigured,
} from "@/lib/db/contact-store"

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; contactId: string }> },
) {
  const { workspaceId, contactId } = await params
  const id = Number.parseInt(contactId, 10)
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid contactId" }, { status: 400 })
  }

  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Unknown workspace" }, { status: 404 })

  if (config.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Postgres not configured" }, { status: 500 })
  }

  let body: { action?: string; reason?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }

  if (body.action === "set") {
    const reason = (body.reason ?? "").trim() || "Manually marked Do-Not-Contact."
    await setDoNotContact(workspaceId, id, {
      classification: "manual",
      snippet:        reason.slice(0, 200),
      source:         "manual",
    })
    return NextResponse.json({ ok: true, action: "set" })
  }

  if (body.action === "release") {
    await releaseDoNotContact(workspaceId, id)
    return NextResponse.json({ ok: true, action: "release" })
  }

  return NextResponse.json(
    { error: `action must be "set" or "release"` },
    { status: 400 },
  )
}
