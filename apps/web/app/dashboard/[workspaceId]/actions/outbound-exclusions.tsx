"use client"

/**
 * OutboundExclusions - Actions-page section listing contacts currently
 * excluded from outbound campaigns and why. Per the dedup master plan:
 *
 *   "Underneath that section, an unfoldable list shows the personal-email
 *    blocklist and the DNC list (the profiles currently flagged Do Not
 *    Contact) so users can always check who's excluded from sends and why."
 *
 * Two unfoldable subsections:
 *   - DNC contacts: shows classification + snippet + decay date. Each row
 *     has a Release button that clears the marker immediately.
 *   - Personal-email-only contacts: shows the address. Read-only - the
 *     blocklist is hard-coded for now (workspace-level overrides are a
 *     follow-up).
 *
 * Counts in the section header always reflect the live data; the
 * unfoldable details are progressive disclosure for scanning the list.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"

export interface DncRow {
  id:                number
  fullName:          string | null
  jobTitle:          string | null
  companyName:       string | null
  classification:    string | null
  snippet:           string | null
  source:            string | null
  doNotContactUntil: string
}

export interface PersonalEmailRow {
  id:          number
  fullName:    string | null
  jobTitle:    string | null
  companyName: string | null
  email:       string
}

export function OutboundExclusions({
  workspaceId,
  dnc,
  personalEmail,
}: {
  workspaceId:   string
  dnc:           DncRow[]
  personalEmail: PersonalEmailRow[]
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03]">
      <div className="border-b border-white/[0.08] px-6 py-4">
        <h2 className="text-[16px] font-bold text-white">Outbound exclusions</h2>
        <p className="mt-1 text-[13px] text-zinc-400">
          Contacts currently excluded from outbound campaigns. {dnc.length} marked Do-Not-Contact
          {" · "}
          {personalEmail.length} personal-email-only.
        </p>
      </div>

      {/* DNC list */}
      <details className="border-b border-white/[0.06]">
        <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-6 py-3 text-[12px] font-medium text-zinc-300 hover:text-white">
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="details-chevron shrink-0"
            aria-hidden
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
          Do-Not-Contact list ({dnc.length})
        </summary>
        {dnc.length === 0 ? (
          <p className="px-6 py-4 text-[13px] text-zinc-500">
            No contacts currently flagged Do-Not-Contact.
          </p>
        ) : (
          <ul className="divide-y divide-white/[0.04]">
            {dnc.map(c => (
              <DncRowItem key={c.id} workspaceId={workspaceId} row={c} />
            ))}
          </ul>
        )}
      </details>

      {/* Personal-email blocklist */}
      <details>
        <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-6 py-3 text-[12px] font-medium text-zinc-300 hover:text-white">
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="details-chevron shrink-0"
            aria-hidden
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
          Personal-email-only contacts ({personalEmail.length})
        </summary>
        {personalEmail.length === 0 ? (
          <p className="px-6 py-4 text-[13px] text-zinc-500">
            No contacts have only a personal email address.
          </p>
        ) : (
          <ul className="divide-y divide-white/[0.04]">
            {personalEmail.map(c => (
              <li key={c.id} className="flex items-center justify-between gap-4 px-6 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-semibold text-white">
                    {c.fullName ?? "Unnamed contact"}
                  </p>
                  <p className="truncate text-[12px] text-zinc-400">
                    {[c.jobTitle, c.companyName].filter(Boolean).join(" · ") || "No job title or company on file"}
                  </p>
                </div>
                <p className="flex-shrink-0 font-mono text-[12px] text-zinc-500">{c.email}</p>
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  )
}

function DncRowItem({
  workspaceId,
  row,
}: {
  workspaceId: string
  row:         DncRow
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [busy, setBusy]     = useState(false)
  const [error, setError]   = useState<string | null>(null)
  const [hidden, setHidden] = useState(false)

  async function release() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/dashboard/${workspaceId}/contacts/${row.id}/dnc`,
        {
          method:  "PATCH",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ action: "release" }),
        },
      )
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`)
        setBusy(false)
        return
      }
      setHidden(true)
      startTransition(() => router.refresh())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  if (hidden) return null

  const until = new Date(row.doNotContactUntil)
  const isManualSet = row.classification === "manual"

  return (
    <li className="flex flex-col gap-2 px-6 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="truncate text-[13px] font-semibold text-white">
          {row.fullName ?? "Unnamed contact"}
        </p>
        <p className="truncate text-[12px] text-zinc-400">
          {[row.jobTitle, row.companyName].filter(Boolean).join(" · ") || "No job title or company on file"}
        </p>
        <p className="text-[12px] text-zinc-500">
          {isManualSet
            ? "Manually marked."
            : `${row.classification ?? "unknown"} on ${row.source ?? "(unknown channel)"}.`}{" "}
          {row.snippet && (
            <span className="text-zinc-400">&ldquo;{row.snippet}&rdquo;</span>
          )}
        </p>
        <p className="text-[11px] text-zinc-600">
          Decays {until.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
        </p>
      </div>
      <div className="flex flex-shrink-0 flex-col items-stretch gap-1.5 sm:items-end">
        <button
          type="button"
          onClick={release}
          disabled={busy}
          className="rounded-lg border border-white/14 bg-white/[0.04] px-3 py-1.5 text-[12px] font-medium text-zinc-200 transition-colors hover:border-[#2BA98B]/40 hover:bg-[#2BA98B]/[0.10] hover:text-white disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
        >
          {busy ? "Releasing..." : "Release"}
        </button>
        {error && <p className="text-right text-[11px] text-red-400">{error}</p>}
      </div>
    </li>
  )
}
