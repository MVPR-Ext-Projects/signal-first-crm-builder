"use client"

/**
 * Shared filter-pill trigger. Matches the spec on Paper artboard
 * 02 - Components (node 7BX-0):
 *
 *   28-32px tall · radius 99 (fully rounded)
 *   inactive: bg #FFFFFF0A · border #FFFFFF1F · label #A1A1AA · chevron #71717A
 *   active:   bg #2BA98B14 · border #2BA98B4D · label #FFFFFF · chevron #2BA98B
 *   gap 8 · padding 6/14 · font Inter 12/16/500 · chevron 10x10 stroke 2.5
 *
 * The chevron + optional "Clear (x)" button are rendered by the pill;
 * children fill the label slot - either plain text, a Label|Value pair
 * (caller renders both with a vertical divider), or a count badge.
 */

import type { ReactNode, MouseEvent } from "react"

export function FilterPill({
  isActive,
  onClear,
  onClick,
  children,
  className = "",
  ariaLabel,
  ariaExpanded,
  ariaHasPopup,
}: {
  isActive:      boolean
  onClick?:      (e: MouseEvent<HTMLButtonElement>) => void
  /** When set, renders a small (x) inside the pill that clears the filter. */
  onClear?:      () => void
  children:      ReactNode
  className?:    string
  ariaLabel?:    string
  ariaExpanded?: boolean
  ariaHasPopup?: "listbox" | "menu" | "dialog"
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-expanded={ariaExpanded}
      aria-haspopup={ariaHasPopup}
      className={`group inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[12px] font-medium leading-[16px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#2BA98B]/40 motion-reduce:transition-none ${
        isActive
          ? "border-[#2BA98B]/30 bg-[#2BA98B]/[0.08] text-white"
          : "border-white/[0.12] bg-white/[0.04] text-zinc-400 hover:bg-white/[0.06]"
      } ${className}`}
    >
      {children}
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className={`shrink-0 ${isActive ? "stroke-[#2BA98B]" : "stroke-zinc-500"}`}
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
      {isActive && onClear && (
        <span
          role="button"
          tabIndex={0}
          aria-label="Clear filter"
          onClick={e => { e.stopPropagation(); onClear() }}
          onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onClear() } }}
          className="-mr-1.5 ml-0.5 inline-flex h-4 w-4 cursor-pointer items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white motion-reduce:transition-none"
        >
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </span>
      )}
    </button>
  )
}

/**
 * Count badge for filters that surface multi-select counts in the trigger.
 * 18px tall · radius 99 · bg #2BA98B · text #00382E · 11px/700/100%.
 * Used as a child inside <FilterPill>:
 *
 *   <FilterPill isActive>
 *     <span>Headcount</span>
 *     <FilterCountBadge count={3} />
 *   </FilterPill>
 */
export function FilterCountBadge({ count }: { count: number }) {
  return (
    <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#2BA98B] px-1.5 text-[11px] font-bold leading-none text-[#00382E]">
      {count}
    </span>
  )
}

/**
 * Vertical divider used in the "Label | Value" trigger pattern, e.g.
 *
 *   <FilterPill isActive>
 *     <span className="text-zinc-400">SDR</span>
 *     <FilterPillDivider />
 *     <span>Tom Lawrence</span>
 *   </FilterPill>
 */
export function FilterPillDivider() {
  return <span className="h-3 w-px shrink-0 bg-white/[0.12]" aria-hidden />
}
