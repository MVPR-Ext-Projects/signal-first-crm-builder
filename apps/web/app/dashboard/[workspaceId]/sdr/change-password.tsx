"use client"

import { useState } from "react"

export function ChangePasswordButton({
  workspaceId,
  isFirstTimeSetup = false,
}: {
  workspaceId: string
  isFirstTimeSetup?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-950 px-2.5 py-0.5 text-[11px] text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"
        title={isFirstTimeSetup ? "Set a dashboard password" : "Change your dashboard password"}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="4" y="11" width="16" height="10" rx="2" />
          <path d="M8 11V7a4 4 0 1 1 8 0v4" />
        </svg>
        <span>{isFirstTimeSetup ? "Set password" : "Change password"}</span>
      </button>
      {open && <ChangePasswordModal workspaceId={workspaceId} isFirstTimeSetup={isFirstTimeSetup} onClose={() => setOpen(false)} />}
    </>
  )
}

function ChangePasswordModal({
  workspaceId,
  isFirstTimeSetup,
  onClose,
}: {
  workspaceId: string
  isFirstTimeSetup: boolean
  onClose: () => void
}) {
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword,     setNewPassword]     = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [error,   setError]   = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [busy,    setBusy]    = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters")
      return
    }
    if (newPassword !== confirmPassword) {
      setError("New passwords don't match")
      return
    }
    if (!isFirstTimeSetup && newPassword === currentPassword) {
      setError("New password must be different from the current one")
      return
    }

    setBusy(true)
    try {
      const body: Record<string, string> = { newPassword }
      if (!isFirstTimeSetup) body.currentPassword = currentPassword
      const res = await fetch(`/api/dashboard/${workspaceId}/change-password`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Request failed (${res.status})`)
        setBusy(false)
        return
      }
      setSuccess(true)
      // Auto-close after a short pause so the success state is visible.
      // On first-time setup, reload so hasAccessToken-gated UI (avatar menu
      // entries, settings nav) re-renders with the new state.
      setTimeout(() => {
        if (isFirstTimeSetup) {
          window.location.reload()
        } else {
          onClose()
        }
      }, 1500)
    } catch (e) {
      setError((e as Error).message ?? "Something went wrong")
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900 p-6 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold text-zinc-50">
              {isFirstTimeSetup ? "Set dashboard password" : "Change password"}
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              {isFirstTimeSetup
                ? "No password is set for this workspace. Until one is set, anyone with the URL can load the dashboard."
                : "Updates the password for this workspace's SDR dashboard."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-600 hover:text-zinc-300"
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <line x1="6" y1="6"  x2="18" y2="18" />
              <line x1="6" y1="18" x2="18" y2="6"  />
            </svg>
          </button>
        </div>

        {success ? (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-xs text-emerald-300">
            {isFirstTimeSetup
              ? "Password set. Reloading - the dashboard will be gated from now on."
              : "Password updated. You'll stay signed in on this device."}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            {!isFirstTimeSetup && (
              <Field
                id="current-password"
                label="Current password"
                value={currentPassword}
                onChange={setCurrentPassword}
                autoComplete="current-password"
                autoFocus
              />
            )}
            <Field
              id="new-password"
              label={isFirstTimeSetup ? "Choose a password" : "New password"}
              value={newPassword}
              onChange={setNewPassword}
              autoComplete="new-password"
              autoFocus={isFirstTimeSetup}
              hint="At least 8 characters"
            />
            <Field
              id="confirm-password"
              label="Confirm password"
              value={confirmPassword}
              onChange={setConfirmPassword}
              autoComplete="new-password"
            />

            {error && (
              <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                {error}
              </p>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="rounded-md px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || (!isFirstTimeSetup && !currentPassword) || !newPassword || !confirmPassword}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Saving…" : isFirstTimeSetup ? "Set password" : "Update password"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

function Field({
  id,
  label,
  value,
  onChange,
  autoComplete,
  autoFocus,
  hint,
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  autoComplete?: string
  autoFocus?: boolean
  hint?: string
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-zinc-400">
        {label}
      </label>
      <input
        id={id}
        type="password"
        value={value}
        onChange={e => onChange(e.target.value)}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        required
        className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none transition-colors focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/40"
      />
      {hint && <p className="mt-1 text-[10px] text-zinc-600">{hint}</p>}
    </div>
  )
}
