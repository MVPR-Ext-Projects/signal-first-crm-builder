/**
 * POST /api/dashboard/[workspaceId]/settings/pr/test
 *
 * Hits MVPR's /coverages endpoint once with the saved credentials to
 * verify the apiKey + baseUrl combo works. Returns { ok, sample? } so
 * the settings form can show "Connected — got: <title>" feedback.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { listCoverages } from "@/lib/mvpr"

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

  if (!config.mvpr?.apiKey || !config.mvpr?.baseUrl) {
    return NextResponse.json({ error: "MVPR not configured for this workspace" }, { status: 400 })
  }

  try {
    const coverages = await listCoverages({
      creds: { apiKey: config.mvpr.apiKey, baseUrl: config.mvpr.baseUrl },
    })
    return NextResponse.json({
      ok:    true,
      count: coverages.length,
      sample: coverages[0]
        ? { title: coverages[0].title, publication: coverages[0].journalist.publication.name }
        : null,
    })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 })
  }
}
