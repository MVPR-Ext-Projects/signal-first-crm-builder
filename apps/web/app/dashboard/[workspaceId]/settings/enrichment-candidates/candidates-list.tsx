"use client"

/**
 * CandidatesList - renders the list of contacts flagged for re-enrichment
 * and an "Enrich now" affordance on each row. Hits the existing
 * /enrich-contact endpoint (which is Surfe-synchronous, ~30-60s per call)
 * and removes the row from the list on success. Failures show inline
 * without removing the row so the user can try again.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"

export interface Candidate {
  id:          number
  name:        string | null
  jobTitle:    string | null
  companyName: string | null
  linkedinUrl: string | null
  reason:      string | null
  updatedAt:   string
}

type RowState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "error";    message: string }
  | { kind: "done";     summary: string }

export function CandidatesList({
  workspaceId,
  candidates,
  surfeConfigured,
}: {
  workspaceId:     string
  candidates:      Candidate[]
  surfeConfigured: boolean
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [rowStates, setRowStates] = useState<Record<number, RowState>>({})
  // Optimistically hide rows once they finish successfully so the UI feels
  // responsive - the next router.refresh() will replace the server-rendered
  // list with the new state.
  const [hidden, setHidden] = useState<Set<number>>(new Set())

  function setRow(id: number, state: RowState) {
    setRowStates(prev => ({ ...prev, [id]: state }))
  }

  async function enrich(c: Candidate) {
    if (!c.linkedinUrl) {
      setRow(c.id, { kind: "error", message: "No LinkedIn URL on this contact - can't enrich." })
      return
    }
    setRow(c.id, { kind: "running" })
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/enrich-contact`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ linkedinUrl: c.linkedinUrl }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setRow(c.id, { kind: "error", message: data.error ?? `HTTP ${res.status}` })
        return
      }
      const status = data.status as string | undefined
      if (status === "enriched") {
        const summary = data.email ? `Enriched · ${data.email}` : "Enriched"
        setRow(c.id, { kind: "done", summary })
        setHidden(prev => new Set(prev).add(c.id))
      } else if (status === "no_match") {
        setRow(c.id, { kind: "done", summary: "Surfe found no match" })
      } else if (status === "internal_purged") {
        setRow(c.id, { kind: "done", summary: "Internal employee - contact removed" })
        setHidden(prev => new Set(prev).add(c.id))
      } else {
        setRow(c.id, { kind: "done", summary: status ?? "Done" })
      }
      startTransition(() => router.refresh())
    } catch (e) {
      setRow(c.id, { kind: "error", message: e instanceof Error ? e.message : String(e) })
    }
  }

  const visible = candidates.filter(c => !hidden.has(c.id))

  if (candidates.length === 0) {
    return (
      <div className="space-y-6">
        {!surfeConfigured && <SurfeWarning />}
        <EmptyState />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {!surfeConfigured && <SurfeWarning />}
      <p className="text-[13px] text-zinc-400">
        Showing {visible.length} of {candidates.length} flagged contact{candidates.length === 1 ? "" : "s"}.
        Most recently flagged first.
      </p>
      <ul className="divide-y divide-white/10 rounded-2xl border border-white/10 bg-white/[0.02]">
        {visible.map(c => (
          <li key={c.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <p className="truncate text-[14px] font-semibold text-white">
                {c.name ?? "Unnamed contact"}
              </p>
              <p className="truncate text-[12px] text-zinc-400">
                {[c.jobTitle, c.companyName].filter(Boolean).join(" · ") || "No job title or company on file"}
              </p>
              <p className="text-[12px] text-zinc-500">
                <span className="font-medium text-zinc-300">Reason:</span>{" "}
                {c.reason ?? "(no reason recorded)"}
              </p>
              <p className="text-[11px] text-zinc-600">
                Flagged {new Date(c.updatedAt).toLocaleDateString(undefined, {
                  year: "numeric", month: "short", day: "numeric",
                })}
              </p>
            </div>
            <div className="flex flex-shrink-0 flex-col items-stretch gap-1.5 sm:items-end">
              <button
                type="button"
                onClick={() => enrich(c)}
                disabled={!surfeConfigured || !c.linkedinUrl || rowStates[c.id]?.kind === "running"}
                className="rounded-lg border border-[#2BA98B]/40 bg-[#2BA98B]/[0.12] px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-[#2BA98B]/[0.20] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
              >
                {rowStates[c.id]?.kind === "running" ? "Enriching..." : "Enrich now"}
              </button>
              <RowStatus state={rowStates[c.id] ?? { kind: "idle" }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function RowStatus({ state }: { state: RowState }) {
  if (state.kind === "idle" || state.kind === "running") return null
  if (state.kind === "error") {
    return <p className="text-right text-[11px] text-red-400">{state.message}</p>
  }
  return <p className="text-right text-[11px] text-zinc-400">{state.summary}</p>
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-6 py-12 text-center">
      <p className="text-[14px] font-semibold text-white">No contacts flagged for enrichment.</p>
      <p className="mx-auto mt-2 max-w-[480px] text-[13px] text-zinc-400">
        Contacts will land here automatically when a LinkedIn URL stops resolving,
        a corporate email goes stale, or a call note flags that someone has left
        the company. None of those triggers have fired yet for this workspace.
      </p>
    </div>
  )
}

function SurfeWarning() {
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-4 py-3 text-[13px] text-amber-100">
      Surfe isn&rsquo;t configured for this workspace. Add a Surfe API key on the
      Enrichment providers page before running enrichments here.
    </div>
  )
}
