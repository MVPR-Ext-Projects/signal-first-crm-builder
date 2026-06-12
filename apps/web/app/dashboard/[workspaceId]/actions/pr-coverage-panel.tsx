"use client"

/**
 * PrCoveragePanel - the upstream PR section that sits at the top of /actions.
 *
 * Coverage flows in from MVPR via the /api/cron/mvpr-coverage-sync cron
 * (see lib/mvpr-sync.ts). This panel renders the latest articles with
 * filters (topic, publication, organic vs placed) and a click-through
 * detail drawer.
 *
 * Click actions ("Use in new campaign" / "Attach to existing") land in
 * PR 4 of the series - this panel is read-only for now.
 */

import { useMemo, useState } from "react"
import type { CoverageRow } from "@/lib/db/coverage"
import { CoverageDetailDrawer } from "./coverage-detail-drawer"

type OrganicFilter = "all" | "organic" | "placed"

export function PrCoveragePanel({
  workspaceId,
  initial,
  isConfigured,
  usageCounts,
}: {
  workspaceId:  string
  initial:      CoverageRow[]
  isConfigured: boolean
  /** Per-coverage campaign-attachment count keyed by mvprId. */
  usageCounts?: Record<string, number>
}) {
  const [topic,        setTopic]        = useState<string | null>(null)
  const [publication,  setPublication]  = useState<string | null>(null)
  const [organic,      setOrganic]      = useState<OrganicFilter>("all")
  const [selectedId,   setSelectedId]   = useState<string | null>(null)

  // Derive the unique topic + publication options from the dataset we have.
  // Cheap on the client; saves a round-trip vs. asking the server for them.
  const topicOptions = useMemo(() => {
    const set = new Set<string>()
    for (const c of initial) for (const t of c.topics) set.add(t)
    return Array.from(set).sort()
  }, [initial])

  const publicationOptions = useMemo(() => {
    const set = new Set<string>()
    for (const c of initial) set.add(c.publicationName)
    return Array.from(set).sort()
  }, [initial])

  const filtered = useMemo(() => {
    return initial.filter(c => {
      if (topic       && !c.topics.includes(topic))    return false
      if (publication && c.publicationName !== publication) return false
      if (organic === "organic" && !c.isOrganic) return false
      if (organic === "placed"  &&  c.isOrganic) return false
      return true
    })
  }, [initial, topic, publication, organic])

  return (
    <div className="border-t border-white/[0.06]">
      {!isConfigured && (
        <p className="px-6 py-6 text-[13px] text-zinc-300">
          No PR source connected yet. Open Edit settings to paste your MVPR API key and start syncing coverage every 6 hours.
        </p>
      )}

      {isConfigured && initial.length === 0 && (
        <p className="px-6 py-10 text-[13px] text-zinc-400">
          No coverage synced yet. Hit Sync now in Edit settings, or wait for the next scheduled pull.
        </p>
      )}

      {isConfigured && initial.length > 0 && (
        <>
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.06] px-6 py-4">
            <select
              value={topic ?? ""}
              onChange={e => setTopic(e.target.value || null)}
              className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-zinc-200 focus:border-white/24 focus:outline-none"
              aria-label="Filter by topic"
            >
              <option value="">All topics</option>
              {topicOptions.map(t => <option key={t} value={t}>{t}</option>)}
            </select>

            <select
              value={publication ?? ""}
              onChange={e => setPublication(e.target.value || null)}
              className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-zinc-200 focus:border-white/24 focus:outline-none"
              aria-label="Filter by publication"
            >
              <option value="">All publications</option>
              {publicationOptions.map(p => <option key={p} value={p}>{p}</option>)}
            </select>

            <div className="inline-flex rounded-lg border border-white/10 bg-white/[0.04] p-0.5 text-[12px]" role="group" aria-label="Filter by coverage type">
              {(["all", "organic", "placed"] as OrganicFilter[]).map(opt => {
                const active = organic === opt
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setOrganic(opt)}
                    aria-pressed={active}
                    className={`rounded-md px-2.5 py-1 capitalize transition-colors motion-reduce:transition-none ${
                      active
                        ? "bg-white/[0.10] font-semibold text-white"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    {opt}
                  </button>
                )
              })}
            </div>

            <p className="ml-auto text-[12px] text-zinc-500 tabular-nums">
              {filtered.length} of {initial.length}
            </p>
          </div>

          {/* List */}
          <ul className="max-h-[520px] divide-y divide-white/[0.04] overflow-y-auto">
            {filtered.length === 0 ? (
              <li className="px-6 py-10 text-[13px] text-zinc-400">No coverage matches these filters.</li>
            ) : (
              filtered.map(c => (
                <li key={c.mvprId}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(c.mvprId)}
                    className="grid w-full grid-cols-[56px_minmax(0,1fr)_auto] items-center gap-4 px-6 py-3 text-left transition-colors hover:bg-white/[0.03] focus-visible:bg-white/[0.04] focus-visible:outline-none motion-reduce:transition-none"
                  >
                    {/* Image */}
                    <div className="h-14 w-14 flex-shrink-0 overflow-hidden rounded-lg bg-white/[0.04]">
                      {c.image
                        ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={c.image} alt="" className="h-full w-full object-cover" loading="lazy" />
                        )
                        : null
                      }
                    </div>

                    {/* Title + meta */}
                    <div className="min-w-0">
                      <p className="truncate text-[14px] font-semibold text-white">{c.title}</p>
                      <p className="mt-0.5 truncate text-[12px] text-zinc-400">
                        <span className="text-zinc-300">{c.publicationName}</span>
                        <span className="mx-1.5 text-zinc-600">·</span>
                        {c.journalistName}
                        <span className="mx-1.5 text-zinc-600">·</span>
                        {formatDate(c.publishedAt)}
                      </p>
                    </div>

                    {/* Right-side chips */}
                    <div className="flex flex-shrink-0 items-center gap-2">
                      {usageCounts && usageCounts[c.mvprId] > 0 && (
                        <span
                          title={`Used in ${usageCounts[c.mvprId]} campaign${usageCounts[c.mvprId] === 1 ? "" : "s"}`}
                          className="inline-flex items-center justify-center rounded-md bg-[#2BA98B]/[0.16] px-2 py-0.5 text-[11px] font-bold tabular-nums text-emerald-200"
                        >
                          Used in {usageCounts[c.mvprId]}
                        </span>
                      )}
                      {c.domainAuthority != null && (
                        <span
                          title="Domain Authority"
                          className="inline-flex items-center justify-center rounded-md bg-white/[0.06] px-2 py-0.5 text-[11px] font-bold tabular-nums text-zinc-200"
                        >
                          DA {c.domainAuthority}
                        </span>
                      )}
                      <TierChip tier={c.tier} />
                      <OrganicChip isOrganic={c.isOrganic} />
                    </div>
                  </button>
                </li>
              ))
            )}
          </ul>
        </>
      )}

      <CoverageDetailDrawer
        workspaceId={workspaceId}
        coverageId={selectedId}
        onClose={() => setSelectedId(null)}
      />
    </div>
  )
}

function TierChip({ tier }: { tier: string }) {
  return (
    <span className="inline-flex items-center justify-center rounded-md border border-white/10 px-2 py-0.5 text-[11px] font-medium text-zinc-300 capitalize">
      {tier}
    </span>
  )
}

function OrganicChip({ isOrganic }: { isOrganic: boolean }) {
  return (
    <span
      title={isOrganic ? "Earned coverage" : "Placed coverage"}
      className={`inline-flex items-center justify-center rounded-md px-2 py-0.5 text-[11px] font-semibold ${
        isOrganic
          ? "bg-emerald-500/[0.12] text-emerald-200"
          : "bg-amber-500/[0.12] text-amber-200"
      }`}
    >
      {isOrganic ? "Earned" : "Placed"}
    </span>
  )
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}
