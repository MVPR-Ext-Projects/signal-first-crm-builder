/**
 * GET / POST /api/enrich/contacts/[workspaceId]/x-interests
 *
 * GET  ?twitterUrl=...                - return cached X interests, 404 if none.
 * POST { twitterUrl: string }         - run the X-interests actor (apidojo
 *                                       hardcoded), persist the result, return it.
 *
 * Sibling of linkedin-interests. Same auth pattern (dashboard cookie).
 *
 * Cached in `x_interests`, one row per (workspace, contact). Re-fetch
 * overwrites. Used by the unified InterestsPanel on each lead row + the
 * future cross-funnel "influence trends" aggregation.
 *
 * Single hardcoded actor — apidojo/twitter-scraper-lite. The user doesn't
 * pick. The only Apify field exposed in Settings is the per-fetch result cap.
 */

import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { fetchContactXInterests } from "@/lib/apify-enrichment"
import { logUsage } from "@/lib/usage-log"
import { APIFY_X_INTERESTS_CENTS_PER_RUN } from "@/lib/pricing"
import {
  findContactByTwitterUrl,
  getXInterests,
  saveXInterests,
} from "@/lib/db/contact-store"
import { linkFollowedInfluencers, xAccountsToInfluencers } from "@/lib/influence/edge-population"

export const runtime = "nodejs"

interface PostBody {
  twitterUrl?: string
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
  const twitterUrl = searchParams.get("twitterUrl")?.trim()
  if (!twitterUrl) {
    return NextResponse.json({ error: "twitterUrl is required" }, { status: 400 })
  }

  const auth = await authorize(workspaceId)
  if (auth.error) return auth.error

  const contactId = await findContactByTwitterUrl(workspaceId, twitterUrl)
  if (!contactId) return NextResponse.json({ error: "Contact not found" }, { status: 404 })

  const cached = await getXInterests(workspaceId, contactId)
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

  let body: PostBody
  try {
    body = (await req.json()) as PostBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const twitterUrl = body.twitterUrl?.trim()
  if (!twitterUrl) {
    return NextResponse.json({ error: "twitterUrl is required" }, { status: 400 })
  }

  const contactId = await findContactByTwitterUrl(workspaceId, twitterUrl)
  if (!contactId) return NextResponse.json({ error: "Contact not found" }, { status: 404 })

  const result = await fetchContactXInterests(twitterUrl, {
    apiToken:   apify.apiToken,
    maxResults: apify.xInterestsMaxResults,
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
    unitCostCents: APIFY_X_INTERESTS_CENTS_PER_RUN,
    metadata:      { actor: "x-interests", contactId, totalCount: result.totalCount },
  })

  await saveXInterests(workspaceId, contactId, {
    totalCount: result.totalCount,
    accounts:   result.accounts,
  })

  // Project the followed X accounts into the influence graph (ADR-015).
  // Fire-and-forget — never fail enrichment on it.
  void linkFollowedInfluencers(
    workspaceId,
    contactId,
    xAccountsToInfluencers(result.accounts),
    "social_follow_x",
  ).catch(() => {})

  return NextResponse.json({
    contactId,
    fetchedAt:  new Date().toISOString(),
    totalCount: result.totalCount,
    accounts:   result.accounts,
  })
}
