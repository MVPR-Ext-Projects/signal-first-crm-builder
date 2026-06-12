"use client"

import { useState } from "react"

export function SignOutButton({ workspaceId }: { workspaceId: string }) {
  const [busy, setBusy] = useState(false)

  async function handleClick() {
    if (busy) return
    setBusy(true)
    try {
      await fetch(`/api/dashboard/${workspaceId}/sign-out`, { method: "POST" })
    } catch {
      // Even if the request fails, send the user to login. The cookie is
      // httpOnly so we can't clear it client-side; the worst case is they
      // re-arrive at /sdr and get bounced to /login by the auth gate.
    } finally {
      window.location.href = `/dashboard/${workspaceId}/login`
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-950 px-2.5 py-0.5 text-[11px] text-zinc-500 hover:border-zinc-700 hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-50"
      title="Sign out of this workspace"
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <polyline points="16 17 21 12 16 7" />
        <line x1="21" y1="12" x2="9" y2="12" />
      </svg>
      <span>{busy ? "Signing out…" : "Sign out"}</span>
    </button>
  )
}
