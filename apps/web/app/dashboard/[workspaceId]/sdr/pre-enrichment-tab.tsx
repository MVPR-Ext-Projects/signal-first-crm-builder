"use client"

import { Fragment, useState } from "react"
import type { CSSProperties } from "react"
import { useRouter } from "next/navigation"
import { useToast } from "../toast"
import { ManualContactEdit, ManualEditIcon } from "../components/manual-contact-edit"
import { DncToggleButton } from "../components/dnc-toggle-button"
import type { FunnelStage, Lead } from "./lead-types"

// Stage tokens aligned with lead-table-row.tsx so the For-enrichment table
// reads as the same surface as People / Persona Match.
const STAGE_AVATAR: Record<FunnelStage, { bg: string; fg: string }> = {
  Prospect:                { bg: "rgba(156,163,175,0.16)", fg: "#9CA3AF" },
  "Signal Found":          { bg: "rgba(147,197,253,0.16)", fg: "#93C5FD" },
  Engaged:                 { bg: "rgba(43,169,139,0.16)",  fg: "#2BA98B" },
  "High Signal":           { bg: "rgba(16,185,129,0.16)",  fg: "#10B981" },
  "Discovery Call":        { bg: "rgba(245,158,11,0.16)",  fg: "#F59E0B" },
  "Requested Information": { bg: "rgba(251,191,36,0.16)",  fg: "#FBBF24" },
  "Follow Up Call":        { bg: "rgba(251,146,60,0.16)",  fg: "#FB923C" },
  "Sent Information":      { bg: "rgba(129,140,248,0.16)", fg: "#818CF8" },
  "Diligence":             { bg: "rgba(192,132,252,0.16)", fg: "#C084FC" },
  "Contract Negotiation":  { bg: "rgba(52,211,153,0.16)",  fg: "#34D399" },
  "Customer Won":          { bg: "rgba(167,139,250,0.16)", fg: "#C4B5FD" },
}

const STAGE_PILL: Record<FunnelStage, { bg: string; fg: string; dot: string }> = {
  Prospect:                { bg: "rgba(156,163,175,0.16)", fg: "#9CA3AF", dot: "#9CA3AF" },
  "Signal Found":          { bg: "rgba(147,197,253,0.16)", fg: "#93C5FD", dot: "#93C5FD" },
  Engaged:                 { bg: "rgba(43,169,139,0.16)",  fg: "#2BA98B", dot: "#2BA98B" },
  "High Signal":           { bg: "rgba(16,185,129,0.16)",  fg: "#10B981", dot: "#10B981" },
  "Discovery Call":        { bg: "rgba(245,158,11,0.16)",  fg: "#F59E0B", dot: "#F59E0B" },
  "Requested Information": { bg: "rgba(251,191,36,0.16)",  fg: "#FBBF24", dot: "#FBBF24" },
  "Follow Up Call":        { bg: "rgba(251,146,60,0.16)",  fg: "#FB923C", dot: "#FB923C" },
  "Sent Information":      { bg: "rgba(129,140,248,0.16)", fg: "#818CF8", dot: "#818CF8" },
  "Diligence":             { bg: "rgba(192,132,252,0.16)", fg: "#C084FC", dot: "#C084FC" },
  "Contract Negotiation":  { bg: "rgba(52,211,153,0.16)",  fg: "#34D399", dot: "#34D399" },
  "Customer Won":          { bg: "rgba(167,139,250,0.16)", fg: "#C4B5FD", dot: "#A78BFA" },
}

// Display-only label overrides. DB values stay unchanged.
const STAGE_DISPLAY_LABEL: Partial<Record<FunnelStage, string>> = {
  "High Signal":    "Highly engaged",
  "Discovery Call": "Ambassadors",
}

const ICP_GROUP_PALETTE: Record<string, { bg: string; fg: string }> = {
  Issuer:               { bg: "rgba(245,158,11,0.10)",  fg: "#F59E0B" },
  "Liquidity Provider": { bg: "rgba(167,139,250,0.10)", fg: "#A78BFA" },
  Exchange:             { bg: "rgba(244,114,182,0.10)", fg: "#F472B6" },
  "Payment Provider":   { bg: "rgba(43,169,139,0.10)",  fg: "#2BA98B" },
}

function initials(name: string | null): string {
  if (!name) return "·"
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0]?.toUpperCase() ?? "")
    .join("") || "·"
}

const SOURCE_LABELS: Record<string, string> = {
  "Visited Company Page":  "Profile view",
  "New Connection":        "Connected",
  "Post Reaction":         "Post reaction",
  "Post Comment":          "Post comment",
  "Followed Company Page": "Followed",
  "Private Message Sent":  "DM sent",
  "AI Search":             "AI search",
}

const SOURCE_DOTS: Record<string, string> = {
  "Visited Company Page":  "bg-blue-400",
  "New Connection":        "bg-emerald-400",
  "Post Reaction":         "bg-violet-400",
  "Post Comment":          "bg-violet-300",
  "Followed Company Page": "bg-amber-400",
  "Private Message Sent":  "bg-zinc-500",
  "AI Search":             "bg-rose-400",
}

function formatDate(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  const ms = Date.now() - d.getTime()
  const day = 86_400_000
  if (ms < day) {
    const hours = Math.floor(ms / 3_600_000)
    if (hours < 1) return "just now"
    return hours === 1 ? "1 hr ago" : `${hours} hrs ago`
  }
  if (ms < 7 * day) {
    const days = Math.floor(ms / day)
    return days === 1 ? "yesterday" : `${days} days ago`
  }
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
}

function Chevron({ open }: { open: boolean }) {
  const style: CSSProperties = {
    transform: open ? "rotate(90deg)" : "rotate(0deg)",
    transition: "transform 150ms ease",
  }
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="text-zinc-500 flex-shrink-0"
      style={style}
      aria-hidden
    >
      <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Total column count in the data row — used by colSpan on the expanded row.
// 1 checkbox + 5 display columns + 1 enrich = 7
const TABLE_COLSPAN = 7

function shortenUrl(url: string): string {
  return url
    .replace("https://www.linkedin.com/", "li/")
    .replace("https://linkedin.com/", "li/")
    .replace(/\?.*$/, "")
}

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()

export function PreEnrichmentTab({
  workspaceId,
  leads,
}: {
  workspaceId: string
  leads: Lead[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<Set<string>>(new Set())
  // Tracks which rows have the manual-edit form open. Separate from `open`
  // (row expansion) because the form can be opened from the pen-and-paper
  // icon next to the name, which also forces the row to expand. Closing
  // the form does not collapse the row.
  const [editing, setEditing] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [bulkBusy, setBulkBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  function toggleOpen(id: string) {
    const next = new Set(open)
    if (next.has(id)) next.delete(id); else next.add(id)
    setOpen(next)
  }

  function openEditFor(id: string) {
    setOpen(prev => prev.has(id) ? prev : new Set(prev).add(id))
    setEditing(prev => prev.has(id) ? prev : new Set(prev).add(id))
  }
  function closeEditFor(id: string) {
    setEditing(prev => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const allSelected   = leads.length > 0 && selected.size === leads.length
  const someSelected  = selected.size > 0

  function toggleAll() {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(leads.map(l => l.recordId)))
  }
  function toggleOne(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id); else next.add(id)
    setSelected(next)
  }

  async function enrichOne(linkedinUrl: string, recordId: string, displayName?: string | null) {
    setBusy(b => ({ ...b, [recordId]: true }))
    setError(null)
    const label = displayName?.trim() || "contact"
    toast.info("Enriching", `Surfe lookup running for ${label}…`)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/enrich-contact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkedinUrl }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const body = await res.json().catch(() => ({})) as { status?: string; credits?: number }
      if (body.status === "no_match") {
        toast.info("No match", `Surfe didn't find ${label}.`)
      } else if (body.status === "internal_purged") {
        toast.info("Internal employee", `${label} matched your internal filter and was purged.`)
      } else {
        toast.success("Enriched", `${label} updated${body.credits ? ` · ${body.credits} credit${body.credits === 1 ? "" : "s"} used` : ""}.`)
      }
      router.refresh()
    } catch (e) {
      const msg = (e as Error).message
      setError(msg)
      toast.error("Enrich failed", msg)
    } finally {
      setBusy(b => ({ ...b, [recordId]: false }))
    }
  }

  async function enrichSelected() {
    const targets = leads.filter(l => selected.has(l.recordId) && l.linkedin)
    if (targets.length === 0) return
    if (!window.confirm(
      `Enrich ${targets.length} contact${targets.length === 1 ? "" : "s"} via Surfe?\n\n` +
      `Each successful match consumes one Surfe credit. Internal employees ` +
      `revealed by enrichment will be auto-purged.`,
    )) return

    setBulkBusy(true)
    setError(null)
    setProgress({ done: 0, total: targets.length })
    toast.info("Bulk enrich started", `Running Surfe across ${targets.length} contact${targets.length === 1 ? "" : "s"}…`)
    let done = 0
    let failed = 0
    for (const lead of targets) {
      try {
        const res = await fetch(`/api/dashboard/${workspaceId}/enrich-contact`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ linkedinUrl: lead.linkedin }),
        })
        if (!res.ok) failed++
      } catch {
        failed++
      }
      done++
      setProgress({ done, total: targets.length })
    }
    setBulkBusy(false)
    setProgress(null)
    setSelected(new Set())
    if (failed === 0) {
      toast.success("Bulk enrich complete", `${done} contact${done === 1 ? "" : "s"} processed.`)
    } else {
      toast.error("Bulk enrich finished with errors", `${done - failed} of ${done} succeeded.`)
    }
    router.refresh()
  }

  if (leads.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-2xl border border-white/10 bg-white/[0.03] py-20">
        <p className="text-[14px] text-zinc-400">
          Everyone with signals has been enriched. New TF webhook events will land here.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* Bulk action bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-[13px] text-zinc-400">
          {someSelected ? `${selected.size} selected` : `${leads.length} unenriched`}
        </div>
        <div className="flex items-center gap-3">
          {error && <span className="text-[12px] text-rose-400">{error}</span>}
          {progress && (
            <span className="text-[12px] text-zinc-400 tabular-nums">
              {progress.done} / {progress.total}
            </span>
          )}
          <button
            type="button"
            onClick={enrichSelected}
            disabled={bulkBusy || !someSelected}
            className="rounded-lg bg-[#2BA98B] px-4 py-2 text-[13px] font-bold text-white transition-colors hover:bg-[#239977] disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60"
          >
            {bulkBusy ? `Enriching ${progress?.done ?? 0}/${progress?.total ?? 0}…` : `Enrich ${someSelected ? selected.size : "selected"}`}
          </button>
        </div>
      </div>

      {/* Table — same surface tokens as the People / Persona Match table.
          A leading checkbox column and a trailing Enrich column are the only
          additions. Email column is omitted because every row is by-definition
          email-less. */}
      <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.03]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/[0.08]">
              <th className="px-4 py-3.5 w-[44px]">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="h-3.5 w-3.5 rounded border-white/20 bg-white/[0.04] accent-[#2BA98B]"
                  aria-label="Select all"
                />
              </th>
              <th className="px-5 py-3.5 text-left text-[12px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Person · Company</th>
              <th className="hidden md:table-cell px-3 py-3.5 text-left text-[12px] font-bold uppercase tracking-[0.10em] text-[#2BA98B] w-[88px]">Links</th>
              <th className="hidden md:table-cell px-3 py-3.5 text-left text-[12px] font-bold uppercase tracking-[0.10em] text-[#2BA98B] w-[140px]">Stage</th>
              <th className="hidden xl:table-cell px-3 py-3.5 text-left text-[12px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Latest signal</th>
              <th className="px-5 py-3.5 text-right text-[12px] font-bold uppercase tracking-[0.10em] text-[#2BA98B] w-[88px]">Score</th>
              <th className="px-3 py-3.5 text-right text-[12px] font-bold uppercase tracking-[0.10em] text-[#2BA98B] w-[100px]"></th>
            </tr>
          </thead>
          <tbody>
            {leads.map(lead => {
              const canExpand    = lead.signals.length > 0
              const isOpen       = open.has(lead.recordId)
              const avatar       = STAGE_AVATAR[lead.stage]
              const stagePill    = STAGE_PILL[lead.stage]
              const latestSignal = lead.signals[0] ?? null
              const latestLabel  = latestSignal?.source ? (SOURCE_LABELS[latestSignal.source] ?? latestSignal.source) : null
              return (
                <Fragment key={lead.recordId}>
                <tr
                  className={`border-b border-white/[0.06] transition-colors motion-reduce:transition-none ${canExpand ? "cursor-pointer hover:bg-white/[0.04]" : ""} ${isOpen ? "bg-[#2BA98B]/[0.06]" : ""}`}
                  onClick={() => canExpand && toggleOpen(lead.recordId)}
                >
                  {/* Checkbox */}
                  <td className="px-4 py-4" onClick={stop}>
                    <input
                      type="checkbox"
                      checked={selected.has(lead.recordId)}
                      onChange={() => toggleOne(lead.recordId)}
                      onClick={stop}
                      className="h-3.5 w-3.5 rounded border-white/20 bg-white/[0.04] accent-[#2BA98B]"
                      aria-label={`Select ${lead.fullName ?? "contact"}`}
                    />
                  </td>

                  {/* Person · Company — chevron + stage-tinted avatar */}
                  <td className="px-5 py-4 max-w-[320px]">
                    <div className="flex items-center gap-3.5">
                      <div className="pt-0.5">
                        {canExpand ? <Chevron open={isOpen} /> : <span className="block w-3" />}
                      </div>
                      <div
                        className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-[13px] font-bold"
                        style={{ backgroundColor: avatar.bg, color: avatar.fg }}
                        aria-hidden
                      >
                        {initials(lead.fullName)}
                      </div>
                      <div className="min-w-0 flex flex-col gap-0.5">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <p className="truncate text-[15px] font-semibold text-white">
                            {lead.fullName ?? "-"}
                          </p>
                          {lead.contactId !== null && (
                            <ManualEditIcon onClick={() => openEditFor(lead.recordId)} />
                          )}
                        </div>
                        <p
                          className="truncate text-[13px] text-zinc-400"
                          title={[lead.jobTitle, lead.company].filter(Boolean).join(" · ") || undefined}
                        >
                          {[lead.jobTitle, lead.company].filter(Boolean).join(" · ") || "—"}
                          {lead.icpGroup && (
                            <span
                              className="ml-2 inline-flex items-center rounded-full px-2 py-0 align-middle text-[10px] font-semibold"
                              style={{
                                backgroundColor: ICP_GROUP_PALETTE[lead.icpGroup]?.bg ?? "rgba(147,197,253,0.10)",
                                color:           ICP_GROUP_PALETTE[lead.icpGroup]?.fg ?? "#93C5FD",
                              }}
                            >
                              {lead.icpGroup}
                            </span>
                          )}
                        </p>
                      </div>
                    </div>
                  </td>

                  {/* Links — LinkedIn + X / Twitter (no CRM record yet pre-enrichment) */}
                  <td className="hidden md:table-cell px-3 py-4 w-[88px]">
                    <div className="flex items-center gap-1.5">
                      {lead.linkedin && (
                        <a
                          href={lead.linkedin}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={stop}
                          title="LinkedIn profile"
                          aria-label="LinkedIn profile"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/10 text-zinc-300 transition-colors hover:border-[#2BA98B]/40 hover:bg-[#2BA98B]/[0.10] hover:text-white motion-reduce:transition-none"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                            <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.268 2.37 4.268 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
                          </svg>
                        </a>
                      )}
                      {lead.twitterUrl && (
                        <a
                          href={lead.twitterUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={stop}
                          title="X / Twitter profile"
                          aria-label="X / Twitter profile"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/10 text-zinc-300 transition-colors hover:border-[#2BA98B]/40 hover:bg-[#2BA98B]/[0.10] hover:text-white motion-reduce:transition-none"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                          </svg>
                        </a>
                      )}
                    </div>
                  </td>

                  {/* Stage pill — same hex tokens as People */}
                  <td className="hidden md:table-cell px-3 py-4 w-[140px]">
                    <span
                      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium whitespace-nowrap"
                      style={{ backgroundColor: stagePill.bg, color: stagePill.fg }}
                    >
                      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: stagePill.dot }} aria-hidden />
                      {STAGE_DISPLAY_LABEL[lead.stage] ?? lead.stage}
                    </span>
                  </td>

                  {/* Latest signal */}
                  <td className="hidden xl:table-cell px-3 py-4 max-w-[260px]">
                    {latestSignal ? (
                      <div className="flex flex-col gap-0.5">
                        <span className="truncate text-[13px] text-zinc-200">{latestLabel}</span>
                        <span className="text-[12px] text-zinc-400">{formatDate(latestSignal.date)}</span>
                      </div>
                    ) : (
                      <span className="text-[13px] text-zinc-500">—</span>
                    )}
                  </td>

                  {/* Score */}
                  <td className="px-5 py-4 text-right whitespace-nowrap w-[88px]">
                    <div className="flex flex-col items-end gap-0.5">
                      <span className="text-[22px] font-bold leading-none tracking-[-0.02em] text-white tabular-nums">{lead.score}</span>
                      <span className="text-[11px] text-zinc-500 tabular-nums">/{lead.signalCount}</span>
                    </div>
                  </td>

                  {/* Enrich button + last-attempt status (so users know
                      whether Surfe was tried and what came back). */}
                  <td className="px-3 py-4 text-right" onClick={stop}>
                    {lead.linkedin ? (
                      <div className="flex flex-col items-end gap-1">
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); enrichOne(lead.linkedin!, lead.recordId, lead.fullName) }}
                          disabled={busy[lead.recordId] || bulkBusy}
                          className="rounded-lg border border-white/14 bg-white/[0.04] px-3 py-1.5 text-[12px] font-semibold text-zinc-100 transition-colors hover:border-[#2BA98B]/40 hover:bg-[#2BA98B]/[0.10] hover:text-white disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60"
                        >
                          {busy[lead.recordId] ? "Enriching…" : (lead.lastEnrichmentStatus ? "Retry" : "Enrich")}
                        </button>
                        <EnrichmentStatusLabel
                          status={lead.lastEnrichmentStatus}
                          when={lead.lastEnrichmentAt}
                        />
                      </div>
                    ) : (
                      <span className="text-[11px] text-zinc-600" title="No LinkedIn URL on this contact — can't enrich. Open the row and add one to manually input data.">
                        no LinkedIn
                      </span>
                    )}
                  </td>
                </tr>

                {isOpen && canExpand && (
                  <tr className="bg-black/20">
                    <td colSpan={TABLE_COLSPAN} className="px-7 py-7 border-b border-white/[0.06]">
                      <div className="space-y-3">
                        <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">
                          Engagement history · {lead.signals.length} of {lead.signalCount} most recent
                        </p>
                        <ul className="divide-y divide-white/[0.06] overflow-hidden rounded-xl border border-white/[0.06]">
                          {lead.signals.map((s, i) => {
                            const dotCls = s.source ? (SOURCE_DOTS[s.source] ?? "bg-zinc-500") : "bg-zinc-700"
                            return (
                              <li key={i} className="flex items-start gap-3 px-4 py-2.5 hover:bg-white/[0.02]">
                                <span
                                  className={`mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full ${dotCls}`}
                                  aria-hidden
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-baseline justify-between gap-3">
                                    <span className="text-[13px] font-medium text-zinc-100">
                                      {s.source ? (SOURCE_LABELS[s.source] ?? s.source) : "Unknown signal"}
                                    </span>
                                    <span className="text-[11px] text-zinc-500 tabular-nums">
                                      {formatDate(s.date)}
                                    </span>
                                  </div>
                                  {s.description && s.url ? (
                                    <a
                                      href={s.url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={stop}
                                      className="mt-0.5 inline-block text-[12px] leading-snug text-zinc-400 hover:text-[#2BA98B] hover:underline underline-offset-2"
                                      title={s.url}
                                    >
                                      {s.description}
                                    </a>
                                  ) : s.description ? (
                                    <p className="mt-0.5 text-[12px] leading-snug text-zinc-400">
                                      {s.description}
                                    </p>
                                  ) : s.url ? (
                                    <a
                                      href={s.url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={stop}
                                      className="mt-1 inline-block break-all text-[11px] text-[#2BA98B] hover:underline"
                                      title={s.url}
                                    >
                                      {shortenUrl(s.url)}
                                    </a>
                                  ) : null}
                                </div>
                              </li>
                            )
                          })}
                        </ul>
                        {lead.contactId !== null && (
                          <div className="mt-3">
                            <DncToggleButton
                              workspaceId={workspaceId}
                              contactId={lead.contactId}
                              doNotContactUntil={lead.doNotContactUntil}
                            />
                          </div>
                        )}
                        {lead.contactId !== null && editing.has(lead.recordId) && (
                          <ManualContactEdit
                            workspaceId={workspaceId}
                            contactId={lead.contactId}
                            initial={{
                              email:             lead.email,
                              linkedinUrl:       lead.linkedin,
                              twitterUrl:        lead.twitterUrl,
                              jobTitle:          lead.jobTitle,
                              fullName:          lead.fullName,
                              companyName:       lead.company,
                              linkedinConnected: lead.linkedinConnected ?? null,
                            }}
                            onClose={() => closeEditFor(lead.recordId)}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Enrichment status label ────────────────────────────────────────────────
//
// Surfaces the result of the last Surfe attempt under the Enrich button so
// users can see WHY a contact still doesn't have an email — vs. assuming
// the enrichment never ran. "no_match" = Surfe didn't find one;
// "internal_purged" = matched as the workspace's own employee and removed
// (so the row probably shouldn't be visible at all, but defensive label).

function EnrichmentStatusLabel({
  status,
  when,
}: {
  status: string | null
  when:   string | null
}) {
  if (!status) return null
  const ago  = when ? formatRelative(when) : null
  const text = status === "enriched"        ? `enriched${ago ? ` · ${ago}` : ""}`
            : status === "no_match"         ? `no email found${ago ? ` · ${ago}` : ""}`
            : status === "internal_purged"  ? "internal — purged"
            : `${status}${ago ? ` · ${ago}` : ""}`
  const colour = status === "no_match" || status === "internal_purged"
    ? "text-amber-300/70"
    : status === "enriched"
      ? "text-emerald-300/70"
      : "text-zinc-500"
  return (
    <span className={`text-[10px] ${colour}`}>{text}</span>
  )
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime()
  const ms = Date.now() - t
  if (ms < 60_000)     return "just now"
  if (ms < 3600_000)   return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3600_000)}h ago`
  if (ms < 2_592_000_000) return `${Math.floor(ms / 86_400_000)}d ago`
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
}

// ManualContactEdit + the Field helper have moved to the shared component
// at ../components/manual-contact-edit so the SDR view can use them too.
