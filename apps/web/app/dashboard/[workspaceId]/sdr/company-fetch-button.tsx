"use client"

/**
 * Per-row "Fetch employees" trigger on a company card.
 *
 * Two states:
 *  • No fetch yet → "Fetch employees" button. Click runs Apify, caches the
 *    result, and opens the EmployeesDrawer for review.
 *  • Cached fetch exists → "Reveal N employees (X matches)" + a small Refetch
 *    link. Click reveals reads the cache and opens the drawer.
 *
 * Promotion to contacts happens inside the drawer (qualify-in flow), not on
 * fetch. Disabled when the company has no LinkedIn URL.
 */

import { useState } from "react"
import { useToast } from "../toast"
import { EmployeesDrawer } from "../companies/employees-drawer"

interface FetchResponse {
  rawCount:   number
  matchCount: number
}

interface Props {
  workspaceId:        string
  companyName:        string
  companyLinkedinUrl: string | null
  initialResult:      FetchResponse | null
  initialFetchedAt:   string | null
}

export function CompanyFetchButton({
  workspaceId,
  companyName,
  companyLinkedinUrl,
  initialResult,
  initialFetchedAt,
}: Props) {
  const toast = useToast()
  const [result,    setResult]    = useState<FetchResponse | null>(initialResult)
  const [fetchedAt, setFetchedAt] = useState<string | null>(initialFetchedAt)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  async function runFetch(openOnSuccess: boolean) {
    if (!companyLinkedinUrl) return
    setLoading(true)
    setError(null)
    setErrorCode(null)
    toast.info("Fetching employees", `Apify scrape running for ${companyName}…`)
    try {
      const res = await fetch(`/api/enrich/companies/${workspaceId}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ companyLinkedinUrl, companyName }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        const msg  = body.error ?? `HTTP ${res.status}`
        const code = typeof body.code === "string" ? body.code : null
        setError(msg)
        setErrorCode(code)
        if (code === "apify-out-of-credits") {
          toast.error("Out of Apify credits", "Top up your account to keep enriching.")
        } else {
          toast.error("Fetch employees failed", msg)
        }
        return
      }
      const data = (await res.json()) as { rawCount: number; matchCount: number }
      setResult({ rawCount: data.rawCount, matchCount: data.matchCount })
      setFetchedAt(new Date().toISOString())
      toast.success("Employees fetched", `${data.rawCount} returned · ${data.matchCount} matched persona. Review and add to contacts.`)
      if (openOnSuccess) setDrawerOpen(true)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      setErrorCode(null)
      toast.error("Fetch employees failed", msg)
    } finally {
      setLoading(false)
    }
  }

  if (!companyLinkedinUrl) return null

  return (
    <div className="flex flex-col items-end gap-1.5">
      <button
        onClick={() => runFetch(true)}
        disabled={loading}
        aria-label={
          result
            ? `Re-fetch employees for ${companyName} (${result.rawCount} found${result.matchCount > 0 ? `, ${result.matchCount} matched` : ""})`
            : `Fetch employees for ${companyName}`
        }
        title={
          result
            ? `Re-fetch employees · ${result.rawCount} found${result.matchCount > 0 ? ` · ${result.matchCount} persona match${result.matchCount === 1 ? "" : "es"}` : ""}`
            : "Fetch employees"
        }
        className="relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/[0.10] bg-white/[0.03] text-zinc-400 transition-colors hover:border-white/[0.20] hover:bg-white/[0.06] hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none"
      >
        {loading ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="animate-spin" aria-hidden>
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        ) : (
          <>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="9" cy="8" r="3" />
              <path d="M2.5 20c0-3 2.5-5 6.5-5s6.5 2 6.5 5" />
              <circle cx="18" cy="10" r="2.4" />
              <path d="M14.5 19c0.5-2 2-3.4 4-3.4s3 1.5 3 3" />
            </svg>
            <div className="pointer-events-none absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 border-[#0A0A0A] bg-white" aria-hidden>
              <svg width="7" height="7" viewBox="0 0 12 12" fill="none">
                <path d="M9 3L3 9" stroke="#0A0A0A" strokeWidth="2" strokeLinecap="round" />
                <path d="M3 6V9H6" stroke="#0A0A0A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          </>
        )}
      </button>

      {error && errorCode === "apify-out-of-credits" && (
        <div className="max-w-[24rem] rounded-lg border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-[11px] text-amber-200">
          <p className="font-semibold">Out of Apify credits</p>
          <p className="mt-0.5 text-amber-200/80">Top up your account to run more enrichments.</p>
          <a
            href="https://console.apify.com/billing/subscription"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-block font-semibold text-amber-100 underline-offset-2 hover:underline"
          >
            Open Apify billing ↗
          </a>
        </div>
      )}
      {error && errorCode !== "apify-out-of-credits" && (
        <span className="text-[11px] text-red-400 max-w-[24rem] text-right">{error}</span>
      )}

      <EmployeesDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        workspaceId={workspaceId}
        companyName={companyName}
        companyLinkedinUrl={companyLinkedinUrl}
      />
    </div>
  )
}
