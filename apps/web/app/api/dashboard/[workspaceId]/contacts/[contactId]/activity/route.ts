import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { recordManualActivity } from "@/lib/db/contact-store"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; contactId: string }> },
) {
  const { workspaceId, contactId: contactIdStr } = await params
  const contactId = Number(contactIdStr)
  if (!Number.isFinite(contactId)) {
    return NextResponse.json({ error: "Invalid contact ID" }, { status: 400 })
  }

  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Workspace not found" }, { status: 404 })

  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })

  const { type, notes, occurredAt, connected } = body as {
    type: string
    notes: string
    occurredAt?: string
    connected?: boolean
  }

  if (type !== "note" && type !== "call") {
    return NextResponse.json({ error: "type must be 'note' or 'call'" }, { status: 400 })
  }
  if (!notes || typeof notes !== "string" || !notes.trim()) {
    return NextResponse.json({ error: "notes is required" }, { status: 400 })
  }

  // connected=false → voicemail/no-answer, connected=true (default) → connected call
  const sourceType = type === "call"
    ? (connected === false ? "Call (Voicemail)" : "Call")
    : "Manual Note"
  const date = occurredAt ? new Date(occurredAt) : new Date()

  await recordManualActivity(workspaceId, contactId, sourceType, notes.trim(), date)

  return NextResponse.json({ ok: true })
}
