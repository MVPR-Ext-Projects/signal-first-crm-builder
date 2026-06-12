/**
 * Per-workspace costs page.
 *
 * MTD spend split by provider plus the previous month total for comparison.
 * Drives the usage-based pricing conversation — SDRs and admins can see
 * exactly which providers ate the budget this month.
 *
 * Cost rates come from lib/pricing.ts (hardcoded). When a plan changes,
 * update the constants there.
 */

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import {
  getUsageBreakdown,
  getEnrichmentLog,
  startOfThisMonth,
  previousMonthWindow,
  type ProviderTotal,
  type EnrichmentLogRow,
} from "@/lib/db/usage-store"

export const dynamic = "force-dynamic"

const PROVIDER_LABELS: Record<string, { label: string; unit: string; category: string }> = {
  surfe:     { label: "Surfe",     unit: "credits",  category: "Enrichment" },
  apify:     { label: "Apify",     unit: "runs",     category: "Enrichment" },
  apollo:    { label: "Apollo",    unit: "credits",  category: "Enrichment" },
  resend:    { label: "Resend",    unit: "emails",   category: "Messaging"  },
  anthropic: { label: "Anthropic", unit: "tokens",   category: "AI"         },
  openai:    { label: "OpenAI",    unit: "tokens",   category: "AI"         },
  unipile:   { label: "Unipile",   unit: "messages", category: "Messaging"  },
  vercel:    { label: "Vercel",    unit: "events",   category: "Platform"   },
  neon:      { label: "Neon",      unit: "events",   category: "Platform"   },
}

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function formatUnits(n: number, unit: string): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M ${unit}`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k ${unit}`
  if (Number.isInteger(n)) return `${n} ${unit}`
  return `${n.toFixed(1)} ${unit}`
}

export default async function CostsPage({
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

  const monthStart = startOfThisMonth()
  const prevMonth  = previousMonthWindow()

  const [thisMonth, lastMonth, enrichmentLog] = await Promise.all([
    getUsageBreakdown(workspaceId, monthStart),
    getUsageBreakdown(workspaceId, prevMonth.start, prevMonth.end),
    getEnrichmentLog(workspaceId),
  ])

  const monthLabel    = monthStart.toLocaleDateString("en-GB", { month: "long", year: "numeric" })
  const lastMonthLbl  = prevMonth.start.toLocaleDateString("en-GB", { month: "long", year: "numeric" })

  return (
    <div className="space-y-7">
      {/* Title */}
      <div>
        <p className="mb-1.5 text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">
          {config.name ?? workspaceId} · Usage & Costs
        </p>
        <h1 className="text-[30px] font-bold tracking-[-0.02em] text-white">
          {monthLabel} so far
        </h1>
        <p className="mt-1.5 text-[15px] leading-[22px] text-zinc-300">
          Tracked usage at our cost. Real Vercel + Neon allocation is approximate
          (split by share of events). Update rates in <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[13px] text-zinc-200">lib/pricing.ts</code>.
        </p>
      </div>

      {/* Totals row */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-0 sm:overflow-hidden sm:rounded-2xl sm:border sm:border-white/10 sm:bg-white/[0.03]">
        <TotalCard
          label={`${monthLabel} (so far)`}
          cents={thisMonth.totalCents}
          accent
        />
        <TotalCard
          label={`${lastMonthLbl} (final)`}
          cents={lastMonth.totalCents}
          delta={lastMonth.totalCents > 0 ? thisMonth.totalCents - lastMonth.totalCents : null}
        />
      </div>

      {/* Breakdown */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03]">
        <div className="border-b border-white/[0.08] px-6 py-4">
          <h2 className="text-[16px] font-bold text-white">Breakdown</h2>
          <p className="mt-1 text-[13px] text-zinc-400">Per-provider totals for {monthLabel}.</p>
        </div>
        {thisMonth.byProvider.length === 0 ? (
          <p className="px-6 py-8 text-[13px] text-zinc-400">
            No usage logged yet this month.
          </p>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-white/[0.06]">
                <th className="px-6 py-3 text-left text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Provider</th>
                <th className="px-6 py-3 text-left text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Category</th>
                <th className="px-6 py-3 text-right text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Usage</th>
                <th className="px-6 py-3 text-right text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Events</th>
                <th className="px-6 py-3 text-right text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Cost</th>
              </tr>
            </thead>
            <tbody>
              {thisMonth.byProvider.map((p: ProviderTotal) => {
                const meta = PROVIDER_LABELS[p.provider] ?? { label: p.provider, unit: "units", category: "Other" }
                return (
                  <tr key={p.provider} className="border-b border-white/[0.04] last:border-0">
                    <td className="px-6 py-3.5 font-medium text-white">{meta.label}</td>
                    <td className="px-6 py-3.5 text-zinc-400">{meta.category}</td>
                    <td className="px-6 py-3.5 text-right font-mono tabular-nums text-zinc-200">{formatUnits(p.units, meta.unit)}</td>
                    <td className="px-6 py-3.5 text-right font-mono tabular-nums text-zinc-400">{p.events}</td>
                    <td className="px-6 py-3.5 text-right font-mono font-semibold tabular-nums text-white">{formatDollars(p.cents)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
      {/* Enrichment log */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03]">
        <div className="border-b border-white/[0.08] px-6 py-4">
          <h2 className="text-[16px] font-bold text-white">Enrichment log</h2>
          <p className="mt-1 text-[13px] text-zinc-400">Most recent 50 enrichment attempts.</p>
        </div>
        {enrichmentLog.length === 0 ? (
          <p className="px-6 py-8 text-[13px] text-zinc-400">No enrichment attempts recorded yet.</p>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-white/[0.06]">
                <th className="px-6 py-3 text-left text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Profile</th>
                <th className="hidden px-6 py-3 text-left text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B] sm:table-cell">LinkedIn</th>
                <th className="px-6 py-3 text-left text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Status</th>
                <th className="px-6 py-3 text-right text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Credits</th>
                <th className="px-6 py-3 text-right text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Date</th>
              </tr>
            </thead>
            <tbody>
              {enrichmentLog.map((row, i) => (
                <EnrichmentRow key={i} row={row} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

const STATUS_STYLES: Record<string, string> = {
  enriched:         "bg-emerald-500/15 text-emerald-300",
  no_match:         "bg-amber-500/15 text-amber-300",
  failed:           "bg-rose-500/15 text-rose-300",
  internal_purged:  "bg-zinc-500/15 text-zinc-400",
}
const STATUS_LABELS: Record<string, string> = {
  enriched:         "Enriched",
  no_match:         "No match",
  failed:           "Failed",
  internal_purged:  "Purged",
}

function EnrichmentRow({ row }: { row: EnrichmentLogRow }) {
  const slug = row.linkedinUrl
    ? row.linkedinUrl.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//, "").replace(/\/$/, "")
    : null
  const credits = row.emailCredits + row.mobileCredits
  const date = new Date(row.occurredAt).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  })
  const statusStyle = STATUS_STYLES[row.status] ?? "bg-zinc-500/15 text-zinc-400"
  const statusLabel = STATUS_LABELS[row.status] ?? row.status

  return (
    <tr className="border-b border-white/[0.04] last:border-0">
      <td className="px-6 py-3 font-medium text-white">
        {row.fullName ?? slug ?? "—"}
      </td>
      <td className="hidden px-6 py-3 text-zinc-400 sm:table-cell">
        {row.linkedinUrl ? (
          <a
            href={row.linkedinUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="max-w-[200px] truncate text-[#2BA98B] hover:underline block"
          >
            {slug ?? row.linkedinUrl}
          </a>
        ) : "—"}
      </td>
      <td className="px-6 py-3">
        <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${statusStyle}`}>
          {statusLabel}
        </span>
      </td>
      <td className="px-6 py-3 text-right font-mono tabular-nums text-zinc-300">
        {credits > 0 ? credits : "—"}
      </td>
      <td className="px-6 py-3 text-right tabular-nums text-zinc-400">{date}</td>
    </tr>
  )
}

function TotalCard({
  label,
  cents,
  delta,
  accent = false,
}: {
  label: string
  cents: number
  delta?: number | null
  accent?: boolean
}) {
  const deltaPct = delta !== null && delta !== undefined && cents > 0 ? (delta / (cents - delta)) * 100 : null
  const deltaUp  = delta !== null && delta !== undefined && delta > 0
  return (
    <div className={`flex flex-col gap-1.5 px-6 py-5 max-sm:rounded-2xl max-sm:border max-sm:border-white/10 max-sm:bg-white/[0.03] ${accent ? "sm:border-r sm:border-white/[0.08]" : ""}`}>
      <span className="text-[12px] font-bold uppercase tracking-[0.12em] text-zinc-400">{label}</span>
      <span className="text-[36px] font-bold leading-[1.05] tracking-[-0.02em] text-white tabular-nums">
        ${(cents / 100).toFixed(2)}
      </span>
      {delta !== null && delta !== undefined && (
        <span className={`text-[12px] ${deltaUp ? "text-amber-300" : "text-emerald-400"}`}>
          {deltaUp ? "+" : ""}{(delta / 100).toFixed(2)}{deltaPct !== null ? ` (${deltaUp ? "+" : ""}${deltaPct.toFixed(0)}%)` : ""} vs last month
        </span>
      )}
    </div>
  )
}
