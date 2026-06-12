"use client"

import { useEffect, useRef, useTransition } from "react"
import { useRouter } from "next/navigation"

type SDRStage =
  | "Prospect"
  | "Signal Found"
  | "Engaged"
  | "High Signal"
  | "Discovery Call"
  | "Requested Information"
  | "Follow Up Call"
  | "Sent Information"
  | "Diligence"
  | "Contract Negotiation"
  | "Customer Won"

const SDR_STAGES: SDRStage[] = [
  "Prospect",
  "Signal Found",
  "Engaged",
  "High Signal",
  "Discovery Call",
  "Requested Information",
  "Sent Information",
  "Follow Up Call",
  "Diligence",
  "Contract Negotiation",
  "Customer Won",
]

const STAGE_DOT: Record<SDRStage, string> = {
  "Prospect":              "#9CA3AF",
  "Signal Found":          "#93C5FD",
  "Engaged":               "#2BA98B",
  "High Signal":           "#10B981",
  "Discovery Call":        "#F59E0B",
  "Requested Information": "#FBBF24",
  "Follow Up Call":        "#FB923C",
  "Sent Information":      "#818CF8",
  "Diligence":             "#C084FC",
  "Contract Negotiation":  "#34D399",
  "Customer Won":          "#A78BFA",
}

const STAGE_DISPLAY_LABEL: Partial<Record<SDRStage, string>> = {
  "High Signal":    "Highly engaged",
  "Discovery Call": "Ambassadors",
}

interface Props {
  workspaceId: string
  tab:         string
  sortMode:    string
  period:      string
  persona:     string | null
  active:      string | null
}

function buildHref(workspaceId: string, params: { sort: string; period: string; tab: string; stage: SDRStage | null; persona: string | null }): string {
  const qs = new URLSearchParams()
  if (params.sort   && params.sort   !== "recent-desc") qs.set("sort",    params.sort)
  if (params.period && params.period !== "all")         qs.set("period",  params.period)
  if (params.tab    && params.tab    !== "all")         qs.set("tab",     params.tab)
  if (params.stage)                                     qs.set("stage",   params.stage)
  if (params.persona)                                   qs.set("persona", params.persona)
  const q = qs.toString()
  return `/dashboard/${workspaceId}/sdr${q ? "?" + q : ""}`
}

export function StageSelect({ workspaceId, tab, sortMode, period, persona, active }: Props) {
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

  function navigate(stage: SDRStage | null) {
    startTransition(() => {
      router.push(buildHref(workspaceId, { sort: sortMode, period, tab, stage, persona }))
    })
    if (ref.current) ref.current.open = false
  }

  const triggerLabel = active ? (STAGE_DISPLAY_LABEL[active as SDRStage] ?? active) : "All"

  return (
    <details ref={ref} className={`relative transition-opacity duration-150 ${isPending ? "pointer-events-none opacity-50" : ""}`}>
      <summary className="inline-flex cursor-pointer list-none select-none items-center gap-2 rounded-full border border-[#2BA98B]/30 bg-[#2BA98B]/[0.08] px-3.5 py-1.5 text-[11px] font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#2BA98B]/40">
        <span className="text-zinc-500">Stage</span>
        <span className="h-3 w-px shrink-0 bg-white/[0.12]" aria-hidden />
        <span className="text-white">{triggerLabel}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#2BA98B" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </summary>
      <div className="absolute left-0 top-full z-20 mt-2 w-[220px] overflow-hidden rounded-xl border border-white/[0.08] bg-[#0F1815] shadow-[0_12px_32px_rgba(0,0,0,0.4)]">
        <div className="border-b border-white/[0.04] px-3.5 py-2.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#2BA98B]">Filter by Stage</span>
        </div>
        <div className="p-1">
          <button
            type="button"
            onClick={() => navigate(null)}
            className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors hover:bg-white/[0.06] ${!active ? "bg-[#2BA98B]/[0.08]" : ""}`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={!active ? "#2BA98B" : "#52525B"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
            <span className={`flex-1 text-left ${!active ? "font-medium text-white" : "text-zinc-300"}`}>All stages</span>
            {!active && (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#2BA98B" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </button>
          <div className="my-1 mx-1.5 h-px bg-white/[0.06]" aria-hidden />
          {SDR_STAGES.map(s => {
            const isOn = active === (s as string)
            const dot = STAGE_DOT[s]
            return (
              <button
                key={s}
                type="button"
                onClick={() => navigate(s)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors hover:bg-white/[0.06] ${isOn ? "bg-[#2BA98B]/[0.08]" : ""}`}
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dot }} aria-hidden />
                <span className={`flex-1 text-left ${isOn ? "font-medium text-white" : "text-zinc-300"}`}>
                  {STAGE_DISPLAY_LABEL[s] ?? s}
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
