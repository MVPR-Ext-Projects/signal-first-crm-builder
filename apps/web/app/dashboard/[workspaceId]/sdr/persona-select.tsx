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
  names:       string[]
  active:      string | null
}

// Deterministic dot colour per persona index
const PERSONA_COLORS = [
  "#F59E0B", "#6366F1", "#2BA98B", "#EC4899",
  "#3B82F6", "#F97316", "#10B981", "#8B5CF6",
]

function buildHref(args: Props & { persona: string | null }): string {
  const { workspaceId, tab, sortMode, period, stage, persona } = args
  const qs = new URLSearchParams()
  if (sortMode !== "recent-desc") qs.set("sort",    sortMode)
  if (period   !== "all")         qs.set("period",  period)
  if (tab      !== "all")         qs.set("tab",     tab)
  if (stage)                      qs.set("stage",   stage)
  if (persona)                    qs.set("persona", persona)
  const q = qs.toString()
  return `/dashboard/${workspaceId}/sdr${q ? "?" + q : ""}`
}

export function PersonaSelect(props: Props) {
  const { names, active } = props
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

  function navigate(persona: string | null) {
    startTransition(() => {
      router.push(buildHref({ ...props, persona }))
    })
    if (ref.current) ref.current.open = false
  }

  // Derive trigger state
  const isExcluded = active === "__none__"
  // __matched__ is a legacy URL value — treat as no filter in the UI
  const activeName = (active && !isExcluded && active !== "__matched__") ? active : null
  const activeIndex = activeName ? names.indexOf(activeName) : -1
  const activeDotColor = activeIndex >= 0 ? PERSONA_COLORS[activeIndex % PERSONA_COLORS.length] : null

  const triggerBorder = isExcluded
    ? "border-[#AA5881]/40 bg-[#AA5881]/[0.08]"
    : activeName
      ? "border-[#2BA98B]/30 bg-[#2BA98B]/[0.08]"
      : "border-white/[0.12] bg-transparent"

  const chevronColor = isExcluded ? "#AA5881" : activeName ? "#2BA98B" : "#52525B"

  return (
    <details ref={ref} className={`relative transition-opacity duration-150 ${isPending ? "pointer-events-none opacity-50" : ""}`}>
      <summary className={`inline-flex cursor-pointer list-none select-none items-center gap-2 rounded-full border px-3.5 py-1.5 text-[11px] font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#2BA98B]/40 ${triggerBorder}`}>
        {isExcluded ? (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#AA5881" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="10" />
            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
          </svg>
        ) : (
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: activeDotColor ?? "#52525B" }}
            aria-hidden
          />
        )}
        <span className={isExcluded ? "text-[#AA5881]" : activeName ? "text-white" : "text-zinc-400"}>
          {isExcluded ? "Excluded" : activeName ?? "No persona"}
        </span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={chevronColor} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </summary>

      <div className="absolute left-0 top-full z-20 mt-2 w-[240px] overflow-hidden rounded-xl border border-white/[0.08] bg-[#0F1815] shadow-[0_12px_32px_rgba(0,0,0,0.4)]">
        <div className="border-b border-white/[0.04] px-3.5 py-2.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#2BA98B]">Set Persona</span>
        </div>
        <div className="p-1">
          {names.map((name, i) => {
            const isOn = active === name
            const dot  = PERSONA_COLORS[i % PERSONA_COLORS.length]
            return (
              <button
                key={name}
                type="button"
                onClick={() => navigate(isOn ? null : name)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors hover:bg-white/[0.06] ${isOn ? "bg-[#2BA98B]/[0.08]" : ""}`}
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dot }} aria-hidden />
                <span className={`flex-1 text-left ${isOn ? "font-medium text-white" : "text-zinc-300"}`}>
                  {name}
                </span>
                {isOn && (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#2BA98B" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            )
          })}

          <div className="mx-1.5 my-1 h-px bg-white/[0.06]" aria-hidden />

          <button
            type="button"
            onClick={() => navigate(isExcluded ? null : "__none__")}
            className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors hover:bg-white/[0.06] ${isExcluded ? "bg-[#AA5881]/[0.08]" : ""}`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#AA5881" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
              <circle cx="12" cy="12" r="10" />
              <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
            </svg>
            <span className={`flex-1 text-left text-[#AA5881] ${isExcluded ? "font-medium" : "opacity-70"}`}>
              Exclude person
            </span>
            {isExcluded && (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#AA5881" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </details>
  )
}
