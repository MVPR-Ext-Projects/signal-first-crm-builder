/**
 * POST /api/dashboard/[workspaceId]/personas/reclassify
 *
 * Re-runs persona classification across every contact in the workspace
 * using the currently-configured personas. Idempotent — only contacts
 * whose persona value would actually change get an UPDATE.
 *
 * Triggered manually by the "Reclassify all contacts" button on the
 * Personas settings page. New contacts arriving via the Teamfluence
 * webhook are classified inline as part of upsert, so this endpoint is
 * only needed after editing persona match rules.
 *
 * Auth: same dashboard cookie as the rest of the workspace.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { reclassifyAllContacts } from "@/lib/persona-match"

export async function POST(
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

  try {
    const updated = await reclassifyAllContacts(workspaceId)
    return NextResponse.json({ ok: true, updated })
  } catch (err) {
    console.error(`[personas/reclassify] failed for ${workspaceId}:`, err)
    return NextResponse.json(
      { error: `Reclassify failed: ${(err as Error).message}` },
      { status: 500 },
    )
  }
}
