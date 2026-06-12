"use client"

import { useEffect, useRef, useTransition, type ReactElement } from "react"
import { useRouter } from "next/navigation"

type Tab      = "all" | "queue"
type SortMode = "recent-desc" | "recent-asc" | "score-desc" | "score-asc" | "score-then-recent" | "recent-then-score"
type Period   = "all" | "week" | "month"
type Option   = "enriched" | "queue" | "excluded"

interface Props {
  workspaceId:     string
  tab:             Tab
  sortMode:        SortMode
  period:          Period
  stage:           string | null
  persona:         string | null
  includeExcluded: boolean
  allCount:        number
  queueCount:      number
  excludedCount:   number
}

function buildHref(workspaceId: string, p: {
  tab: Tab; sort: SortMode; period: Period; stage: string | null; persona: string | null; excluded: boolean
}): string {
  const qs = new URLSearchParams()
  if (p.sort   !== "recent-desc") qs.set("sort",    p.sort)
  if (p.period !== "all")         qs.set("period",  p.period)
  if (p.tab    !== "all")         qs.set("tab",     p.tab)
  if (p.stage)                    qs.set("stage",   p.stage)
  if (p.persona)                  qs.set("persona", p.persona)
  if (p.excluded)                 qs.set("excluded", "1")
  const q = qs.toString()
  return `/dashboard/${workspaceId}/sdr${q ? "?" + q : ""}`
}

const ICONS: Record<Option, ReactElement> = {
  enriched: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <polyline points="9 12 11 14 15 10" />
    </svg>
  ),
  queue: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  ),
  excluded: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
    </svg>
  ),
}

const LABELS: Record<Option, string> = {
  enriched: "Enriched",
  queue:    "For enrichment",
  excluded: "Excluded",
}

export function EnrichmentSelect({
  workspaceId, tab, sortMode, period, stage, persona, includeExcluded,
  allCount, queueCount, excludedCount,
}: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const ref = useRef<HTMLDetailsElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        ref.current.open = false
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [])

  const active: Option = includeExcluded ? "excluded" : tab === "queue" ? "queue" : "enriched"

  const counts: Record<Option, number> = {
    enriched: allCount,
    queue:    queueCount,
    excluded: excludedCount,
  }

  // When switching to Excluded, drop persona pseudo-values to avoid empty results
  const safePersona = (persona && persona !== "__matched__" && persona !== "__none__") ? persona : null

  function navigate(option: Option) {
    const href =
      option === "queue"
        ? buildHref(workspaceId, { tab: "queue", sort: sortMode, period, stage, persona, excluded: false })
        : option === "excluded"
          ? buildHref(workspaceId, { tab: "all",   sort: sortMode, period, stage, persona: safePersona, excluded: true })
          : buildHref(workspaceId, { tab: "all",   sort: sortMode, period, stage, persona, excluded: false })
    startTransition(() => router.push(href))
    if (ref.current) ref.current.open = false
  }

  const OPTIONS: Option[] = ["enriched", "queue", "excluded"]

  return (
    <details ref={ref} className={`relative transition-opacity duration-150 ${isPending ? "pointer-events-none opacity-50" : ""}`}>
      <summary className="inline-flex cursor-pointer list-none select-none items-center gap-2 rounded-full border border-[#2BA98B]/30 bg-[#2BA98B]/[0.08] px-3.5 py-1.5 text-[11px] font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#2BA98B]/40">
        <span className="text-white">{LABELS[active]}</span>
        <span className="h-3 w-px shrink-0 bg-white/[0.12]" aria-hidden />
        <span className="tabular-nums text-zinc-400">{counts[active]}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#2BA98B" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </summary>

      <div className="absolute left-0 top-full z-20 mt-2 w-[240px] overflow-hidden rounded-xl border border-white/[0.08] bg-[#0F1815] shadow-[0_12px_32px_rgba(0,0,0,0.4)]">
        <div className="border-b border-white/[0.04] px-3.5 py-2.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#2BA98B]">Filter by Enrichment</span>
        </div>
        <div className="p-1">
          {OPTIONS.map(opt => {
            const isOn = active === opt
            return (
              <button
                key={opt}
                type="button"
                onClick={() => navigate(opt)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors hover:bg-white/[0.06] ${isOn ? "bg-[#2BA98B]/[0.08]" : ""}`}
              >
                <span className={`shrink-0 ${isOn ? "text-[#2BA98B]" : "text-zinc-500"}`}>
                  {ICONS[opt]}
                </span>
                <span className={`flex-1 text-left ${isOn ? "font-medium text-white" : "text-zinc-300"}`}>
                  {LABELS[opt]}
                </span>
                <span className={`shrink-0 font-mono text-[11px] tabular-nums ${isOn ? "text-zinc-300" : "text-zinc-500"}`}>
                  {counts[opt]}
                </span>
                {isOn && (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#2BA98B" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </details>
  )
}
