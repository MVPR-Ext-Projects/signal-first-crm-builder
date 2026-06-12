/**
 * Channels page.
 *
 * Replaces the previous /actions stack of hardcoded channel sections.
 * Channels are now DB-driven: the migration seeded the canonical six
 * (PR coverage, LinkedIn DM, Direct Email, Newsletter, Product Updates,
 * Outbound Calls); the user can create more from the top-of-page form.
 *
 * Each channel renders one card with:
 *   - Header: name + delivery mechanism + fingerprint chip
 *   - Stat strip pulled from the existing channel-specific helpers
 *     (getOutreachStats / getCallStats / getBroadcastStats) by mapping
 *     the channel name to the legacy enum value. PR C will replace
 *     this mapping with a generic channel-id-driven helper that also
 *     accepts a Custom Tag filter.
 *   - Nested campaigns (channel_id-filtered). Each row carries its own
 *     stat strip (stubbed to "-" until PR C wires getStatsByCampaign).
 *     Click a row to unfurl Companies -> People -> Signals in place.
 *   - "Add campaign" affordance inside each delivery channel card.
 *
 * The OutboundExclusions section is preserved below the channel cards
 * since it's a workspace-wide setting, not channel-specific.
 */

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import {
  getOutreachStats,
  getCallStats,
  getBroadcastStats,
  getCallLogTree,
  getDncContacts,
  getPersonalEmailContacts,
  isDbConfigured,
} from "@/lib/db/contact-store"
import { listChannels, type ChannelRow } from "@/lib/db/channels"
import { listCampaigns, type CampaignRow } from "@/lib/db/campaigns"
import { listCoverage, getCoverageUsageCounts } from "@/lib/db/coverage"
import { OutboundExclusions } from "./outbound-exclusions"
import { PrCoveragePanel } from "./pr-coverage-panel"
import { CreateChannelForm } from "./create-channel-form"
import { ChannelCard, type ChannelCardStats } from "./channel-card"
import { CallLogTree } from "./call-log-tree"
import { resolveProspectTypes } from "@/lib/workspace-config"

export const dynamic = "force-dynamic"

export default async function ChannelsPage({
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

  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000)
  const [
    channels,
    campaigns,
    dmStats,
    emailStats,
    callStats,
    newsletterStats,
    productEmailStats,
    dncContacts,
    personalEmailContacts,
    coverage,
  ] = await Promise.all([
    listChannels(workspaceId),
    listCampaigns(workspaceId),
    getOutreachStats(workspaceId, thirtyDaysAgo, 'dm'),
    getOutreachStats(workspaceId, thirtyDaysAgo, 'email'),
    getCallStats(workspaceId, thirtyDaysAgo),
    getBroadcastStats(workspaceId, 'newsletter', thirtyDaysAgo),
    getBroadcastStats(workspaceId, 'product_update', thirtyDaysAgo),
    getDncContacts(workspaceId),
    getPersonalEmailContacts(workspaceId),
    listCoverage(workspaceId, { limit: 100 }),
  ])
  // PR-coverage source isn't wired in this template; treat as unconfigured
  // until the integration is rebuilt.
  const prCoverageConfigured = false
  const usageCountsMap = await getCoverageUsageCounts(workspaceId)
  const usageCounts: Record<string, number> = {}
  for (const [k, v] of usageCountsMap.entries()) usageCounts[k] = v
  const callTree = await getCallLogTree(workspaceId, thirtyDaysAgo)

  const campaignsByChannelId = groupCampaignsByChannelId(campaigns)
  const prospectTypes = resolveProspectTypes(config)

  return (
    <div className="space-y-7">
      <div>
        <p className="mb-1.5 text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">
          {config.name ?? workspaceId} · Channels
        </p>
        <h1 className="text-[30px] font-bold tracking-[-0.02em] text-white">Channels</h1>
        <p className="mt-1.5 text-[15px] leading-[22px] text-zinc-300">
          Outreach across your pipeline, grouped by channel. Each channel has its own delivery mechanism and nested campaigns.
        </p>
      </div>

      <CreateChannelForm workspaceId={workspaceId} />

      {channels.map(channel => {
        const channelCampaigns = (campaignsByChannelId.get(channel.id) ?? []).map(c => ({
          id:        c.id,
          name:      c.name,
          createdAt: c.createdAt,
        }))
        const stats = statsForChannel(channel.name, {
          dmStats, emailStats, callStats, newsletterStats, productEmailStats,
        })

        return (
          <ChannelCard
            key={channel.id}
            workspaceId={workspaceId}
            channel={channel}
            campaigns={channelCampaigns}
            stats={stats}
            prospectTypes={prospectTypes}
          >
            {channel.name === "PR coverage" && (
              <PrCoveragePanel
                workspaceId={workspaceId}
                initial={coverage}
                isConfigured={prCoverageConfigured}
                usageCounts={usageCounts}
              />
            )}
            {channel.name === "Outbound Calls" && (
              <CallLogTree companies={callTree} />
            )}
          </ChannelCard>
        )
      })}

      <OutboundExclusions
        workspaceId={workspaceId}
        dnc={dncContacts}
        personalEmail={personalEmailContacts}
      />
    </div>
  )
}

function groupCampaignsByChannelId(campaigns: CampaignRow[]): Map<string, CampaignRow[]> {
  const map = new Map<string, CampaignRow[]>()
  for (const c of campaigns) {
    if (!c.channelId) continue
    const list = map.get(c.channelId) ?? []
    list.push(c)
    map.set(c.channelId, list)
  }
  return map
}

// Stats helper bridge - PR B still uses the legacy channel-name dispatch.
// PR C will replace this with `getStatsByChannel(channelId, ...)` that goes
// through the channels.delivery_mechanism + name and accepts a Custom Tag
// filter.
type StatsBundle = {
  dmStats: Awaited<ReturnType<typeof getOutreachStats>>
  emailStats: Awaited<ReturnType<typeof getOutreachStats>>
  callStats: Awaited<ReturnType<typeof getCallStats>>
  newsletterStats: Awaited<ReturnType<typeof getBroadcastStats>>
  productEmailStats: Awaited<ReturnType<typeof getBroadcastStats>>
}

function statsForChannel(channelName: string, b: StatsBundle): ChannelCardStats {
  switch (channelName) {
    case "LinkedIn DM":
      return {
        primary: [
          { label: "DMs sent",        value: b.dmStats.sent.toString() },
          { label: "Response rate",   value: b.dmStats.responseRate !== null ? `${b.dmStats.responseRate}%` : "-" },
          { label: "Booking rate",    value: b.dmStats.bookingRate   !== null ? `${b.dmStats.bookingRate}%`  : "-" },
          { label: "Client win rate", value: b.dmStats.winRate       !== null ? `${b.dmStats.winRate}%`      : "-" },
        ],
      }
    case "Direct Email":
      return {
        primary: [
          { label: "Emails sent",     value: b.emailStats.sent.toString() },
          { label: "Response rate",   value: b.emailStats.responseRate !== null ? `${b.emailStats.responseRate}%` : "-" },
          { label: "Booking rate",    value: b.emailStats.bookingRate   !== null ? `${b.emailStats.bookingRate}%`  : "-" },
          { label: "Client win rate", value: b.emailStats.winRate       !== null ? `${b.emailStats.winRate}%`      : "-" },
        ],
      }
    case "Outbound Calls":
      return {
        primary: [
          { label: "Calls made",      value: b.callStats.total.toString() },
          { label: "Answer rate",     value: b.callStats.answerRate  !== null ? `${b.callStats.answerRate}%`  : "-" },
          { label: "Booking rate",    value: b.callStats.bookingRate !== null ? `${b.callStats.bookingRate}%` : "-" },
          { label: "Client win rate", value: b.callStats.winRate     !== null ? `${b.callStats.winRate}%`     : "-" },
        ],
      }
    case "Newsletter":
      return {
        primary: [
          { label: "Sent",            value: b.newsletterStats.sends.toString() },
          { label: "Open rate",       value: b.newsletterStats.openRate    !== null ? `${b.newsletterStats.openRate}%`    : "-" },
          { label: "Click rate",      value: b.newsletterStats.clickRate   !== null ? `${b.newsletterStats.clickRate}%`   : "-" },
          { label: "Booking rate",    value: b.newsletterStats.bookingRate !== null ? `${b.newsletterStats.bookingRate}%` : "-" },
        ],
      }
    case "Product Updates":
      return {
        primary: [
          { label: "Sent",            value: b.productEmailStats.sends.toString() },
          { label: "Click rate",      value: b.productEmailStats.clickRate   !== null ? `${b.productEmailStats.clickRate}%`   : "-" },
          { label: "Booking rate",    value: b.productEmailStats.bookingRate !== null ? `${b.productEmailStats.bookingRate}%` : "-" },
          { label: "Win/upsell rate", value: b.productEmailStats.winOrUpsoldRate !== null ? `${b.productEmailStats.winOrUpsoldRate}%` : "-" },
        ],
      }
    default:
      // PR coverage (delivery=none) + any user-created channel renders
      // with an empty stat strip for now.
      return { primary: [] }
  }
}
