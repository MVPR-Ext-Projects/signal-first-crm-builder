"use client"

/**
 * Free-text search input for the SDR + Companies pages. Debounced URL
 * push, syncs back from `?q=`. Submits via Enter as well so users who
 * paste a query feel the change immediately.
 */

import { useEffect, useRef, useState } from "react"
import { useRouter, useSearchParams, usePathname } from "next/navigation"

const DEBOUNCE_MS = 250

export function SearchBar({ placeholder }: { placeholder: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const initial = params.get("q") ?? ""
  const [value, setValue] = useState(initial)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // External URL changes (e.g. user clicks a filter pill that drops ?q,
  // or hits Back) should reset the input.
  useEffect(() => {
    setValue(params.get("q") ?? "")
  }, [params])

  function pushQuery(next: string) {
    const trimmed = next.trim()
    const search = new URLSearchParams(params.toString())
    if (trimmed) search.set("q", trimmed)
    else search.delete("q")
    // Search changes the result set, so reset pagination.
    search.delete("p")
    const qs = search.toString()
    router.push(`${pathname}${qs ? "?" + qs : ""}`)
  }

  function onChange(next: string) {
    setValue(next)
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => pushQuery(next), DEBOUNCE_MS)
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    pushQuery(value)
  }

  function clear() {
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    setValue("")
    pushQuery("")
  }

  return (
    <form onSubmit={onSubmit} className="relative inline-flex items-center">
      <svg
        width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        aria-hidden
        className="pointer-events-none absolute left-3 text-zinc-500"
      >
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-64 rounded-xl border border-white/[0.10] bg-white/[0.04] py-1.5 pl-8 pr-8 text-[13px] text-zinc-100 placeholder:text-zinc-500 focus:border-[#2BA98B]/40 focus:outline-none"
      />
      {value && (
        <button
          type="button"
          onClick={clear}
          aria-label="Clear search"
          className="absolute right-2 inline-flex h-5 w-5 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white motion-reduce:transition-none"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </form>
  )
}
