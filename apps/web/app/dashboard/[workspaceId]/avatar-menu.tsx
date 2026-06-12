"use client"

/**
 * AvatarMenu — top-right user button + dropdown.
 *
 * Combines the per-workspace controls that previously lived as separate pills
 * in the SDR header (Settings, Change password, Sign out). Click outside to
 * close. Sign out hits the same /sign-out endpoint as before; failure still
 * sends the user to /login because the cookie is httpOnly.
 */

import { useEffect, useRef, useState } from "react"

interface Props {
  workspaceId: string
  workspaceName: string | null
  /** Shown when the workspace has an accessToken — same condition that gated the old pills. */
  hasAccessToken: boolean
}

export function AvatarMenu({ workspaceId, workspaceName, hasAccessToken }: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("click", onDocClick)
    document.addEventListener("keydown", onEsc)
    return () => {
      document.removeEventListener("click", onDocClick)
      document.removeEventListener("keydown", onEsc)
    }
  }, [open])

  async function handleSignOut() {
    if (busy) return
    setBusy(true)
    try {
      await fetch(`/api/dashboard/${workspaceId}/sign-out`, { method: "POST" })
    } catch {
      // httpOnly cookie — we can't clear it client-side; the auth gate will
      // catch us at /sdr and redirect to /login.
    } finally {
      window.location.href = `/dashboard/${workspaceId}/login`
    }
  }

  const label = workspaceName ?? workspaceId
  const initials = label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0]?.toUpperCase() ?? "")
    .join("") || "·"

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Open account menu"
        className={`flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-xs font-bold text-white transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60 ${
          open ? "ring-2 ring-[#2BA98B]/60" : ""
        }`}
      >
        {initials}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-10 z-30 w-56 overflow-hidden rounded-xl border border-white/10 bg-[#0B3D2E] shadow-[0_12px_32px_rgba(0,0,0,0.45)]"
        >
          <div className="flex items-center gap-2.5 border-b border-white/10 px-3.5 py-3">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-white/10 text-[11px] font-bold text-white">
              {initials}
            </div>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-white">{label}</p>
              <p className="truncate text-[11px] text-zinc-400">Signed in</p>
            </div>
          </div>

          <div className="p-1.5">
            <a
              href={`/dashboard/${workspaceId}/import`}
              role="menuitem"
              className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] text-zinc-200 hover:bg-white/5 motion-reduce:transition-none"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-zinc-400">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Import
            </a>
            <a
              href={`/dashboard/${workspaceId}/costs`}
              role="menuitem"
              className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] text-zinc-200 hover:bg-white/5 motion-reduce:transition-none"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-zinc-400">
                <line x1="12" y1="1" x2="12" y2="23" />
                <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
              Usage & Costs
            </a>
            <a
              href={`/dashboard/${workspaceId}/settings`}
              role="menuitem"
              className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] text-zinc-200 hover:bg-white/5 motion-reduce:transition-none"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-zinc-400">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              Workspace settings
            </a>
            <a
              href={`/dashboard/${workspaceId}/settings/access`}
              role="menuitem"
              className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] text-zinc-200 hover:bg-white/5 motion-reduce:transition-none"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-zinc-400">
                <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
              </svg>
              {hasAccessToken ? "Change password" : "Set password"}
            </a>
          </div>

          {hasAccessToken && (
            <div className="border-t border-white/10 p-1.5">
              <button
                type="button"
                onClick={handleSignOut}
                disabled={busy}
                role="menuitem"
                className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] font-medium text-white hover:bg-white/5 disabled:opacity-60 motion-reduce:transition-none"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
                {busy ? "Signing out…" : `Sign out of ${label}`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
