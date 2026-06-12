"use client"

/**
 * Per-row Prospect Type pill on a company card. Shows the company's current
 * tags as a stack of small pills; clicking opens a multi-select dropdown that
 * saves immediately. Untagged companies show a "+ Tag" affordance instead.
 *
 * The available tag values come from WorkspaceConfig.prospectTypes (resolved
 * with defaults on the server). Tag colours are stable per-value via a small
 * hash so the same tag always looks the same across the page.
 *
 * The dropdown is rendered via a React portal into document.body so it
 * escapes the parent <details className="overflow-hidden ..."> clip box that
 * would otherwise slice the menu when the card is unfurled or sits near the
 * page bottom. Position is computed from the trigger's bounding rect.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useRouter } from "next/navigation"

const TAG_COLORS: { dot: string; text: string; bg: string; border: string }[] = [
  { dot: "#10B981", text: "#A7F3D0", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.30)" },
  { dot: "#3B82F6", text: "#BFDBFE", bg: "rgba(59,130,246,0.10)", border: "rgba(59,130,246,0.30)" },
  { dot: "#F59E0B", text: "#FDE68A", bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.30)" },
  { dot: "#EF4444", text: "#FECACA", bg: "rgba(239,68,68,0.10)",  border: "rgba(239,68,68,0.30)"  },
  { dot: "#8B5CF6", text: "#DDD6FE", bg: "rgba(139,92,246,0.10)", border: "rgba(139,92,246,0.30)" },
  { dot: "#EC4899", text: "#FBCFE8", bg: "rgba(236,72,153,0.10)", border: "rgba(236,72,153,0.30)" },
  { dot: "#06B6D4", text: "#A5F3FC", bg: "rgba(6,182,212,0.10)",  border: "rgba(6,182,212,0.30)"  },
]

function colorFor(value: string) {
  let h = 0
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0
  return TAG_COLORS[h % TAG_COLORS.length]
}

const DROPDOWN_W = 192   // matches w-48 on the menu
const VIEWPORT_PAD = 8   // breathing room from screen edges

export function ProspectTypePill({
  workspaceId,
  companyName,
  initial,
  available,
}: {
  workspaceId: string
  companyName: string
  initial: string[]
  available: string[]
}) {
  const router = useRouter()
  const [tags, setTags] = useState<string[]>(initial)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [mounted, setMounted] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef    = useRef<HTMLDivElement>(null)

  useEffect(() => { setMounted(true) }, [])

  // Compute viewport position for the portal'd menu. Re-computes on open + on
  // scroll/resize so the menu stays anchored to the trigger as the user
  // scrolls the page.
  useLayoutEffect(() => {
    if (!open) return
    function place() {
      const btn = triggerRef.current
      if (!btn) return
      const r = btn.getBoundingClientRect()
      // Align to right edge of trigger; clamp to viewport.
      let left = r.right - DROPDOWN_W
      if (left < VIEWPORT_PAD) left = VIEWPORT_PAD
      if (left + DROPDOWN_W > window.innerWidth - VIEWPORT_PAD) {
        left = window.innerWidth - DROPDOWN_W - VIEWPORT_PAD
      }
      // Default to opening below; flip above if it would clip the bottom.
      const menuH = menuRef.current?.offsetHeight ?? 220
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
  }, [open, available.length, tags.length])

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

  async function toggle(value: string) {
    const next = tags.includes(value) ? tags.filter(t => t !== value) : [...tags, value]
    setTags(next)
    setBusy(true)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/companies/tags`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ companyName, prospectTypes: next }),
      })
      if (!res.ok) {
        // Revert on failure so the UI matches server state.
        setTags(tags)
      } else {
        router.refresh()
      }
    } catch {
      setTags(tags)
    } finally {
      setBusy(false)
    }
  }

  const menu = open && pos && mounted ? createPortal(
    <div
      ref={menuRef}
      role="listbox"
      aria-multiselectable="true"
      onClick={(e) => e.stopPropagation()}
      style={{ position: "fixed", top: pos.top, left: pos.left, width: DROPDOWN_W }}
      className="z-[60] rounded-xl border border-white/12 bg-[#0d1f1a] p-1 shadow-2xl"
    >
      {available.length === 0 ? (
        <p className="px-3 py-2 text-[11px] text-zinc-500">No tag values configured.</p>
      ) : (
        available.map(value => {
          const c = colorFor(value)
          const checked = tags.includes(value)
          return (
            <button
              key={value}
              type="button"
              role="option"
              aria-selected={checked}
              onClick={() => toggle(value)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px] text-zinc-200 hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#2BA98B]/40"
            >
              <span
                className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border"
                style={{ borderColor: checked ? c.dot : "rgba(255,255,255,0.16)", backgroundColor: checked ? c.dot : "transparent" }}
                aria-hidden
              >
                {checked && (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#0d1f1a" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </span>
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: c.dot }} aria-hidden />
              <span className="flex-1 text-left" style={{ color: checked ? c.text : undefined }}>{value}</span>
            </button>
          )
        })
      )}
    </div>,
    document.body,
  ) : null

  return (
    <span onClick={(e) => e.stopPropagation()}>
      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => { e.preventDefault(); setOpen(o => !o) }}
        disabled={busy}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-full border border-white/14 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:border-[#2BA98B]/40 hover:bg-[#2BA98B]/[0.10] hover:text-white disabled:opacity-50 motion-reduce:transition-none"
      >
        {tags.length === 0 ? (
          <>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Tag
          </>
        ) : (
          <>
            {tags.slice(0, 2).map(t => {
              const c = colorFor(t)
              return (
                <span key={t} className="inline-flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: c.dot }} aria-hidden />
                  <span style={{ color: c.text }}>{t}</span>
                </span>
              )
            })}
            {tags.length > 2 && (
              <span className="text-zinc-500">+{tags.length - 2}</span>
            )}
          </>
        )}
      </button>
      {menu}
    </span>
  )
}

export const prospectTypeColor = colorFor
