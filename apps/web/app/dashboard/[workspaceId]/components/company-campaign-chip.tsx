"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"

interface Campaign {
  id:       string
  name:     string
  channel:  string
  enrolled: boolean
}

export function CompanyCampaignChip({
  workspaceId,
  contactIds,
}: {
  workspaceId: string
  contactIds:  number[]
}) {
  const router = useRouter()
  const ref    = useRef<HTMLDivElement>(null)
  const [open,      setOpen]      = useState(false)
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null)
  const [loading,   setLoading]   = useState(false)
  const [busy,      setBusy]      = useState<string | null>(null)
  const [newName,   setNewName]   = useState("")
  const [creating,  setCreating]  = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onEsc)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onEsc)
    }
  }, [open])

  async function fetchCampaigns() {
    if (!contactIds[0]) return
    setLoading(true)
    setError(null)
    try {
      const res  = await fetch(`/api/dashboard/${workspaceId}/contacts/${contactIds[0]}/campaigns`)
      const data = await res.json()
      setCampaigns(data.campaigns ?? [])
    } catch {
      setError("Failed to load campaigns")
    } finally {
      setLoading(false)
    }
  }

  function handleOpen(e: React.MouseEvent) {
    e.stopPropagation()
    if (!open) void fetchCampaigns()
    setOpen(o => !o)
  }

  async function toggle(campaign: Campaign) {
    if (busy || contactIds.length === 0) return
    setBusy(campaign.id)
    setError(null)
    try {
      if (campaign.enrolled) {
        await Promise.all(
          contactIds.map(id =>
            fetch(`/api/dashboard/${workspaceId}/contacts/${id}/campaigns/${campaign.id}`, { method: "DELETE" }),
          ),
        )
      } else {
        await Promise.all(
          contactIds.map(id =>
            fetch(`/api/dashboard/${workspaceId}/contacts/${id}/campaigns`, {
              method:  "POST",
              headers: { "Content-Type": "application/json" },
              body:    JSON.stringify({ campaignId: campaign.id }),
            }),
          ),
        )
      }
      setCampaigns(prev =>
        prev?.map(c => c.id === campaign.id ? { ...c, enrolled: !c.enrolled } : c) ?? null,
      )
      router.refresh()
    } catch {
      setError("Failed to update enrollment")
    } finally {
      setBusy(null)
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault()
    e.stopPropagation()
    const name = newName.trim()
    if (!name || creating || !contactIds[0]) return
    setCreating(true)
    setError(null)
    try {
      const res  = await fetch(`/api/dashboard/${workspaceId}/contacts/${contactIds[0]}/campaigns`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ name }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? "Failed"); return }
      setNewName("")
      await fetchCampaigns()
      router.refresh()
    } catch {
      setError("Failed to create campaign")
    } finally {
      setCreating(false)
    }
  }

  if (contactIds.length === 0) return null

  const enrolledCount = campaigns?.filter(c => c.enrolled).length ?? 0

  return (
    <div ref={ref} className="relative flex-shrink-0" onClick={e => e.stopPropagation()}>
      <button
        type="button"
        title={enrolledCount > 0 ? `In ${enrolledCount} campaign${enrolledCount === 1 ? "" : "s"}` : "Add company to campaign"}
        onClick={handleOpen}
        className={`relative inline-flex h-6 w-6 items-center justify-center rounded-[6px] bg-white/[0.06] text-zinc-400 transition-colors hover:text-zinc-200 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60 ${open ? "text-zinc-200" : ""}`}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 12h14" />
          <path d="M12 5v14" />
        </svg>
        {enrolledCount > 0 && (
          <div
            className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#14B8A6] ring-2 ring-[#0D1F1A]"
            aria-hidden
          >
            <span className="text-[7px] font-bold leading-none text-[#0A0A0A] tabular-nums">
              {enrolledCount}
            </span>
          </div>
        )}
      </button>

      {open && (
        <div
          role="menu"
          onClick={e => e.stopPropagation()}
          className="absolute left-0 top-9 z-30 w-60 overflow-hidden rounded-xl border border-white/10 bg-[#0B3D2E] shadow-[0_12px_32px_rgba(0,0,0,0.45)]"
        >
          <div className="border-b border-white/10 px-3.5 py-2">
            <p className="text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">
              Campaigns
            </p>
          </div>

          <div className="max-h-52 overflow-y-auto">
            {loading ? (
              <p className="px-3.5 py-3 text-[12px] text-zinc-500">Loading...</p>
            ) : campaigns?.length === 0 ? (
              <p className="px-3.5 py-3 text-[12px] text-zinc-500">No campaigns yet - create one below.</p>
            ) : (
              campaigns?.map(c => (
                <button
                  key={c.id}
                  type="button"
                  role="menuitem"
                  onClick={() => toggle(c)}
                  disabled={!!busy}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-white/[0.06] disabled:opacity-60"
                >
                  <span
                    className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-[4px] border ${
                      c.enrolled
                        ? "border-[#14B8A6] bg-[#14B8A6]/20"
                        : "border-white/20 bg-transparent"
                    }`}
                  >
                    {c.enrolled && (
                      <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="#14B8A6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <polyline points="1.5,5 4,7.5 8.5,2.5" />
                      </svg>
                    )}
                  </span>
                  <span className={`flex-1 truncate text-[13px] ${c.enrolled ? "font-medium text-white" : "text-zinc-300"}`}>
                    {c.name}
                  </span>
                  {busy === c.id && (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden className="animate-spin text-zinc-400">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                  )}
                </button>
              ))
            )}
          </div>

          <form
            onSubmit={create}
            className="border-t border-white/10 p-2"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="New campaign name..."
                disabled={creating}
                className="min-w-0 flex-1 rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-zinc-200 placeholder-zinc-600 focus:border-[#2BA98B]/40 focus:outline-none focus:ring-1 focus:ring-[#2BA98B]/40 disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!newName.trim() || creating}
                className="flex-shrink-0 rounded-md bg-[#2BA98B] px-2.5 py-1.5 text-[12px] font-semibold text-white hover:bg-[#239977] disabled:opacity-40"
              >
                {creating ? "..." : "Add"}
              </button>
            </div>
            {error && (
              <p className="mt-1.5 text-[11px] text-rose-400">{error}</p>
            )}
          </form>
        </div>
      )}
    </div>
  )
}
