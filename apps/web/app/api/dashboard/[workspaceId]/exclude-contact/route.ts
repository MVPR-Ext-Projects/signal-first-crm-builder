/**
 * POST /api/dashboard/[workspaceId]/exclude-contact
 *
 * Marks a contact as an internal employee:
 *   1. Adds their LinkedIn URL to WorkspaceConfig.internalLinkedinUrls
 *      (so future webhooks for them are dropped at the entry point).
 *   2. Deletes the contact + cascade signals from the Postgres projection.
 *
 * Auth: same cookie check as the dashboard page.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig, saveWorkspaceConfig } from "@/lib/workspace-config"
import { sql, isDbConfigured } from "@/lib/db"

const normalize = (u: string) => u.toLowerCase().replace(/\/$/, "")

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params

  // ── Auth ─────────────────────────────────────────────────────────────────
  const config = await getWorkspaceConfig(workspaceId)
  if (!config) {
    return NextResponse.json({ error: "Unknown workspace" }, { status: 404 })
  }
  if (config.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  // ── Body ─────────────────────────────────────────────────────────────────
  let linkedinUrl: string | undefined
  let contactId:   number | undefined
  try {
    const body = await request.json()
    linkedinUrl = typeof body.linkedinUrl === "string" ? body.linkedinUrl : undefined
    if (typeof body.contactId === "number") contactId = body.contactId
    else if (typeof body.contactId === "string" && /^\d+$/.test(body.contactId)) contactId = Number(body.contactId)
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }
  if (!linkedinUrl && contactId == null) {
    return NextResponse.json({ error: "linkedinUrl or contactId is required" }, { status: 400 })
  }

  // ── 1. Add to internalLinkedinUrls when we have a URL (idempotent) ──────
  // Without a URL there's nothing to add to the future-webhook filter; the
  // contact still gets deleted by id below.
  let addedToFilter = false
  if (linkedinUrl) {
    const target  = normalize(linkedinUrl)
    const current = config.internalLinkedinUrls ?? []
    const already = current.some(u => normalize(u) === target)
    if (!already) {
      config.internalLinkedinUrls = [...current, linkedinUrl]
      await saveWorkspaceConfig(config)
      addedToFilter = true
    }
  }

  // ── 2. Delete contact + cascade signals from Postgres ───────────────────
  let deleted = 0
  if (isDbConfigured()) {
    const db = sql()
    if (linkedinUrl) {
      const target = normalize(linkedinUrl)
      const rows = await db`
        DELETE FROM contacts
        WHERE workspace_id = ${workspaceId}
          AND LOWER(REGEXP_REPLACE(linkedin_url, '/$', '')) = ${target}
        RETURNING id
      `
      deleted = rows.length
    } else if (contactId != null) {
      const rows = await db`
        DELETE FROM contacts
        WHERE workspace_id = ${workspaceId}
          AND id           = ${contactId}
        RETURNING id
      `
      deleted = rows.length
    }
  }

  return NextResponse.json({ ok: true, addedToFilter, deletedRows: deleted })
}
