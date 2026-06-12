/**
 * Reports page — funnel velocity.
 *
 * Three sections:
 *  1. Funnel snapshot — current count at each stage
 *  2. Stage velocity — how quickly companies progress between stages
 *  3. Recent transitions — last 20 stage changes
 */

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import {
  getRecentStageTransitions,
  getStageTransitionVelocity,
  getStageSummary,
  getFunnelConversion,
  getFollowCampaignStats,
  getCompanyFunnelMetrics,
  isDbConfigured,
  type StageTransitionRow,
  type StageSummaryRow,
  type FunnelConversionRow,
  type FollowCampaignRow,
  type CompanyFunnelMetric,
} from "@/lib/db/contact-store"
import { ReportsTabs } from "./reports-tabs"

// Short display labels for the funnel-matrix headers so the 11
// columns fit on a single row at typical widths. DB strings stay
// canonical.
const SHORT_LABEL: Partial<Record<Stage, string>> = {
  "Discovery Call":        "Disc Call",
  "Requested Information": "Info Request",
  "Follow Up Call":        "2nd Call",
  "Sent Information":      "Sent Info",
  "Contract Negotiation":  "Negotiation",
  "Customer Won":          "Won",
}

function fmtMoney(n: number): string {
  if (n >= 1_000_000) return `£${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000)     return `£${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return `£${Math.round(n)}`
}

// Approximate GBP -> USD spot rate for the hover-state USD figure on
// MRR / ARR cells. Pinned for now; lift to WorkspaceConfig if you start
// needing it elsewhere or want to update it without a deploy.
const USD_PER_GBP = 1.27

function fmtUsd(gbp: number): string {
  const usd = gbp * USD_PER_GBP
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}


export const dynamic = "force-dynamic"

const STAGE_ORDER = [
  "Prospect",
  "Signal Found",
  "Engaged",
  "High Signal",
  "Discovery Call",
  "Requested Information",
  "Sent Information",
  "Follow Up Call",
  "Diligence",
  "Contract Negotiation",
  "Customer Won",
] as const
type Stage = (typeof STAGE_ORDER)[number]

const STAGE_DISPLAY_LABEL: Partial<Record<Stage, string>> = {
  "Discovery Call": "Ambassadors",
}

const STAGE_COLORS: Record<Stage, { bg: string; fg: string; dot: string }> = {
  "Prospect":              { bg: "rgba(156,163,175,0.12)", fg: "#9CA3AF", dot: "#6B7280"  },
  "Signal Found":          { bg: "rgba(221,128,168,0.12)", fg: "#F9A8D4", dot: "#DD80A8"  },
  "Engaged":               { bg: "rgba(34,197,94,0.12)",   fg: "#86EFAC", dot: "#22C55E"  },
  "High Signal":           { bg: "rgba(234,88,12,0.12)",   fg: "#FDBA74", dot: "#EA580C"  },
  "Discovery Call":        { bg: "rgba(56,189,248,0.12)",  fg: "#BAE6FD", dot: "#38BDF8"  },
  "Requested Information": { bg: "rgba(251,191,36,0.12)",  fg: "#FDE68A", dot: "#FBBF24"  },
  "Follow Up Call":        { bg: "rgba(251,146,60,0.12)",  fg: "#FDBA74", dot: "#FB923C"  },
  "Sent Information":      { bg: "rgba(129,140,248,0.12)", fg: "#C7D2FE", dot: "#818CF8"  },
  "Diligence":             { bg: "rgba(192,132,252,0.12)", fg: "#E9D5FF", dot: "#C084FC"  },
  "Contract Negotiation":  { bg: "rgba(52,211,153,0.12)",  fg: "#A7F3D0", dot: "#34D399"  },
  "Customer Won":          { bg: "rgba(43,169,139,0.12)",  fg: "#6EE7B7", dot: "#2BA98B"  },
}


function fmtRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins  = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days  = Math.floor(diff / 86_400_000)
  if (mins  < 60)  return `${mins}m ago`
  if (hours < 24)  return `${hours}h ago`
  if (days  < 30)  return `${days}d ago`
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
}

export default async function ReportsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}) {
  const { workspaceId } = await params
  const config = await getWorkspaceConfig(workspaceId)

  if (!config) {
    return (
      <div className="flex items-center justify-center py-32">
        <p className="text-[14px] text-zinc-400">Workspace not found.</p>
      </div>
    )
  }

  if (config.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) {
      redirect(`/dashboard/${workspaceId}/login`)
    }
  }

  if (!isDbConfigured()) {
    return (
      <div className="flex items-center justify-center py-32">
        <p className="text-[14px] text-zinc-400">Database not configured.</p>
      </div>
    )
  }

  const enabledCampaigns = (config.dripifyWebhooks ?? [])
    .filter(w => w.includeInReports)
    .map(w => w.campaignName)

  const [stageSummary, funnelConversion, recentTransitions, followCampaigns, funnelMatrix] = await Promise.all([
    getStageSummary(workspaceId),
    getFunnelConversion(workspaceId),
    getRecentStageTransitions(workspaceId, 20),
    getFollowCampaignStats(workspaceId, enabledCampaigns),
    getCompanyFunnelMetrics(workspaceId),
  ])
  const funnelByStage: Record<string, CompanyFunnelMetric | undefined> = Object.fromEntries(funnelMatrix.map(m => [m.stage, m]))

  const summaryMap: Record<string, StageSummaryRow> = {}
  for (const s of stageSummary) summaryMap[s.stage] = s

  return (
    <div className="space-y-7">
      {/* Header */}
      <div>
        <p className="mb-1.5 text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">
          {config.name ?? workspaceId} · Reports
        </p>
        <h1 className="text-[30px] font-bold tracking-[-0.02em] text-white">
          Funnel Reporting
        </h1>
        <p className="mt-1.5 text-[15px] leading-[22px] text-zinc-300">
          How quickly companies move through your pipeline - and whether your marketing tactics are working.
        </p>
      </div>

      <ReportsTabs workspaceId={workspaceId} active="funnel" />

      {/* Funnel matrix - same 11 stages as the Companies page, four
          rows: count / conversion-to-Won / MRR / ARR. */}
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
        <div className="border-b border-white/[0.08] px-6 py-4">
          <h2 className="text-[16px] font-bold text-white">Pipeline snapshot</h2>
          <p className="mt-1 text-[13px] text-zinc-400">Current company count, conversion-to-Won, MRR and ARR per stage.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-white/[0.08] text-left">
                <th className="sticky left-0 z-[1] bg-[#0F1815] px-4 py-2.5 text-[10px] font-bold uppercase tracking-[0.08em] text-zinc-500">Stage</th>
                {STAGE_ORDER.map(stage => {
                  const c = STAGE_COLORS[stage]
                  return (
                    <th key={stage} className="px-2.5 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: c.dot }} aria-hidden />
                        <span
                          className="text-[9px] font-bold uppercase leading-[1.15] tracking-[0.06em] whitespace-nowrap"
                          style={{ color: c.fg }}
                        >
                          {SHORT_LABEL[stage] ?? stage}
                        </span>
                      </div>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-white/[0.04]">
                <th className="sticky left-0 z-[1] bg-[#0F1815] px-4 py-2.5 text-left text-[10px] font-bold uppercase tracking-[0.08em] text-zinc-500">Companies</th>
                {STAGE_ORDER.map(stage => {
                  const m = funnelByStage[stage]
                  return (
                    <td key={stage} className="px-2.5 py-2.5 text-[18px] font-bold tabular-nums text-white">
                      {m?.companyCount ?? 0}
                    </td>
                  )
                })}
              </tr>
              <tr className="border-b border-white/[0.04]">
                <th className="sticky left-0 z-[1] bg-[#0F1815] px-4 py-2.5 text-left text-[10px] font-bold uppercase tracking-[0.08em] text-zinc-500">
                  Conv. to Won
                </th>
                {STAGE_ORDER.map(stage => {
                  const m = funnelByStage[stage]
                  if (stage === "Customer Won") return <td key={stage} className="px-2.5 py-2.5 text-[13px] tabular-nums text-zinc-600">—</td>
                  const pct = m?.conversionToWonPct
                  return (
                    <td
                      key={stage}
                      className="px-2.5 py-2.5 text-[13px] tabular-nums text-zinc-300"
                      title={m ? `${m.wonOfEver} of ${m.everCount} companies ever-at-${stage} are now at Customer Won` : undefined}
                    >
                      {pct == null ? "—" : `${pct.toFixed(0)}%`}
                    </td>
                  )
                })}
              </tr>
              <tr className="border-b border-white/[0.04]">
                <th className="sticky left-0 z-[1] bg-[#0F1815] px-4 py-2.5 text-left text-[10px] font-bold uppercase tracking-[0.08em] text-zinc-500">MRR</th>
                {STAGE_ORDER.map(stage => {
                  const m = funnelByStage[stage]
                  const mrr = m?.mrrTotal ?? 0
                  return (
                    <td
                      key={stage}
                      className={`px-2.5 py-2.5 text-[13px] tabular-nums ${mrr > 0 ? "text-[#6EE7B7]" : "text-zinc-600"}`}
                      title={`£${mrr.toLocaleString("en-GB", { minimumFractionDigits: 2 })} (~${fmtUsd(mrr)}) accumulated MRR currently in ${stage}`}
                    >
                      {fmtMoney(mrr)}
                    </td>
                  )
                })}
              </tr>
              <tr>
                <th className="sticky left-0 z-[1] bg-[#0F1815] px-4 py-2.5 text-left text-[10px] font-bold uppercase tracking-[0.08em] text-zinc-500">ARR</th>
                {STAGE_ORDER.map(stage => {
                  const m = funnelByStage[stage]
                  const arr = (m?.mrrTotal ?? 0) * 12
                  return (
                    <td
                      key={stage}
                      className={`px-2.5 py-2.5 text-[13px] tabular-nums ${arr > 0 ? "text-[#6EE7B7]" : "text-zinc-600"}`}
                      title={`£${arr.toLocaleString("en-GB", { minimumFractionDigits: 2 })} (~${fmtUsd(arr)}) accumulated ARR currently in ${stage}`}
                    >
                      {fmtMoney(arr)}
                    </td>
                  )
                })}
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Funnel snapshot */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03]">
        <div className="border-b border-white/[0.08] px-6 py-4">
          <h2 className="text-[16px] font-bold text-white">Funnel velocity</h2>
          <p className="mt-1 text-[13px] text-zinc-400">Net new entrants (last 30 days) and average time spent at each stage.</p>
        </div>
        <div className="grid grid-cols-2 divide-y divide-white/[0.06] sm:grid-cols-5 sm:divide-x sm:divide-y-0">
          {STAGE_ORDER.filter(stage => stage !== "Customer Won").map(stage => {
            const c       = STAGE_COLORS[stage]
            const summary = summaryMap[stage]
            const netNew  = summary?.netNew ?? 0
            const avgDays = summary?.avgDays ?? null
            return (
              <div key={stage} className="flex flex-col gap-2 px-5 py-5">
                <span
                  className="inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em]"
                  style={{ backgroundColor: c.bg, color: c.fg }}
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: c.dot }} aria-hidden />
                  {stage}
                </span>
                <div>
                  <span className="text-[28px] font-bold tabular-nums leading-none text-white">{netNew}</span>
                  <p className="mt-0.5 text-[11px] text-zinc-500">net new (30d)</p>
                </div>
                <div>
                  <span className="text-[18px] font-semibold tabular-nums leading-none text-zinc-300">
                    {avgDays !== null ? `${avgDays}d` : "—"}
                  </span>
                  <p className="mt-0.5 text-[11px] text-zinc-500">avg time in stage</p>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Funnel conversion */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03]">
        <div className="border-b border-white/[0.08] px-6 py-4">
          <h2 className="text-[16px] font-bold text-white">Funnel conversion</h2>
          <p className="mt-1 text-[13px] text-zinc-400">
            Of companies that entered each stage, how many ultimately reached Ambassador status — and how many are still waiting.
          </p>
        </div>
        {funnelConversion.length === 0 ? (
          <p className="px-6 py-8 text-[13px] text-zinc-400">
            Conversion data will appear here as companies move through the funnel.
          </p>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-white/[0.06]">
                <th className="px-6 py-3 text-left text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Entered at</th>
                <th className="px-6 py-3 text-right text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Companies</th>
                <th className="px-6 py-3 text-right text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Reached Ambassadors</th>
                <th className="px-6 py-3 text-right text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Conversion</th>
                <th className="px-6 py-3 text-right text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Stalled here</th>
              </tr>
            </thead>
            <tbody>
              {funnelConversion.map((row: FunnelConversionRow) => {
                const c = STAGE_COLORS[row.stage as Stage]
                const pct = row.conversionPct
                const barWidth = pct !== null ? Math.min(pct, 100) : 0
                return (
                  <tr key={row.stage} className="border-b border-white/[0.04] last:border-0">
                    <td className="px-6 py-4">
                      <span
                        className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
                        style={{ backgroundColor: c.bg, color: c.fg }}
                      >
                        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: c.dot }} aria-hidden />
                        {STAGE_DISPLAY_LABEL[row.stage as Stage] ?? row.stage} → Ambassadors
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right font-mono tabular-nums text-zinc-300">
                      {row.entered}
                    </td>
                    <td className="px-6 py-4 text-right font-mono tabular-nums text-white">
                      {row.convertedToDc}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-white/[0.06]">
                          <div
                            className="h-full rounded-full bg-[#2BA98B]"
                            style={{ width: `${barWidth}%` }}
                          />
                        </div>
                        <span className="w-10 text-right font-mono tabular-nums text-white">
                          {pct !== null ? `${pct}%` : "—"}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right font-mono tabular-nums text-zinc-400">
                      {row.stalled > 0 ? (
                        <span className="text-amber-300">{row.stalled}</span>
                      ) : (
                        row.stalled
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Follow campaigns */}
      {followCampaigns.length > 0 && (
        <div className="rounded-2xl border border-white/10 bg-white/[0.03]">
          <div className="border-b border-white/[0.08] px-6 py-4">
            <h2 className="text-[16px] font-bold text-white">Follow Campaigns</h2>
            <p className="mt-1 text-[13px] text-zinc-400">
              LinkedIn outbound follow activity — how many prospects were contacted and where they sit in the funnel now.
            </p>
          </div>
          <div className="divide-y divide-white/[0.04]">
            {followCampaigns.map((row: FollowCampaignRow) => {
              const converted = row.engaged + row.highSignal + row.discoveryCall + row.customerWon
              const convPct = row.uniqueContacts > 0
                ? Math.round(converted * 100 / row.uniqueContacts)
                : 0
              return (
                <div key={`${row.campaignName}-${row.actor}`} className="px-6 py-5">
                  <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-[15px] font-semibold text-white">{row.campaignName}</p>
                      <p className="mt-0.5 text-[12px] text-zinc-500">{row.actor}</p>
                    </div>
                    <div className="flex items-center gap-5">
                      <div className="text-right">
                        <p className="text-[22px] font-bold tabular-nums leading-none text-white">{row.uniqueContacts}</p>
                        <p className="mt-0.5 text-[11px] text-zinc-500">people followed</p>
                      </div>
                      <div className="text-right">
                        <p className="text-[22px] font-bold tabular-nums leading-none text-white">{convPct}%</p>
                        <p className="mt-0.5 text-[11px] text-zinc-500">moved to Engaged+</p>
                      </div>
                    </div>
                  </div>
                  {/* Stage breakdown bar */}
                  <div className="flex gap-3">
                    {([
                      { label: "Signal Found",   count: row.signalFound,   color: STAGE_COLORS["Signal Found"]   },
                      { label: "Engaged",         count: row.engaged,       color: STAGE_COLORS["Engaged"]         },
                      { label: "High Signal",     count: row.highSignal,    color: STAGE_COLORS["High Signal"]     },
                      { label: "Discovery Call",  count: row.discoveryCall, color: STAGE_COLORS["Discovery Call"]  },
                      { label: "Customer Won",    count: row.customerWon,   color: STAGE_COLORS["Customer Won"]    },
                    ] as const).map(({ label, count, color }) => (
                      <div key={label} className="flex flex-col gap-1">
                        <span
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                          style={{ backgroundColor: color.bg, color: color.fg }}
                        >
                          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color.dot }} aria-hidden />
                          {STAGE_DISPLAY_LABEL[label as Stage] ?? label}
                        </span>
                        <span className="pl-1 text-[18px] font-bold tabular-nums leading-none text-white">{count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Recent transitions */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03]">
        <div className="border-b border-white/[0.08] px-6 py-4">
          <h2 className="text-[16px] font-bold text-white">Recent transitions</h2>
          <p className="mt-1 text-[13px] text-zinc-400">Last 20 stage changes across all companies.</p>
        </div>
        {recentTransitions.length === 0 ? (
          <p className="px-6 py-8 text-[13px] text-zinc-400">
            No stage transitions recorded yet — they will appear here as companies accumulate signals and move through the funnel.
          </p>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-white/[0.06]">
                <th className="px-6 py-3 text-left text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Company</th>
                <th className="px-6 py-3 text-left text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Transition</th>
                <th className="px-6 py-3 text-right text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Trigger</th>
                <th className="px-6 py-3 text-right text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">When</th>
              </tr>
            </thead>
            <tbody>
              {recentTransitions.map((t: StageTransitionRow, i) => {
                const fromC = t.fromStage ? STAGE_COLORS[t.fromStage as Stage] : null
                const toC   = STAGE_COLORS[t.toStage as Stage]
                return (
                  <tr key={i} className="border-b border-white/[0.04] last:border-0">
                    <td className="px-6 py-3.5 font-medium text-white">
                      {t.companyName}
                    </td>
                    <td className="px-6 py-3.5">
                      <span className="flex flex-wrap items-center gap-1.5">
                        {fromC ? (
                          <span
                            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
                            style={{ backgroundColor: fromC.bg, color: fromC.fg }}
                          >
                            {t.fromStage}
                          </span>
                        ) : (
                          <span className="text-[11px] text-zinc-500">—</span>
                        )}
                        <span className="text-zinc-500">→</span>
                        {toC && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
                            style={{ backgroundColor: toC.bg, color: toC.fg }}
                          >
                            {t.toStage}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-6 py-3.5 text-right">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        t.trigger === "manual"
                          ? "bg-violet-500/15 text-violet-300"
                          : "bg-zinc-500/15 text-zinc-400"
                      }`}>
                        {t.trigger === "manual" ? "Manual" : "Auto"}
                      </span>
                    </td>
                    <td className="px-6 py-3.5 text-right tabular-nums text-zinc-400">
                      {fmtRelative(t.transitionedAt)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
