"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"

export function CreateCompanyButton({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-[13px] font-medium text-zinc-400 transition-colors hover:border-[#2BA98B]/40 hover:text-[#2BA98B] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#2BA98B]/40"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        Create company
      </button>
      {open && <CreateCompanyModal workspaceId={workspaceId} onClose={() => setOpen(false)} />}
    </>
  )
}

function CreateCompanyModal({
  workspaceId,
  onClose,
}: {
  workspaceId: string
  onClose: () => void
}) {
  const router = useRouter()
  const [name,       setName]       = useState("")
  const [linkedinUrl, setLinkedinUrl] = useState("")
  const [website,    setWebsite]    = useState("")
  const [busy,       setBusy]       = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  function handleBackdrop(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose()
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) { setError("Company name is required"); return }
    setBusy(true)
    setError(null)
    try {
      // Create a stub contact row so the company appears in the companies view.
      const res = await fetch(`/api/dashboard/${workspaceId}/contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName:       `[${name.trim()}]`,   // placeholder name so the row is valid
          companyName:    name.trim(),
          companyWebsite: website.trim() || undefined,
          linkedinUrl:    linkedinUrl.trim() || undefined,
          isCompanyStub:  true,
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

  const INPUT_CLS =
    "w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[13px] text-zinc-200 placeholder-zinc-500 focus:border-[#2BA98B]/40 focus:outline-none focus:ring-1 focus:ring-[#2BA98B]/40"

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
      onClick={handleBackdrop}
    >
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0B1F19] shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/[0.08] px-6 py-4">
          <h2 className="text-[16px] font-bold text-white">Create company</h2>
          <button type="button" onClick={onClose} className="text-zinc-500 hover:text-white" aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-5">
          <div className="space-y-1.5">
            <label className="block text-[12px] font-medium text-zinc-400">Company name<span className="ml-0.5 text-rose-400">*</span></label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Acme Inc." autoFocus className={INPUT_CLS} />
          </div>
          <div className="space-y-1.5">
            <label className="block text-[12px] font-medium text-zinc-400">LinkedIn page URL</label>
            <input type="url" value={linkedinUrl} onChange={e => setLinkedinUrl(e.target.value)} placeholder="https://linkedin.com/company/acme" className={INPUT_CLS} />
          </div>
          <div className="space-y-1.5">
            <label className="block text-[12px] font-medium text-zinc-400">Website</label>
            <input type="url" value={website} onChange={e => setWebsite(e.target.value)} placeholder="https://acme.com" className={INPUT_CLS} />
          </div>

          {error && <p className="text-[12px] text-rose-400">{error}</p>}

          <div className="flex items-center justify-end gap-3 pt-1">
            <button type="button" onClick={onClose} disabled={busy} className="rounded-lg px-4 py-2 text-[13px] text-zinc-400 hover:text-white disabled:opacity-50">Cancel</button>
            <button type="submit" disabled={busy || !name.trim()} className="rounded-lg bg-[#2BA98B] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#239977] disabled:cursor-not-allowed disabled:opacity-50">
              {busy ? "Creating…" : "Create company"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
