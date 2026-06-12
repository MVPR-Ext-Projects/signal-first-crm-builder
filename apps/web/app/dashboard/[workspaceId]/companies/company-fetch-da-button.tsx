"use client"

import { useState } from "react"
import { useToast } from "../toast"

/**
 * Domain Authority chip in the company-card header.
 *
 * Shape matches the row's StatusIcon style (h-6 w-6 rounded square + a
 * h-3.5 tick/cross badge). When no DA is on file yet, the chip reads "DA"
 * with a pink cross badge and clicking it kicks off a Moz fetch. Once a
 * score lands, the chip displays the number with a teal tick badge.
 * Clicking again re-fetches.
 */
export function CompanyDaIcon({
  workspaceId,
  websiteDomain,
  initialDA,
}: {
  workspaceId:   string
  websiteDomain: string | null
  initialDA:     number | null
}) {
  const toast = useToast()
  const [loading, setLoading] = useState(false)
  const [da, setDa]           = useState<number | null>(initialDA)

  const hasValue = da !== null
  const disabled = !websiteDomain

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation()
    e.preventDefault()
    if (disabled || loading) return
    setLoading(true)
    try {
      const res = await fetch(`/api/enrich/moz/${workspaceId}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ domain: websiteDomain }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error("Moz fetch failed", data.error ?? `HTTP ${res.status}`)
        return
      }
      const next = typeof data.domainAuthority === "number" ? data.domainAuthority : null
      setDa(next)
      if (next !== null) {
        toast.success("Domain Authority fetched", `${websiteDomain}: DA ${next}`)
      } else {
        toast.info("No DA returned", `Moz didn't return a score for ${websiteDomain}.`)
      }
    } catch (err) {
      toast.error("Moz fetch failed", err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const tooltip = disabled
    ? "Set website domain via company edit to fetch DA"
    : loading
      ? `Fetching Moz DA for ${websiteDomain}...`
      : hasValue
        ? `Domain Authority: ${da} - click to re-fetch ${websiteDomain}`
        : `Click to fetch Domain Authority for ${websiteDomain}`

  return (
    <span className="relative inline-flex shrink-0" title={tooltip}>
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled || loading}
        aria-label={hasValue ? `Domain Authority ${da}, click to re-fetch` : "Fetch Domain Authority"}
        className={`inline-flex h-6 w-6 items-center justify-center rounded-[6px] bg-white/[0.06] font-bold text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60 motion-reduce:transition-none disabled:cursor-not-allowed ${
          disabled
            ? "text-zinc-600 opacity-50"
            : hasValue
              ? "text-zinc-200 hover:bg-white/[0.12]"
              : "text-zinc-400 hover:bg-white/[0.12]"
        }`}
      >
        {loading ? (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="animate-spin" aria-hidden>
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        ) : hasValue ? (
          <span className="tabular-nums">{da}</span>
        ) : (
          "DA"
        )}
      </button>
      {/* Cross badge only when there's no DA yet - the number itself is
          enough confirmation when populated; an extra tick would be
          redundant on top of the visible value. */}
      {!hasValue && (
        <span
          className="pointer-events-none absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full"
          style={{ backgroundColor: "#AA5882", border: "1px solid #000" }}
          aria-hidden
        >
          <svg width="7" height="7" viewBox="0 0 10 10" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round">
            <line x1="2" y1="2" x2="8" y2="8" />
            <line x1="8" y1="2" x2="2" y2="8" />
          </svg>
        </span>
      )}
    </span>
  )
}
