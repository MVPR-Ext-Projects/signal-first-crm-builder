/**
 * GET /api/dashboard/[workspaceId]/channels/[channelId]/stats?prospectType=...
 *
 * Combined endpoint for the Channels page filter chip: returns both the
 * channel-header stat strip + per-campaign stat strips in one round-trip.
 *
 * Dispatches to the appropriate underlying helper based on channel name
 * + delivery mechanism (legacy enum mapping). Newsletter / Product
 * Updates / no-delivery channels return `{ primary: [] }` since their
 * data model isn't filterable by Custom Tag (broadcast_sends rolls up
 * counts pre-recipient).
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { getChannelById } from "@/lib/db/channels"
import { listCampaigns } from "@/lib/db/campaigns"
import {
  getOutreachStats,
  getCallStats,
  getBroadcastStats,
  getStatsByCampaign,
} from "@/lib/db/contact-store"

interface PrimaryStat { label: string; value: string }
interface ChannelStats { primary: PrimaryStat[] }
interface CampaignStats { id: string; primary: PrimaryStat[] }

const THIRTY_DAYS_MS = 30 * 86_400_000

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; channelId: string }> },
) {
  const { workspaceId, channelId } = await params

  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Unknown workspace" }, { status: 404 })
  if (config.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  const channel = await getChannelById(workspaceId, channelId)
  if (!channel) return NextResponse.json({ error: "Channel not found" }, { status: 404 })

  const prospectType = (req.nextUrl.searchParams.get("prospectType") || "").trim() || null
  const since = new Date(Date.now() - THIRTY_DAYS_MS)

  const channelStats: ChannelStats = await channelStrip(workspaceId, channel.name, since, prospectType)

  // Per-campaign strips: only meaningful for delivery channels.
  let campaignStats: CampaignStats[] = []
  if (channel.deliveryMechanism !== "none") {
    const campaigns = await listCampaigns(workspaceId)
    const own = campaigns.filter(c => c.channelId === channel.id)
    campaignStats = await Promise.all(
      own.map(async c => {
        const s = await getStatsByCampaign(workspaceId, c.id, since, prospectType)
        return {
          id:      c.id,
          primary: [
            { label: "Sent",     value: s.sent.toString() },
            { label: "Reply %",  value: s.responseRate !== null ? `${s.responseRate}%` : "-" },
            { label: "Booked %", value: s.bookingRate  !== null ? `${s.bookingRate}%`  : "-" },
            { label: "Won %",    value: s.winRate      !== null ? `${s.winRate}%`      : "-" },
          ],
        }
      }),
    )
  }

  return NextResponse.json({
    channel:           channelStats,
    campaigns:         campaignStats,
    filterableBy:      channel.deliveryMechanism === "none" || channel.name === "Newsletter" || channel.name === "Product Updates"
      ? null
      : "prospectType",
    activeProspectType: prospectType,
  })
}

async function channelStrip(
  workspaceId: string,
  channelName: string,
  since: Date,
  prospectType: string | null,
): Promise<ChannelStats> {
  switch (channelName) {
    case "LinkedIn DM": {
      const s = await getOutreachStats(workspaceId, since, "dm", prospectType)
      return {
        primary: [
          { label: "DMs sent",        value: s.sent.toString() },
          { label: "Response rate",   value: s.responseRate !== null ? `${s.responseRate}%` : "-" },
          { label: "Booking rate",    value: s.bookingRate  !== null ? `${s.bookingRate}%`  : "-" },
          { label: "Client win rate", value: s.winRate      !== null ? `${s.winRate}%`      : "-" },
        ],
      }
    }
    case "Direct Email": {
      const s = await getOutreachStats(workspaceId, since, "email", prospectType)
      return {
        primary: [
          { label: "Emails sent",     value: s.sent.toString() },
          { label: "Response rate",   value: s.responseRate !== null ? `${s.responseRate}%` : "-" },
          { label: "Booking rate",    value: s.bookingRate  !== null ? `${s.bookingRate}%`  : "-" },
          { label: "Client win rate", value: s.winRate      !== null ? `${s.winRate}%`      : "-" },
        ],
      }
    }
    case "Outbound Calls": {
      const s = await getCallStats(workspaceId, since, 50, prospectType)
      return {
        primary: [
          { label: "Calls made",      value: s.total.toString() },
          { label: "Answer rate",     value: s.answerRate  !== null ? `${s.answerRate}%`  : "-" },
          { label: "Booking rate",    value: s.bookingRate !== null ? `${s.bookingRate}%` : "-" },
          { label: "Client win rate", value: s.winRate     !== null ? `${s.winRate}%`     : "-" },
        ],
      }
    }
    case "Newsletter": {
      // broadcast_sends rolls up counts pre-recipient; not filterable by tag.
      const s = await getBroadcastStats(workspaceId, "newsletter", since)
      return {
        primary: [
          { label: "Sent",          value: s.sends.toString() },
          { label: "Open rate",     value: s.openRate    !== null ? `${s.openRate}%`    : "-" },
          { label: "Click rate",    value: s.clickRate   !== null ? `${s.clickRate}%`   : "-" },
          { label: "Booking rate",  value: s.bookingRate !== null ? `${s.bookingRate}%` : "-" },
        ],
      }
    }
    case "Product Updates": {
      const s = await getBroadcastStats(workspaceId, "product_update", since)
      return {
        primary: [
          { label: "Sent",            value: s.sends.toString() },
          { label: "Click rate",      value: s.clickRate       !== null ? `${s.clickRate}%`       : "-" },
          { label: "Booking rate",    value: s.bookingRate     !== null ? `${s.bookingRate}%`     : "-" },
          { label: "Win/upsell rate", value: s.winOrUpsoldRate !== null ? `${s.winOrUpsoldRate}%` : "-" },
        ],
      }
    }
    default:
      return { primary: [] }
  }
}
