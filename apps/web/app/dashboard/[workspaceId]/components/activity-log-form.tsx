"use client"

import { useState } from "react"

export type ActivityType = "note" | "call"

function todayLocal() {
  const d = new Date()
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}

/**
 * Inline form — parent controls which type is active and provides onClose.
 * Renders nothing when activeType is null.
 */
export function ActivityLogInlineForm({
  workspaceId,
  contactId,
  activeType,
  onClose,
  onSaved,
}: {
  workspaceId: string
  contactId:   number
  activeType:  ActivityType | null
  onClose:     () => void
  onSaved:     () => void
}) {
  const [notes,      setNotes]      = useState("")
  const [occurredAt, setOccurredAt] = useState(todayLocal)
  const [connected,  setConnected]  = useState(true)
  const [busy,       setBusy]       = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  if (!activeType) return null

  function cancel(e: React.MouseEvent) {
    e.stopPropagation()
    setNotes("")
    setError(null)
    onClose()
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (!notes.trim()) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/dashboard/${workspaceId}/contacts/${contactId}/activity`,
        {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ type: activeType, notes: notes.trim(), occurredAt, connected: activeType === "call" ? connected : undefined }),
        },
      )
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? `Failed (${res.status})`)
      setNotes("")
      onClose()
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={save}
      onClick={e => e.stopPropagation()}
      className="rounded-xl border border-white/10 bg-white/[0.03] p-3 space-y-2"
    >
      <p className="text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">
        {activeType === "call" ? "Log call" : "Add note"}
      </p>
      <textarea
        value={notes}
        onChange={e => setNotes(e.target.value)}
        placeholder={activeType === "call" ? "Call notes…" : "Note…"}
        rows={3}
        autoFocus
        className="w-full resize-none rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[12px] text-zinc-200 placeholder-zinc-500 focus:border-[#2BA98B]/40 focus:outline-none focus:ring-1 focus:ring-[#2BA98B]/40"
      />
      {activeType === "call" && (
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="datetime-local"
            value={occurredAt}
            onChange={e => setOccurredAt(e.target.value)}
            className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[12px] text-zinc-300 focus:border-[#2BA98B]/40 focus:outline-none focus:ring-1 focus:ring-[#2BA98B]/40"
          />
          <label className="inline-flex cursor-pointer items-center gap-2 text-[12px] text-zinc-400 select-none">
            <span
              onClick={() => setConnected(v => !v)}
              className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${connected ? "bg-[#2BA98B]" : "bg-white/10"}`}
            >
              <span className={`inline-block h-4 w-4 translate-y-0.5 rounded-full bg-white shadow transition-transform ${connected ? "translate-x-4" : "translate-x-0.5"}`} />
            </span>
            {connected ? "Connected" : "No answer / voicemail"}
          </label>
        </div>
      )}
      {error && <p className="text-[11px] text-rose-400">{error}</p>}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy || !notes.trim()} className="rounded-lg bg-[#2BA98B] px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-[#239977] disabled:cursor-not-allowed disabled:opacity-50">
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={cancel} disabled={busy} className="rounded-lg px-3 py-1.5 text-[12px] text-zinc-400 hover:text-white disabled:opacity-50">
          Cancel
        </button>
      </div>
    </form>
  )
}

/** Self-contained version — manages its own open/close state. Kept for any callers that don't need the inline layout. */
export function ActivityLogForm({
  workspaceId,
  contactId,
  onSaved,
}: {
  workspaceId: string
  contactId:   number
  onSaved:     () => void
}) {
  const [activeType, setActiveType] = useState<ActivityType | null>(null)

  return (
    <div className="mt-3" onClick={e => e.stopPropagation()}>
      {activeType === null ? (
        <ActivityLogButtons onOpen={setActiveType} />
      ) : (
        <ActivityLogInlineForm
          workspaceId={workspaceId}
          contactId={contactId}
          activeType={activeType}
          onClose={() => setActiveType(null)}
          onSaved={onSaved}
        />
      )}
    </div>
  )
}

/** Just the Note + Call trigger buttons — reusable in action rows. */
export function ActivityLogButtons({
  onOpen,
}: {
  onOpen: (type: ActivityType) => void
}) {
  return (
    <>
      <button
        type="button"
        onClick={() => onOpen("note")}
        className={BTN_CLS}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
        Add note
      </button>
      <button
        type="button"
        onClick={() => onOpen("call")}
        className={BTN_CLS}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.62 3.38 2 2 0 0 1 3.6 1.21h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.81a16 16 0 0 0 6.29 6.29l.95-.95a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
        </svg>
        Log call
      </button>
    </>
  )
}

const BTN_CLS =
  "inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1 text-[11px] font-medium text-zinc-400 transition-colors hover:border-[#2BA98B]/40 hover:text-[#2BA98B] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#2BA98B]/40"
