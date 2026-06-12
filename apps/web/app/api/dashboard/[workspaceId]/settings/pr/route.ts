/**
 * PATCH /api/dashboard/[workspaceId]/settings/pr
 *
 * Save the workspace's MVPR REST API credentials (apiKey + baseUrl).
 * apiKey is encrypted at rest by patchWorkspaceConfig. baseUrl is stored
 * as-is - per-tenant URLs embed the MVPR company id in the path, so
 * users paste the whole thing from MVPR's docs.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig, patchWorkspaceConfig } from "@/lib/workspace-config"
import { getSyncState } from "@/lib/db/coverage"

async function auth(workspaceId: string): Promise<NextResponse | null> {
  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Unknown workspace" }, { status: 404 })
  if (config.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }
  return null
}

/**
 * GET - state for the PR coverage section in the Channel Settings drawer.
 * Returns whether an API key is configured + the baseUrl + last sync
 * timestamps. Never returns the plaintext apiKey (only a boolean).
 */
export async function GET(
  _req: NextRequest,
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
  const syncState = await getSyncState(workspaceId)
  return NextResponse.json({
    hasApiKey:              Boolean(config.mvpr?.apiKey),
    baseUrl:                config.mvpr?.baseUrl ?? "",
    lastCoverageSyncAt:     syncState?.lastCoverageSyncAt     ?? null,
    lastAnnouncementSyncAt: syncState?.lastAnnouncementSyncAt ?? null,
  })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params
  const err = await auth(workspaceId)
  if (err) return err

  const body = await req.json().catch(() => null) as { apiKey?: string; baseUrl?: string } | null
  if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 })

  const apiKey  = typeof body.apiKey  === "string" ? body.apiKey.trim()  : undefined
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : undefined

  if (apiKey === undefined && baseUrl === undefined) {
    return NextResponse.json({ error: "apiKey or baseUrl required" }, { status: 400 })
  }

  if (baseUrl !== undefined) {
    try {
      const u = new URL(baseUrl)
      if (u.protocol !== "https:" && u.protocol !== "http:") {
        return NextResponse.json({ error: "baseUrl must be an http(s) URL" }, { status: 400 })
      }
    } catch {
      return NextResponse.json({ error: "baseUrl is not a valid URL" }, { status: 400 })
    }
  }

  await patchWorkspaceConfig(workspaceId, {
    mvpr: {
      ...(apiKey !== undefined  ? { apiKey }  : {}),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
    } as { apiKey: string; baseUrl: string },
  })

  return NextResponse.json({ ok: true })
}
