"use client"

import { useEffect, useRef, useTransition } from "react"
import { useRouter } from "next/navigation"

type Tab      = "all" | "queue"
type SortMode = "recent-desc" | "recent-asc" | "score-desc" | "score-asc" | "score-then-recent" | "recent-then-score"
type Period   = "all" | "week" | "month"

interface Props {
  workspaceId: string
  tab:         Tab
  sortMode:    SortMode
  period:      Period
  stage:       string | null
  persona:     string | null
}

const OPTIONS: { value: Period; label: string; meta?: string }[] = [
  { value: "all",   label: "All time"   },
  { value: "month", label: "This month", meta: "30d" },
  { value: "week",  label: "This week",  meta: "7d"  },
]

function buildHref(workspaceId: string, p: {
  tab: Tab; sort: SortMode; period: Period; stage: string | null; persona: string | null
}): string {
  const qs = new URLSearchParams()
  if (p.sort   !== "recent-desc") qs.set("sort",    p.sort)
  if (p.period !== "all")         qs.set("period",  p.period)
  if (p.tab    !== "all")         qs.set("tab",     p.tab)
  if (p.stage)                    qs.set("stage",   p.stage)
  if (p.persona)                  qs.set("persona", p.persona)
  const q = qs.toString()
  return `/dashboard/${workspaceId}/sdr${q ? "?" + q : ""}`
}

export function PeriodSelect({ workspaceId, tab, sortMode, period, stage, persona }: Props) {
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

  function navigate(value: Period) {
    startTransition(() => {
      router.push(buildHref(workspaceId, { tab, sort: sortMode, period: value, stage, persona }))
    })
    if (ref.current) ref.current.open = false
  }

  const activeLabel = OPTIONS.find(o => o.value === period)?.label ?? "All time"

  return (
    <details ref={ref} className={`relative transition-opacity duration-150 ${isPending ? "pointer-events-none opacity-50" : ""}`}>
      <summary className="inline-flex cursor-pointer list-none select-none items-center gap-2 rounded-full border border-[#2BA98B]/30 bg-[#2BA98B]/[0.08] px-3.5 py-1.5 text-[11px] font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#2BA98B]/40">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#2BA98B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
        <span className="text-white">{activeLabel}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#2BA98B" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </summary>

      <div className="absolute left-0 top-full z-20 mt-2 w-[200px] overflow-hidden rounded-xl border border-white/[0.08] bg-[#0F1815] shadow-[0_12px_32px_rgba(0,0,0,0.4)]">
        <div className="border-b border-white/[0.04] px-3.5 py-2.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#2BA98B]">Time Range</span>
        </div>
        <div className="p-1">
          {OPTIONS.map(opt => {
            const isOn = period === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => navigate(opt.value)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors hover:bg-white/[0.06] ${isOn ? "bg-[#2BA98B]/[0.08]" : ""}`}
              >
                <span className={`flex-1 text-left ${isOn ? "font-medium text-white" : "text-zinc-300"}`}>
                  {opt.label}
                </span>
                {opt.meta && !isOn && (
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-zinc-500">
                    {opt.meta}
                  </span>
                )}
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
