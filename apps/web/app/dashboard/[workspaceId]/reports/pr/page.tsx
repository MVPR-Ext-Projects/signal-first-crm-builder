/**
 * PR coverage report.
 *
 * Aggregate view over mvpr_coverage + mvpr_announcements +
 * campaign_coverage:
 *
 *  - Headline numbers (total coverage, sum DA, organic/placed split)
 *  - Tier distribution
 *  - Top publications (count + avg DA)
 *  - Top topics
 *  - Announcement report (per-announcement stats + coverage + campaign counts)
 *  - Campaigns spawned from coverage (cross-reference)
 */

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { isDbConfigured } from "@/lib/db"
import {
  getCoverageStats,
  getAnnouncementReport,
  getCampaignsFromCoverage,
  getCoverageOutcomes,
  getPrPerformance,
} from "@/lib/db/coverage"
import { getChannelLiftByCoverage } from "@/lib/db/contact-store"
import { ReportsTabs } from "../reports-tabs"

export const dynamic = "force-dynamic"

export default async function PrReportPage({
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

  const [stats, announcements, campaigns, outcomes, lift, prPerf] = await Promise.all([
    getCoverageStats(workspaceId),
    getAnnouncementReport(workspaceId, 50),
    getCampaignsFromCoverage(workspaceId, 50),
    getCoverageOutcomes(workspaceId, 50),
    getChannelLiftByCoverage(workspaceId),
    getPrPerformance(workspaceId),
  ])

  const tierTotal = stats.tierBreakdown.reduce((n, r) => n + r.count, 0)

  return (
    <div className="space-y-7">
      <div>
        <p className="mb-1.5 text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">
          {config.name ?? workspaceId} · Reports
        </p>
        <h1 className="text-[30px] font-bold tracking-[-0.02em] text-white">PR Coverage</h1>
        <p className="mt-1.5 text-[15px] leading-[22px] text-zinc-300">
          Coverage volume, reach, and how it&apos;s feeding downstream campaigns.
        </p>
      </div>

      <ReportsTabs workspaceId={workspaceId} active="pr" />

      {stats.total === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-6 py-12 text-center">
          <p className="text-[14px] text-zinc-300">No coverage synced yet.</p>
          <p className="mt-1 text-[13px] text-zinc-500">
            Connect MVPR on the{" "}
            <a href={`/dashboard/${workspaceId}/settings/pr`} className="text-white underline decoration-white/30 underline-offset-4 hover:decoration-white">
              PR coverage settings page
            </a>
            {" "}or wait for the next 6-hour sync.
          </p>
        </div>
      ) : (
        <>
          {/* Headline numbers */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
            <div className="border-b border-white/[0.08] px-6 py-4">
              <h2 className="text-[16px] font-bold text-white">Headline numbers</h2>
            </div>
            <div className="grid grid-cols-2 divide-x divide-white/[0.06] sm:grid-cols-4">
              <Stat label="Coverage pieces" value={stats.total.toString()} />
              <Stat label="Sum domain authority" value={stats.sumDa.toLocaleString()} />
              <Stat label="Avg DA" value={stats.avgDa != null ? Math.round(stats.avgDa).toString() : "-"} />
              <Stat
                label="Earned / placed"
                value={`${stats.organicCount} / ${stats.placedCount}`}
              />
            </div>
          </div>

          {/* Journalist outreach performance: the two headline PR rates +
              which pitch intents land + which journalists actually engage.
              Response/coverage rate only - open rate is deliberately omitted
              (inbox proxies make it unreliable). Sourced from mvpr_threads. */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
            <div className="border-b border-white/[0.08] px-6 py-4">
              <h2 className="text-[16px] font-bold text-white">Journalist outreach performance</h2>
              <p className="mt-1 text-[13px] text-zinc-400">
                Pitch threads from MVPR. Response rate = threads a journalist replied to; coverage rate = threads that produced published coverage. Drafts excluded.
              </p>
            </div>
            {prPerf.threadsSent === 0 ? (
              <p className="px-6 py-8 text-[13px] text-zinc-400">No sent pitch threads synced yet.</p>
            ) : (
              <>
                <div className="grid grid-cols-2 divide-x divide-white/[0.06] sm:grid-cols-4">
                  <Stat label="Threads sent" value={prPerf.threadsSent.toString()} />
                  <Stat label="Response rate" value={fmtPct(prPerf.responseRate ?? undefined)} />
                  <Stat label="Coverage rate" value={fmtPct(prPerf.coverageRate ?? undefined)} />
                  <Stat label="Replied / covered" value={`${prPerf.replied} / ${prPerf.withCoverage}`} />
                </div>

                <div className="grid grid-cols-1 gap-px bg-white/[0.06] sm:grid-cols-2">
                  {/* By intent — which messages land */}
                  <div className="bg-[#0c0c0e]">
                    <div className="px-5 py-3 border-b border-white/[0.06]">
                      <h3 className="text-[13px] font-semibold text-white">Which pitches land (by intent)</h3>
                    </div>
                    {prPerf.byIntent.length === 0 ? <Empty /> : (
                      <table className="w-full text-[13px]">
                        <thead>
                          <tr className="border-b border-white/[0.06] text-left text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">
                            <th className="px-5 py-2.5">Intent</th>
                            <th className="px-5 py-2.5 text-right">Sent</th>
                            <th className="px-5 py-2.5 text-right">Resp.</th>
                            <th className="px-5 py-2.5 text-right">Cov.</th>
                          </tr>
                        </thead>
                        <tbody>
                          {prPerf.byIntent.map(r => (
                            <tr key={r.intent} className="border-b border-white/[0.04] last:border-0">
                              <td className="px-5 py-2.5 text-zinc-200">{intentLabel(r.intent)}</td>
                              <td className="px-5 py-2.5 text-right font-mono tabular-nums text-white">{r.sent}</td>
                              <td className="px-5 py-2.5 text-right font-mono tabular-nums text-zinc-300">{fmtPct(r.responseRate ?? undefined)}</td>
                              <td className="px-5 py-2.5 text-right font-mono tabular-nums text-zinc-300">{fmtPct(r.coverageRate ?? undefined)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>

                  {/* Top journalists — who actually engages */}
                  <div className="bg-[#0c0c0e]">
                    <div className="px-5 py-3 border-b border-white/[0.06]">
                      <h3 className="text-[13px] font-semibold text-white">Most responsive journalists</h3>
                    </div>
                    {prPerf.topJournalists.length === 0 ? <Empty /> : (
                      <table className="w-full text-[13px]">
                        <thead>
                          <tr className="border-b border-white/[0.06] text-left text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">
                            <th className="px-5 py-2.5">Journalist</th>
                            <th className="px-5 py-2.5 text-right">Sent</th>
                            <th className="px-5 py-2.5 text-right">Repl.</th>
                            <th className="px-5 py-2.5 text-right">Cov.</th>
                          </tr>
                        </thead>
                        <tbody>
                          {prPerf.topJournalists.map(j => (
                            <tr key={j.journalistId} className="border-b border-white/[0.04] last:border-0">
                              <td className="px-5 py-2.5 text-zinc-200">
                                {j.journalistName}
                                {j.publicationName && <span className="block text-[11px] text-zinc-500">{j.publicationName}</span>}
                              </td>
                              <td className="px-5 py-2.5 text-right font-mono tabular-nums text-white">{j.sent}</td>
                              <td className="px-5 py-2.5 text-right font-mono tabular-nums text-zinc-300">{j.replied}</td>
                              <td className="px-5 py-2.5 text-right font-mono tabular-nums text-zinc-300">{j.withCoverage}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Tier + organic/placed split */}
          <div className="grid grid-cols-1 gap-7 lg:grid-cols-2">
            <Card title="Tier distribution">
              {stats.tierBreakdown.length === 0 ? (
                <Empty />
              ) : (
                <ul className="divide-y divide-white/[0.04]">
                  {stats.tierBreakdown.map(row => {
                    const pct = tierTotal ? Math.round((row.count / tierTotal) * 100) : 0
                    return (
                      <li key={row.tier} className="grid grid-cols-[120px_1fr_60px] items-center gap-3 px-5 py-3">
                        <span className="capitalize text-[13px] text-zinc-200">{row.tier}</span>
                        <div className="h-1.5 rounded-full bg-white/[0.06]">
                          <div className="h-1.5 rounded-full bg-[#2BA98B]/60" style={{ width: `${pct}%` }} aria-hidden />
                        </div>
                        <span className="text-right tabular-nums text-[12px] text-zinc-300">
                          {row.count} <span className="text-zinc-500">({pct}%)</span>
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </Card>

            <Card title="Earned vs placed">
              <SplitBar
                leftLabel="Earned"
                leftCount={stats.organicCount}
                rightLabel="Placed"
                rightCount={stats.placedCount}
              />
            </Card>
          </div>

          {/* Top publications + topics */}
          <div className="grid grid-cols-1 gap-7 lg:grid-cols-2">
            <Card title="Top publications">
              {stats.topPublications.length === 0 ? (
                <Empty />
              ) : (
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-white/[0.06] text-left text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">
                      <th className="px-5 py-2.5">Publication</th>
                      <th className="px-5 py-2.5 text-right">Pieces</th>
                      <th className="px-5 py-2.5 text-right">Avg DA</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.topPublications.map(p => (
                      <tr key={p.name} className="border-b border-white/[0.04] last:border-0">
                        <td className="px-5 py-2.5 text-zinc-200">{p.name}</td>
                        <td className="px-5 py-2.5 text-right font-mono tabular-nums text-white">{p.count}</td>
                        <td className="px-5 py-2.5 text-right font-mono tabular-nums text-zinc-300">{p.avgDa != null ? Math.round(p.avgDa) : "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <Card title="Top topics">
              {stats.topTopics.length === 0 ? (
                <Empty />
              ) : (
                <ul className="divide-y divide-white/[0.04]">
                  {stats.topTopics.map(t => (
                    <li key={t.topic} className="flex items-center justify-between px-5 py-2.5">
                      <span className="text-[13px] text-zinc-200">{t.topic}</span>
                      <span className="font-mono tabular-nums text-[12px] text-zinc-300">{t.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          {/* Announcement report */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
            <div className="border-b border-white/[0.08] px-6 py-4">
              <h2 className="text-[16px] font-bold text-white">Announcements</h2>
              <p className="mt-1 text-[13px] text-zinc-400">
                Each announcement&apos;s MVPR-side engagement stats plus the count of resulting coverage and campaigns spawned from that coverage in gtm-os.
              </p>
            </div>
            {announcements.length === 0 ? (
              <p className="px-6 py-8 text-[13px] text-zinc-400">No announcements synced yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[800px] text-[13px]">
                  <thead>
                    <tr className="border-b border-white/[0.06] text-left text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">
                      <th className="px-6 py-3">Title</th>
                      <th className="px-6 py-3">Type</th>
                      <th className="px-6 py-3">Start</th>
                      <th className="px-6 py-3 text-right">Coverage</th>
                      <th className="px-6 py-3 text-right">Campaigns</th>
                      <th className="px-6 py-3 text-right">Coverage ratio</th>
                      <th className="px-6 py-3 text-right">Sent</th>
                      <th className="px-6 py-3 text-right">Response rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {announcements.map(a => (
                      <tr key={a.mvprId} className="border-b border-white/[0.04] last:border-0">
                        <td className="px-6 py-3 font-medium text-white">{a.title}</td>
                        <td className="px-6 py-3 capitalize text-zinc-300">
                          {a.announcementType.replace(/-announcement$/, "").replace(/-/g, " ")}
                        </td>
                        <td className="px-6 py-3 text-zinc-300">
                          {new Date(a.startTime).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                        </td>
                        <td className="px-6 py-3 text-right font-mono tabular-nums text-white">{a.coverageCount}</td>
                        <td className="px-6 py-3 text-right font-mono tabular-nums text-white">{a.campaignCount}</td>
                        <td className="px-6 py-3 text-right font-mono tabular-nums text-zinc-300">{fmtPct(a.stats?.coverageRatio)}</td>
                        <td className="px-6 py-3 text-right font-mono tabular-nums text-zinc-300">{a.stats?.messagesSent ?? "-"}</td>
                        <td className="px-6 py-3 text-right font-mono tabular-nums text-zinc-300">{fmtPct(announcementResponseRate(a.stats))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Signal-first lift: with-coverage vs without-coverage per channel.
              Answers "does adding earned media to outbound actually improve
              outcomes?". Per-channel rows show side-by-side metric columns
              with the delta on the right. */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
            <div className="border-b border-white/[0.08] px-6 py-4">
              <h2 className="text-[16px] font-bold text-white">Signal-first lift</h2>
              <p className="mt-1 text-[13px] text-zinc-400">
                Outbound performance with coverage attached vs. without, per channel. Positive deltas mean attaching earned media is moving the needle.
              </p>
            </div>
            {lift.every(l => l.withCoverage.sent === 0 && l.withoutCoverage.sent === 0) ? (
              <p className="px-6 py-8 text-[13px] text-zinc-400">
                No outbound sends recorded since coverage attribution started (PR D). Send a few DMs / emails from a campaign that has coverage attached, and check back in a few days.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-[13px]">
                  <thead>
                    <tr className="border-b border-white/[0.06] text-left text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">
                      <th className="px-6 py-3">Channel</th>
                      <th className="px-6 py-3 text-right">Sent (w / w/o)</th>
                      <th className="px-6 py-3 text-right">Reply %</th>
                      <th className="px-6 py-3 text-right">Booking %</th>
                      <th className="px-6 py-3 text-right">Win %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lift.map(l => (
                      <tr key={l.channel} className="border-b border-white/[0.04] last:border-0">
                        <td className="px-6 py-3 font-semibold text-white">{l.channelLabel}</td>
                        <td className="px-6 py-3 text-right font-mono tabular-nums text-zinc-300">
                          {l.withCoverage.sent} / {l.withoutCoverage.sent}
                        </td>
                        <LiftCell w={l.withCoverage.responseRate} wo={l.withoutCoverage.responseRate} />
                        <LiftCell w={l.withCoverage.bookingRate}  wo={l.withoutCoverage.bookingRate} />
                        <LiftCell w={l.withCoverage.winRate}      wo={l.withoutCoverage.winRate} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Coverage outcomes: per-coverage rollup of outbound performance.
              "This article is a workhorse" identification via booked-meeting
              rate ordering. */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
            <div className="border-b border-white/[0.08] px-6 py-4">
              <h2 className="text-[16px] font-bold text-white">Coverage outcomes</h2>
              <p className="mt-1 text-[13px] text-zinc-400">
                Outbound results per coverage piece, ranked by bookings then sends. Empty rows are pieces no campaign has used yet.
              </p>
            </div>
            {outcomes.length === 0 ? (
              <p className="px-6 py-8 text-[13px] text-zinc-400">No coverage synced yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] text-[13px]">
                  <thead>
                    <tr className="border-b border-white/[0.06] text-left text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">
                      <th className="px-6 py-3">Coverage</th>
                      <th className="px-6 py-3">Publication</th>
                      <th className="px-6 py-3 text-right">Campaigns</th>
                      <th className="px-6 py-3 text-right">Sent</th>
                      <th className="px-6 py-3 text-right">Reply %</th>
                      <th className="px-6 py-3 text-right">Booking %</th>
                      <th className="px-6 py-3 text-right">Win %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {outcomes.map(r => (
                      <tr key={r.mvprId} className="border-b border-white/[0.04] last:border-0">
                        <td className="px-6 py-3">
                          <p className="font-medium text-white">{r.title}</p>
                          <p className="text-[11px] text-zinc-500 capitalize">
                            {r.isOrganic ? "Earned" : "Placed"}
                            <span className="mx-1.5 text-zinc-600">·</span>
                            {r.tier}
                            {r.domainAuthority != null && (<>
                              <span className="mx-1.5 text-zinc-600">·</span>
                              DA {r.domainAuthority}
                            </>)}
                          </p>
                        </td>
                        <td className="px-6 py-3 text-zinc-300">{r.publicationName}</td>
                        <td className="px-6 py-3 text-right font-mono tabular-nums text-white">{r.campaignCount}</td>
                        <td className="px-6 py-3 text-right font-mono tabular-nums text-white">{r.sent}</td>
                        <td className="px-6 py-3 text-right font-mono tabular-nums text-zinc-300">{r.responseRate != null ? `${r.responseRate}%` : "-"}</td>
                        <td className="px-6 py-3 text-right font-mono tabular-nums text-zinc-300">{r.bookingRate != null ? `${r.bookingRate}%` : "-"}</td>
                        <td className="px-6 py-3 text-right font-mono tabular-nums text-zinc-300">{r.winRate != null ? `${r.winRate}%` : "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Campaigns spawned from coverage */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
            <div className="border-b border-white/[0.08] px-6 py-4">
              <h2 className="text-[16px] font-bold text-white">Campaigns from coverage</h2>
              <p className="mt-1 text-[13px] text-zinc-400">
                Campaigns the team has spawned from a coverage piece, or attached one to.
              </p>
            </div>
            {campaigns.length === 0 ? (
              <p className="px-6 py-8 text-[13px] text-zinc-400">
                No campaigns yet have a coverage attached. Open a coverage row on{" "}
                <a className="underline decoration-white/30 underline-offset-4" href={`/dashboard/${workspaceId}/actions`}>/actions</a>
                {" "}and try the &quot;Use this coverage&quot; panel.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-[13px]">
                  <thead>
                    <tr className="border-b border-white/[0.06] text-left text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">
                      <th className="px-6 py-3">Campaign</th>
                      <th className="px-6 py-3">Channel</th>
                      <th className="px-6 py-3">Coverage</th>
                      <th className="px-6 py-3">Publication</th>
                      <th className="px-6 py-3">Attached</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.map(r => (
                      <tr key={`${r.campaignId}:${r.coverageMvprId}`} className="border-b border-white/[0.04] last:border-0">
                        <td className="px-6 py-3 font-medium text-white">
                          <a
                            href={`/dashboard/${workspaceId}/settings/campaigns/${r.campaignId}`}
                            className="hover:underline decoration-white/30 underline-offset-4"
                          >
                            {r.campaignName}
                          </a>
                        </td>
                        <td className="px-6 py-3 capitalize text-zinc-300">{r.channel.replace(/_/g, " ")}</td>
                        <td className="px-6 py-3 text-zinc-300">{r.coverageTitle}</td>
                        <td className="px-6 py-3 text-zinc-300">{r.publicationName}</td>
                        <td className="px-6 py-3 text-zinc-400">
                          {new Date(r.attachedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-6 py-5">
      <p className="text-[11px] font-bold uppercase tracking-[0.10em] text-zinc-500">{label}</p>
      <p className="mt-1 text-[28px] font-bold tabular-nums leading-none text-white">{value}</p>
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
      <div className="border-b border-white/[0.08] px-5 py-3">
        <h3 className="text-[14px] font-semibold text-white">{title}</h3>
      </div>
      {children}
    </div>
  )
}

function Empty() {
  return <p className="px-5 py-8 text-[13px] text-zinc-400">No data yet.</p>
}

function SplitBar({
  leftLabel, leftCount, rightLabel, rightCount,
}: {
  leftLabel: string; leftCount: number; rightLabel: string; rightCount: number
}) {
  const total = leftCount + rightCount
  const leftPct  = total ? Math.round((leftCount  / total) * 100) : 0
  const rightPct = total ? 100 - leftPct : 0
  return (
    <div className="space-y-3 px-5 py-5">
      <div className="flex h-3 overflow-hidden rounded-full bg-white/[0.06]">
        <div className="bg-emerald-400/60" style={{ width: `${leftPct}%` }} aria-hidden />
        <div className="bg-amber-400/60"   style={{ width: `${rightPct}%` }} aria-hidden />
      </div>
      <div className="flex justify-between text-[12px] text-zinc-300">
        <span><span className="inline-block h-2 w-2 mr-1.5 rounded-full bg-emerald-400/80 align-middle" />{leftLabel}: <span className="tabular-nums text-white">{leftCount}</span> <span className="text-zinc-500">({leftPct}%)</span></span>
        <span>{rightLabel}: <span className="tabular-nums text-white">{rightCount}</span> <span className="text-zinc-500">({rightPct}%)</span><span className="inline-block h-2 w-2 ml-1.5 rounded-full bg-amber-400/80 align-middle" /></span>
      </div>
    </div>
  )
}

function fmtPct(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return "-"
  return `${Math.round(n * 100)}%`
}

const INTENT_LABELS: Record<string, string> = {
  pressRelease:      "Press release",
  outreach:          "Outreach",
  newsjacking:       "Newsjacking",
  opEd:              "Op-ed",
  opportunity:       "Opportunity",
  customOpportunity: "Custom opportunity",
}

function intentLabel(intent: string): string {
  return INTENT_LABELS[intent] ?? intent
}

/** Response rate from announcement message stats (received / sent). Avoids open rate. */
function announcementResponseRate(stats: { messagesSent?: number; messagesReceived?: number } | null): number | undefined {
  if (!stats || !stats.messagesSent) return undefined
  return (stats.messagesReceived ?? 0) / stats.messagesSent
}

function LiftCell({ w, wo }: { w: number | null; wo: number | null }) {
  const delta = (w != null && wo != null) ? w - wo : null
  const deltaColor = delta == null ? "text-zinc-500" : delta > 0 ? "text-emerald-300" : delta < 0 ? "text-rose-300" : "text-zinc-400"
  return (
    <td className="px-6 py-3 text-right">
      <span className="inline-flex flex-col items-end leading-tight">
        <span className="font-mono tabular-nums text-white">
          {w != null ? `${w}%` : "-"}
          <span className="ml-1 text-zinc-500">vs {wo != null ? `${wo}%` : "-"}</span>
        </span>
        <span className={`text-[10px] font-bold tabular-nums ${deltaColor}`}>
          {delta == null ? "" : delta > 0 ? `+${delta}pp` : `${delta}pp`}
        </span>
      </span>
    </td>
  )
}
