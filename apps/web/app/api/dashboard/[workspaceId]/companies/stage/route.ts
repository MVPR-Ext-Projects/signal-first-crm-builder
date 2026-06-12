/**
 * POST /api/dashboard/[workspaceId]/companies/stage
 *
 * Sets a company's manual funnel-stage override (e.g. "Discovery Call").
 * Pass `null` to clear and fall back to the auto-derived stage. Body:
 * { companyName: string, stage: string | null }.
 *
 * The stage is validated against the canonical funnel-stage list so
 * stale clients can't write arbitrary values. Auth: same dashboard
 * cookie as the page.
 *
 * (A future Calendly webhook will hit setCompanyStage directly when a
 * meeting is booked — that's outside this route, but the helper is
 * shaped for it.)
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { setCompanyStage, isDbConfigured } from "@/lib/db/contact-store"

// Any canonical stage is settable. Forward moves to manual sales stages
// (Discovery Call onward) are the common path; backward moves to a
// score-derived stage are also allowed so the user can demote a company
// that turned out not to be a fit (e.g. Discovery Call -> Engaged).
// The picker UI gates forward movement to manual stages only; this
// list only guards against typos / stale clients writing junk strings.
const ALLOWED_STAGES = [
  "Prospect",
  "Signal Found",
  "Engaged",
  "High Signal",
  "Discovery Call",
  "Requested Information",
  "Follow Up Call",
  "Sent Information",
  "Diligence",
  "Contract Negotiation",
  "Customer Won",
]

export async function POST(
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

  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Postgres not configured" }, { status: 500 })
  }

  let body: { companyName?: unknown; stage?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }

  const companyName = typeof body.companyName === "string" ? body.companyName : null
  if (!companyName) {
    return NextResponse.json({ error: "companyName is required" }, { status: 400 })
  }

  let stage: string | null
  if (body.stage === null) {
    stage = null
  } else if (typeof body.stage === "string" && ALLOWED_STAGES.includes(body.stage)) {
    stage = body.stage
  } else {
    return NextResponse.json(
      { error: `stage must be null or one of: ${ALLOWED_STAGES.join(", ")}` },
      { status: 400 },
    )
  }

  await setCompanyStage(workspaceId, companyName, stage)
  return NextResponse.json({ ok: true, companyName, stage })
}
