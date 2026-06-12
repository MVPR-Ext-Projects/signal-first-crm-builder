"use client"

/**
 * CallLogTree - the Outbound Calls channel's expand-content.
 *
 * Flat list of people-with-calls (sorted by call count DESC). Each row
 * shows the person's name + job title - company, plus a call count and
 * signal score on the right. Click a row to expand the recent calls
 * underneath.
 *
 * The grouping-by-company step is dropped for v2 of this surface - the
 * user wanted to see "who was called" without an extra click. Company
 * lives inline on the row as the trailing piece of the meta line.
 *
 * Server-side data still arrives as CallTreeCompany[] (nested) from
 * getCallLogTree; this component flattens it for display so the helper
 * stays reusable for any future hierarchical view.
 */

import { useState } from "react"
import type { CallTreeCompany, CallTreeContact, CallTreeCall } from "@/lib/db/contact-store"

interface FlatPerson extends CallTreeContact {
  companyName: string
}

function flatten(companies: CallTreeCompany[]): FlatPerson[] {
  const out: FlatPerson[] = []
  for (const co of companies) {
    for (const c of co.contacts) {
      out.push({ ...c, companyName: co.companyName })
    }
  }
  // Sort by call count DESC, then by signal score DESC. Most-called people
  // surface first so the user spots their high-touch contacts at a glance.
  return out.sort((a, b) => b.callCount - a.callCount || b.signalScore - a.signalScore)
}

export function CallLogTree({ companies }: { companies: CallTreeCompany[] }) {
  const people = flatten(companies)
  const [openContact, setOpenContact] = useState<number | null>(null)

  if (people.length === 0) {
    return (
      <p className="border-t border-white/[0.06] px-6 py-8 text-[13px] text-zinc-400">
        No calls logged yet. Use the Log call button on any contact to record a call.
      </p>
    )
  }

  return (
    <div className="border-t border-white/[0.06] px-6 py-4 space-y-1">
      <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.10em] text-zinc-500">
        {people.length} {people.length === 1 ? "person" : "people"} called
      </p>
      <ul className="space-y-1">
        {people.map(p => (
          <PersonNode
            key={p.id}
            person={p}
            expanded={openContact === p.id}
            onToggle={() => setOpenContact(openContact === p.id ? null : p.id)}
          />
        ))}
      </ul>
    </div>
  )
}

function PersonNode({
  person, expanded, onToggle,
}: {
  person:   FlatPerson
  expanded: boolean
  onToggle: () => void
}) {
  const meta = [person.jobTitle, person.companyName].filter(Boolean).join(" - ")
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-white/[0.02]"
      >
        <Chevron expanded={expanded} />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-semibold text-white">{person.fullName ?? "(no name)"}</span>
          {meta && <span className="ml-1.5 text-zinc-400">· {meta}</span>}
        </span>
        <span className="ml-auto inline-flex items-center gap-2 text-[10px] tabular-nums text-zinc-500">
          <span>{person.callCount} {person.callCount === 1 ? "call" : "calls"}</span>
          <span>•</span>
          <span>score {person.signalScore}</span>
        </span>
      </button>
      {expanded && (
        <ul className="ml-6 mt-1 space-y-0.5">
          {person.recentCalls.length === 0 && (
            <li className="px-2 py-1 text-[11px] text-zinc-500">No calls yet.</li>
          )}
          {person.recentCalls.map(c => <CallNode key={c.signalId} call={c} />)}
        </ul>
      )}
    </li>
  )
}

function CallNode({ call }: { call: CallTreeCall }) {
  return (
    <li className="px-2 py-1 text-[11px] text-zinc-400">
      <span className="text-zinc-300">{call.sourceType}</span>
      {call.notes && <span className="text-zinc-500"> · {call.notes.slice(0, 140)}{call.notes.length > 140 ? "..." : ""}</span>}
      <span className="ml-2 text-zinc-600">
        {new Date(call.occurredAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
      </span>
    </li>
  )
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 text-zinc-500 transition-transform motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}
      aria-hidden
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}
