"use client"

/**
 * Single-select filter dropdown. Pill trigger + custom popover panel that
 * matches the Paper spec on artboard 02 - Components (variants A and D):
 *
 *   Panel: bg #0F1815 · border #FFFFFF14 · radius 12 · shadow 0 12 32 rgba(0,0,0,0.4)
 *   Header: 10/12/700 uppercase #2BA98B with 0.14em tracking, bottom border #FFFFFF0A
 *   Row: padding 6/10, radius 8, gap 10
 *   Row selected: bg #2BA98B14, label #FFFFFF, check icon #2BA98B
 *   Row hover: bg #FFFFFF0A
 *   Row meta (right): font mono 10/12 #52525B (default) / #2BA98B (selected)
 *
 * Click-outside + Esc close. Keyboard navigation is basic (focus moves
 * with Tab); proper arrow-key roving is a future enhancement.
 */

import { useEffect, useRef, useState, type ReactNode } from "react"
import { FilterPill, FilterPillDivider } from "./filter-pill"

export interface FilterItem {
  /** Empty string represents the "All / None" pinned-first option. */
  value:    string
  label:    string
  /** Optional right-aligned meta (count, etc). */
  meta?:    string | number
  /** Optional leading slot (avatar bubble, status dot, icon). */
  leading?: ReactNode
}

export function FilterDropdown({
  pillLabel,
  header,
  items,
  activeValue,
  onChange,
  panelWidth = 240,
  emptyLabel,
  showLabelOnSelect = false,
  persistent = false,
}: {
  /** Text shown on the pill when nothing is selected. Also used as the
   *  left half of the "Label | Value" trigger when showLabelOnSelect or
   *  persistent is true. */
  pillLabel:   string
  /** Section header inside the panel. */
  header:      string
  items:       FilterItem[]
  activeValue: string | null
  onChange:    (value: string | null) => void
  panelWidth?: number
  /** Override label when nothing is selected (defaults to pillLabel). */
  emptyLabel?: string
  /**
   * When true, render the active state as "Label | Value" (the SDR | Tom
   * Lawrence Paper pattern). When false, just render the active value's
   * label by itself.
   */
  showLabelOnSelect?: boolean
  /**
   * When true, the pill ALWAYS renders in the active visual style and
   * ALWAYS uses the two-tone "Label | Value" layout - even when no value
   * is selected. The right-side label falls back to `emptyLabel` so the
   * filter reads as a stable affordance (e.g. "SDR | Select owner")
   * instead of changing shape on first selection. The (x) clear button
   * still only appears when an actual value is selected.
   */
  persistent?: boolean
}) {
  const [open, setOpen] = useState(false)
  const containerRef    = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onMouse(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false)
    }
    window.addEventListener("mousedown", onMouse)
    window.addEventListener("keydown",   onKey)
    return () => {
      window.removeEventListener("mousedown", onMouse)
      window.removeEventListener("keydown",   onKey)
    }
  }, [open])

  const isActive    = !!activeValue
  const activeItem  = isActive ? items.find(i => i.value === activeValue) : undefined
  const displayLabel = activeItem?.label ?? emptyLabel ?? pillLabel
  const twoTone     = persistent || (isActive && showLabelOnSelect)

  function pick(value: string) {
    onChange(value === "" ? null : value)
    setOpen(false)
  }

  return (
    <div ref={containerRef} className="relative inline-block">
      <FilterPill
        isActive={isActive || persistent}
        onClick={() => setOpen(o => !o)}
        onClear={isActive ? () => { onChange(null); setOpen(false) } : undefined}
        ariaExpanded={open}
        ariaHasPopup="listbox"
      >
        {twoTone ? (
          <>
            <span className="text-zinc-400">{pillLabel}</span>
            <FilterPillDivider />
            <span>{displayLabel}</span>
          </>
        ) : (
          <span>{displayLabel}</span>
        )}
      </FilterPill>

      {open && (
        <div
          role="listbox"
          aria-label={header}
          className="absolute left-0 top-full z-50 mt-1.5 overflow-hidden rounded-xl border border-white/[0.08] bg-[#0F1815] shadow-[0_12px_32px_rgba(0,0,0,0.45)]"
          style={{ width: panelWidth }}
        >
          <div className="border-b border-white/[0.04] px-3.5 py-2.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[#2BA98B]">
            {header}
          </div>
          <ul className="flex max-h-[420px] flex-col overflow-y-auto p-1">
            {items.map((item, idx) => {
              const selected = item.value === (activeValue ?? "")
              return (
                <li key={item.value || `__empty-${idx}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => pick(item.value)}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] leading-[16px] transition-colors motion-reduce:transition-none ${
                      selected
                        ? "bg-[#2BA98B]/[0.08] font-medium text-white"
                        : "text-zinc-200 hover:bg-white/[0.04]"
                    }`}
                  >
                    {item.leading && (
                      <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center">
                        {item.leading}
                      </span>
                    )}
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.meta != null && item.meta !== "" && (
                      <span className={`shrink-0 font-mono text-[10px] leading-[12px] ${selected ? "text-zinc-300" : "text-zinc-500"}`}>
                        {item.meta}
                      </span>
                    )}
                    {selected && (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#2BA98B" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
