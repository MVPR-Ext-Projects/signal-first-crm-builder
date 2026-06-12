/**
 * GET /api/dashboard/[workspaceId]/style/cell?channel=&scope=&persona_id=
 *
 * Returns the active fingerprint for a fingerprint cell, or
 * { fingerprint: null } when none has been generated yet.
 *
 * Query params:
 *   - channel:    'linkedin_dm' | 'email'. Required.
 *   - scope:      'channel' | 'channel_persona'. Defaults to 'channel_persona'
 *                 for backwards compatibility.
 *   - persona_id: required when scope='channel_persona'; forbidden when
 *                 scope='channel'.
 *
 * Auth: same dashboard cookie as the page.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { getActiveFingerprint, type StyleChannel, type StyleScope } from "@/lib/db/style-store"

const VALID_CHANNELS = new Set<StyleChannel>(["linkedin_dm", "email"])
const VALID_CELL_SCOPES = new Set<StyleScope>(["channel", "channel_persona"])

export async function GET(
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

  const url       = new URL(request.url)
  const channel   = url.searchParams.get("channel") as StyleChannel | null
  const scopeParam = (url.searchParams.get("scope") ?? "channel_persona") as StyleScope
  const personaId = url.searchParams.get("persona_id")

  if (!channel || !VALID_CHANNELS.has(channel)) {
    return NextResponse.json({ error: "channel must be 'linkedin_dm' or 'email'" }, { status: 400 })
  }
  if (!VALID_CELL_SCOPES.has(scopeParam)) {
    return NextResponse.json({ error: "scope must be 'channel' or 'channel_persona'" }, { status: 400 })
  }
  if (scopeParam === "channel_persona" && !personaId) {
    return NextResponse.json({ error: "persona_id is required when scope='channel_persona'" }, { status: 400 })
  }
  if (scopeParam === "channel" && personaId) {
    return NextResponse.json({ error: "persona_id must be omitted when scope='channel'" }, { status: 400 })
  }

  const active = await getActiveFingerprint({
    workspaceId,
    scope:     scopeParam,
    channel,
    personaId: scopeParam === "channel_persona" ? personaId : null,
  })

  return NextResponse.json({
    fingerprint: active?.fingerprint ?? null,
    version:     active?.version     ?? null,
    id:          active?.id          ?? null,
    createdAt:   active?.createdAt   ?? null,
  })
}
