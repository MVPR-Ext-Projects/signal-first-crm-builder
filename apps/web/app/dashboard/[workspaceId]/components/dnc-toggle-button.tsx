"use client"

/**
 * DncToggleButton - shared inline affordance to set / release a contact's
 * Do-Not-Contact marker. Used from:
 *
 *   - apps/web/app/dashboard/[workspaceId]/sdr/lead-table-row.tsx
 *     (engaged contacts in the main SDR view)
 *   - apps/web/app/dashboard/[workspaceId]/sdr/pre-enrichment-tab.tsx
 *     (contacts waiting to be enriched)
 *
 * Backend is /api/dashboard/[workspaceId]/contacts/[id]/dnc (PATCH with
 * action: "set" | "release"). "set" uses the 6-month default decay
 * with classification/source = "manual"; "release" clears immediately.
 *
 * Three states:
 *   1. Not flagged  -> "Mark DNC" button (subtle gray).
 *   2. Confirming   -> inline Confirm / Cancel to prevent fat-fingers.
 *   3. Active DNC   -> red pill + inline Release link.
 *
 * Sized to match the Send DM / ActivityLogButtons sibling pattern:
 * px-2.5 py-1 text-[11px].
 */

import { useState } from "react"
import { useRouter } from "next/navigation"

export function DncToggleButton({
  workspaceId,
  contactId,
  doNotContactUntil,
}: {
  workspaceId:       string
  contactId:         number
  doNotContactUntil: string | null | undefined
}) {
  const router = useRouter()
  const [busy, setBusy]             = useState(false)
  const [error, setError]           = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const isActive = !!doNotContactUntil && new Date(doNotContactUntil).getTime() > Date.now()

  async function patch(action: "set" | "release") {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/dashboard/${workspaceId}/contacts/${contactId}/dnc`,
        {
          method:  "PATCH",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({
            action,
            reason: action === "set" ? "Marked via dashboard." : undefined,
          }),
        },
      )
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`)
        setBusy(false)
        return
      }
      setConfirming(false)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (isActive) {
    return (
      <div className="inline-flex flex-col items-start gap-1">
        <div className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/[0.08] px-2.5 py-1 text-[11px] font-medium text-red-200">
          <span aria-hidden>DNC</span>
          <button
            type="button"
            onClick={() => patch("release")}
            disabled={busy}
            className="text-[11px] font-medium text-red-100/80 underline-offset-2 hover:text-white hover:underline disabled:opacity-50"
            title="Release the Do-Not-Contact marker"
          >
            {busy ? "..." : "Release"}
          </button>
        </div>
        {error && <p className="text-[11px] text-red-400">{error}</p>}
      </div>
    )
  }

  if (confirming) {
    return (
      <div className="inline-flex flex-col items-start gap-1">
        <div className="inline-flex items-center gap-1.5">
          <span className="text-[11px] text-zinc-300">Mark DNC?</span>
          <button
            type="button"
            onClick={() => patch("set")}
            disabled={busy}
            className="rounded-lg border border-red-500/30 bg-red-500/[0.10] px-2.5 py-1 text-[11px] font-semibold text-red-100 transition-colors hover:bg-red-500/[0.18] disabled:opacity-50 motion-reduce:transition-none"
          >
            {busy ? "Saving..." : "Confirm"}
          </button>
          <button
            type="button"
            onClick={() => { setConfirming(false); setError(null) }}
            disabled={busy}
            className="rounded-lg px-2.5 py-1 text-[11px] text-zinc-400 transition-colors hover:text-white disabled:opacity-50 motion-reduce:transition-none"
          >
            Cancel
          </button>
        </div>
        {error && <p className="text-[11px] text-red-400">{error}</p>}
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.10] bg-white/[0.02] px-2.5 py-1 text-[11px] font-medium text-zinc-400 transition-colors hover:border-red-500/30 hover:bg-red-500/[0.06] hover:text-red-200 motion-reduce:transition-none"
      title="Mark this contact Do-Not-Contact"
    >
      Mark DNC
    </button>
  )
}
