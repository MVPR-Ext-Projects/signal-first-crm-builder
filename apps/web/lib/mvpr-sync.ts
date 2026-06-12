/**
 * MVPR coverage + announcement sync logic.
 *
 * Shared by the /api/cron/mvpr-coverage-sync cron (every 6h) and the
 * "Sync now" button in /settings/pr (manual one-shot for the current
 * workspace). Both call syncWorkspace(workspaceId).
 *
 * Strategy:
 *   - Coverage: incremental pull bounded by startDate = lastCoverageSyncAt - 1 day
 *     so late edits to recently-published rows still get picked up. First run
 *     pulls the lot (no startDate).
 *   - Announcements: list endpoint has no date filter; fetch all summaries
 *     every run, then detail per announcement. Announcement count is low
 *     relative to coverage so the cost is acceptable.
 */

import { Redis } from "@upstash/redis"
import { getWorkspaceConfig } from "./workspace-config"
import {
  listCoverages,
  listAnnouncements,
  getAnnouncement,
  listThreads,
  type MvprCreds,
} from "./mvpr"
import {
  upsertCoverage,
  upsertAnnouncementSummary,
  upsertAnnouncementDetail,
  upsertThread,
  getSyncState,
  updateSyncState,
} from "./db/coverage"
import { upsertInfluencer } from "./db/influencers"

export interface SyncResult {
  workspaceId:        string
  coveragesIngested:  number
  announcementsIngested: number
  threadsIngested:    number
  influencersUpserted: number
  errors:             string[]
}

/** Best-effort registrable host from a URL (publication domain from an article link). */
function hostFromUrl(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase()
  } catch {
    return null
  }
}

const THREAD_PAGE_SIZE = 50
const MAX_THREAD_PAGES  = 40  // safety cap: 2,000 threads/run is well past any tenant's volume

const OVERLAP_MS = 24 * 60 * 60 * 1000  // 1 day rewind to catch late edits

/**
 * Pull coverage + announcements for one workspace. Returns the per-workspace
 * counts and any per-step errors (we never throw - one workspace's failure
 * shouldn't stop the cron from advancing others).
 */
export async function syncWorkspace(workspaceId: string): Promise<SyncResult> {
  const result: SyncResult = {
    workspaceId,
    coveragesIngested:     0,
    announcementsIngested: 0,
    threadsIngested:       0,
    influencersUpserted:   0,
    errors:                [],
  }

  const config = await getWorkspaceConfig(workspaceId)
  if (!config?.mvpr?.apiKey || !config?.mvpr?.baseUrl) {
    result.errors.push("MVPR not configured")
    return result
  }

  const creds: MvprCreds = {
    apiKey:  config.mvpr.apiKey,
    baseUrl: config.mvpr.baseUrl,
  }

  const state = await getSyncState(workspaceId)
  const nowIso = new Date().toISOString()

  // ── Coverage ─────────────────────────────────────────────────────────────
  try {
    const startIso = state?.lastCoverageSyncAt
      ? new Date(new Date(state.lastCoverageSyncAt).getTime() - OVERLAP_MS).toISOString()
      : undefined
    const coverages = await listCoverages({ creds, startDate: startIso })
    for (const c of coverages) {
      try {
        await upsertCoverage(workspaceId, c)
        result.coveragesIngested += 1
      } catch (e) {
        result.errors.push(`upsertCoverage(${c.id}): ${(e as Error).message}`)
      }

      // Register the people/orgs behind the coverage as first-class influencers
      // (ADR-015). The journalist is a person-influencer; the publication is an
      // organization-influencer. Edges to specific prospects (influencer ->
      // contact) are NOT created here - they're established where a prospect
      // engages with this coverage (the trust-nested loop), or via import.
      try {
        if (c.journalist?.id) {
          await upsertInfluencer(workspaceId, {
            kind: "person",
            type: "journalist",
            name: c.journalist.name,
            mvprJournalistId: c.journalist.id,
          })
          result.influencersUpserted += 1
        }
        const pub = c.journalist?.publication
        if (pub?.id) {
          await upsertInfluencer(workspaceId, {
            kind: "organization",
            type: "publication",
            name: pub.name,
            mvprPublicationId: pub.id,
            domain: hostFromUrl(c.link),
          })
          result.influencersUpserted += 1
        }
      } catch (e) {
        result.errors.push(`upsertInfluencer(coverage ${c.id}): ${(e as Error).message}`)
      }
    }
    await updateSyncState({ workspaceId, lastCoverageSyncAt: nowIso })
  } catch (e) {
    result.errors.push(`coverages: ${(e as Error).message}`)
  }

  // ── Announcements ────────────────────────────────────────────────────────
  try {
    const summaries = await listAnnouncements({ creds })
    for (const a of summaries) {
      try {
        await upsertAnnouncementSummary(workspaceId, a)
        // Pull detail so we get document / stats / coverages / threads. If
        // detail fails we keep the summary - the row already exists.
        try {
          const detail = await getAnnouncement({ creds, id: a.id })
          await upsertAnnouncementDetail(workspaceId, detail)
        } catch (e) {
          result.errors.push(`getAnnouncement(${a.id}): ${(e as Error).message}`)
        }
        result.announcementsIngested += 1
      } catch (e) {
        result.errors.push(`upsertAnnouncement(${a.id}): ${(e as Error).message}`)
      }
    }
    await updateSyncState({ workspaceId, lastAnnouncementSyncAt: nowIso })
  } catch (e) {
    result.errors.push(`announcements: ${(e as Error).message}`)
  }

  // ── Threads ────────────────────────────────────────────────────────────────
  // The list endpoint has no date filter, so we page through newest-first
  // until a short page. Threads are low-volume relative to coverage; the
  // MAX_THREAD_PAGES cap is a runaway guard, not an expected limit.
  try {
    for (let page = 1; page <= MAX_THREAD_PAGES; page += 1) {
      const threads = await listThreads({ creds, page, pageSize: THREAD_PAGE_SIZE })
      for (const t of threads) {
        try {
          await upsertThread(workspaceId, t)
          result.threadsIngested += 1
        } catch (e) {
          result.errors.push(`upsertThread(${t.id}): ${(e as Error).message}`)
        }
      }
      if (threads.length < THREAD_PAGE_SIZE) break
      if (page === MAX_THREAD_PAGES) {
        result.errors.push(`threads: hit MAX_THREAD_PAGES (${MAX_THREAD_PAGES}); some threads may be unsynced`)
      }
    }
    await updateSyncState({ workspaceId, lastThreadSyncAt: nowIso })
  } catch (e) {
    result.errors.push(`threads: ${(e as Error).message}`)
  }

  return result
}

/**
 * Enumerate workspace ids by scanning Redis for `workspace:<id>:config` keys.
 * Same pattern as the stripe-reconcile cron.
 */
export async function listWorkspaceIds(): Promise<string[]> {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return []
  const redis = new Redis({
    url:   process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  })
  const ids: string[] = []
  let cursor = "0"
  do {
    const result: [string, string[]] = await redis.scan(cursor, { match: "workspace:*:config", count: 200 })
    const [next, batch] = result
    for (const k of batch) {
      const m = /^workspace:([^:]+):config$/.exec(k)
      if (m) ids.push(m[1])
    }
    cursor = next
    if (cursor === "0") break
  } while (true)
  return ids
}
