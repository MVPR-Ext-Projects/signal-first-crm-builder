"use client"

/**
 * ImportForm — three-step flow:
 *  1. Input  — AI text chat or CSV file upload
 *  2. Preview — table showing parsed contacts + de-dup warnings
 *  3. Done   — success count + link back to dashboard
 */

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"

interface ParsedContact {
  _id?:          string
  firstName?:    string
  lastName?:     string
  fullName?:     string
  jobTitle?:     string
  companyName?:  string
  email?:        string
  linkedinUrl?:  string
  location?:     string
  duplicate?: {
    contactId: number
    fullName:  string | null
    email:     string | null
  }
}

type Step = "input" | "preview" | "done"
type InputMode = "text" | "csv"

export function ImportForm({ workspaceId }: { workspaceId: string }) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)

  const [step,      setStep]      = useState<Step>("input")
  const [mode,      setMode]      = useState<InputMode>("text")
  const [text,      setText]      = useState("")
  const [contacts,  setContacts]  = useState<ParsedContact[]>([])
  const [selected,  setSelected]  = useState<Set<string>>(new Set())
  const [parsing,   setParsing]   = useState(false)
  const [importing, setImporting] = useState(false)
  const [imported,  setImported]  = useState(0)
  const [error,     setError]     = useState<string | null>(null)

  // ── Step 1: Parse ──────────────────────────────────────────────────────────

  async function handleParse() {
    if (!text.trim()) return
    setParsing(true)
    setError(null)
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/import-contacts`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ mode: "parse", text }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Parse failed")

      const parsed: ParsedContact[] = (data.contacts as ParsedContact[]).map((c, i) => ({
        ...c,
        _id: c._id ?? `c-${i}`,
      }))

      // De-dup check
      const dedupRes = await fetch(`/api/workspace/${workspaceId}/import-contacts`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ mode: "dedup", contacts: parsed }),
      })
      const dedupData = await dedupRes.json()
      const withDup: ParsedContact[] = dedupData.contacts ?? parsed

      setContacts(withDup)
      // Pre-select all non-duplicates
      setSelected(new Set(withDup.filter(c => !c.duplicate).map(c => c._id!)))
      setStep("preview")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error")
    } finally {
      setParsing(false)
    }
  }

  async function handleCsvFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setParsing(true)
    setError(null)
    try {
      const rawText = await file.text()
      setText(rawText)
      const res = await fetch(`/api/workspace/${workspaceId}/import-contacts`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ mode: "parse", text: rawText }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Parse failed")

      const parsed: ParsedContact[] = (data.contacts as ParsedContact[]).map((c, i) => ({
        ...c,
        _id: `c-${i}`,
      }))

      const dedupRes = await fetch(`/api/workspace/${workspaceId}/import-contacts`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ mode: "dedup", contacts: parsed }),
      })
      const dedupData = await dedupRes.json()
      const withDup: ParsedContact[] = dedupData.contacts ?? parsed

      setContacts(withDup)
      setSelected(new Set(withDup.filter(c => !c.duplicate).map(c => c._id!)))
      setStep("preview")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error")
    } finally {
      setParsing(false)
    }
  }

  // ── Step 2: Import ─────────────────────────────────────────────────────────

  async function handleImport() {
    const toImport = contacts.filter(c => c._id && selected.has(c._id))
    if (toImport.length === 0) return
    setImporting(true)
    setError(null)
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/import-contacts`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ mode: "import", contacts: toImport }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Import failed")
      setImported(data.imported ?? toImport.length)
      setStep("done")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error")
    } finally {
      setImporting(false)
    }
  }

  function toggleContact(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) { next.delete(id) } else { next.add(id) }
      return next
    })
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (step === "done") {
    return (
      <div className="flex flex-col gap-5 rounded-2xl border border-[#2BA98B]/20 bg-[#2BA98B]/[0.06] p-7">
        <div>
          <p className="text-[28px] font-bold text-white">{imported}</p>
          <p className="text-[14px] text-zinc-400">
            {imported === 1 ? "contact imported" : "contacts imported"} — starting at Prospect stage
          </p>
        </div>
        <div className="flex items-center gap-3">
          <a
            href={`/dashboard/${workspaceId}/sdr`}
            className="rounded-xl bg-[#2BA98B] px-5 py-2.5 text-[14px] font-semibold text-white hover:opacity-90 transition-opacity"
          >
            Go to pipeline
          </a>
          <button
            onClick={() => { setStep("input"); setText(""); setContacts([]); setSelected(new Set()) }}
            className="rounded-xl border border-white/[0.10] px-5 py-2.5 text-[14px] font-medium text-zinc-300 hover:border-white/20 transition-colors"
          >
            Import more
          </button>
        </div>
      </div>
    )
  }

  if (step === "preview") {
    const selectedCount = selected.size
    const dupCount = contacts.filter(c => c.duplicate).length
    return (
      <div className="flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[14px] font-semibold text-white">
              {contacts.length} {contacts.length === 1 ? "contact" : "contacts"} found
            </p>
            {dupCount > 0 && (
              <p className="text-[12px] text-amber-400 mt-0.5">
                {dupCount} possible {dupCount === 1 ? "duplicate" : "duplicates"} — unchecked by default
              </p>
            )}
          </div>
          <button
            onClick={() => setStep("input")}
            className="text-[13px] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Back
          </button>
        </div>

        <div className="overflow-hidden rounded-2xl border border-white/[0.08]">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-white/[0.08] bg-white/[0.03]">
                <th className="w-10 px-4 py-3 text-left">
                  <input
                    type="checkbox"
                    checked={selectedCount === contacts.filter(c => !c.duplicate).length && contacts.filter(c => !c.duplicate).length > 0}
                    onChange={e => {
                      if (e.target.checked) {
                        setSelected(new Set(contacts.filter(c => !c.duplicate).map(c => c._id!)))
                      } else {
                        setSelected(new Set())
                      }
                    }}
                    className="accent-[#2BA98B]"
                  />
                </th>
                <th className="px-3 py-3 text-left font-semibold text-zinc-400">Name</th>
                <th className="px-3 py-3 text-left font-semibold text-zinc-400">Title</th>
                <th className="px-3 py-3 text-left font-semibold text-zinc-400">Company</th>
                <th className="px-3 py-3 text-left font-semibold text-zinc-400">Email</th>
                <th className="px-3 py-3 text-left font-semibold text-zinc-400">Status</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c, i) => {
                const id = c._id ?? `c-${i}`
                const isSelected = selected.has(id)
                const isDup = !!c.duplicate
                return (
                  <tr
                    key={id}
                    className={`border-b border-white/[0.06] transition-colors cursor-pointer hover:bg-white/[0.02] ${isDup ? "opacity-60" : ""}`}
                    onClick={() => toggleContact(id)}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleContact(id)}
                        onClick={e => e.stopPropagation()}
                        className="accent-[#2BA98B]"
                      />
                    </td>
                    <td className="px-3 py-3 text-white font-medium">
                      {c.fullName ?? [c.firstName, c.lastName].filter(Boolean).join(" ") ?? "—"}
                    </td>
                    <td className="px-3 py-3 text-zinc-400">{c.jobTitle ?? "—"}</td>
                    <td className="px-3 py-3 text-zinc-400">{c.companyName ?? "—"}</td>
                    <td className="px-3 py-3 text-zinc-500">{c.email ?? "—"}</td>
                    <td className="px-3 py-3">
                      {isDup ? (
                        <span className="rounded-full bg-amber-500/[0.12] px-2.5 py-0.5 text-[11px] font-medium text-amber-400">
                          Possible duplicate
                        </span>
                      ) : (
                        <span className="rounded-full bg-[#2BA98B]/[0.12] px-2.5 py-0.5 text-[11px] font-medium text-[#2BA98B]">
                          New
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {error && <p className="text-[13px] text-red-400">{error}</p>}

        <div className="flex items-center gap-3">
          <button
            onClick={handleImport}
            disabled={importing || selectedCount === 0}
            className="rounded-xl bg-[#2BA98B] px-5 py-2.5 text-[14px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {importing ? "Importing…" : `Import ${selectedCount} ${selectedCount === 1 ? "contact" : "contacts"}`}
          </button>
          <p className="text-[12px] text-zinc-600">
            Duplicates will update existing contacts if selected.
          </p>
        </div>
      </div>
    )
  }

  // Step: input
  return (
    <div className="flex flex-col gap-5">
      {/* Mode toggle */}
      <div className="flex gap-1 rounded-xl border border-white/[0.08] bg-white/[0.03] p-1 self-start">
        {(['text', 'csv'] as InputMode[]).map(m => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`rounded-lg px-4 py-2 text-[13px] font-medium transition-colors ${
              mode === m
                ? "bg-[#2BA98B]/[0.16] text-white"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {m === "text" ? "Paste text" : "Upload CSV"}
          </button>
        ))}
      </div>

      {mode === "text" ? (
        <div className="flex flex-col gap-3">
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            rows={8}
            placeholder={[
              "Paste anything — LinkedIn profile URLs, names and job titles, email signatures, a CSV list…",
              "",
              "e.g.",
              "Sarah Chen, VP Product at Stripe, https://linkedin.com/in/sarahchen",
              "james.smith@acme.com, CTO",
            ].join("\n")}
            className="w-full resize-y rounded-2xl border border-white/[0.10] bg-white/[0.03] px-5 py-4 text-[13px] text-white placeholder:text-zinc-600 focus:border-[#2BA98B]/40 focus:outline-none focus:ring-1 focus:ring-[#2BA98B]/20 font-mono leading-relaxed"
          />
          {error && <p className="text-[13px] text-red-400">{error}</p>}
          <button
            onClick={handleParse}
            disabled={parsing || !text.trim()}
            className="self-start rounded-xl bg-[#2BA98B] px-5 py-2.5 text-[14px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {parsing ? "Parsing…" : "Parse contacts"}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div
            className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/[0.14] bg-white/[0.02] py-12 transition-colors hover:border-[#2BA98B]/30 hover:bg-[#2BA98B]/[0.03]"
            onClick={() => fileRef.current?.click()}
          >
            <p className="text-[14px] font-medium text-zinc-300">
              {parsing ? "Parsing file…" : "Click to upload CSV or Excel file"}
            </p>
            <p className="text-[12px] text-zinc-600">.csv, .xlsx, .xls supported</p>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls,text/csv"
            className="hidden"
            onChange={handleCsvFile}
          />
          {error && <p className="text-[13px] text-red-400">{error}</p>}
        </div>
      )}
    </div>
  )
}
