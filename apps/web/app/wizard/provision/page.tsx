"use client"

import { useState, Suspense } from "react"
import { useSearchParams } from "next/navigation"

// ─── View setup checklist data ────────────────────────────────────────────────

const VIEW_CHECKLIST = [
  {
    object: "Signals",
    icon: "⚡",
    views: [
      {
        name: "By Signal Type",
        type: "Board",
        steps: [
          "Open Signals in the left sidebar",
          'Click the "+" next to the existing view tab',
          "Choose Board",
          'Set "Group by" to Source Event',
          'Name it "By Signal Type" and save',
        ],
        why: "See signal volume by source at a glance — Profile Views, New Connections, Post Reactions, Follows.",
      },
      {
        name: "High Signal",
        type: "Table",
        steps: [
          "Open Signals → add a new Table view",
          "Click Filter → add Engagement Score ≥ 10",
          "Sort by Created At descending",
          'Name it "High Signal"',
        ],
        why: "Surfaces your warmest signals — the people worth prioritising for outreach today.",
      },
    ],
  },
  {
    object: "People",
    icon: "👤",
    views: [
      {
        name: "Funnel",
        type: "Board",
        steps: [
          "Open People → add a new Board view",
          'Set "Group by" to Funnel Stage',
          'Name it "Funnel"',
          "Pin the columns: Signal Score, LinkedIn, Job Title",
        ],
        why: "Visualise movement through Signal Found → Engaged → High Signal → Call Booked.",
      },
      {
        name: "Ready to Reach Out",
        type: "Table",
        steps: [
          "Open People → add a new Table view",
          "Click Filter → Signal Score ≥ 20",
          "Sort by Signal Score descending",
          'Name it "Ready to Reach Out"',
        ],
        why: "Your shortlist — people who have accumulated enough signal that outreach will feel warm.",
      },
    ],
  },
  {
    object: "ICP Target Segment A",
    icon: "🎯",
    views: [
      {
        name: "Board by Status",
        type: "Board",
        steps: [
          "Go to Lists → ICP Target Segment A",
          "Add a Board view",
          'Set "Group by" to Status',
          "Add Signal Score and Last Signal At as visible columns",
        ],
        why: "Track progress of each contact through the segment from Identified to Meeting Booked.",
      },
    ],
  },
  {
    object: "ICP Target Segment B",
    icon: "🎯",
    views: [
      {
        name: "Board by Status",
        type: "Board",
        steps: [
          "Go to Lists → ICP Target Segment B",
          "Add a Board view, group by Status",
          "Mirror the same column setup as Segment A",
        ],
        why: "Same view pattern as Segment A — keeps both segments consistent and comparable.",
      },
    ],
  },
  {
    object: "Experiments",
    icon: "🧪",
    views: [
      {
        name: "Active Experiments",
        type: "Board",
        steps: [
          "Open Experiments → add a Board view",
          'Set "Group by" to Status',
          "Add columns: Business Objective, Channel, Start Date",
          'Name it "Active Experiments"',
        ],
        why: "Shows which outreach experiments are running, paused, or complete — so nothing falls through.",
      },
    ],
  },
  {
    object: "VC Funds",
    icon: "💰",
    views: [
      {
        name: "Pipeline",
        type: "Board",
        steps: [
          "Go to Lists → VC Funds",
          "Add a Board view",
          'Set "Group by" to Status',
          "Add columns: Investor Type, Check Size, Warm Intro Via",
          'Name it "Pipeline"',
        ],
        why: "Tracks your fundraising pipeline from Identified through to Term Sheet and Closed.",
      },
    ],
  },
]

// ─── What was created summary ─────────────────────────────────────────────────

const CREATED_SUMMARY = [
  { label: "Custom objects", value: "9", detail: "signals, experiments, personas, messaging, influencers, marketing strategies, call transcripts, products, payments" },
  { label: "Attributes", value: "243+", detail: "All objects fully attributed — select options, references, and scoring fields included" },
  { label: "Starter lists", value: "3", detail: "ICP Target Segment A, ICP Target Segment B, VC Funds" },
]

// ─── Components ───────────────────────────────────────────────────────────────

function ChecklistItem({ item }: { item: typeof VIEW_CHECKLIST[0] }) {
  const [expanded, setExpanded] = useState<number | null>(null)
  const [checked, setChecked] = useState<boolean[]>(item.views.map(() => false))

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-white/[0.08]">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#2BA98B]/[0.16] text-[14px]">
          <span aria-hidden>{item.icon}</span>
        </div>
        <span className="text-[15px] font-semibold text-white">{item.object}</span>
        <span className="ml-auto text-[12px] font-medium text-zinc-400">
          {checked.filter(Boolean).length} of {item.views.length} views
        </span>
      </div>

      <div className="divide-y divide-white/[0.06]">
        {item.views.map((view, i) => (
          <div key={view.name}>
            <button
              onClick={() => setExpanded(expanded === i ? null : i)}
              className="w-full flex items-start gap-3.5 px-5 py-4 text-left transition-colors hover:bg-white/[0.02] motion-reduce:transition-none"
            >
              <div
                role="checkbox"
                aria-checked={checked[i]}
                onClick={(e) => {
                  e.stopPropagation()
                  setChecked((c) => c.map((v, j) => (j === i ? !v : v)))
                }}
                className={`mt-0.5 h-[18px] w-[18px] shrink-0 rounded-md border-[1.5px] transition-colors motion-reduce:transition-none ${
                  checked[i]
                    ? "bg-[#2BA98B] border-[#2BA98B]"
                    : "border-white/30 hover:border-white/50"
                }`}
              >
                {checked[i] && (
                  <svg viewBox="0 0 12 12" className="w-full h-full text-white p-0.5" fill="none" stroke="currentColor" strokeWidth={2}>
                    <polyline points="1,6 4,10 11,2" />
                  </svg>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2.5">
                  <span className="text-[15px] font-semibold text-white">{view.name}</span>
                  <span className="rounded-full border border-[#2BA98B]/30 bg-[#2BA98B]/[0.10] px-2.5 py-0.5 text-[11px] font-semibold text-[#2BA98B]">
                    {view.type}
                  </span>
                </div>
                <p className="mt-1 text-[13px] leading-[19px] text-zinc-300 line-clamp-2">{view.why}</p>
              </div>
              <span className="mt-1.5 text-[12px] font-medium text-zinc-400 whitespace-nowrap">
                {expanded === i ? "Hide steps" : "Show steps"} {expanded === i ? "▴" : "▾"}
              </span>
            </button>

            {expanded === i && (
              <div className="px-5 pb-4 pl-[58px] space-y-3">
                <ol className="space-y-2 list-none">
                  {view.steps.map((step, s) => (
                    <li key={s} className="flex items-start gap-2.5 text-[13px] leading-[20px] text-zinc-200">
                      <span className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-[10px] font-bold text-[#2BA98B]">
                        {s + 1}
                      </span>
                      {step}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function ProvisionPageInner() {
  const searchParams = useSearchParams()
  const workspaceId = searchParams.get("workspaceId") ?? ""

  const totalViews = VIEW_CHECKLIST.reduce((n, g) => n + g.views.length, 0)

  return (
    <div className="space-y-10">

      {/* Header */}
      <div className="space-y-3">
        <div className="inline-flex items-center gap-2 rounded-full bg-emerald-500/16 px-3 py-1.5">
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-[10px] font-bold text-[#08302E]">✓</span>
          <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-emerald-400">Workspace provisioned</span>
        </div>
        <h1 className="text-[36px] font-bold leading-[1.05] tracking-[-0.02em] text-white">Your workspace is live in your CRM.</h1>
        <p className="max-w-[640px] text-[16px] leading-[26px] text-zinc-300">
          The signal-first methodology has been provisioned into your workspace. Complete the steps below to finish setup — some CRM views can&apos;t be created via API, so these are done once in your CRM UI.
        </p>
      </div>

      {/* What was created */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] divide-y divide-white/[0.08]">
        {CREATED_SUMMARY.map((item) => (
          <div key={item.label} className="flex items-start gap-4 px-5 py-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/16">
              <svg className="h-4 w-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <div>
              <div className="flex items-baseline gap-2">
                <span className="text-[20px] font-bold tracking-[-0.02em] text-white tabular-nums">{item.value}</span>
                <span className="text-[14px] font-semibold text-white">{item.label}</span>
              </div>
              <p className="mt-0.5 text-[13px] text-zinc-400">{item.detail}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Open CRM */}
      <a
        href="https://app.hubspot.com"
        target="_blank"
        rel="noopener noreferrer"
        className="flex w-full items-center justify-between gap-3 rounded-2xl border border-[#2BA98B]/30 bg-[#2BA98B]/[0.08] px-5 py-4 transition-colors hover:bg-[#2BA98B]/[0.12] motion-reduce:transition-none"
      >
        <div className="flex flex-col gap-0.5 text-left">
          <p className="text-[14px] font-semibold text-white">Open your workspace in your CRM</p>
          <p className="text-[13px] text-zinc-400">Then come back to set up the missing views below.</p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-lg bg-[#2BA98B] px-4 py-2.5 text-[14px] font-bold text-white">
          Open CRM
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </span>
      </a>

      {/* View setup checklist */}
      <div className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-baseline gap-3">
            <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">Finish your setup</p>
            <span className="text-[12px] text-zinc-400">0 of {totalViews} views complete</span>
          </div>
          <h2 className="text-[24px] font-bold tracking-[-0.02em] text-white">{totalViews} views to set up by hand in your CRM</h2>
        </div>
        <p className="max-w-[640px] text-[14px] leading-[21px] text-zinc-300">
          Some CRM views can&apos;t be created via API. Each view takes about 90 seconds. Tick them off as you go — your progress is saved.
        </p>

        <div className="space-y-3">
          {VIEW_CHECKLIST.map((item) => (
            <ChecklistItem key={item.object} item={item} />
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-white/10 pt-6 flex items-center justify-between">
        <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">Step 6 of 6 · Setup complete</p>
        {workspaceId && (
          <span className="font-mono text-[12px] text-zinc-400">workspace: {workspaceId}</span>
        )}
      </div>

    </div>
  )
}

export default function ProvisionPage() {
  return (
    <Suspense>
      <ProvisionPageInner />
    </Suspense>
  )
}
