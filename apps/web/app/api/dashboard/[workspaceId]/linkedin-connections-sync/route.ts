/**
 * POST /api/dashboard/:workspaceId/linkedin-connections-sync
 *
 * On-demand sweep: pages through the connected Unipile account's
 * 1st-degree connections and flips linkedin_connected = TRUE on every
 * matching contact (by LinkedIn slug) whose flag is still NULL.
 *
 * Does NOT touch explicit FALSE overrides. Safe to run repeatedly.
 */
import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { syncLinkedinConnectionsFromUnipile, isDbConfigured } from "@/lib/db/contact-store"
import { listLinkedInRelations } from "@/lib/unipile"

// LinkedIn caps account connections at ~30k, so 500 pages * 100 = 50k
// slugs covers the worst case with headroom. Still a hard ceiling so a
// pathological Unipile cursor loop can't run away.
const MAX_PAGES = 500

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params
  // Optional ?pages=N caps page-fetch count - useful for sanity-testing
  // the Unipile response shape without burning the full 30k-connection
  // pull. Clamped to [1, MAX_PAGES].
  const pagesParam = req.nextUrl.searchParams.get("pages")
  const pageCap = pagesParam
    ? Math.min(MAX_PAGES, Math.max(1, Number.parseInt(pagesParam, 10) || MAX_PAGES))
    : MAX_PAGES
  // ?dryRun=1 skips the DB write so we can inspect what Unipile sent
  // without flipping any rows.
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1"

  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Workspace not found" }, { status: 404 })
  if (config.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  if (!isDbConfigured()) return NextResponse.json({ error: "Postgres not configured" }, { status: 500 })

  const creds = config.messaging?.unipile
  if (!creds?.apiKey || !creds?.dsn || !creds?.accountId) {
    return NextResponse.json({ error: "Unipile not configured for this workspace" }, { status: 400 })
  }

  const collected: Array<{ slug: string; memberId: string | null }> = []
  let cursor: string | null = null
  let pages = 0
  let sampleRelations: unknown[] = []
  try {
    do {
      const page = await listLinkedInRelations({ creds, cursor })
      if (pages === 0) sampleRelations = page.relations.slice(0, 5)
      for (const r of page.relations) {
        if (r.publicIdentifier) collected.push({ slug: r.publicIdentifier, memberId: r.memberId })
      }
      cursor = page.nextCursor
      pages++
      if (pages >= pageCap) break
    } while (cursor)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err), slugsFetched: collected.length },
      { status: 502 },
    )
  }

  const result = dryRun
    ? { rowsStampedMemberId: 0, rowsFlippedConnected: 0 }
    : await syncLinkedinConnectionsFromUnipile(workspaceId, collected)
  return NextResponse.json({
    ok:                  true,
    dryRun,
    pageCap,
    pagesFetched:        pages,
    slugsFetched:        collected.length,
    rowsFlipped:         result.rowsFlippedConnected,
    rowsStampedMemberId: result.rowsStampedMemberId,
    sampleSlugs:         collected.slice(0, 10).map(c => c.slug),
    sampleRelations,
  })
}
