"use client"

/**
 * ManualContactEdit — controlled inline form for manually editing a
 * contact's identity fields. Used by:
 *
 *   - apps/web/app/dashboard/[workspaceId]/sdr/pre-enrichment-tab.tsx
 *     Lets users fix data the enrichment provider didn't return - paste
 *     an email Surfe couldn't find, correct a job title, swap a stale
 *     LinkedIn URL.
 *   - apps/web/app/dashboard/[workspaceId]/sdr/lead-table-row.tsx
 *     Same affordance for engaged contacts in the main SDR view.
 *
 * Only sends fields the user actually changed (omitted = leave unchanged);
 * empty string clears. Controlled by the parent (open state lives there)
 * so the trigger icon and the form can be in separate parts of the row.
 */

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useToast } from "../toast"

export interface ManualFields {
  email:              string | null
  linkedinUrl:        string | null
  twitterUrl:         string | null
  jobTitle:           string | null
  fullName:           string | null
  companyName:        string | null
  linkedinConnected:  boolean | null
}

export function ManualContactEdit({
  workspaceId,
  contactId,
  initial,
  onClose,
}: {
  workspaceId: string
  contactId:   number
  initial:     ManualFields
  onClose:     () => void
}) {
  const router = useRouter()
  const toast  = useToast()
  const [busy, setBusy]     = useState(false)
  const [fields, setFields] = useState<ManualFields>(initial)

  function update(key: keyof ManualFields, value: string) {
    setFields(f => ({ ...f, [key]: value }))
  }

  async function save() {
    setBusy(true)
    try {
      const patch: Record<string, string | null | boolean> = {}
      const STRING_KEYS = ["email", "linkedinUrl", "twitterUrl", "jobTitle", "fullName", "companyName"] as const
      for (const k of STRING_KEYS) {
        const next = fields[k]?.trim() === "" ? null : (fields[k] ?? null)
        if (next !== initial[k]) patch[k] = next
      }
      if (fields.linkedinConnected !== initial.linkedinConnected) {
        patch.linkedinConnected = fields.linkedinConnected
      }
      if (Object.keys(patch).length === 0) {
        toast.info("Nothing to save", "No fields changed.")
        setBusy(false)
        return
      }
      const res = await fetch(`/api/dashboard/${workspaceId}/contacts/${contactId}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(patch),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        toast.error("Save failed", data.error ?? `HTTP ${res.status}`)
        setBusy(false)
        return
      }
      toast.success("Saved", `Updated ${Object.keys(patch).length} field${Object.keys(patch).length === 1 ? "" : "s"}.`)
      onClose()
      router.refresh()
    } catch (e) {
      toast.error("Save failed", e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-white/[0.10] bg-white/[0.02] p-4">
      <p className="mb-3 text-[12px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">
        Manual fields
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Full name"     value={fields.fullName ?? ""}    onChange={v => update("fullName",    v)} />
        <Field label="Job title"     value={fields.jobTitle ?? ""}    onChange={v => update("jobTitle",    v)} />
        <Field label="Email"         value={fields.email ?? ""}       onChange={v => update("email",       v)} type="email" />
        <CompanySearchField
          workspaceId={workspaceId}
          value={fields.companyName ?? ""}
          onChange={v => setFields(f => ({ ...f, companyName: v }))}
        />
        <Field label="LinkedIn"      value={fields.linkedinUrl ?? ""} onChange={v => update("linkedinUrl", v)} type="url" />
        <Field label="X / Twitter"   value={fields.twitterUrl ?? ""}  onChange={v => update("twitterUrl",  v)} type="url" />
      </div>
      <label className="mt-3 flex cursor-pointer items-center gap-2.5">
        <input
          type="checkbox"
          checked={fields.linkedinConnected === true}
          onChange={e =>
            setFields(f => ({ ...f, linkedinConnected: e.target.checked ? true : null }))
          }
          className="accent-[#2BA98B]"
        />
        <span className="text-[13px] text-zinc-300">Connected on LinkedIn</span>
        {fields.linkedinConnected === true && (
          <span className="text-[11px] text-[#2BA98B]">Confirmed</span>
        )}
      </label>
      <p className="mt-2 text-[11px] text-zinc-500">
        Empty a field to clear it. These overrides survive future enrichment runs.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-lg bg-[#2BA98B] px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-[#249A7E] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
        >
          {busy ? "Saving..." : "Save"}
        </button>
        <button
          type="button"
          onClick={() => { setFields(initial); onClose() }}
          disabled={busy}
          className="rounded-lg px-3 py-1.5 text-[12px] text-zinc-400 transition-colors hover:text-white disabled:opacity-50 motion-reduce:transition-none"
        >
          Cancel
        </button>
      </div>

      <MergeDuplicatesPanel workspaceId={workspaceId} targetId={contactId} />
    </div>
  )
}

// ─── Merge duplicates panel ───────────────────────────────────────────────────

interface SearchHit {
  id:          number
  fullName:    string | null
  email:       string | null
  linkedinUrl: string | null
  companyName: string | null
  signalScore: number
  signalCount: number
}

function MergeDuplicatesPanel({
  workspaceId,
  targetId,
}: {
  workspaceId: string
  targetId:    number
}) {
  const router = useRouter()
  const toast  = useToast()
  const [open, setOpen]     = useState(false)
  const [q, setQ]           = useState("")
  const [results, setResults] = useState<SearchHit[]>([])
  const [picked,  setPicked]  = useState<Set<number>>(new Set())
  const [searching, setSearching] = useState(false)
  const [merging,   setMerging]   = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  function search(v: string) {
    setQ(v)
    if (timerRef.current) clearTimeout(timerRef.current)
    if (v.trim().length < 2) { setResults([]); return }
    setSearching(true)
    timerRef.current = setTimeout(async () => {
      try {
        const res  = await fetch(`/api/dashboard/${workspaceId}/contacts?q=${encodeURIComponent(v)}&exclude=${targetId}`)
        const data = await res.json().catch(() => ({}))
        setResults((data.contacts ?? []) as SearchHit[])
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 250)
  }

  function toggle(id: number) {
    setPicked(p => {
      const next = new Set(p)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function runMerge() {
    if (picked.size === 0) return
    if (!confirm(`Merge ${picked.size} contact${picked.size === 1 ? "" : "s"} into this one? The selected rows will be deleted (their signals + outreach reparent here).`)) return
    setMerging(true)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/contacts/${targetId}/merge`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ sourceIds: [...picked] }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        toast.error("Merge failed", data.error ?? `HTTP ${res.status}`)
        return
      }
      toast.success("Merged", `${data.merged} contact${data.merged === 1 ? "" : "s"} merged in.`)
      setPicked(new Set())
      setResults([])
      setQ("")
      router.refresh()
    } catch (e) {
      toast.error("Merge failed", e instanceof Error ? e.message : String(e))
    } finally {
      setMerging(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-white/[0.10] px-3 py-1.5 text-[12px] text-zinc-400 transition-colors hover:border-white/[0.18] hover:text-zinc-200 motion-reduce:transition-none"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="8 17 12 21 16 17" />
          <polyline points="8 7 12 3 16 7" />
          <line x1="12" y1="3" x2="12" y2="21" />
        </svg>
        Merge duplicates into this contact
      </button>
    )
  }

  return (
    <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.03] p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[11px] font-bold uppercase tracking-[0.10em] text-amber-300">Merge duplicates</p>
        <button type="button" onClick={() => { setOpen(false); setPicked(new Set()); setResults([]); setQ("") }} className="text-[11px] text-zinc-500 hover:text-zinc-300">
          Close
        </button>
      </div>
      <input
        type="text"
        value={q}
        onChange={e => search(e.target.value)}
        placeholder="Search by name, email, LinkedIn URL, or company..."
        className="w-full rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-500 focus:border-amber-500/40 focus:outline-none"
      />
      {searching && <p className="mt-2 text-[11px] text-zinc-500">Searching...</p>}
      {!searching && q.trim().length >= 2 && results.length === 0 && (
        <p className="mt-2 text-[11px] text-zinc-500">No matches.</p>
      )}
      {results.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 max-h-64 overflow-y-auto">
          {results.map(r => {
            const isPicked = picked.has(r.id)
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => toggle(r.id)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                    isPicked
                      ? "bg-amber-500/[0.10] text-amber-100"
                      : "hover:bg-white/[0.04] text-zinc-300"
                  }`}
                >
                  <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${isPicked ? "border-amber-400 bg-amber-400 text-black" : "border-white/[0.18]"}`}>
                    {isPicked && (
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block truncate font-semibold">{r.fullName ?? "(unknown)"}</span>
                    <span className="block truncate text-[11px] text-zinc-500">
                      {[r.companyName, r.email, r.linkedinUrl].filter(Boolean).join(" · ") || "(no details)"}
                    </span>
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums text-zinc-500">
                    {r.signalCount} sig · {r.signalScore}p
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={runMerge}
          disabled={merging || picked.size === 0}
          className="rounded-lg bg-amber-500 px-3 py-1.5 text-[12px] font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {merging ? "Merging..." : `Merge ${picked.size || ""} into this contact`}
        </button>
        {picked.size > 0 && (
          <button
            type="button"
            onClick={() => setPicked(new Set())}
            disabled={merging}
            className="rounded-lg px-3 py-1.5 text-[12px] text-zinc-400 transition-colors hover:text-white disabled:opacity-50"
          >
            Clear
          </button>
        )}
      </div>
      <p className="mt-2 text-[11px] text-zinc-500">
        Source contacts are deleted; their signals, notes, outreach log and deal shares move onto this one.
      </p>
    </div>
  )
}

function CompanySearchField({
  workspaceId,
  value,
  onChange,
}: {
  workspaceId: string
  value:       string
  onChange:    (v: string) => void
}) {
  const [results, setResults] = useState<{ name: string }[]>([])
  const [open, setOpen]       = useState(false)
  const timerRef              = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  function handleChange(v: string) {
    onChange(v)
    if (timerRef.current) clearTimeout(timerRef.current)
    if (v.trim().length < 2) { setResults([]); setOpen(false); return }
    timerRef.current = setTimeout(async () => {
      try {
        const res  = await fetch(`/api/dashboard/${workspaceId}/companies/search?q=${encodeURIComponent(v)}`)
        const data = await res.json()
        const list = (data.results ?? []) as { name: string }[]
        setResults(list)
        setOpen(list.length > 0)
      } catch { /* ignore */ }
    }, 250)
  }

  function select(name: string) {
    onChange(name)
    setOpen(false)
    setResults([])
  }

  return (
    <div className="relative block">
      <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.10em] text-zinc-500">Company</span>
      <input
        type="text"
        value={value}
        onChange={e => handleChange(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="w-full rounded-lg border border-white/[0.12] bg-white/[0.04] px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-500 focus:border-[#2BA98B]/40 focus:outline-none"
      />
      {open && (
        <ul className="absolute z-50 mt-1 w-full rounded-lg border border-white/[0.10] bg-zinc-900 py-1 shadow-xl">
          {results.map(r => (
            <li key={r.name}>
              <button
                type="button"
                onMouseDown={() => select(r.name)}
                className="w-full px-3 py-2 text-left text-[13px] text-zinc-200 hover:bg-white/[0.06]"
              >
                {r.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label:    string
  value:    string
  onChange: (v: string) => void
  type?:    string
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.10em] text-zinc-500">{label}</span>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full rounded-lg border border-white/[0.12] bg-white/[0.04] px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-500 focus:border-[#2BA98B]/40 focus:outline-none"
      />
    </label>
  )
}

/**
 * Reusable pen-and-paper icon button to trigger ManualContactEdit. Sized
 * to slot inline next to a contact's name; stops event propagation so it
 * doesn't trigger any row-level click handler the icon sits inside.
 */
export function ManualEditIcon({
  onClick,
}: {
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick() }}
      title="Manually edit fields"
      aria-label="Manually edit fields"
      className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 motion-reduce:transition-none"
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
      </svg>
    </button>
  )
}
