/**
 * Signals page — raw chronological list of signal events for the workspace.
 *
 * Primary use case: confirming that ingestion is wired up — when a SDR or
 * admin wants to verify that Teamfluence webhooks (or any other source) are
 * actually landing rows, this page shows the latest 200 events with the
 * source type, the contact, and the engagement URL.
 *
 * Auth gate matches the SDR / Companies pages.
 */

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import {
  getRecentSignals,
  countRecentSignals,
  countSignalsAtExcludedCompanies,
  getSignalsByMonth,
  listSignalVerbs,
  isDbConfigured,
  type RecentSignalRow,
} from "@/lib/db/contact-store"
import { PaginationFooter } from "../pagination-footer"
import { SignalsTrendChart } from "./signals-trend-chart"
import { SourceTypeSelect } from "./source-type-select"

export const dynamic = "force-dynamic"

const PAGE_SIZE = 100

function fmtDate(when: string | Date | null): string {
  if (!when) return "—"
  const t = typeof when === "string" ? new Date(when) : when
  return t.toLocaleString("en-GB", {
    day:    "numeric",
    month:  "short",
    hour:   "2-digit",
    minute: "2-digit",
  })
}

function first(name: string): string {
  return name.split(" ")[0]
}

// Extract team member first name from source_type patterns like "Camille Followed",
// "Tom Followed" — used as a fallback when signal_actor is null on imported signals.
function actorFromSourceType(sourceType: string | null | undefined): string | null {
  if (!sourceType) return null
  const m = sourceType.match(/^(\w+)(?:\s+\w+)?\s+Followed$/i)
  return m ? m[1] : null
}

// Extract sender name from verbDescription e.g. "Tom Lawrence sent a message..."
function actorFromVerbDescription(vd: string | null | undefined): string | null {
  if (!vd) return null
  const m = vd.match(/^(tom(?: lawrence)?|camille(?: oster)?|john(?: mayhew)?|konrad|laura)\b/i)
  return m ? m[1].split(" ")[0] : null
}

function buildSignalLabel(s: RecentSignalRow): string {
  const { signalVerb: verb, signalActor: actor, signalObject: object } = s
  if (!verb) {
    if (s.description) return s.description.slice(0, 100) + (s.description.length > 100 ? "…" : "")
    return s.sourceType ?? "Unknown signal"
  }
  switch (verb) {
    case "liked_post":           return object ? `Liked ${first(object)}'s post` : "Liked a post"
    case "commented_post":       return object ? `Commented on ${first(object)}'s post` : "Commented on a post"
    case "viewed_profile":       return object ? `Viewed ${object}'s LinkedIn profile` : "Viewed a profile"
    case "followed_our_team_member": return object ? `Followed ${object} on LinkedIn` : "Followed a team member"
    case "followed_prospect": {
      const a = actor ?? actorFromSourceType(s.sourceType)
      return a ? `${a} followed them on LinkedIn` : "Team followed this contact"
    }
    case "followed_our_company": return "Followed our company on LinkedIn"
    case "sent_connection_request": return actor ? `${actor} sent a connection request` : "Connection request sent"
    case "accepted_our_connection": return object ? `Accepted ${first(object)}'s connection request` : "Accepted a connection request"
    case "connected":            return object ? `Connected with ${object}` : "Connected on LinkedIn"
    case "sent_dm": {
      const a = actor ?? actorFromVerbDescription(s.verbDescription)
      return a ? `${a} sent a DM` : "Team sent a DM"
    }
    case "replied_dm":           return "Replied to a DM"
    case "booked_meeting":       return "Booked a meeting"
    case "ai_search":            return "AI search"
    default:                     return verb
  }
}

function fmtRelative(when: string | Date | null): string {
  if (!when) return "-"
  const t = typeof when === "string" ? new Date(when) : when
  const ms = Date.now() - t.getTime()
  // Future-dated signals (e.g. a booked-meeting row where occurred_at is
  // the scheduled meeting time, not the booking time) shouldn't read as
  // "just now". recordSignal clamps new writes, but historical/external
  // rows can still slip through. Show no relative label for them - the
  // absolute date next to this still renders.
  if (ms < 0)          return ""
  if (ms < 60_000)     return "just now"
  if (ms < 3600_000)   return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

export default async function SignalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>
  searchParams?: Promise<{ excluded?: string; p?: string; source?: string }>
}) {
  const { workspaceId } = await params
  const search = (await searchParams) ?? {}
  const includeExcluded = search.excluded === "1"
  const sourceFilter = typeof search.source === "string" && search.source !== "" ? search.source : null
  const pageRaw = typeof search.p === "string" ? Number(search.p) : 1
  const pageNum = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1
  const offset = (pageNum - 1) * PAGE_SIZE
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
        <p className="text-[14px] text-zinc-400">Postgres not configured.</p>
      </div>
    )
  }

  // Fetch PAGE_SIZE + 1 to detect "has next page" without a separate
  // COUNT. The `totalCount` query runs alongside for the workspace-wide
  // total pill, `monthly` powers the trend chart, `sourceOptions`
  // populates the source-type dropdown.
  const [rawSignals, totalCount, excludedCount, monthly, allVerbOptions] = await Promise.all([
    getRecentSignals(workspaceId, PAGE_SIZE + 1, includeExcluded, undefined, offset, sourceFilter),
    countRecentSignals(workspaceId, includeExcluded, undefined, sourceFilter),
    countSignalsAtExcludedCompanies(workspaceId),
    getSignalsByMonth(workspaceId, 12, includeExcluded, undefined, sourceFilter),
    listSignalVerbs(workspaceId, includeExcluded),
  ])
  const sourceOptions = allVerbOptions
  const hasNextPage = rawSignals.length > PAGE_SIZE
  const signals = hasNextPage ? rawSignals.slice(0, PAGE_SIZE) : rawSignals
  const newest  = signals[0]?.occurredAt ?? null

  // Toggling Excluded resets to page 1 — different result set. The
  // source filter is preserved across both toggles and pagination.
  function buildHref(opts: { excluded?: boolean; page?: number; source?: string | null }): string {
    const sp = new URLSearchParams()
    if (opts.excluded)                         sp.set("excluded", "1")
    if (opts.source)                           sp.set("source",   opts.source)
    if (opts.page && opts.page > 1)            sp.set("p",        String(opts.page))
    const qs = sp.toString()
    return `/dashboard/${workspaceId}/signals${qs ? "?" + qs : ""}`
  }
  const togglePillHref = buildHref({ excluded: !includeExcluded, source: sourceFilter })
  const prevHref       = buildHref({ excluded: includeExcluded,   source: sourceFilter, page: pageNum - 1 })
  const nextHref       = buildHref({ excluded: includeExcluded,   source: sourceFilter, page: pageNum + 1 })

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mb-1.5 text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">
            {config.name ?? workspaceId} · Signals
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[30px] font-bold tracking-[-0.02em] text-white">Signals</h1>
            <span
              className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] px-3 py-1 text-[12px] font-medium text-zinc-200"
              title={`${totalCount} signal event${totalCount === 1 ? "" : "s"} ${includeExcluded ? "at Excluded-tagged companies" : "in the workspace"}`}
            >
              <span className="tabular-nums font-semibold">{totalCount}</span>
              <span className="text-zinc-400">{totalCount === 1 ? "signal" : "signals"}</span>
            </span>
          </div>
          <p className="mt-1.5 text-[15px] leading-[22px] text-zinc-300">
            {newest ? `Most recent ${fmtRelative(newest)}. ` : ""}
            Use this view to confirm Teamfluence is delivering events.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SourceTypeSelect options={sourceOptions} active={sourceFilter} />
          {(excludedCount > 0 || includeExcluded) && (
            <a
              href={togglePillHref}
              aria-pressed={includeExcluded}
              title={includeExcluded
                ? "Hide signals at Excluded-tagged companies"
                : `Show ${excludedCount} hidden signal${excludedCount === 1 ? "" : "s"} at Excluded-tagged companies`}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[12px] font-medium transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60 ${
                includeExcluded
                  ? "bg-rose-500/[0.16] text-rose-200 hover:bg-rose-500/[0.22]"
                  : "bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08] hover:text-white"
              }`}
            >
              <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-zinc-500">Excluded</span>
              <span className="tabular-nums">{excludedCount}</span>
            </a>
          )}
        </div>
      </div>

      {totalCount > 0 && <SignalsTrendChart data={monthly} />}

      {signals.length === 0 ? (
        <div className="flex items-center justify-center rounded-2xl border border-white/10 bg-white/[0.03] py-20">
          <p className="text-[14px] text-zinc-400">
            No signals yet. They&rsquo;ll appear here as Teamfluence delivers webhook events.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-white/[0.08]">
                <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">When</th>
                <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Contact</th>
                <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Signal</th>
                <th className="px-5 py-3 text-right text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Pts</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((s: RecentSignalRow) => (
                <tr key={s.id} className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02]">
                  <td className="px-5 py-2.5 align-top whitespace-nowrap">
                    <span className="text-zinc-200">{fmtDate(s.occurredAt)}</span>
                    <span className="block text-[11px] text-zinc-500">{fmtRelative(s.occurredAt)}</span>
                  </td>
                  <td className="px-5 py-2.5 align-top max-w-[200px]">
                    {s.linkedinUrl ? (
                      <a
                        href={s.linkedinUrl.startsWith("http") ? s.linkedinUrl : `https://${s.linkedinUrl}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block truncate font-medium text-white hover:text-[#2BA98B] hover:underline"
                      >
                        {s.contactName ?? "(unknown)"}
                      </a>
                    ) : (
                      <span className="block truncate font-medium text-white">{s.contactName ?? "(unknown)"}</span>
                    )}
                    {(s.jobTitle || s.companyName) && (
                      <span className="block truncate text-[11px] text-zinc-500">
                        {[s.jobTitle, s.companyName].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-2.5 align-top">
                    {s.engagementUrl ? (
                      <a
                        href={s.engagementUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-white hover:text-[#2BA98B] hover:underline"
                      >
                        {buildSignalLabel(s)}
                      </a>
                    ) : (
                      <span className="text-white">{buildSignalLabel(s)}</span>
                    )}
                    {s.scoreDelta === 0 && s.signalVerb && (
                      <span className="block text-[11px] text-zinc-500">deduped</span>
                    )}
                  </td>
                  <td className={`px-5 py-2.5 align-top text-right font-mono tabular-nums ${
                    s.scoreDelta > 0 ? "font-semibold text-emerald-300" : s.scoreDelta < 0 ? "text-rose-300" : "text-zinc-500"
                  }`}>
                    {s.scoreDelta > 0 ? `+${s.scoreDelta}` : s.scoreDelta}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PaginationFooter
        pageNum={pageNum}
        hasNextPage={hasNextPage}
        prevHref={prevHref}
        nextHref={nextHref}
      />
    </div>
  )
}
