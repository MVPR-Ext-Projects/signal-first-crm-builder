"use client"

/**
 * Inline-editable MRR chip on each company row. Click to edit;
 * Enter or blur saves; Escape cancels; clearing the input + saving
 * clears the value. Pinned to 2dp on the server side; rendered as a
 * rounded GBP figure here.
 */
import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"

export function CompanyMrrPill({
  workspaceId,
  companyName,
  initial,
}: {
  workspaceId: string
  companyName: string
  initial:     number | null
}) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue]     = useState<number | null>(initial)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft]     = useState("")
  const [busy, setBusy]       = useState(false)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => { if (editing) inputRef.current?.focus() }, [editing])

  function startEdit(e: React.MouseEvent) {
    e.stopPropagation()
    e.preventDefault()
    setDraft(value == null ? "" : String(value))
    setEditing(true)
    setError(null)
  }

  async function save() {
    if (busy) return
    const trimmed = draft.trim()
    // Strip any £ / commas the user might type; coerce to number.
    const cleaned = trimmed.replace(/[£,\s]/g, "")
    let next: number | null
    if (cleaned === "") next = null
    else if (/^\d+(\.\d{1,2})?$/.test(cleaned)) next = Number(cleaned)
    else { setError("Numbers only, e.g. 2499 or 2499.50"); return }

    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/companies/mrr`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ companyName, dealMrr: next }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        let msg = `HTTP ${res.status}`
        if (text) {
          try { const d = JSON.parse(text) as { error?: string }; if (d.error) msg = d.error } catch { msg = text.slice(0, 200) }
        }
        throw new Error(msg)
      }
      setValue(next)
      setEditing(false)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed")
    } finally {
      setBusy(false)
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter")     { e.preventDefault(); void save() }
    else if (e.key === "Escape") { e.preventDefault(); setEditing(false); setError(null) }
  }

  if (editing) {
    return (
      <span
        onClick={(e) => { e.stopPropagation(); e.preventDefault() }}
        className="inline-flex items-center gap-1 rounded-full bg-[#2BA98B]/[0.10] px-2.5 py-1 text-[11px] font-semibold tabular-nums text-[#6EE7B7] ring-1 ring-[#2BA98B]/40"
      >
        <span className="text-[9px] uppercase tracking-[0.08em] text-[#2BA98B]">MRR £</span>
        <input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          value={draft}
          disabled={busy}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => void save()}
          placeholder="0"
          className="w-16 bg-transparent text-[11px] tabular-nums text-white outline-none placeholder:text-zinc-500"
          aria-label={`Edit MRR for ${companyName}`}
        />
        {error && <span className="ml-1 text-[10px] text-rose-300" title={error}>!</span>}
      </span>
    )
  }

  const display = value != null && value > 0 ? `£${value.toLocaleString("en-GB", { maximumFractionDigits: 0 })}` : null
  const arr = value != null && value > 0 ? value * 12 : null

  return (
    <button
      type="button"
      onClick={startEdit}
      title={
        display
          ? `Deal value: £${value!.toLocaleString("en-GB", { minimumFractionDigits: 2 })} MRR · £${arr!.toLocaleString("en-GB", { minimumFractionDigits: 2 })} ARR · click to edit`
          : "Set deal MRR"
      }
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold tabular-nums transition-colors hover:bg-[#2BA98B]/[0.16] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#2BA98B]/60 motion-reduce:transition-none ${
        display
          ? "bg-[#2BA98B]/[0.10] text-[#6EE7B7]"
          : "border border-dashed border-white/[0.12] bg-transparent text-zinc-500 hover:text-zinc-300"
      }`}
    >
      <span className="text-[9px] uppercase tracking-[0.08em] text-[#2BA98B]">MRR</span>
      {display ?? "+ add"}
    </button>
  )
}
