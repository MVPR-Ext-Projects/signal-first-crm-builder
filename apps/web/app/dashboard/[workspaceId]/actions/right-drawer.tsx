"use client"

/**
 * RightDrawer - shared right-edge slide-in shell. Backdrop dismiss,
 * Escape-key dismiss, fixed-width 640px max. Both the coverage drawer
 * and the new campaign-settings drawer mount inside this primitive.
 */

import { useEffect } from "react"
import type { ReactNode } from "react"

export function RightDrawer({
  open,
  onClose,
  ariaLabel,
  eyebrow,
  children,
}: {
  open:      boolean
  onClose:   () => void
  ariaLabel: string
  eyebrow:   string
  children:  ReactNode
}) {
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={ariaLabel}>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-[640px] flex-col bg-[#0B0B0E] shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/[0.08] px-6 py-4">
          <p className="text-[12px] font-bold uppercase tracking-[0.10em] text-zinc-500">{eyebrow}</p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-white motion-reduce:transition-none"
            aria-label="Close detail"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {children}
        </div>
      </aside>
    </div>
  )
}
