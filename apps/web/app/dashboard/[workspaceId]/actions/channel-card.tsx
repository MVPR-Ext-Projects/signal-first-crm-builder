"use client"

/**
 * ChannelCard - one card per channel on the Channels page. Renders:
 *   - Header: channel name, delivery mechanism chip, fingerprint chip,
 *     Custom Tag filter (when applicable), stat strip.
 *   - Nested campaign list. Each row gets its own per-campaign stat
 *     strip pulled from getStatsByCampaign via the combined channel-
 *     stats endpoint. Click row to unfurl Companies -> People ->
 *     Signals tree. "Edit settings" inside the unfurled header opens
 *     the campaign-settings drawer.
 *   - "Add campaign" button.
 *
 * Server-side initial render seeds the stats; flipping the Custom Tag
 * filter re-fetches /api/dashboard/[wsId]/channels/[id]/stats and
 * updates both the channel header strip + each campaign row strip.
 *
 * Newsletter / Product Updates / no-delivery channels hide the filter
 * chip - their data model isn't filterable by Custom Tag.
 */

import { useState, useEffect, useTransition } from "react"
import { useRouter } from "next/navigation"
import type { ChannelRow } from "@/lib/db/channels"
import { CampaignRow } from "./campaign-row"
import { RightDrawer } from "./right-drawer"
import { ChannelSettingsDrawer } from "./channel-settings-drawer"

export interface ChannelCardCampaign {
  id:               string
  name:             string
  createdAt:        string
}

export interface ChannelCardStats {
  primary:    { label: string; value: string }[]   // 1-4 stat cards rendered in the header
}

export function ChannelCard({
  workspaceId,
  channel,
  campaigns,
  stats,
  prospectTypes,
  emptyMessage,
  children,
}: {
  workspaceId:    string
  channel:        ChannelRow
  campaigns:      ChannelCardCampaign[]
  stats:          ChannelCardStats
  /** Available Custom Tags from WorkspaceConfig.prospectTypes. Empty array hides the filter. */
  prospectTypes:  string[]
  emptyMessage?:  string
  /** Optional inline content slot (e.g. PR coverage uses this for the coverage list). */
  children?:      React.ReactNode
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [newName, setNewName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  // ── Expand state + drawer ──────────────────────────────────────────────────
  const [expanded, setExpanded] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)

  // ── Custom Tag filter state + lazy stats fetch ─────────────────────────────
  const [tag, setTag] = useState<string | null>(null)
  const [headerStats, setHeaderStats] = useState<ChannelCardStats>(stats)
  const [campaignStatsById, setCampaignStatsById] = useState<Record<string, { label: string; value: string }[]>>({})
  const [statsBusy, setStatsBusy] = useState(false)

  const filterable = isFilterable(channel)

  useEffect(() => {
    // Initial fetch on mount so per-campaign rows populate too.
    // Also re-runs when the tag changes.
    let cancelled = false
    async function load() {
      setStatsBusy(true)
      try {
        const qs = tag ? `?prospectType=${encodeURIComponent(tag)}` : ""
        const res = await fetch(`/api/dashboard/${workspaceId}/channels/${channel.id}/stats${qs}`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok || cancelled) return
        setHeaderStats(data.channel ?? { primary: [] })
        const byId: Record<string, { label: string; value: string }[]> = {}
        for (const c of (data.campaigns ?? []) as Array<{ id: string; primary: { label: string; value: string }[] }>) {
          byId[c.id] = c.primary
        }
        setCampaignStatsById(byId)
      } finally {
        if (!cancelled) setStatsBusy(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [tag, workspaceId, channel.id])

  const enumValue = deliveryToCampaignChannel(channel)

  async function addCampaign() {
    if (!newName.trim()) { setError("Name is required."); return }
    setError(null)
    setBusy(true)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/campaigns`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          name:             newName.trim(),
          channel:          enumValue,
          clickedLinkScore: 0,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); return }
      setNewName("")
      setShowAdd(false)
      startTransition(() => router.refresh())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
      {/* Header - click to expand/collapse the targets area */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded(v => !v)}
        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded(v => !v) } }}
        className="cursor-pointer border-b border-white/[0.08] px-6 py-4 transition-colors hover:bg-white/[0.01] motion-reduce:transition-none"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex items-center gap-2.5">
            <Chevron expanded={expanded} />
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[16px] font-bold text-white">{channel.name}</h2>
              <DeliveryChip mechanism={channel.deliveryMechanism} />
              {channel.hasFingerprint && (
                <span className="rounded-md bg-[#2BA98B]/[0.16] px-2 py-0.5 text-[11px] font-semibold text-emerald-200">
                  fingerprint
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
            {filterable && prospectTypes.length > 0 && (
              <>
                <label className="text-[11px] text-zinc-500" htmlFor={`tag-${channel.id}`}>Tag:</label>
                <select
                  id={`tag-${channel.id}`}
                  value={tag ?? ""}
                  onChange={e => setTag(e.target.value || null)}
                  disabled={statsBusy}
                  className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-zinc-200 focus:border-white/24 focus:outline-none disabled:opacity-50"
                >
                  <option value="">All tags</option>
                  {prospectTypes.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </>
            )}
            <button
              type="button"
              onClick={e => { e.stopPropagation(); setDrawerOpen(true) }}
              className="rounded-md border border-white/12 bg-white/[0.04] px-2.5 py-1 text-[11px] font-semibold text-zinc-200 hover:border-white/24 motion-reduce:transition-none"
            >
              Edit settings
            </button>
          </div>
        </div>
      </div>

      {/* Stat strip - always visible (collapsed cards still show at-a-glance numbers) */}
      {headerStats.primary.length > 0 && (
        <div className="grid grid-cols-2 divide-x divide-white/[0.06] sm:grid-cols-4">
          {headerStats.primary.map(s => (
            <StatCard key={s.label} label={s.label} value={s.value} />
          ))}
        </div>
      )}

      {/* Inline content slot (e.g. PR coverage panel, call log tree). Only shown when expanded. */}
      {expanded && children}

      {/* Campaigns under this channel - only when expanded */}
      {expanded && channel.deliveryMechanism !== "none" && channel.deliveryMechanism !== "twilio_voice" && (
        <div className="border-t border-white/[0.06]">
          <div className="flex items-center justify-between px-6 py-3">
            <p className="text-[11px] font-bold uppercase tracking-[0.10em] text-zinc-500">
              Campaigns ({campaigns.length})
            </p>
            <button
              type="button"
              onClick={() => setShowAdd(v => !v)}
              className="rounded-md border border-white/12 bg-white/[0.04] px-2.5 py-1 text-[11px] font-semibold text-zinc-200 hover:border-white/24"
            >
              {showAdd ? "Cancel" : "+ Add campaign"}
            </button>
          </div>

          {showAdd && (
            <div className="border-t border-white/[0.04] bg-white/[0.02] px-6 py-3 flex gap-2">
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="Campaign name (e.g. Q3 founders push)"
                className="flex-1 rounded-lg border border-white/12 bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-zinc-100 placeholder:text-zinc-500 focus:border-white/24 focus:outline-none"
              />
              <button
                type="button"
                onClick={addCampaign}
                disabled={busy}
                className="rounded-lg bg-[#2BA98B] px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-[#249A7E] disabled:opacity-50"
              >{busy ? "Adding..." : "Create"}</button>
            </div>
          )}
          {error && <p className="px-6 py-2 text-[12px] text-red-400">{error}</p>}

          {campaigns.length === 0 ? (
            <p className="px-6 py-6 text-[13px] text-zinc-400">
              {emptyMessage ?? `No campaigns yet on this channel. Add one to start tracking ${channel.name} performance per campaign.`}
            </p>
          ) : (
            <ul className="divide-y divide-white/[0.04]">
              {campaigns.map(c => (
                <CampaignRow
                  key={c.id}
                  workspaceId={workspaceId}
                  campaign={c}
                  channelLabel={channel.name}
                  supportsFingerprint={channel.hasFingerprint}
                  stats={campaignStatsById[c.id]}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      <RightDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        ariaLabel={`${channel.name} settings`}
        eyebrow="Channel settings"
      >
        <ChannelSettingsDrawer
          workspaceId={workspaceId}
          channel={channel}
          onArchived={() => { setDrawerOpen(false); router.refresh() }}
        />
      </RightDrawer>
    </div>
  )
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="11"
      height="11"
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

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-6 py-5">
      <p className="text-[11px] font-bold uppercase tracking-[0.10em] text-zinc-500">{label}</p>
      <p className="mt-1 text-[28px] font-bold tabular-nums leading-none text-white">{value}</p>
    </div>
  )
}

function DeliveryChip({ mechanism }: { mechanism: string }) {
  const labels: Record<string, string> = {
    none:         "no delivery",
    unipile:      "via Unipile",
    resend:       "via Resend",
    twilio_voice: "via Twilio (soon)",
  }
  return (
    <span className="rounded-md border border-white/10 px-2 py-0.5 text-[11px] font-medium text-zinc-400">
      {labels[mechanism] ?? mechanism}
    </span>
  )
}

/**
 * Map a Channel's display name + delivery mechanism back onto the legacy
 * campaigns.channel enum value. Used when creating a campaign under a
 * channel so the legacy enum stays populated for back-compat stats reads.
 */
function deliveryToCampaignChannel(channel: ChannelRow): "linkedin_dm" | "email" | "newsletter" | "lead_magnet" | "other" {
  const name = channel.name.toLowerCase()
  if (name.includes("linkedin"))    return "linkedin_dm"
  if (name.includes("newsletter"))  return "newsletter"
  if (channel.deliveryMechanism === "resend") return "email"
  return "other"
}

/**
 * Can this channel's stats be filtered by Custom Tag? Broadcast channels
 * (newsletter, product updates) roll up counts per send before they
 * touch contacts, so the contact-side tag filter doesn't apply. No-delivery
 * channels (PR coverage) have no outbound stats at all.
 */
function isFilterable(channel: ChannelRow): boolean {
  if (channel.deliveryMechanism === "none") return false
  if (channel.name === "Newsletter") return false
  if (channel.name === "Product Updates") return false
  return true
}
