/**
 * Teamfluence Feed Poll — manual-trigger backfill endpoint.
 *
 * Steady-state ingestion runs over the webhook at
 * /api/webhooks/[workspaceId]/teamfluence (HMAC-secured, real-time). This
 * endpoint exists as a backfill tool — useful for new-workspace bootstrap
 * or for reconciling against the Feed API after a webhook outage. It is
 * NOT scheduled (the daily cron was removed once we moved to webhook-only)
 * — invoke manually with the CRON_SECRET header when you need it.
 *
 * For each workspace that has teamfluenceApiKey + teamfluenceProfileId configured:
 *   1. Fetch posts from the last 7 days via Teamfluence Feed API
 *   2. Fetch all named engagers per post
 *   3. Upsert contact + signals into the Postgres projection
 *      (this is what powers the SDR dashboard)
 *
 * Workspaces without a CRM still have their Teamfluence signals captured in
 * Postgres so the SDR dashboard at /dashboard/[workspaceId] works for them.
 *
 * Deduplication:
 *   - Postgres: per-event-type, keyed by `${activity_urn}:${event_type}` in
 *     signals.crm_signal_id.
 *
 * Triggered by: POST /api/teamfluence/feed-poll with `x-cron-secret` or
 * `Authorization: Bearer <CRON_SECRET>` header.
 */

import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig, type WorkspaceConfig } from "@/lib/workspace-config"
import { Redis } from "@upstash/redis"
import { isDbConfigured, recordSignal, safeUpsertContact, signalExistsInDb } from "@/lib/db/contact-store"
import { classifyContactPersona } from "@/lib/persona-match"
import { findOrCreateCompany } from "@/lib/companies/find-or-create"
import { normalizeDomain } from "@/lib/normalize/domain"

const TF_BASE = "https://api.teamfluence.app/external"

// ─── Types ────────────────────────────────────────────────────────────────────

interface TFPost {
  id: string
  activity_urn: string
  post_url: string
  content: string
  author: string
  published_at: string
  likes_num: number
  comments_num: number
  impressions_num: number
  shares_num: number
}

interface TFLead {
  first_name: string
  last_name: string
  linkedin_url: string
  email?: string
  contact_email?: string
  phone_number?: string
  headline?: string
  job_title?: string
  company?: { name?: string; website?: string; linkedin_url?: string }
  engagement_score?: number
  engagement_events_count?: number
  history?: { event_type?: string; description?: string; created_at?: string; post_url?: string }[]
  picture?: string
}

// Map Teamfluence event_type → source label + score
const EVENT_MAP: Record<string, { sourceType: string; score: number }> = {
  LINKEDIN_POST_ENGAGEMENT:       { sourceType: "Post Reaction",         score: 3  },
  LINKEDIN_PROFILE_VIEWER:        { sourceType: "Visited Company Page",  score: 3  },
  LINKEDIN_ACCEPTED_CONNECTION:   { sourceType: "New Connection",        score: 10 },
  LINKEDIN_PROFILE_FOLLOWER:      { sourceType: "Followed Company Page", score: 10 },
  LINKEDIN_COMMENT_ENGAGEMENT:    { sourceType: "Post Comment",          score: 5  },
  LINKEDIN_COMPANY_PAGE_VISIT:    { sourceType: "Visited Company Page",  score: 3  },
}

function buildSignalDescription(
  leadName: string,
  eventType: string,
  post: TFPost,
): string | undefined {
  if (!leadName) return undefined
  const isComment  = eventType === "LINKEDIN_COMMENT_ENGAGEMENT"
  const isPostEvent = isComment || eventType === "LINKEDIN_POST_ENGAGEMENT"
  if (!isPostEvent) return undefined
  const action = isComment ? "commented on" : "liked"
  const author = post.author ? `${post.author}'s` : "a"
  if (post.content) {
    const snippet = post.content.replace(/\s+/g, " ").trim()
    const short = snippet.length > 60 ? `${snippet.slice(0, 60)}…` : snippet
    return `${leadName} ${action} ${author} post: "${short}"`
  }
  return `${leadName} ${action} ${author} LinkedIn post`
}

// ─── Poll a single workspace ──────────────────────────────────────────────────

async function pollWorkspace(wsConfig: WorkspaceConfig, tfApiKey: string, profileId: string) {
  const { workspaceId } = wsConfig
  const log: string[] = []

  if (!isDbConfigured()) {
    return { workspaceId, error: "Postgres not configured (DATABASE_URL missing)" }
  }

  // 1. Fetch posts
  const postsRes = await fetch(`${TF_BASE}/${profileId}/posts`, {
    headers: { Authorization: `Bearer ${tfApiKey}` },
    cache: "no-store",
  })
  if (!postsRes.ok) {
    return { workspaceId, error: `Teamfluence posts fetch failed: ${postsRes.status}` }
  }

  const raw = await postsRes.json()
  const posts: TFPost[] = Array.isArray(raw) ? raw : raw.posts ?? raw.data ?? []
  log.push(`${posts.length} posts fetched`)

  let signalsCreated = 0
  let signalsDeduped = 0

  for (const post of posts) {
    // 2. Fetch engagers
    const activityId = post.activity_urn.split(":").pop()
    const leadsRes = await fetch(
      `${TF_BASE}/${profileId}/activity/${activityId}/leads?qualified_only=false`,
      { headers: { Authorization: `Bearer ${tfApiKey}` }, cache: "no-store" }
    )
    if (!leadsRes.ok) continue

    const leadsRaw = await leadsRes.json()
    const leads: TFLead[] = Array.isArray(leadsRaw) ? leadsRaw : leadsRaw.leads ?? leadsRaw.data ?? []

    for (const lead of leads) {
      // 3. Resolve a stable CRM contact id for the Postgres projection.
      // For workspaces with a CRM configured the steady-state webhook path
      // handles real CRM record IDs; this backfill endpoint synthesises a
      // deterministic id from LinkedIn URL / email so the unique key
      // (workspace_id, crm_contact_id) still works.
      const crmProvider = "teamfluence"
      const leadEmail = lead.email || lead.contact_email
      const crmContactId = lead.linkedin_url
        ? `linkedin:${lead.linkedin_url}`
        : leadEmail
          ? `email:${leadEmail}`
          : null
      if (!crmContactId) continue   // can't dedup or store this lead

      // 4. Upsert Postgres contact
      const fullName = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || undefined
      const companyWebsite = lead.company?.website ?? undefined
      const companyDomain  = normalizeDomain(companyWebsite) ?? undefined

      let gtmCompanyId: number | undefined
      if (lead.company?.linkedin_url || companyDomain || lead.company?.name) {
        try {
          const result = await findOrCreateCompany(workspaceId, {
            linkedinUrl: lead.company?.linkedin_url,
            domain:      companyDomain,
            website:     companyWebsite,
            name:        lead.company?.name,
          })
          gtmCompanyId = result?.companyId
        } catch (err) {
          console.warn(`[feed-poll] findOrCreateCompany failed:`, err)
        }
      }

      const pgContactId = await safeUpsertContact(workspaceId, crmProvider, crmContactId, {
        email:       leadEmail            ?? undefined,
        linkedinUrl: lead.linkedin_url    ?? undefined,
        firstName:   lead.first_name      ?? undefined,
        lastName:    lead.last_name       ?? undefined,
        fullName,
        jobTitle:    lead.job_title ?? lead.headline ?? undefined,
        companyName:        lead.company?.name         ?? undefined,
        companyLinkedinUrl: lead.company?.linkedin_url ?? undefined,
        companyWebsite,
        companyDomain,
        gtmCompanyId,
        avatarUrl:   lead.picture         ?? undefined,
        phone:       lead.phone_number    ?? undefined,
      })
      if (!pgContactId) continue
      // Re-classify the persona based on the latest job_title — fire-and-forget.
      void classifyContactPersona(workspaceId, pgContactId)

      // 5. Filter history to events for THIS post (history contains the person's
      // full engagement history across all posts, not just the one we queried).
      const postEvents = lead.history?.filter(h => h.post_url === post.post_url || !h.post_url)
      const events = postEvents?.length
        ? postEvents
        : [{ event_type: "LINKEDIN_POST_ENGAGEMENT", created_at: post.published_at }]

      for (const event of events) {
        const eventType   = event.event_type ?? "LINKEDIN_POST_ENGAGEMENT"
        const crmSignalId = `${post.activity_urn}:${eventType}`

        // Postgres dedup (per event_type)
        if (await signalExistsInDb(workspaceId, pgContactId, crmSignalId)) {
          signalsDeduped++
          continue
        }

        const defaultMapping = EVENT_MAP[eventType] ?? { sourceType: "Post Reaction", score: 3 }
        const mapping = {
          ...defaultMapping,
          // Per-workspace option title override (e.g. some workspaces use "Profile Follower" not "Followed Company Page")
          ...(wsConfig.eventTypeMap?.[eventType]
            ? { sourceType: wsConfig.eventTypeMap[eventType] }
            : {}),
        }

        // Postgres signal — drives the SDR dashboard for all workspaces
        const leadName = [lead.first_name, lead.last_name].filter(Boolean).join(" ")
        await recordSignal(workspaceId, pgContactId, {
          crmSignalId,
          sourceType:    mapping.sourceType,
          engagementUrl: post.post_url ?? undefined,
          description:   buildSignalDescription(leadName, eventType, post),
          scoreDelta:    mapping.score,
          occurredAt:    event.created_at ? new Date(event.created_at) : undefined,
        })

        signalsCreated++
      }
    }
  }

  log.push(`${signalsCreated} signals created`)
  log.push(`${signalsDeduped} signals deduped`)
  return { workspaceId, log }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Verify cron secret
  const secret = req.headers.get("x-cron-secret") ?? req.headers.get("authorization")?.replace("Bearer ", "")
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const kv = process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
    ? new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN })
    : null

  if (!kv) return NextResponse.json({ error: "KV not configured" }, { status: 500 })

  // Scan all workspace config keys
  const keys = await kv.keys("workspace:*:config")
  const results = []

  for (const key of keys) {
    const wsConfig = await kv.get<WorkspaceConfig>(key)
    if (!wsConfig?.teamfluenceApiKey || !wsConfig?.teamfluenceProfileId) continue

    const result = await pollWorkspace(
      wsConfig,
      wsConfig.teamfluenceApiKey,
      wsConfig.teamfluenceProfileId,
    )
    results.push(result)
  }

  if (results.length === 0) {
    return NextResponse.json({ message: "No workspaces with Feed API credentials configured" })
  }

  return NextResponse.json({ polled: results.length, results })
}

// Allow GET for manual trigger from browser (still requires secret as query param)
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret")
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  return POST(new NextRequest(req.url, { method: "POST", headers: req.headers }))
}

// Suppress unused-import warning for getWorkspaceConfig in case of editor reorgs.
void getWorkspaceConfig
