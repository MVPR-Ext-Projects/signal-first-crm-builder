"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import type { CallLogRow } from "@/lib/db/contact-store"

const STAGE_DOT: Record<string, string> = {
  "Prospect":              "#6B7280",
  "Signal Found":          "#DD80A8",
  "Engaged":               "#22C55E",
  "High Signal":           "#EA580C",
  "Discovery Call":        "#38BDF8",
  "Requested Information": "#FBBF24",
  "Follow Up Call":        "#FB923C",
  "Sent Information":      "#818CF8",
  "Diligence":             "#C084FC",
  "Contract Negotiation":  "#34D399",
  "Customer Won":          "#2BA98B",
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "—"
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days === 0) return "today"
  if (days === 1) return "yesterday"
  if (days < 14)  return `${days}d ago`
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" })
}

function ResultToggle({ workspaceId, row }: { workspaceId: string; row: CallLogRow }) {
  const router = useRouter()
  const [connected, setConnected] = useState(row.sourceType === "Call")
  const [busy, setBusy] = useState(false)

  async function toggle() {
    const next = !connected
    setBusy(true)
    await fetch(`/api/dashboard/${workspaceId}/signals/${row.signalId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connected: next }),
    })
    setConnected(next)
    setBusy(false)
    router.refresh()
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      title="Click to toggle"
      className={`inline-flex cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50 ${
        connected
          ? "bg-emerald-500/15 text-emerald-300"
          : "bg-zinc-500/15 text-zinc-400"
      }`}
    >
      {busy ? "…" : connected ? "Connected" : "Voicemail"}
    </button>
  )
}

export function CallLogTable({
  workspaceId,
  rows,
}: {
  workspaceId: string
  rows: CallLogRow[]
}) {
  if (rows.length === 0) return null

  return (
    <details className="border-t border-white/[0.06]">
      <summary className="cursor-pointer px-6 py-3 text-[12px] font-medium text-zinc-500 hover:text-zinc-300 select-none list-none flex items-center gap-2">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="6 9 12 15 18 9" />
        </svg>
        View call log ({rows.length})
      </summary>

      <div className="divide-y divide-white/[0.04]">
        {rows.map((row) => {
          const dot  = STAGE_DOT[row.effectiveStage ?? "Prospect"] ?? "#6B7280"
          const slug = row.linkedinUrl?.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1]
          return (
            <div key={row.signalId} className="px-6 py-4">
              {/* Top row: name + company + toggle */}
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {slug ? (
                      <a
                        href={row.linkedinUrl!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[14px] font-semibold text-white hover:text-[#2BA98B] hover:underline"
                      >
                        {row.fullName ?? "(unknown)"}
                      </a>
                    ) : (
                      <span className="text-[14px] font-semibold text-white">{row.fullName ?? "(unknown)"}</span>
                    )}
                    {row.effectiveStage && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-zinc-400">
                        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: dot }} aria-hidden />
                        {row.effectiveStage}
                      </span>
                    )}
                    {row.signalScore > 0 && (
                      <span className="text-[11px] font-mono tabular-nums text-zinc-500">
                        {row.signalScore} pts
                      </span>
                    )}
                  </div>
                  {row.jobTitle && (
                    <p className="mt-0.5 text-[12px] text-zinc-400 truncate max-w-[480px]">{row.jobTitle}</p>
                  )}
                  {row.companyName && (
                    <p className="text-[12px] text-zinc-500">{row.companyName}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <ResultToggle workspaceId={workspaceId} row={row} />
                  <span className="text-[12px] tabular-nums text-zinc-500">{fmtDate(row.occurredAt)}</span>
                </div>
              </div>

              {/* Notes */}
              {row.notes && (
                <p className="mt-2 text-[12px] leading-[18px] text-zinc-300">{row.notes}</p>
              )}

              {/* Last signal */}
              {row.lastSignalType && (
                <p className="mt-1.5 text-[11px] text-zinc-500">
                  Last signal: {row.lastSignalType} · {fmtRelative(row.lastSignalAt)}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </details>
  )
}
