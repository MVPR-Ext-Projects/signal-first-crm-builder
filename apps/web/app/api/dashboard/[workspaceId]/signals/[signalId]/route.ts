import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { updateSignalDescription, deleteSignal } from "@/lib/db/contact-store"
import { sql, isDbConfigured } from "@/lib/db/index"

type Params = { workspaceId: string; signalId: string }

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<Params> },
) {
  const { workspaceId, signalId: idStr } = await params
  const signalId = Number(idStr)
  if (!Number.isFinite(signalId)) {
    return NextResponse.json({ error: "Invalid signal ID" }, { status: 400 })
  }

  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Workspace not found" }, { status: 404 })

  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })

  // Update description
  if (typeof body.description === "string") {
    if (!body.description.trim()) return NextResponse.json({ error: "description is required" }, { status: 400 })
    const updated = await updateSignalDescription(workspaceId, signalId, body.description.trim())
    if (!updated) return NextResponse.json({ error: "Signal not found" }, { status: 404 })
    return NextResponse.json({ ok: true })
  }

  // Toggle call result: connected ↔ voicemail
  if (typeof body.connected === "boolean" && isDbConfigured()) {
    const db = sql()
    const newType = body.connected ? "Call" : "Call (Voicemail)"
    await db`
      UPDATE signals
      SET source_type = ${newType}
      WHERE id = ${signalId}
        AND workspace_id = ${workspaceId}
        AND source_type IN ('Call', 'Call (Voicemail)')
    `
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: "description or connected is required" }, { status: 400 })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<Params> },
) {
  const { workspaceId, signalId: idStr } = await params
  const signalId = Number(idStr)
  if (!Number.isFinite(signalId)) {
    return NextResponse.json({ error: "Invalid signal ID" }, { status: 400 })
  }

  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Workspace not found" }, { status: 404 })

  const deleted = await deleteSignal(workspaceId, signalId)
  if (!deleted) return NextResponse.json({ error: "Signal not found" }, { status: 404 })

  return NextResponse.json({ ok: true })
}
