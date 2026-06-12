"use client"

import React, { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef } from "react"

type ContactRef = { id: number; companyName: string | null }

interface SelectionCtx {
  selected:             Set<number>
  selectedCompanies:    Set<string>
  toggle:               (ref: ContactRef) => void
  toggleMany:           (refs: ContactRef[]) => void
  selectAll:            (refs: ContactRef[]) => void
  clearAll:             () => void
  isSelected:           (id: number) => boolean
}

const Ctx = createContext<SelectionCtx | null>(null)

export function useCompanySelection() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error("useCompanySelection used outside SelectionProvider")
  return ctx
}

export function SelectionProvider({ children }: { children: React.ReactNode }) {
  const [selected,  setSelected]  = useState<Map<number, string | null>>(new Map())

  const toggle = useCallback((ref: ContactRef) => {
    setSelected(p => {
      const n = new Map(p)
      if (n.has(ref.id)) n.delete(ref.id)
      else n.set(ref.id, ref.companyName)
      return n
    })
  }, [])

  const toggleMany = useCallback((refs: ContactRef[]) => {
    setSelected(p => {
      const n = new Map(p)
      const allIn = refs.every(r => n.has(r.id))
      refs.forEach(r => {
        if (allIn) n.delete(r.id)
        else n.set(r.id, r.companyName)
      })
      return n
    })
  }, [])

  const selectAll  = useCallback((refs: ContactRef[]) => {
    setSelected(new Map(refs.map(r => [r.id, r.companyName])))
  }, [])
  const clearAll   = useCallback(() => setSelected(new Map()), [])

  const selectedIds = useMemo(() => new Set(selected.keys()), [selected])
  const isSelected  = useCallback((id: number) => selectedIds.has(id), [selectedIds])

  const selectedCompanies = useMemo(() => {
    const s = new Set<string>()
    for (const name of selected.values()) {
      if (name && name.trim().length > 0) s.add(name)
    }
    return s
  }, [selected])

  return (
    <Ctx.Provider value={{ selected: selectedIds, selectedCompanies, toggle, toggleMany, selectAll, clearAll, isSelected }}>
      {children}
    </Ctx.Provider>
  )
}

export function SelectionHeaderCheckbox({ allContacts }: { allContacts: ContactRef[] }) {
  const { selected, selectAll, clearAll } = useCompanySelection()
  const allSelected  = allContacts.length > 0 && allContacts.every(r => selected.has(r.id))
  const someSelected = !allSelected && allContacts.some(r => selected.has(r.id))
  return (
    <input
      type="checkbox"
      checked={allSelected}
      ref={(el) => { if (el) el.indeterminate = someSelected }}
      onChange={e => e.target.checked ? selectAll(allContacts) : clearAll()}
      onClick={e => e.stopPropagation()}
      className="h-3.5 w-3.5 cursor-pointer rounded accent-[#2BA98B]"
      title={allSelected ? "Deselect all" : "Select all contacts on this page"}
      aria-label={allSelected ? "Deselect all contacts" : "Select all contacts on this page"}
    />
  )
}

export function CompanyCheckbox({ contactIds, companyName }: { contactIds: number[]; companyName: string | null }) {
  const { selected, toggleMany } = useCompanySelection()
  const refs = useMemo(() => contactIds.map(id => ({ id, companyName })), [contactIds, companyName])
  const allSelected  = refs.length > 0 && refs.every(r => selected.has(r.id))
  const someSelected = !allSelected && refs.some(r => selected.has(r.id))
  return (
    <input
      type="checkbox"
      checked={allSelected}
      ref={(el) => { if (el) el.indeterminate = someSelected }}
      onChange={() => toggleMany(refs)}
      onClick={e => e.stopPropagation()}
      className="h-3.5 w-3.5 cursor-pointer rounded accent-[#2BA98B]"
      title={allSelected ? "Deselect all contacts in this company" : "Select all contacts in this company"}
    />
  )
}

export function ContactCheckbox({ contactId, companyName }: { contactId: number; companyName: string | null }) {
  const { isSelected, toggle } = useCompanySelection()
  return (
    <input
      type="checkbox"
      checked={isSelected(contactId)}
      onChange={() => toggle({ id: contactId, companyName })}
      onClick={e => e.stopPropagation()}
      className="h-3.5 w-3.5 cursor-pointer rounded accent-[#2BA98B]"
      aria-label="Select contact"
    />
  )
}

export function SelectionActionBar({
  workspaceId,
}: {
  workspaceId: string
}) {
  const { selected, selectedCompanies, clearAll } = useCompanySelection()
  const [campaignOpen,    setCampaignOpen]    = useState(false)
  const [campaigns,       setCampaigns]       = useState<{ id: string; name: string }[] | null>(null)
  const [loading,         setLoading]         = useState(false)
  const [busy,            setBusy]            = useState(false)
  const [error,           setError]           = useState<string | null>(null)
  const ref            = useRef<HTMLDivElement>(null)
  const count          = selected.size
  const companyCount   = selectedCompanies.size

  useEffect(() => {
    if (!campaignOpen || campaigns !== null) return
    setLoading(true)
    fetch(`/api/dashboard/${workspaceId}/campaigns`)
      .then(r => r.json())
      .then(d => setCampaigns(d.campaigns ?? []))
      .catch(() => setError("Failed to load campaigns"))
      .finally(() => setLoading(false))
  }, [campaignOpen, workspaceId, campaigns])

  useEffect(() => {
    if (!campaignOpen) return
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) {
        setCampaignOpen(false)
      }
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [campaignOpen])

  if (count === 0) return null

  async function addToCampaign(campaignId: string) {
    setBusy(true)
    setError(null)
    try {
      await Promise.all(
        [...selected].map(id =>
          fetch(`/api/dashboard/${workspaceId}/contacts/${id}/campaigns`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ campaignId }),
          })
        )
      )
      setCampaignOpen(false)
      clearAll()
    } catch {
      setError("Failed to enrol contacts")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2" ref={ref}>
      <div className="flex items-center gap-3 rounded-2xl border border-white/20 bg-[#0D2B20] px-5 py-3 shadow-[0_8px_40px_rgba(0,0,0,0.6)]">
        <span className="text-[13px] font-medium text-white tabular-nums">
          {count} contact{count === 1 ? "" : "s"} selected
          {companyCount > 0 && (
            <span className="ml-1 text-zinc-400">
              ({companyCount} {companyCount === 1 ? "company" : "companies"})
            </span>
          )}
        </span>
        <button onClick={clearAll} className="text-[12px] text-zinc-400 transition-colors hover:text-zinc-200">
          Clear
        </button>
        <div className="relative">
          <button
            onClick={() => { setCampaignOpen(o => !o) }}
            disabled={busy}
            className="rounded-lg bg-[#2BA98B] px-4 py-1.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Add to campaign
          </button>
          {campaignOpen && (
            <div className="absolute bottom-10 left-0 w-60 overflow-hidden rounded-xl border border-white/10 bg-[#0B3D2E] shadow-[0_12px_32px_rgba(0,0,0,0.5)]">
              <div className="border-b border-white/10 px-3.5 py-2">
                <p className="text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Choose campaign</p>
              </div>
              {loading ? (
                <p className="px-3.5 py-3 text-[12px] text-zinc-500">Loading...</p>
              ) : campaigns?.length === 0 ? (
                <p className="px-3.5 py-3 text-[12px] text-zinc-500">No campaigns yet.</p>
              ) : (
                campaigns?.map(c => (
                  <button
                    key={c.id}
                    onClick={() => addToCampaign(c.id)}
                    disabled={busy}
                    className="flex w-full items-center px-3.5 py-2.5 text-left text-[13px] text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-white disabled:opacity-60"
                  >
                    {c.name}
                  </button>
                ))
              )}
              {error && <p className="border-t border-white/10 px-3.5 py-2 text-[12px] text-red-400">{error}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
