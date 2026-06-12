"use client"

/**
 * Inline manual-stage picker on each company row in the Companies page.
 *
 * Stage is set at the company level — the override rolls down to every
 * contact at that company on the SDR page (a "Discovery Call" booking
 * is an account-level fact). Clearing the override drops the company
 * back to the auto-derived stage from signal_score.
 *
 * The pill always shows the *effective* stage (manual override if set,
 * else auto-derived). The dropdown is rendered via a React portal into
 * document.body — same trick as ProspectTypePill — so it escapes the
 * parent <details className="overflow-hidden ..."> clip box that would
 * otherwise slice the menu when the card is unfurled.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useRouter } from "next/navigation"

const STAGES = [
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
type Stage = typeof STAGES[number]

const STAGE_INDEX = Object.fromEntries(STAGES.map((s, i) => [s, i])) as Record<Stage, number>

// Manual sales stages - anything from Discovery Call onward. Score-derived
// stages (Prospect / Signal Found / Engaged / High Signal) are off-limits
// for forward manual overrides so the score model isn't gamed.
const MANUAL_STAGES: Stage[] = [
  "Discovery Call",
  "Requested Information",
  "Sent Information",
  "Follow Up Call",
  "Diligence",
  "Contract Negotiation",
  "Customer Won",
]

/**
 * Which stages can the user manually move to from the current effective stage?
 *
 * - Forward: only manual sales stages (Discovery Call onward) - earlier
 *   stages are auto-derived from signal scores and shouldn't be manually gamed.
 * - Backward: any stage earlier than the current one - to de-escalate a company
 *   that e.g. had an exploratory call but isn't a fit right now.
 */
function selectableStages(effectiveStage: string): Stage[] {
  const currentIdx = STAGE_INDEX[effectiveStage as Stage] ?? -1
  return STAGES.filter((s, i) => {
    if (s === effectiveStage) return false
    if (MANUAL_STAGES.includes(s)) return true
    return i < currentIdx  // backward movement only
  })
}

const STAGE_COLOR: Record<Stage, { dot: string; text: string }> = {
  "Prospect":              { dot: "#9CA3AF", text: "#9CA3AF" },
  "Signal Found":          { dot: "#DD80A8", text: "#DD80A8" },
  "Engaged":               { dot: "#22C55E", text: "#22C55E" },
  "High Signal":           { dot: "#EA580C", text: "#EA580C" },
  "Discovery Call":        { dot: "#38BDF8", text: "#38BDF8" },
  "Requested Information": { dot: "#FBBF24", text: "#FBBF24" },
  "Follow Up Call":        { dot: "#FB923C", text: "#FB923C" },
  "Sent Information":      { dot: "#818CF8", text: "#818CF8" },
  "Diligence":             { dot: "#C084FC", text: "#C084FC" },
  "Contract Negotiation":  { dot: "#34D399", text: "#34D399" },
  "Customer Won":          { dot: "#2BA98B", text: "#2BA98B" },
}

const DROPDOWN_W = 208
const VIEWPORT_PAD = 8

export function CompanyStagePicker({
  workspaceId,
  companyName,
  effectiveStage,
  manualStage,
}: {
  workspaceId:    string
  companyName:    string
  /** Currently displayed stage — manual override if set, else auto-derived. */
  effectiveStage: string
  /** The manual override string (or null when stage is auto-derived). */
  manualStage:    string | null
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [mounted, setMounted] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef    = useRef<HTMLDivElement>(null)

  useEffect(() => { setMounted(true) }, [])

  const isManual = manualStage !== null
  const colour = (effectiveStage in STAGE_COLOR)
    ? STAGE_COLOR[effectiveStage as Stage]
    : { dot: "#9CA3AF", text: "#9CA3AF" }

  // Re-position the portal'd menu while open so it stays anchored to the
  // trigger as the user scrolls.
  useLayoutEffect(() => {
    if (!open) return
    function place() {
      const btn = triggerRef.current
      if (!btn) return
      const r = btn.getBoundingClientRect()
      let left = r.right - DROPDOWN_W
      if (left < VIEWPORT_PAD) left = VIEWPORT_PAD
      if (left + DROPDOWN_W > window.innerWidth - VIEWPORT_PAD) {
        left = window.innerWidth - DROPDOWN_W - VIEWPORT_PAD
      }
      // Default to opening below; flip above if it would clip the bottom.
      const menuH = menuRef.current?.offsetHeight ?? 240
      let top = r.bottom + 4
      if (top + menuH > window.innerHeight - VIEWPORT_PAD) {
        top = Math.max(VIEWPORT_PAD, r.top - menuH - 4)
      }
      setPos({ top, left })
    }
    place()
    window.addEventListener("scroll", place, true)
    window.addEventListener("resize", place)
    return () => {
      window.removeEventListener("scroll", place, true)
      window.removeEventListener("resize", place)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      const t = e.target as Node
      if (triggerRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onClick)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  async function setStage(next: string | null) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/companies/stage`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ companyName, stage: next }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Failed (${res.status})`)
        setBusy(false)
        return
      }
      setOpen(false)
      setBusy(false)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const menu = open && pos && mounted ? createPortal(
    <div
      ref={menuRef}
      role="menu"
      onClick={(e) => { e.stopPropagation(); e.preventDefault() }}
      style={{ position: "fixed", top: pos.top, left: pos.left, width: DROPDOWN_W }}
      className="z-[60] overflow-hidden rounded-xl border border-white/12 bg-[#0d1f1a] shadow-2xl"
    >
      <div className="border-b border-white/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">
        Set stage
      </div>
      <p className="border-b border-white/10 px-3 py-1.5 text-[10px] text-zinc-500">
        Advance to an outcome, or move back to keep in funnel.
      </p>
      {selectableStages(effectiveStage).map(stage => {
        const isCurrent = stage === effectiveStage
        const sc = STAGE_COLOR[stage as Stage]
        return (
          <button
            key={stage}
            type="button"
            role="menuitem"
            onClick={() => setStage(stage)}
            disabled={busy}
            className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12px] transition-colors hover:bg-white/[0.06] disabled:opacity-50 motion-reduce:transition-none ${
              isCurrent ? "font-semibold text-white" : "text-zinc-300"
            }`}
          >
            <span className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: sc.dot }} aria-hidden />
              {stage}
            </span>
            {isCurrent && (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </button>
        )
      })}
      {isManual && (
        <button
          type="button"
          role="menuitem"
          onClick={() => setStage(null)}
          disabled={busy}
          className="flex w-full items-center border-t border-white/10 px-3 py-2 text-left text-[12px] text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white disabled:opacity-50 motion-reduce:transition-none"
        >
          Clear override (auto-derive)
        </button>
      )}
      {error && (
        <p className="border-t border-white/10 bg-rose-500/10 px-3 py-1.5 text-[10px] text-rose-300">
          {error}
        </p>
      )}
    </div>,
    document.body,
  ) : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen(o => !o) }}
        disabled={busy}
        title={isManual ? "Manual stage override active — click to change or clear" : "Click to override the auto-derived stage"}
        aria-label={`Stage: ${effectiveStage}${isManual ? " (manually set)" : ""}. Click to change.`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
        style={{ color: colour.text }}
      >
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: colour.dot }} aria-hidden />
        {isManual && <span className="text-[9px]" aria-hidden>📌</span>}
        {effectiveStage}
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {menu}
    </>
  )
}
