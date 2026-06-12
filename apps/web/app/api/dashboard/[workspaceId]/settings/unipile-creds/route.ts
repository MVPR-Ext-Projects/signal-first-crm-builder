/**
 * PATCH /api/dashboard/[workspaceId]/settings/unipile-creds
 *
 * Save Unipile credentials (apiKey, dsn, accountId) from the Channel
 * Settings drawer. These are workspace-level - shared across every
 * channel whose delivery_mechanism = 'unipile'. The drawer notes this
 * sharing rule so the user knows editing one LinkedIn channel's
 * Unipile creds affects all of them.
 *
 * apiKey is encrypted at rest by patchWorkspaceConfig. dsn + accountId
 * are stored as-is (not secrets).
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig, patchWorkspaceConfig } from "@/lib/workspace-config"

export async function PATCH(
  req: NextRequest,
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

  const body = await req.json().catch(() => null) as {
    apiKey?: string; dsn?: string; accountId?: string
  } | null
  if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 })

  const apiKey    = typeof body.apiKey    === "string" ? body.apiKey.trim()    : undefined
  const dsn       = typeof body.dsn       === "string" ? body.dsn.trim()       : undefined
  const accountId = typeof body.accountId === "string" ? body.accountId.trim() : undefined

  if (apiKey === undefined && dsn === undefined && accountId === undefined) {
    return NextResponse.json({ error: "Nothing to save" }, { status: 400 })
  }

  await patchWorkspaceConfig(workspaceId, {
    messaging: {
      ...(config.messaging ?? {}),
      unipile: {
        ...(config.messaging?.unipile ?? { apiKey: "", dsn: "", accountId: "" }),
        ...(apiKey    !== undefined ? { apiKey }    : {}),
        ...(dsn       !== undefined ? { dsn }       : {}),
        ...(accountId !== undefined ? { accountId } : {}),
      } as { apiKey: string; dsn: string; accountId: string },
    },
  })

  return NextResponse.json({ ok: true })
}
