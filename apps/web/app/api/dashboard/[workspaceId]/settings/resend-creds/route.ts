/**
 * PATCH /api/dashboard/[workspaceId]/settings/resend-creds
 *
 * Save the Resend API key only. Senders list management stays on
 * /settings/access - the Channel Settings drawer shows a deep link
 * rather than duplicating that editor. The senders array is preserved
 * by patchWorkspaceConfig's existing resend-merge handling.
 *
 * Shared across every channel whose delivery_mechanism = 'resend'
 * (Direct Email, Newsletter, Product Updates, future user-created
 * email channels).
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

  const body = await req.json().catch(() => null) as { apiKey?: string } | null
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : ""
  if (!apiKey) {
    return NextResponse.json({ error: "apiKey is required" }, { status: 400 })
  }

  await patchWorkspaceConfig(workspaceId, {
    resend: {
      ...(config.resend ?? { apiKey: "", senders: [] }),
      apiKey,
    },
  })

  return NextResponse.json({ ok: true })
}
