"use client"

/**
 * Companies page toolbar — client component.
 *
 * Reading filter state from useSearchParams() on every interaction (not from
 * render-time props) means clicking size → type → sort in any order always
 * builds from the live URL, with no stale-closure race conditions.
 *
 * router.replace() with scroll:false gives soft navigation — the RSC data
 * layer re-fetches but the page doesn't hard-reload and client state (e.g.
 * the Size dropdown open/closed) is preserved across filter clicks.
 */

import { useEffect, useRef, useTransition } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import type { SortMode } from "@/lib/db/contact-store"
import { SIZE_BUCKETS } from "@/lib/db/contact-store"

export type Tab = "default" | "all" | string  // reserved

// ─── URL helpers ─────────────────────────────────────────────────────────────

function buildUrl(
  workspaceId: string,
  params: Record<string, string | string[] | undefined>,
): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) {
      for (const item of v) if (item) sp.append(k, item)
    } else if (v !== "") {
      sp.set(k, v)
    }
  }
  const qs = sp.toString()
  return qs
    ? `/dashboard/${workspaceId}/companies?${qs}`
    : `/dashboard/${workspaceId}/companies`
}

/** Read all relevant filter params from the live URL. */
function useFilterState() {
  const sp = useSearchParams()

  const selected: string[] = sp.getAll("type")
  const untaggedRaw = sp.get("untagged")
  const untagged = untaggedRaw === "0" ? false : untaggedRaw === "1" ? true : undefined
  const stage     = sp.get("stage") ?? undefined
  const sortRaw   = sp.get("sort") ?? "recent-desc"
  const sortMode  = sortRaw as SortMode
  const sizes     = sp.getAll("size")
  const team      = sp.get("team") ?? undefined
  const q         = sp.get("q") ?? undefined
  const p         = sp.get("p") ?? undefined

  return { selected, untagged, stage, sortMode, sizes, team, q, p }
}

const COMPANY_STAGES = [
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
] as const

const COMPANY_STAGE_DOT: Record<string, string> = {
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

// ─── Chip colours ─────────────────────────────────────────────────────────────

const CHIP_COLORS: { dot: string; text: string }[] = [
  { dot: "#10B981", text: "#A7F3D0" },
  { dot: "#3B82F6", text: "#BFDBFE" },
  { dot: "#F59E0B", text: "#FDE68A" },
  { dot: "#EF4444", text: "#FECACA" },
  { dot: "#8B5CF6", text: "#DDD6FE" },
  { dot: "#EC4899", text: "#FBCFE8" },
  { dot: "#06B6D4", text: "#A5F3FC" },
]

function chipColor(value: string) {
  let h = 0
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0
  return CHIP_COLORS[h % CHIP_COLORS.length]
}

// ─── CompaniesToolbar ─────────────────────────────────────────────────────────

interface ToolbarProps {
  workspaceId:     string
  available:       string[]
  defaultExcluded: string[]
}

export function CompaniesToolbar({ workspaceId, available, defaultExcluded }: ToolbarProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const { selected, untagged, stage, sortMode, sizes, team, q } = useFilterState()

  const stageRef     = useRef<HTMLDetailsElement>(null)
  const typeRef      = useRef<HTMLDetailsElement>(null)
  const headcountRef = useRef<HTMLDetailsElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (stageRef.current && !stageRef.current.contains(e.target as Node)) {
        stageRef.current.open = false
      }
      if (typeRef.current && !typeRef.current.contains(e.target as Node)) {
        typeRef.current.open = false
      }
      if (headcountRef.current && !headcountRef.current.contains(e.target as Node)) {
        headcountRef.current.open = false
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [])

  // Shared params that must survive every navigation.
  function base() {
    return {
      stage,
      sort:     sortMode === "recent-desc" ? undefined : sortMode,
      size:     sizes.length > 0 ? sizes : undefined,
      type:     selected.length > 0 ? selected : undefined,
      untagged: undefined,
      team,
      q,
    }
  }

  function navigate(overrides: Record<string, string | string[] | undefined>) {
    startTransition(() => {
      router.replace(buildUrl(workspaceId, { ...base(), ...overrides }), { scroll: false })
    })
  }

  function toggleSize(label: string) {
    const next = sizes.includes(label)
      ? sizes.filter(v => v !== label)
      : [...sizes, label]
    navigate({ size: next.length > 0 ? next : undefined })
  }

  function clearSizes() {
    navigate({ size: undefined })
  }

  const userHasFiltered = selected.length > 0

  // Trigger label: what the pill shows as the selected value
  const triggerLabel = !userHasFiltered
    ? "All"
    : selected.length === 1
      ? selected[0]
      : `${selected[0]} +${selected.length - 1}`

  const isAllActive = !userHasFiltered

  const TAG_ORDER = [
    "Brand - Software",
    "Brand - Services",
    "PR Agency",
    "Partner",
    "Investor",
  ]

  const primaryTypes  = available
    .filter(v => !defaultExcluded.includes(v))
    .sort((a, b) => {
      const ai = TAG_ORDER.indexOf(a)
      const bi = TAG_ORDER.indexOf(b)
      if (ai === -1 && bi === -1) return a.localeCompare(b)
      if (ai === -1) return 1
      if (bi === -1) return -1
      return ai - bi
    })
  const excludedTypes = available.filter(v =>  defaultExcluded.includes(v))

  function selectType(value: string) {
    navigate({ type: [value], untagged: undefined })
  }

  function selectAllTypes() {
    navigate({ type: undefined, untagged: undefined, size: undefined })
  }

  function navigateStage(newStage: string | undefined) {
    startTransition(() => {
      router.replace(buildUrl(workspaceId, { ...base(), stage: newStage }), { scroll: false })
    })
  }

  const stageTriggerLabel = stage ?? "All"

  return (
    <div className={`flex flex-wrap items-center gap-2 transition-opacity duration-150 ${isPending ? "pointer-events-none opacity-50" : ""}`}>
      {/* Stage filter dropdown */}
      <details ref={stageRef} className="relative">
        <summary className="inline-flex cursor-pointer list-none select-none items-center gap-2 rounded-full border border-[#2BA98B]/30 bg-[#2BA98B]/[0.08] px-3.5 py-1.5 text-[11px] font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#2BA98B]/40">
          <span className="text-zinc-500">Stage</span>
          <span className="h-3 w-px shrink-0 bg-white/[0.12]" aria-hidden />
          <span className="text-white">{stageTriggerLabel}</span>
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
              onClick={() => navigateStage(undefined)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors hover:bg-white/[0.06] ${!stage ? "bg-[#2BA98B]/[0.08]" : ""}`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={!stage ? "#2BA98B" : "#52525B"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
              <span className={`flex-1 text-left ${!stage ? "font-medium text-white" : "text-zinc-300"}`}>All stages</span>
              {!stage && (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#2BA98B" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </button>
            <div className="my-1 mx-1.5 h-px bg-white/[0.06]" aria-hidden />
            {COMPANY_STAGES.map(s => {
              const isOn = stage === s
              const dot = COMPANY_STAGE_DOT[s]
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => navigateStage(s)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors hover:bg-white/[0.06] ${isOn ? "bg-[#2BA98B]/[0.08]" : ""}`}
                >
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dot }} aria-hidden />
                  <span className={`flex-1 text-left ${isOn ? "font-medium text-white" : "text-zinc-300"}`}>{s}</span>
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

      {/* Custom Tag filter dropdown */}
      <details ref={typeRef} className="relative">
        <summary className="inline-flex cursor-pointer list-none select-none items-center gap-2 rounded-full border border-[#2BA98B]/30 bg-[#2BA98B]/[0.08] px-3.5 py-1.5 text-[11px] font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#2BA98B]/40">
          <span className="text-zinc-500">Tag</span>
          <span className="h-3 w-px shrink-0 bg-white/[0.12]" aria-hidden />
          <span className="text-white">{triggerLabel}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#2BA98B" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </summary>
        <div className="absolute left-0 top-full z-20 mt-2 w-[240px] overflow-hidden rounded-xl border border-white/[0.08] bg-[#0F1815] shadow-[0_12px_32px_rgba(0,0,0,0.4)]">
          <div className="border-b border-white/[0.04] px-3.5 py-2.5">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#2BA98B]">Filter by Tag</span>
          </div>
          <div className="p-1">
            {/* All Types */}
            <button
              type="button"
              onClick={selectAllTypes}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors hover:bg-white/[0.06] ${isAllActive ? "bg-[#2BA98B]/[0.08]" : ""}`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={isAllActive ? "#2BA98B" : "#52525B"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
              <span className={`flex-1 text-left ${isAllActive ? "font-medium text-white" : "text-zinc-300"}`}>All Types</span>
              {isAllActive && (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#2BA98B" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </button>

            <div className="my-1 mx-1.5 h-px bg-white/[0.06]" aria-hidden />

            {/* Primary types */}
            {primaryTypes.map(value => {
              const c = chipColor(value)
              const isOn = selected.includes(value)
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => selectType(value)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors hover:bg-white/[0.06] ${isOn ? "bg-[#2BA98B]/[0.08]" : ""}`}
                >
                  <span
                    className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
                    style={{ backgroundColor: `${c.dot}1A`, color: c.dot }}
                    aria-hidden
                  >
                    {value[0].toUpperCase()}
                  </span>
                  <span className={`flex-1 text-left ${isOn ? "font-medium text-white" : "text-zinc-300"}`}>{value}</span>
                  {isOn && (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#2BA98B" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              )
            })}

            {/* Excluded types */}
            {excludedTypes.length > 0 && (
              <>
                <div className="mx-1.5 my-1 flex items-center gap-2">
                  <div className="h-px flex-1 bg-white/[0.06]" aria-hidden />
                  <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-zinc-600">Excluded</span>
                  <div className="h-px flex-1 bg-white/[0.06]" aria-hidden />
                </div>
                {excludedTypes.map(value => {
                  const c = chipColor(value)
                  const isOn = selected.includes(value)
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => selectType(value)}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors hover:bg-white/[0.06] ${isOn ? "bg-[#2BA98B]/[0.08]" : ""}`}
                    >
                      <span
                        className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[10px] font-bold opacity-50"
                        style={{ backgroundColor: `${c.dot}1A`, color: c.dot }}
                        aria-hidden
                      >
                        {value[0].toUpperCase()}
                      </span>
                      <span className={`flex-1 text-left ${isOn ? "font-medium text-white" : "text-zinc-500"}`}>{value}</span>
                      {isOn && (
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#2BA98B" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </button>
                  )
                })}
              </>
            )}
          </div>
        </div>
      </details>

      {/* FTE filter dropdown */}
      <details ref={headcountRef} className="relative">
        <summary className="inline-flex cursor-pointer list-none select-none items-center gap-2 rounded-full border border-[#2BA98B]/30 bg-[#2BA98B]/[0.08] px-3.5 py-1.5 text-[11px] font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#2BA98B]/40">
          <span className="text-zinc-500">FTE</span>
          <span className="h-3 w-px shrink-0 bg-white/[0.12]" aria-hidden />
          <span className="text-white">
            {sizes.length === 0 ? "All" : sizes.length === 1 ? sizes[0] : `${sizes.length} selected`}
          </span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#2BA98B" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </summary>
        <div className="absolute left-0 top-full z-20 mt-2 w-[260px] overflow-hidden rounded-xl border border-white/[0.08] bg-[#0F1815] shadow-[0_12px_32px_rgba(0,0,0,0.4)]">
          <div className="flex items-center justify-between border-b border-white/[0.04] px-3.5 py-2.5">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#2BA98B]">Company FTE</span>
            {sizes.length > 0 && (
              <span className="text-[10px] text-zinc-500">{sizes.length} of {SIZE_BUCKETS.length}</span>
            )}
          </div>
          <div className="p-1">
            {SIZE_BUCKETS.map(({ label }) => {
              const isOn = sizes.includes(label)
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => toggleSize(label)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] transition-colors hover:bg-white/[0.06]"
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border-[1.5px] transition-colors ${
                      isOn ? "border-[#2BA98B] bg-[#2BA98B]" : "border-zinc-600"
                    }`}
                    aria-hidden
                  >
                    {isOn && (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#00382E" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </span>
                  <span className={`flex-1 text-left ${isOn ? "font-medium text-white" : "text-zinc-300"}`}>{label}</span>
                </button>
              )
            })}
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.04] px-3.5 py-2">
            <button
              type="button"
              onClick={clearSizes}
              className={`text-[12px] transition-colors hover:text-zinc-200 motion-reduce:transition-none ${sizes.length > 0 ? "text-zinc-500" : "cursor-default text-zinc-700"}`}
              disabled={sizes.length === 0}
            >
              Clear all
            </button>
          </div>
        </div>
      </details>
    </div>
  )
}

// ─── CompaniesSortToggle ──────────────────────────────────────────────────────

export function CompaniesSortToggle({ workspaceId }: { workspaceId: string }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const { selected, untagged, stage, sortMode, sizes, team, q } = useFilterState()

  function base() {
    return {
      stage,
      type:     selected.length > 0 ? selected : undefined,
      untagged: untagged !== undefined ? (untagged ? "1" : "0") : undefined,
      size:     sizes.length > 0 ? sizes : undefined,
      team,
      q,
    }
  }

  function navigate(sort: SortMode) {
    startTransition(() => {
      router.replace(
        buildUrl(workspaceId, { ...base(), sort: sort === "recent-desc" ? undefined : sort }),
        { scroll: false },
      )
    })
  }

  const recentActive = sortMode === "recent-desc" || sortMode === "recent-asc"
                    || sortMode === "score-then-recent" || sortMode === "recent-then-score"
  const scoreActive  = sortMode === "score-desc"  || sortMode === "score-asc"
                    || sortMode === "score-then-recent" || sortMode === "recent-then-score"
  const bothActive   = recentActive && scoreActive

  function nextRecentMode(): SortMode {
    if (bothActive) return sortMode === "score-then-recent" ? "recent-then-score" : "score-then-recent"
    if (recentActive) return sortMode === "recent-desc" ? "recent-asc" : "recent-desc"
    return "score-then-recent"
  }

  function nextScoreMode(): SortMode {
    if (bothActive) return sortMode === "recent-then-score" ? "score-then-recent" : "recent-then-score"
    if (scoreActive) return sortMode === "score-desc" ? "score-asc" : "score-desc"
    return "recent-then-score"
  }

  const recentArrow = (sortMode === "recent-asc" || sortMode === "recent-then-score") ? "↑" : "↓"
  const scoreArrow  = (sortMode === "score-asc"  || sortMode === "score-then-recent") ? "↑" : "↓"

  return (
    <div className={`inline-flex items-center gap-1 rounded-xl bg-white/[0.04] p-1 text-[12px] transition-opacity duration-150 ${isPending ? "pointer-events-none opacity-50" : ""}`}>
      <button
        type="button"
        aria-pressed={recentActive}
        onClick={() => navigate(nextRecentMode())}
        title={bothActive ? "Both active — click to switch primary sort" : recentActive ? "Toggle direction" : "Add Recent sort"}
        className={`rounded-lg px-3 py-1.5 transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60 ${
          recentActive ? "bg-white/[0.10] font-semibold text-white" : "text-zinc-400 hover:text-zinc-200"
        }`}
      >
        Recent {recentArrow}
      </button>
      <button
        type="button"
        aria-pressed={scoreActive}
        onClick={() => navigate(nextScoreMode())}
        title={bothActive ? "Both active — click to switch primary sort" : scoreActive ? "Toggle direction" : "Add Score sort"}
        className={`rounded-lg px-3 py-1.5 transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60 ${
          scoreActive ? "bg-white/[0.10] font-semibold text-white" : "text-zinc-400 hover:text-zinc-200"
        }`}
      >
        Score {scoreArrow}
      </button>
    </div>
  )
}
