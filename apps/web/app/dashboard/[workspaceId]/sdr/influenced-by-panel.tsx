"use client"

/**
 * InfluencedByPanel — lazy-loaded "Influenced by" section for a lead row.
 *
 * Sits inside the expanded panel of LeadTableRow. Fetches from
 * GET /api/dashboard/<workspaceId>/influenced-by?linkedinUrl=… on first
 * render, then renders a flat list grouped by kind. Caps the initial render
 * to keep contacts with thousands of references (e.g. Barney Hussey-Yeo at
 * ~1.7k) usable.
 *
 * Hidden entirely when the contact has no influences imported, so the panel
 * doesn't add noise for the (currently many) contacts whose influenced_by
 * field hasn't been populated yet.
 */

import { useEffect, useState } from "react"

interface InfluencedByEntry {
  kind:           "person" | "company" | "influencer" | string
  crmId?:         string
  name:           string | null
  linkedinUrl?:   string | null
  domain?:        string | null
  url?:           string | null       // influencer Twitter/LinkedIn URL
  website?:       string | null       // influencer website
  classification?: string | null      // Journalist / Other / …
}

const INITIAL_LIMIT = 12

const KIND_ICON: Record<string, string> = {
  person:     "👤",
  company:    "🏢",
  influencer: "⭐",
}

const KIND_LABEL: Record<string, string> = {
  person:     "People",
  company:    "Companies",
  influencer: "Influencers",
}

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()

export function InfluencedByPanel({
  workspaceId,
  linkedinUrl,
}: {
  workspaceId: string
  /** When null/empty the panel renders nothing — there's no contact to look up. */
  linkedinUrl: string | null
}) {
  const [entries, setEntries] = useState<InfluencedByEntry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    if (!linkedinUrl) { setLoading(false); return }
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch(
          `/api/dashboard/${workspaceId}/influenced-by?linkedinUrl=${encodeURIComponent(linkedinUrl)}`,
        )
        if (cancelled) return
        if (!r.ok) {
          setError(`Lookup failed (${r.status})`)
          setLoading(false)
          return
        }
        const data = await r.json()
        setEntries(Array.isArray(data.influencedBy) ? data.influencedBy : [])
      } catch (e) {
        if (cancelled) return
        setError((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [workspaceId, linkedinUrl])

  // Hide entirely when there's nothing to show — keeps the lead row clean
  // for contacts whose influenced_by isn't populated yet.
  if (!linkedinUrl) return null
  if (loading) {
    return (
      <div className="text-[12px] text-zinc-400">Loading influences…</div>
    )
  }
  if (error)                       return null
  if (!entries || entries.length === 0) return null

  // Sort: influencers (with classification) first, then people, then companies.
  const sorted = [...entries].sort((a, b) => {
    const order = { influencer: 0, person: 1, company: 2 } as Record<string, number>
    return (order[a.kind] ?? 9) - (order[b.kind] ?? 9)
  })
  const visible = showAll ? sorted : sorted.slice(0, INITIAL_LIMIT)
  const hiddenCount = sorted.length - visible.length

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">
          Influenced by · {entries.length} total
        </h4>
        <span className="text-[12px] text-zinc-400">Sorted by kind</span>
      </div>
      <ul className="flex flex-wrap gap-2">
        {visible.map((e, i) => (
          <li key={`${e.kind}-${e.crmId ?? i}`}>
            <Pill entry={e} />
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && !showAll && (
        <button
          type="button"
          onClick={(ev) => { ev.stopPropagation(); setShowAll(true) }}
          className="text-[12px] font-medium text-[#2BA98B] hover:underline"
        >
          Show {hiddenCount} more →
        </button>
      )}
      {showAll && entries.length > INITIAL_LIMIT && (
        <button
          type="button"
          onClick={(ev) => { ev.stopPropagation(); setShowAll(false) }}
          className="text-[12px] font-medium text-[#2BA98B] hover:underline"
        >
          Show less
        </button>
      )}
    </div>
  )
}

function Pill({ entry }: { entry: InfluencedByEntry }) {
  const icon  = KIND_ICON[entry.kind] ?? "•"
  const name  = entry.name ?? "(unknown)"
  const kindLabel = KIND_LABEL[entry.kind] ?? entry.kind
  const href  =
    entry.kind === "person"     ? entry.linkedinUrl :
    entry.kind === "company"    ? (entry.domain ? `https://${entry.domain}` : null) :
    entry.kind === "influencer" ? (entry.url ?? (entry.website ? `https://${entry.website}` : null)) :
    null
  const tooltip = entry.classification ? `${kindLabel} · ${entry.classification}` : kindLabel
  const ariaLabel = entry.classification
    ? `${kindLabel}, ${entry.classification}: ${name}`
    : `${kindLabel}: ${name}`

  const isInfluencer = entry.kind === "influencer"
  const className = isInfluencer
    ? "inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[12px] text-amber-200 hover:border-amber-500/50 hover:text-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40"
    : "inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[12px] text-zinc-200 hover:border-white/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60"

  const inner = (
    <>
      <span aria-hidden className={isInfluencer ? "text-amber-400" : "text-zinc-400"}>{icon}</span>
      <span className="truncate max-w-[200px] font-medium">{name}</span>
      {entry.classification && (
        <span
          className={`text-[10px] font-bold uppercase tracking-[0.04em] ${isInfluencer ? "text-amber-300/70" : "text-zinc-500"}`}
        >
          {entry.classification}
        </span>
      )}
    </>
  )

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={stop}
        title={tooltip}
        aria-label={ariaLabel}
        className={className}
      >
        {inner}
      </a>
    )
  }
  return (
    <span title={tooltip} aria-label={ariaLabel} role="text" className={className}>
      {inner}
    </span>
  )
}
