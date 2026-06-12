"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"

interface CompanySuggestion {
  name: string
  linkedinUrl: string | null
}

export function CreateProspectModal({
  workspaceId,
  onClose,
}: {
  workspaceId: string
  onClose: () => void
}) {
  const router = useRouter()
  const [fullName,      setFullName]      = useState("")
  const [linkedinUrl,   setLinkedinUrl]   = useState("")
  const [email,         setEmail]         = useState("")
  const [companyQuery,  setCompanyQuery]  = useState("")
  const [suggestions,   setSuggestions]   = useState<CompanySuggestion[]>([])
  const [showSuggest,   setShowSuggest]   = useState(false)
  const [selectedCo,    setSelectedCo]    = useState<string | null>(null)  // picked from suggestions
  const [showNewCo,     setShowNewCo]     = useState(false)
  const [newCoName,     setNewCoName]     = useState("")
  const [newCoWebsite,  setNewCoWebsite]  = useState("")
  const [busy,          setBusy]          = useState(false)
  const [error,         setError]         = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Debounced company search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!companyQuery.trim()) { setSuggestions([]); return }
    debounceRef.current = setTimeout(async () => {
      const res = await fetch(
        `/api/dashboard/${workspaceId}/companies/search?q=${encodeURIComponent(companyQuery)}`,
      )
      const data = await res.json().catch(() => ({ results: [] }))
      setSuggestions(data.results ?? [])
      setShowSuggest(true)
    }, 250)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [companyQuery, workspaceId])

  // Auto-fill website from email domain
  function handleEmailBlur() {
    if (!newCoWebsite && email.includes("@")) {
      const domain = email.split("@")[1]
      if (domain) setNewCoWebsite(`https://${domain}`)
    }
  }

  function pickCompany(co: CompanySuggestion) {
    setCompanyQuery(co.name)
    setSelectedCo(co.name)
    setShowSuggest(false)
    setShowNewCo(false)
  }

  function handleCompanyQueryChange(v: string) {
    setCompanyQuery(v)
    setSelectedCo(null)
    setShowNewCo(false)
  }

  function handleAddNewCompany() {
    setShowNewCo(true)
    setShowSuggest(false)
    setNewCoName(companyQuery)
    // Try auto-filling website from email domain
    if (!newCoWebsite && email.includes("@")) {
      const domain = email.split("@")[1]
      if (domain) setNewCoWebsite(`https://${domain}`)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!fullName.trim()) { setError("Full name is required"); return }
    setBusy(true)
    setError(null)
    try {
      const companyName = showNewCo ? newCoName.trim() : (selectedCo ?? (companyQuery.trim() || undefined))
      const res = await fetch(`/api/dashboard/${workspaceId}/contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: fullName.trim(),
          linkedinUrl: linkedinUrl.trim() || undefined,
          email: email.trim() || undefined,
          companyName: companyName || undefined,
          companyWebsite: showNewCo ? newCoWebsite.trim() || undefined : undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? `Failed (${res.status})`)
      router.refresh()
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  // Close on backdrop click
  function handleBackdrop(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose()
  }

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
      onClick={handleBackdrop}
    >
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0B1F19] shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/[0.08] px-6 py-4">
          <h2 className="text-[16px] font-bold text-white">Create prospect</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-white"
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-5">
          {/* Full name */}
          <Field label="Full name" required>
            <input
              type="text"
              value={fullName}
              onChange={e => setFullName(e.target.value)}
              placeholder="Jane Smith"
              autoFocus
              className={INPUT_CLS}
            />
          </Field>

          {/* LinkedIn */}
          <Field label="LinkedIn profile URL">
            <input
              type="url"
              value={linkedinUrl}
              onChange={e => setLinkedinUrl(e.target.value)}
              placeholder="https://linkedin.com/in/janesmith"
              className={INPUT_CLS}
            />
          </Field>

          {/* Email */}
          <Field label="Email address">
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              onBlur={handleEmailBlur}
              placeholder="jane@example.com"
              className={INPUT_CLS}
            />
          </Field>

          {/* Company search */}
          <Field label="Company">
            <div className="relative">
              <input
                type="text"
                value={companyQuery}
                onChange={e => handleCompanyQueryChange(e.target.value)}
                onFocus={() => companyQuery && setShowSuggest(true)}
                placeholder="Search existing companies…"
                autoComplete="off"
                className={INPUT_CLS}
              />
              {showSuggest && (
                <div className="absolute left-0 top-full z-10 mt-1 w-full overflow-hidden rounded-xl border border-white/10 bg-[#0d1f1a] shadow-xl">
                  {suggestions.length > 0 ? (
                    suggestions.map(co => (
                      <button
                        key={co.name}
                        type="button"
                        onClick={() => pickCompany(co)}
                        className="flex w-full items-center px-3 py-2 text-left text-[13px] text-zinc-300 hover:bg-white/[0.06]"
                      >
                        {co.name}
                      </button>
                    ))
                  ) : (
                    <p className="px-3 py-2 text-[12px] text-zinc-500">No matches</p>
                  )}
                  <button
                    type="button"
                    onClick={handleAddNewCompany}
                    className="flex w-full items-center gap-1.5 border-t border-white/[0.06] px-3 py-2 text-left text-[12px] text-[#2BA98B] hover:bg-white/[0.04]"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    Add "{companyQuery}" as new company
                  </button>
                </div>
              )}
            </div>
          </Field>

          {/* New company details — unfurl */}
          {showNewCo && (
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
              <p className="text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">New company</p>
              <Field label="Company name">
                <input
                  type="text"
                  value={newCoName}
                  onChange={e => setNewCoName(e.target.value)}
                  placeholder="Acme Inc."
                  className={INPUT_CLS}
                />
              </Field>
              <Field label="Website">
                <input
                  type="url"
                  value={newCoWebsite}
                  onChange={e => setNewCoWebsite(e.target.value)}
                  placeholder="https://acme.com"
                  className={INPUT_CLS}
                />
              </Field>
            </div>
          )}

          {error && <p className="text-[12px] text-rose-400">{error}</p>}

          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-lg px-4 py-2 text-[13px] text-zinc-400 hover:text-white disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !fullName.trim()}
              className="rounded-lg bg-[#2BA98B] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#239977] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Creating…" : "Create prospect"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

const INPUT_CLS =
  "w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[13px] text-zinc-200 placeholder-zinc-500 focus:border-[#2BA98B]/40 focus:outline-none focus:ring-1 focus:ring-[#2BA98B]/40"

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[12px] font-medium text-zinc-400">
        {label}{required && <span className="ml-0.5 text-rose-400">*</span>}
      </label>
      {children}
    </div>
  )
}
