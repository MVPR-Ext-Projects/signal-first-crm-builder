"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

export function ExcludePersonButton({
  workspaceId,
  linkedinUrl,
  name,
  showLabel = false,
}: {
  workspaceId: string
  linkedinUrl: string
  name: string
  showLabel?: boolean
}) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function requestConfirm(e: React.MouseEvent) {
    e.stopPropagation()
    setConfirming(true)
    setError(null)
  }

  function cancel(e: React.MouseEvent) {
    e.stopPropagation()
    setConfirming(false)
  }

  async function confirm(e: React.MouseEvent) {
    e.stopPropagation()
    setConfirming(false)
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/exclude-contact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkedinUrl }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Request failed (${res.status})`)
      }
      router.refresh()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  if (confirming) {
    return (
      <span className="inline-flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
        <span className="text-[12px] text-zinc-400">Exclude {name}?</span>
        <button
          type="button"
          onClick={confirm}
          className="rounded-full border border-rose-500/50 bg-rose-500/10 px-2.5 py-1 text-[12px] font-medium text-rose-400 transition-colors hover:bg-rose-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40 motion-reduce:transition-none"
        >
          Yes, exclude
        </button>
        <button
          type="button"
          onClick={cancel}
          className="rounded-full border border-white/10 px-2.5 py-1 text-[12px] text-zinc-400 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 motion-reduce:transition-none"
        >
          Cancel
        </button>
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      {error && <span className="text-[10px] text-rose-400">{error}</span>}
      <button
        type="button"
        onClick={requestConfirm}
        disabled={busy}
        title={showLabel ? undefined : "Exclude"}
        aria-label="Exclude person"
        className={`inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-transparent text-zinc-500 transition-colors hover:border-rose-500/50 hover:bg-rose-500/10 hover:text-rose-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40 disabled:opacity-40 motion-reduce:transition-none ${showLabel ? "px-2.5 py-1" : "h-7 w-7 justify-center"} flex`}
      >
        {busy ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin shrink-0" aria-hidden>
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
            <circle cx="12" cy="12" r="10" />
            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
          </svg>
        )}
        {showLabel && (
          <span className="text-[12px] font-medium">{busy ? "Excluding…" : "Exclude Person"}</span>
        )}
      </button>
    </span>
  )
}
