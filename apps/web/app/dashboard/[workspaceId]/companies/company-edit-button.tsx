"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useToast } from "../toast"

export function CompanyEditButton({
  workspaceId,
  companyName,
  companyLinkedinUrl,
  websiteDomain,
}: {
  workspaceId:        string
  companyName:        string
  companyLinkedinUrl: string | null
  websiteDomain?:     string | null
}) {
  const router = useRouter()
  const toast  = useToast()
  const [open,   setOpen]   = useState(false)
  const [busy,   setBusy]   = useState(false)
  const [name,   setName]   = useState(companyName)
  const [url,    setUrl]    = useState(companyLinkedinUrl ?? "")
  const [domain, setDomain] = useState(websiteDomain ?? "")

  function handleOpen(e: React.MouseEvent) {
    e.stopPropagation()
    setOpen(true)
  }

  function handleClose(e?: React.MouseEvent) {
    e?.stopPropagation()
    if (busy) return
    setOpen(false)
    setName(companyName)
    setUrl(companyLinkedinUrl ?? "")
  }

  async function save(e: React.MouseEvent) {
    e.stopPropagation()
    const patch: Record<string, string | null> = {}
    const trimmedName   = name.trim()
    const trimmedUrl    = url.trim() || null
    const trimmedDomain = domain.trim().toLowerCase() || null
    if (trimmedName   !== companyName)       patch.newCompanyName = trimmedName || null
    if (trimmedUrl    !== companyLinkedinUrl) patch.linkedinUrl   = trimmedUrl
    if (trimmedDomain !== (websiteDomain ?? null)) patch.websiteDomain = trimmedDomain

    if (Object.keys(patch).length === 0) {
      toast.info("Nothing to save", "No fields changed.")
      setOpen(false)
      return
    }

    setBusy(true)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/companies/edit`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ companyName, ...patch }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        toast.error("Save failed", data.error ?? `HTTP ${res.status}`)
        return
      }
      toast.success("Saved", `Company updated.`)
      setOpen(false)
      router.refresh()
    } catch (err) {
      toast.error("Save failed", err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        title="Edit company"
        aria-label="Edit company"
        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/[0.08] hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60 motion-reduce:transition-none"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
          onClick={handleClose}
          role="dialog"
          aria-modal="true"
          aria-label="Edit company"
        >
          <div
            className="w-full max-w-md rounded-2xl border border-white/[0.12] bg-[#0F1F1C] p-6 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="mb-4 text-[14px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">
              Edit company
            </h2>

            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.10em] text-zinc-500">
                  Company name
                </span>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  disabled={busy}
                  className="w-full rounded-lg border border-white/[0.12] bg-white/[0.04] px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-500 focus:border-[#2BA98B]/40 focus:outline-none disabled:opacity-50"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.10em] text-zinc-500">
                  LinkedIn URL
                </span>
                <input
                  type="url"
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  placeholder="https://linkedin.com/company/…"
                  disabled={busy}
                  className="w-full rounded-lg border border-white/[0.12] bg-white/[0.04] px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-500 focus:border-[#2BA98B]/40 focus:outline-none disabled:opacity-50"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.10em] text-zinc-500">
                  Website domain
                </span>
                <input
                  type="text"
                  value={domain}
                  onChange={e => setDomain(e.target.value)}
                  placeholder="example.com"
                  disabled={busy}
                  className="w-full rounded-lg border border-white/[0.12] bg-white/[0.04] px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-500 focus:border-[#2BA98B]/40 focus:outline-none disabled:opacity-50"
                />
                <p className="mt-1 text-[11px] text-zinc-600">Used to fetch Moz domain authority. Just the domain — no https:// needed.</p>
              </label>
            </div>

            <p className="mt-3 text-[11px] text-zinc-500">
              Changes apply to all contacts at this company. Renaming updates the company name across contacts and tags.
            </p>

            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={save}
                disabled={busy}
                className="rounded-lg bg-[#2BA98B] px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[#249A7E] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
              >
                {busy ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={handleClose}
                disabled={busy}
                className="rounded-lg px-4 py-2 text-[13px] text-zinc-400 transition-colors hover:text-white disabled:opacity-50 motion-reduce:transition-none"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
