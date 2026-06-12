"use client"

/**
 * Per-row remove button for the unfurled contact list under a company card.
 * One-click, no menu — confirms via window.confirm so accidental clicks don't
 * silently delete a Prospect. Hits DELETE /api/dashboard/[ws]/contacts/[id]
 * which cascades to the signals table.
 *
 * Used today for Apify-scraped Prospects the SDR doesn't want; works equally
 * for any contact the user wants gone.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"

export function ContactRemoveButton({
  workspaceId,
  contactId,
  contactName,
}: {
  workspaceId: string
  contactId:   number
  contactName: string | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function onClick(e: React.MouseEvent) {
    e.stopPropagation()
    e.preventDefault()
    if (busy || pending) return
    const ok = window.confirm(
      `Remove ${contactName ?? "this contact"} from the dashboard?\n\nTheir signal history will be deleted. This can't be undone (but they'll be re-added the next time they engage via Teamfluence or get fetched from Apify).`,
    )
    if (!ok) return

    setBusy(true)
    setError(null)
    fetch(`/api/dashboard/${workspaceId}/contacts/${contactId}`, { method: "DELETE" })
      .then(async r => {
        const body = await r.json().catch(() => ({}))
        if (!r.ok || !body.ok) {
          setError(body.error ?? `Failed (${r.status})`)
          setBusy(false)
          return
        }
        startTransition(() => router.refresh())
      })
      .catch(err => {
        setError((err as Error).message)
        setBusy(false)
      })
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || pending}
      title={error ?? `Remove ${contactName ?? "contact"}`}
      aria-label={`Remove ${contactName ?? "contact"}`}
      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-rose-500/[0.10] hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-rose-400/40"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6" />
        <path d="M14 11v6" />
      </svg>
    </button>
  )
}
