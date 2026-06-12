/**
 * POST /api/dashboard/[workspaceId]/campaigns/from-coverage
 *
 * Spawn a new campaign of the chosen channel, seeded from a piece of
 * coverage. The new campaign gets:
 *   - name        = body.name OR "Coverage: <article title>"
 *   - channel     = body.channel (linkedin_dm | email | newsletter)
 *   - 1 default campaign_template:
 *       linkedin_dm  -> { body: "<title>\n\n<summary>\n\n<link>" }
 *       email/newsletter -> { subject: title, body: "<summary>\n\n<link>" }
 *   - 1 campaign_coverage row linking back to the source article.
 *
 * Body: { coverageId, channel, name? }.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { createCampaign, type CampaignChannel } from "@/lib/db/campaigns"
import { getCoverage } from "@/lib/db/coverage"
import { createTemplate } from "@/lib/db/campaign-templates"
import { attachCoverageToCampaign } from "@/lib/db/campaign-coverage"

const VALID_CHANNELS: CampaignChannel[] = ["linkedin_dm", "email", "newsletter"]

export async function POST(
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
    coverageId?: string; channel?: string; name?: string
  } | null
  if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 })

  const coverageId = (body.coverageId ?? "").trim()
  if (!coverageId) return NextResponse.json({ error: "coverageId is required" }, { status: 400 })

  const channel = body.channel as CampaignChannel | undefined
  if (!channel || !VALID_CHANNELS.includes(channel)) {
    return NextResponse.json(
      { error: `channel must be one of: ${VALID_CHANNELS.join(", ")}` },
      { status: 400 },
    )
  }

  const coverage = await getCoverage(workspaceId, coverageId)
  if (!coverage) return NextResponse.json({ error: "Coverage not found" }, { status: 404 })

  const campaignName = (body.name?.trim() || `Coverage: ${coverage.title}`).slice(0, 200)

  const campaignId = await createCampaign({
    workspaceId,
    name:             campaignName,
    channel,
    clickedLinkScore: 0,
  })
  if (!campaignId) {
    return NextResponse.json({ error: "Failed to create campaign" }, { status: 500 })
  }

  const linkLine = coverage.link ? `\n\n${coverage.link}` : ""
  const summary  = coverage.summary?.trim() ?? ""

  // Channel-shaped seed body. Email/newsletter put the title in the subject
  // so it doesn't repeat in the body; LinkedIn DM has no subject so the
  // title leads the body.
  let templateBody:    string
  let templateSubject: string | null
  if (channel === "linkedin_dm") {
    templateBody    = `${coverage.title}\n\n${summary}${linkLine}`.trim()
    templateSubject = null
  } else {
    templateBody    = `${summary}${linkLine}`.trim() || coverage.title
    templateSubject = coverage.title
  }

  const templateId = await createTemplate({
    workspaceId,
    campaignId,
    name:      "Default",
    body:      templateBody,
    subject:   templateSubject,
    html:      null,
    isDefault: true,
  })

  await attachCoverageToCampaign({ workspaceId, campaignId, coverageMvprId: coverageId })

  return NextResponse.json({
    ok:         true,
    campaignId,
    templateId,
  })
}
