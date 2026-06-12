/**
 * GET / POST /api/enrich/contacts/[workspaceId]/linkedin-interests
 *
 * GET  ?linkedinUrl=...         - return cached interests, 404 if none.
 * POST { linkedinUrl: string }  - run the Apify profile-interests actor,
 *                                 persist the result, return it.
 *
 * The Postgres contact id is resolved from linkedin_url server-side so the
 * client never has to pass it. Same dashboard cookie auth as the SDR page.
 *
 * Does NOT write to the CRM. Cached results live in `linkedin_interests`,
 * one row per (workspace, contact). Re-fetch overwrites.
 *
 * Sibling routes for other platforms (twitter-following, etc.) will land
 * alongside this one when those platforms get wired up.
 */

import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { fetchContactInterests } from "@/lib/apify-enrichment"
import { logUsage } from "@/lib/usage-log"
import { APIFY_LINKEDIN_INTERESTS_CENTS_PER_RUN } from "@/lib/pricing"
import {
  findContactByLinkedin,
  getLinkedinInterests,
  saveLinkedinInterests,
} from "@/lib/db/contact-store"
import { linkFollowedInfluencers, linkedinInterestsToInfluencers } from "@/lib/influence/edge-population"

export const runtime = "nodejs"

interface PostBody {
  linkedinUrl?: string
}

async function authorize(workspaceId: string) {
  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return { error: NextResponse.json({ error: "Workspace not found" }, { status: 404 }) }
  if (config.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) {
      return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
    }
  }
  return { config }
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await ctx.params
  const { searchParams } = new URL(req.url)
  const linkedinUrl = searchParams.get("linkedinUrl")?.trim()
  if (!linkedinUrl) {
    return NextResponse.json({ error: "linkedinUrl is required" }, { status: 400 })
  }

  const auth = await authorize(workspaceId)
  if (auth.error) return auth.error

  const contactId = await findContactByLinkedin(workspaceId, linkedinUrl)
  if (!contactId) return NextResponse.json({ error: "Contact not found" }, { status: 404 })

  const cached = await getLinkedinInterests(workspaceId, contactId)
  if (!cached) return NextResponse.json({ error: "Not yet fetched" }, { status: 404 })

  return NextResponse.json(cached)
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await ctx.params
  const auth = await authorize(workspaceId)
  if (auth.error) return auth.error
  const config = auth.config

  const apify = config?.enrichment?.apify
  if (!apify?.apiToken) {
    return NextResponse.json(
      { error: "Apify token not configured for this workspace. Add it on the Settings page." },
      { status: 400 },
    )
  }
  if (!apify.interestsActorId) {
    return NextResponse.json(
      { error: "LinkedIn interests Apify actor not configured. Set 'Profile interests actor ID' on the Settings page." },
      { status: 400 },
    )
  }

  let body: PostBody
  try {
    body = (await req.json()) as PostBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const linkedinUrl = body.linkedinUrl?.trim()
  if (!linkedinUrl) {
    return NextResponse.json({ error: "linkedinUrl is required" }, { status: 400 })
  }

  const contactId = await findContactByLinkedin(workspaceId, linkedinUrl)
  if (!contactId) return NextResponse.json({ error: "Contact not found" }, { status: 404 })

  const result = await fetchContactInterests(linkedinUrl, {
    apiToken: apify.apiToken,
    actorId:  apify.interestsActorId,
  })
  if (result.error) {
    return NextResponse.json(
      { error: `Apify ${result.error.status}: ${result.error.message}` },
      { status: 502 },
    )
  }
  // Cost tracking
  void logUsage({
    workspaceId,
    category:      "enrichment",
    provider:      "apify",
    units:         1,
    unitCostCents: APIFY_LINKEDIN_INTERESTS_CENTS_PER_RUN,
    metadata:      { actor: "linkedin-interests", contactId, totalCount: result.totalCount },
  })

  await saveLinkedinInterests(workspaceId, contactId, {
    totalCount:  result.totalCount,
    topVoices:   result.interests.topVoices,
    companies:   result.interests.companies,
    groups:      result.interests.groups,
    newsletters: result.interests.newsletters,
  })

  // Project the followed accounts into the influence graph (ADR-015): each
  // followed top-voice / company / newsletter becomes an influencer this
  // prospect is influenced_by. Fire-and-forget — never fail enrichment on it.
  void linkFollowedInfluencers(
    workspaceId,
    contactId,
    linkedinInterestsToInfluencers(result.interests),
    "social_follow_linkedin",
  ).catch(() => {})

  return NextResponse.json({
    contactId,
    fetchedAt:   new Date().toISOString(),
    totalCount:  result.totalCount,
    topVoices:   result.interests.topVoices,
    companies:   result.interests.companies,
    groups:      result.interests.groups,
    newsletters: result.interests.newsletters,
  })
}
