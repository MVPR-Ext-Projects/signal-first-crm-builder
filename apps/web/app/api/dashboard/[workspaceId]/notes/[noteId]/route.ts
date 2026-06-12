/**
 * PATCH / DELETE on individual notes.
 *
 * Mirrors /api/dashboard/[workspaceId]/signals/[signalId] but operates on
 * the notes table — split out per Task #12 (notes aren't engagement
 * signals; they live in a dedicated table so they don't roll into
 * signal_count / signal_score / funnel_stage).
 *
 * Auth: same dashboard cookie as the rest of the workspace.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { updateNoteBody, deleteNote } from "@/lib/db/contact-store"

type Params = { workspaceId: string; noteId: string }

async function authorize(workspaceId: string): Promise<NextResponse | null> {
  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Workspace not found" }, { status: 404 })
  if (config.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }
  return null
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<Params> },
) {
  const { workspaceId, noteId: idStr } = await params
  const noteId = Number(idStr)
  if (!Number.isFinite(noteId)) {
    return NextResponse.json({ error: "Invalid note ID" }, { status: 400 })
  }

  const authErr = await authorize(workspaceId)
  if (authErr) return authErr

  const body = await req.json().catch(() => null)
  if (!body || typeof body.body !== "string" || !body.body.trim()) {
    return NextResponse.json({ error: "body is required" }, { status: 400 })
  }

  const updated = await updateNoteBody(workspaceId, noteId, body.body.trim())
  if (!updated) return NextResponse.json({ error: "Note not found" }, { status: 404 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<Params> },
) {
  const { workspaceId, noteId: idStr } = await params
  const noteId = Number(idStr)
  if (!Number.isFinite(noteId)) {
    return NextResponse.json({ error: "Invalid note ID" }, { status: 400 })
  }

  const authErr = await authorize(workspaceId)
  if (authErr) return authErr

  const deleted = await deleteNote(workspaceId, noteId)
  if (!deleted) return NextResponse.json({ error: "Note not found" }, { status: 404 })
  return NextResponse.json({ ok: true })
}
