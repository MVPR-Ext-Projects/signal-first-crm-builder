"use client"

/**
 * EmployeesDrawer — right-hand pullout that lists Apify-fetched employees
 * for a company and lets the user qualify-in which ones become contacts.
 *
 * Flow:
 *   • Caller fetches Apify (writes to company_enrichments) and opens the
 *     drawer with the company.
 *   • Drawer reads cached profiles via GET /companies/enrichment.
 *   • User ticks profiles (matched are pre-checked) and clicks "Add as
 *     contacts" — POSTs to /companies/promote-contacts which dedupes by
 *     linkedin_url and inserts at Prospect stage.
 *   • Drawer closes, page refreshes so the new contacts appear under the
 *     company card.
 */

import { useEffect, useState, useTransition } from "react"
import { createPortal } from "react-dom"
import { useRouter } from "next/navigation"

interface Employee {
  fullName?:       string | null
  firstName?:      string | null
  lastName?:       string | null
  title?:          string
  linkedinUrl?:    string | null
  titleMatch?:     boolean
  matchedPersona?: string | null
}

interface EnrichmentRow {
  companyLinkedinUrl: string
  companyName:        string | null
  fetchedAt:          string | null
  rawCount:           number
  matchCount:         number
  employees:          Employee[]
}

export function EmployeesDrawer({
  open,
  onClose,
  workspaceId,
  companyName,
  companyLinkedinUrl,
}: {
  open:               boolean
  onClose:            () => void
  workspaceId:        string
  companyName:        string
  companyLinkedinUrl: string
}) {
  const router = useRouter()
  const [, startRefreshTransition] = useTransition()
  const [employees,  setEmployees]  = useState<Employee[]>([])
  const [fetchedAt,  setFetchedAt]  = useState<string | null>(null)
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState<string | null>(null)
  const [selected,   setSelected]   = useState<Set<string>>(new Set()) // keys = linkedinUrl
  const [submitting, setSubmitting] = useState(false)

  // Animate in/out via a renderId-style gate so the panel doesn't snap.
  const [render,   setRender]   = useState(false)
  const [entered,  setEntered]  = useState(false)
  useEffect(() => {
    if (open) {
      setRender(true)
      const r = requestAnimationFrame(() => setEntered(true))
      return () => cancelAnimationFrame(r)
    }
    setEntered(false)
    const t = setTimeout(() => setRender(false), 220)
    return () => clearTimeout(t)
  }, [open])

  // Load cached enrichment when the drawer opens.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    const url = `/api/dashboard/${workspaceId}/companies/enrichment?companyLinkedinUrl=${encodeURIComponent(companyLinkedinUrl)}`
    fetch(url)
      .then(async r => {
        const body = await r.json().catch(() => ({}))
        if (cancelled) return
        if (!r.ok) {
          setError(body.error ?? `HTTP ${r.status}`)
          setEmployees([])
          return
        }
        const row = body as EnrichmentRow
        setEmployees(row.employees ?? [])
        setFetchedAt(row.fetchedAt ?? null)
        // Pre-check the persona-matched profiles; user can adjust.
        const initial = new Set<string>()
        for (const e of row.employees ?? []) {
          if (e.titleMatch && e.linkedinUrl) initial.add(e.linkedinUrl)
        }
        setSelected(initial)
      })
      .catch(e => { if (!cancelled) { setError((e as Error).message); setEmployees([]) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, workspaceId, companyLinkedinUrl])

  // Esc to close.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, onClose])

  function toggle(linkedinUrl: string | null | undefined) {
    if (!linkedinUrl) return
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(linkedinUrl)) next.delete(linkedinUrl)
      else next.add(linkedinUrl)
      return next
    })
  }
  function selectAllMatched() {
    const next = new Set<string>()
    for (const e of employees) {
      if (e.titleMatch && e.linkedinUrl) next.add(e.linkedinUrl)
    }
    setSelected(next)
  }
  function selectAll() {
    const next = new Set<string>()
    for (const e of employees) {
      if (e.linkedinUrl) next.add(e.linkedinUrl)
    }
    setSelected(next)
  }
  function clearAll() { setSelected(new Set()) }

  async function confirm() {
    if (submitting || selected.size === 0) return
    setSubmitting(true)
    setError(null)
    try {
      const profiles = employees.filter(e => e.linkedinUrl && selected.has(e.linkedinUrl))
      const res = await fetch(`/api/dashboard/${workspaceId}/companies/promote-contacts`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          companyLinkedinUrl,
          companyName,
          profiles,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.ok) {
        setError(body.error ?? `Failed (${res.status})`)
        return
      }
      // Fire the server-component refresh inside a transition before the
      // close animation starts. revalidatePath was already called by the
      // route handler, so this just triggers React to re-render with the
      // fresh RSC payload. Closing afterwards lets the animation play.
      startRefreshTransition(() => router.refresh())
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  if (!render) return null

  const matchedCount = employees.filter(e => e.titleMatch).length

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className={`absolute inset-0 cursor-default bg-black/50 backdrop-blur-[2px] transition-opacity duration-200 motion-reduce:transition-none ${entered ? "opacity-100" : "opacity-0"}`}
      />
      <aside
        className={`relative flex h-full w-full max-w-[560px] flex-col gap-0 overflow-hidden border-l border-white/10 bg-[#0B3D2E] shadow-[-12px_0_40px_rgba(0,0,0,0.45)] transition-transform duration-200 ease-out motion-reduce:transition-none ${entered ? "translate-x-0" : "translate-x-full"}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="flex items-start justify-between gap-3 border-b border-white/10 p-5">
          <div className="min-w-0">
            <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Employees · {companyName}</p>
            <h2 className="truncate text-[18px] font-bold tracking-[-0.01em] text-white">
              {employees.length} fetched · {matchedCount} matched persona
            </h2>
            {fetchedAt && (
              <p className="mt-0.5 text-[12px] text-zinc-500">Fetched {new Date(fetchedAt).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close drawer"
            className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        {/* Bulk controls */}
        <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-5 py-3 text-[12px] text-zinc-400">
          <span className="font-semibold text-zinc-200">{selected.size} selected</span>
          <span className="text-zinc-600">·</span>
          <button type="button" onClick={selectAllMatched} className="rounded-md px-1.5 py-0.5 hover:bg-white/[0.06] hover:text-zinc-100">Select matched ({matchedCount})</button>
          <button type="button" onClick={selectAll}        className="rounded-md px-1.5 py-0.5 hover:bg-white/[0.06] hover:text-zinc-100">Select all</button>
          <button type="button" onClick={clearAll}         className="rounded-md px-1.5 py-0.5 hover:bg-white/[0.06] hover:text-zinc-100">Clear</button>
        </div>

        {/* List */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-[13px] text-zinc-400">Loading…</div>
          ) : error ? (
            <div className="m-5 rounded-lg border border-rose-500/30 bg-rose-500/[0.10] px-3 py-2 text-[12px] text-rose-200">{error}</div>
          ) : employees.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-[13px] text-zinc-500">No employees fetched yet.</div>
          ) : (
            <ul className="divide-y divide-white/[0.05]">
              {employees.map((e, i) => {
                const checked = !!e.linkedinUrl && selected.has(e.linkedinUrl)
                const disabled = !e.linkedinUrl
                return (
                  <li
                    key={(e.linkedinUrl ?? `noli-${i}`) + i}
                    className={`flex items-start gap-3 px-5 py-3 ${disabled ? "opacity-50" : "cursor-pointer hover:bg-white/[0.03]"} ${checked ? "bg-[#2BA98B]/[0.06]" : ""}`}
                    onClick={() => !disabled && toggle(e.linkedinUrl)}
                  >
                    <span
                      className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border"
                      style={{
                        borderColor:     checked ? "#2BA98B" : "rgba(255,255,255,0.20)",
                        backgroundColor: checked ? "#2BA98B" : "transparent",
                      }}
                      aria-hidden
                    >
                      {checked && (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#0d1f1a" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-[14px] font-semibold text-white">{e.fullName ?? "(unknown)"}</p>
                        {e.matchedPersona && (
                          <span className="inline-flex items-center rounded-full bg-violet-400/[0.16] px-1.5 py-0 text-[10px] font-bold uppercase tracking-[0.06em] text-violet-200">
                            {e.matchedPersona}
                          </span>
                        )}
                        {e.linkedinUrl && (
                          <a
                            href={e.linkedinUrl.startsWith("http") ? e.linkedinUrl : `https://${e.linkedinUrl}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(ev) => ev.stopPropagation()}
                            title="LinkedIn"
                            className="inline-flex h-5 w-5 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-[#2BA98B] motion-reduce:transition-none"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                              <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.268 2.37 4.268 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
                            </svg>
                          </a>
                        )}
                      </div>
                      {e.title && <p className="mt-0.5 truncate text-[12px] text-zinc-400" title={e.title}>{e.title}</p>}
                      {!e.linkedinUrl && <p className="mt-0.5 text-[11px] text-zinc-500">No LinkedIn URL — can't be promoted</p>}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-white/10 p-5">
          {error && <p className="mb-2 text-[12px] text-rose-300">{error}</p>}
          <div className="flex items-center justify-between gap-3">
            <p className="text-[12px] text-zinc-400">
              {selected.size === 0 ? "Pick which to add" : `${selected.size} will be added as Prospects`}
            </p>
            <button
              type="button"
              onClick={confirm}
              disabled={submitting || selected.size === 0}
              className="rounded-xl bg-[#2BA98B] px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[#249A7E] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60"
            >
              {submitting ? "Adding…" : `Add ${selected.size} as contacts`}
            </button>
          </div>
        </div>
      </aside>
    </div>,
    document.body,
  )
}
