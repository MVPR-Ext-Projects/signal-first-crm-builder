"use client"

/**
 * Unified Interests panel — combines LinkedIn interests (Top Voices,
 * Companies, Groups, Newsletters) and X (Twitter) following into one
 * flat list with per-item source badges.
 *
 * Lazy-loads cached data from both sources on mount. The single
 * "Fetch interests" button calls whichever sources we have a URL for —
 * LinkedIn endpoint when contact has linkedinUrl, X endpoint when contact
 * has twitterUrl, both when both are present. Hidden entirely when neither
 * URL is known.
 *
 * Per-platform endpoints stay separate server-side; the merging happens
 * in this client component so we can render partial-success states cleanly
 * (e.g. X works, LinkedIn errors with "configure actor" — show what we got).
 */

import { useEffect, useState } from "react"
import { useToast } from "../toast"

interface LinkedinAccount {
  name:           string
  linkedinUrl:    string | null
  tagline:        string | null
  followerCount:  number | null
}

interface LinkedinResult {
  fetchedAt:   string
  totalCount:  number
  topVoices:   LinkedinAccount[]
  companies:   LinkedinAccount[]
  groups:      LinkedinAccount[]
  newsletters: LinkedinAccount[]
}

interface XAccount {
  name:           string
  handle:         string
  profileUrl:     string | null
  bio:            string | null
  followerCount:  number | null
  verified:       boolean
}

interface XResult {
  fetchedAt:  string
  totalCount: number
  accounts:   XAccount[]
}

type Source = "linkedin" | "x"

interface UnifiedItem {
  source:        Source
  /** LinkedIn sub-bucket (Top Voices / Companies / Groups / Newsletters). Null for X. */
  category:      string | null
  name:          string
  url:           string | null
  description:   string | null   // tagline (LinkedIn) or bio (X)
  followerCount: number | null
  verified:      boolean
}

const INITIAL_LIMIT = 24
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()

export function InterestsPanel({
  workspaceId,
  linkedinUrl,
  twitterUrl,
}: {
  workspaceId: string
  linkedinUrl: string | null
  twitterUrl:  string | null
}) {
  const toast = useToast()
  const [linkedin, setLinkedin] = useState<LinkedinResult | null>(null)
  const [xData,    setXData]    = useState<XResult | null>(null)
  const [loadingCache, setLoadingCache] = useState(true)
  const [busy,    setBusy]    = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [filter,  setFilter]  = useState<"all" | Source>("all")
  const [showAll, setShowAll] = useState(false)

  const hasLinkedin = !!linkedinUrl
  const hasX        = !!twitterUrl

  // Initial cache lookup — pulls from both sources in parallel.
  useEffect(() => {
    if (!hasLinkedin && !hasX) { setLoadingCache(false); return }
    let cancelled = false
    ;(async () => {
      const calls: Promise<unknown>[] = []
      if (hasLinkedin) {
        calls.push(
          fetch(`/api/enrich/contacts/${workspaceId}/linkedin-interests?linkedinUrl=${encodeURIComponent(linkedinUrl!)}`)
            .then(async (r) => r.ok ? setLinkedin(await r.json() as LinkedinResult) : undefined)
            .catch(() => undefined),
        )
      }
      if (hasX) {
        calls.push(
          fetch(`/api/enrich/contacts/${workspaceId}/x-interests?twitterUrl=${encodeURIComponent(twitterUrl!)}`)
            .then(async (r) => r.ok ? setXData(await r.json() as XResult) : undefined)
            .catch(() => undefined),
        )
      }
      await Promise.all(calls)
      if (!cancelled) setLoadingCache(false)
    })()
    return () => { cancelled = true }
  }, [workspaceId, linkedinUrl, twitterUrl, hasLinkedin, hasX])

  async function runFetch(e: { stopPropagation: () => void }) {
    e.stopPropagation()
    setBusy(true)
    setError(null)
    const errors: string[] = []

    const sources: string[] = []
    if (hasLinkedin) sources.push("LinkedIn")
    if (hasX)        sources.push("X")
    toast.info("Fetching interests", `Apify run starting for ${sources.join(" + ")}…`)

    const calls: Promise<unknown>[] = []
    if (hasLinkedin) {
      calls.push(
        fetch(`/api/enrich/contacts/${workspaceId}/linkedin-interests`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ linkedinUrl }),
        }).then(async (r) => {
          const data = await r.json().catch(() => ({}))
          if (!r.ok) errors.push(`LinkedIn: ${data.error ?? r.status}`)
          else setLinkedin(data as LinkedinResult)
        }).catch((e) => errors.push(`LinkedIn: ${(e as Error).message}`)),
      )
    }
    if (hasX) {
      calls.push(
        fetch(`/api/enrich/contacts/${workspaceId}/x-interests`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ twitterUrl }),
        }).then(async (r) => {
          const data = await r.json().catch(() => ({}))
          if (!r.ok) errors.push(`X: ${data.error ?? r.status}`)
          else setXData(data as XResult)
        }).catch((e) => errors.push(`X: ${(e as Error).message}`)),
      )
    }
    await Promise.all(calls)
    if (errors.length) {
      setError(errors.join(" · "))
      toast.error("Interests fetch failed", errors.join(" · "))
    } else {
      toast.success("Interests fetched", `${sources.join(" + ")} updated.`)
    }
    setBusy(false)
  }

  // Only render when we have the X/Twitter profile — that's the primary
  // signal source for interests. LinkedIn interests still load when both
  // URLs are present.
  if (!hasX) return null

  const items: UnifiedItem[] = [
    ...(linkedin?.topVoices   ?? []).map(a => liItem(a, "Top Voices")),
    ...(linkedin?.companies   ?? []).map(a => liItem(a, "Companies")),
    ...(linkedin?.groups      ?? []).map(a => liItem(a, "Groups")),
    ...(linkedin?.newsletters ?? []).map(a => liItem(a, "Newsletters")),
    ...(xData?.accounts ?? []).map(xItem),
  ]
  const filtered = filter === "all" ? items : items.filter(i => i.source === filter)
  // Verified first, then by follower count desc.
  const sorted = [...filtered].sort((a, b) => {
    if (a.verified !== b.verified) return a.verified ? -1 : 1
    return (b.followerCount ?? 0) - (a.followerCount ?? 0)
  })
  const visible = showAll ? sorted : sorted.slice(0, INITIAL_LIMIT)
  const hidden  = sorted.length - visible.length

  const liCount = linkedin?.totalCount ?? 0
  const xCount  = xData?.totalCount ?? 0

  return (
    <div className="mt-4 border-t border-zinc-800/60 pt-3">
      <div className="mb-2 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
            Interests
          </h4>
          <SourceFilterPills
            filter={filter}
            setFilter={setFilter}
            liCount={liCount}
            xCount={xCount}
            hasLinkedin={hasLinkedin}
            hasX={hasX}
          />
        </div>
        <button
          type="button"
          onClick={runFetch}
          disabled={busy || loadingCache}
          aria-label={items.length > 0 ? "Re-fetch interests" : "Fetch interests"}
          className="rounded-md border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:border-blue-500 hover:text-blue-300 hover:bg-blue-950/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40 disabled:cursor-not-allowed motion-reduce:transition-none"
        >
          {busy ? "Fetching…" : loadingCache ? "Loading…" : items.length > 0 ? "Re-fetch" : "Fetch interests"}
        </button>
      </div>

      {error && (
        <p className="mb-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-300" role="alert">
          {error}
        </p>
      )}

      {!loadingCache && items.length === 0 && !error && (
        <p className="text-[11px] text-zinc-500">
          Not yet fetched —{" "}
          <a
            href={`/dashboard/${workspaceId}/settings`}
            className="text-zinc-400 underline hover:text-zinc-200"
          >
            connect your Apify API key in Enrichment providers
          </a>{" "}
          to enable this.
        </p>
      )}

      {visible.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {visible.map((it, i) => (
            <li key={`${it.source}-${it.url ?? it.name}-${i}`}>
              <Pill item={it} />
            </li>
          ))}
        </ul>
      )}

      {hidden > 0 && !showAll && (
        <button
          type="button"
          onClick={(ev) => { ev.stopPropagation(); setShowAll(true) }}
          className="mt-2 text-[11px] text-zinc-400 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 rounded"
        >
          Show {hidden} more
        </button>
      )}
      {showAll && filtered.length > INITIAL_LIMIT && (
        <button
          type="button"
          onClick={(ev) => { ev.stopPropagation(); setShowAll(false) }}
          className="mt-2 text-[11px] text-zinc-400 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 rounded"
        >
          Show less
        </button>
      )}
    </div>
  )
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function liItem(a: LinkedinAccount, category: string): UnifiedItem {
  const url = a.linkedinUrl
    ? (a.linkedinUrl.startsWith("http") ? a.linkedinUrl : `https://${a.linkedinUrl}`)
    : null
  return {
    source:        "linkedin",
    category,
    name:          a.name,
    url,
    description:   a.tagline,
    followerCount: a.followerCount,
    verified:      false,
  }
}

function xItem(a: XAccount): UnifiedItem {
  return {
    source:        "x",
    category:      null,
    name:          a.name,
    url:           a.profileUrl ?? `https://x.com/${a.handle}`,
    description:   a.bio,
    followerCount: a.followerCount,
    verified:      a.verified,
  }
}

function SourceFilterPills({
  filter, setFilter, liCount, xCount, hasLinkedin, hasX,
}: {
  filter: "all" | Source
  setFilter: (v: "all" | Source) => void
  liCount: number
  xCount:  number
  hasLinkedin: boolean
  hasX: boolean
}) {
  const total = liCount + xCount
  const cls = (active: boolean) =>
    `rounded-full border px-2 py-0.5 text-[10px] transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 ${
      active
        ? "bg-zinc-100 text-zinc-900 border-zinc-100"
        : "bg-zinc-950 text-zinc-400 border-zinc-700 hover:border-zinc-500"
    }`
  return (
    <div className="flex items-center gap-1">
      <button type="button" onClick={(e) => { e.stopPropagation(); setFilter("all") }} className={cls(filter === "all")}>
        All <span className="tabular-nums">{total}</span>
      </button>
      {hasLinkedin && (
        <button type="button" onClick={(e) => { e.stopPropagation(); setFilter("linkedin") }} className={cls(filter === "linkedin")} aria-label="Filter to LinkedIn">
          <span aria-hidden>in</span> <span className="tabular-nums">{liCount}</span>
        </button>
      )}
      {hasX && (
        <button type="button" onClick={(e) => { e.stopPropagation(); setFilter("x") }} className={cls(filter === "x")} aria-label="Filter to X">
          <span aria-hidden>𝕏</span> <span className="tabular-nums">{xCount}</span>
        </button>
      )}
    </div>
  )
}

function Pill({ item }: { item: UnifiedItem }) {
  const sourceLabel = item.source === "linkedin"
    ? (item.category ? `LinkedIn · ${item.category}` : "LinkedIn")
    : "X"
  // Screen-reader-friendly aria-label that includes platform context.
  const aria = `${sourceLabel}: ${item.name}`
  const tooltip = item.description ? `${sourceLabel} — ${item.description}` : sourceLabel
  const className =
    "inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400"
  // Source badge — small, distinct colour per platform. aria-hidden because
  // the spoken label already includes "LinkedIn" / "X" via aria-label above.
  const badge = item.source === "linkedin"
    ? <span aria-hidden className="rounded-sm bg-blue-500/20 text-blue-300 px-1 text-[9px] font-bold tracking-wider">in</span>
    : <span aria-hidden className="rounded-sm bg-zinc-800 text-zinc-200 px-1 text-[9px] font-bold">𝕏</span>

  const inner = (
    <>
      {badge}
      <span className="truncate max-w-[180px]">{item.name}</span>
      {item.verified && <span className="text-blue-400 text-[10px]" aria-hidden>✓</span>}
    </>
  )

  if (item.url) {
    return (
      <a href={item.url} target="_blank" rel="noopener noreferrer" onClick={stop} title={tooltip} aria-label={aria} className={className}>
        {inner}
      </a>
    )
  }
  return (
    <span title={tooltip} aria-label={aria} role="text" className={className}>
      {inner}
    </span>
  )
}
