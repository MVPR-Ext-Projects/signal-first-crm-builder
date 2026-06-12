/**
 * PATCH /api/dashboard/[workspaceId]/contacts/[contactId]/persona
 *
 * Body: { persona: string | null }
 *
 * Sets or clears the contact's manual persona override. Pass `null` to clear
 * and let the auto-classifier's `persona` value win again. Mirrors the stage
 * route exactly. Validates the value against WorkspaceConfig.messaging.personas
 * so the dashboard can't write a stray persona name the system doesn't know.
 *
 * Auth: same dashboard cookie as the page.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { setManualPersona, isDbConfigured } from "@/lib/db/contact-store"

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

  const allowed = new Set(
    (config.messaging?.personas ?? [])
      .map(p => p.name?.trim())
      .filter((n): n is string => !!n),
  )

  let persona: string | null
  try {
    const body = await request.json()
    if (body.persona === null) {
      persona = null
    } else if (typeof body.persona === "string" && allowed.has(body.persona)) {
      persona = body.persona
    } else {
      return NextResponse.json(
        { error: `persona must be null or one of the workspace's configured personas` },
        { status: 400 },
      )
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }

  await setManualPersona(workspaceId, id, persona)
  return NextResponse.json({ ok: true, persona })
}
