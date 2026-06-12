/**
 * POST /api/dashboard/:workspaceId/contacts/:contactId/merge
 *
 * Merge one or more source contacts into this target contact. Reparents
 * signals / notes / outreach_log / linkedin_send_failures
 * and the linkedin_interests / x_interests singletons, then deletes the
 * source contact rows and recomputes the target's signal_score /
 * signal_count / last_signal_at.
 *
 * Body: { sourceIds: number[] }.
 */
import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { mergeContacts, isDbConfigured } from "@/lib/db/contact-store"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; contactId: string }> },
) {
  const { workspaceId, contactId } = await params
  const targetId = Number(contactId)
  if (!Number.isFinite(targetId) || targetId <= 0) {
    return NextResponse.json({ error: "Invalid contactId" }, { status: 400 })
  }

  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Workspace not found" }, { status: 404 })
  if (config.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  if (!isDbConfigured()) return NextResponse.json({ error: "Postgres not configured" }, { status: 500 })

  let body: { sourceIds?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: "Invalid request body" }, { status: 400 }) }

  if (!Array.isArray(body.sourceIds) || body.sourceIds.length === 0) {
    return NextResponse.json({ error: "sourceIds (non-empty array) is required" }, { status: 400 })
  }
  const sourceIds = body.sourceIds.map(v => Number(v)).filter(n => Number.isFinite(n) && n > 0)
  if (sourceIds.length === 0) return NextResponse.json({ error: "sourceIds had no valid ids" }, { status: 400 })
  if (sourceIds.includes(targetId)) return NextResponse.json({ error: "Cannot merge a contact into itself" }, { status: 400 })

  try {
    const result = await mergeContacts(workspaceId, targetId, sourceIds)
    return NextResponse.json({ ok: true, merged: result.merged })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
