"use client"

/**
 * CampaignRow - one row per campaign inside a ChannelCard.
 *
 *   - Click the row to unfurl Companies -> People -> Signals tree in
 *     place. Lazy-loads via /api/dashboard/[wsId]/campaigns/[id]/unfurl.
 *   - "Edit settings" button (visible only when unfurled) opens the
 *     CampaignSettingsDrawer (templates / fingerprint / coverage /
 *     archive).
 *   - Inline stat strip on the row mirrors the channel-header strip
 *     so per-campaign perf is visible at a glance. Stats are stubbed
 *     to "-" until PR C wires getStatsByCampaign.
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { RightDrawer } from "./right-drawer"
import { CampaignSettingsDrawer } from "./campaign-settings-drawer"
import type { CampaignTemplateRow } from "@/lib/db/campaign-templates"

interface ChannelCardCampaign {
  id:        string
  name:      string
  createdAt: string
}

interface UnfurlSignal {
  id:         number
  verb:       string | null
  description: string | null
  occurredAt: string
  scoreDelta: number
}

interface UnfurlContact {
  id:            number
  fullName:      string | null
  jobTitle:      string | null
  linkedinUrl:   string | null
  signalScore:   number
  signalCount:   number
  recentSignals: UnfurlSignal[]
}

interface UnfurlCompany {
  companyName:  string
  contactCount: number
  contacts:     UnfurlContact[]
}

export function CampaignRow({
  workspaceId,
  campaign,
  channelLabel,
  supportsFingerprint,
  stats,
}: {
  workspaceId:         string
  campaign:            ChannelCardCampaign
  channelLabel:        string
  supportsFingerprint: boolean
  /** Inline stat strip passed in from the ChannelCard's combined fetch. Undefined while loading. */
  stats?:              { label: string; value: string }[]
}) {
  const router = useRouter()
  const [expanded, setExpanded] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [companies, setCompanies] = useState<UnfurlCompany[] | null>(null)
  const [unfurlLoading, setUnfurlLoading] = useState(false)
  const [unfurlError, setUnfurlError] = useState<string | null>(null)
  const [openCompany, setOpenCompany] = useState<string | null>(null)
  const [openContact, setOpenContact] = useState<number | null>(null)

  // Drawer payload, lazy-loaded on open.
  const [drawerData, setDrawerData] = useState<null | {
    templates:           CampaignTemplateRow[]
    fingerprint:         { id: number; version: number; createdAt: string; samplePos: number } | null
    coverage:            { mvprId: string; title: string; publicationName: string }[]
    channelLabel:        string
    supportsFingerprint: boolean
  }>(null)
  const [drawerLoading, setDrawerLoading] = useState(false)

  useEffect(() => {
    if (!expanded || companies !== null) return
    let cancelled = false
    async function load() {
      setUnfurlLoading(true)
      setUnfurlError(null)
      try {
        const res = await fetch(`/api/dashboard/${workspaceId}/campaigns/${campaign.id}/unfurl`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          if (!cancelled) setUnfurlError(data.error ?? `HTTP ${res.status}`)
          return
        }
        if (!cancelled) setCompanies(data.companies ?? [])
      } catch (e) {
        if (!cancelled) setUnfurlError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setUnfurlLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [expanded, companies, workspaceId, campaign.id])

  async function openDrawer() {
    setDrawerOpen(true)
    if (drawerData !== null) return
    setDrawerLoading(true)
    try {
      const [tplRes, fpRes] = await Promise.all([
        fetch(`/api/dashboard/${workspaceId}/campaigns/${campaign.id}/templates`),
        supportsFingerprint
          ? fetch(`/api/dashboard/${workspaceId}/campaigns/${campaign.id}/fingerprint`)
          : Promise.resolve(null as Response | null),
      ])
      const tplBody = await tplRes.json().catch(() => ({}))
      const fpBody  = fpRes ? await fpRes.json().catch(() => ({})) : { fingerprint: null }
      setDrawerData({
        templates:           tplBody.templates ?? [],
        fingerprint:         fpBody.fingerprint
          ? {
              id:        fpBody.fingerprint.id,
              version:   fpBody.fingerprint.version,
              createdAt: fpBody.fingerprint.createdAt,
              samplePos: fpBody.fingerprint.samplePos,
            }
          : null,
        // Coverage attached list comes from a future PR's endpoint;
        // empty array for now.
        coverage:            [],
        channelLabel,
        supportsFingerprint,
      })
    } finally {
      setDrawerLoading(false)
    }
  }

  return (
    <li>
      <div className="px-6 py-3">
        <div
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onClick={() => setExpanded(v => !v)}
          onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded(v => !v) } }}
          className="cursor-pointer rounded-lg px-3 py-2 -mx-3 hover:bg-white/[0.02] transition-colors motion-reduce:transition-none flex flex-wrap items-center gap-3"
        >
          <Chevron expanded={expanded} />
          <span className="flex-1 min-w-0 truncate text-[14px] font-semibold text-white">{campaign.name}</span>

          {/* Inline stat strip - sourced from getStatsByCampaign via the
              ChannelCard's combined fetch. Falls back to placeholders
              while the parent is still loading. */}
          <div className="hidden md:flex items-center gap-4 text-[11px] tabular-nums text-zinc-400">
            {(stats ?? [
              { label: "Sent",     value: "-" },
              { label: "Reply %",  value: "-" },
              { label: "Booked %", value: "-" },
              { label: "Won %",    value: "-" },
            ]).map(s => (
              <MiniStat key={s.label} label={s.label} value={s.value} />
            ))}
          </div>
        </div>

        {expanded && (
          <div className="mt-3 ml-7 border-l border-white/[0.06] pl-5 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-bold uppercase tracking-[0.10em] text-zinc-500">
                {companies?.length ?? 0} {companies?.length === 1 ? "company" : "companies"} in this campaign
              </p>
              <button
                type="button"
                onClick={openDrawer}
                className="rounded-md border border-white/12 bg-white/[0.04] px-2.5 py-1 text-[11px] font-semibold text-zinc-200 hover:border-white/24"
              >
                Edit settings
              </button>
            </div>

            {unfurlLoading && <p className="text-[12px] text-zinc-400">Loading...</p>}
            {unfurlError && <p className="text-[12px] text-red-400">{unfurlError}</p>}
            {!unfurlLoading && !unfurlError && companies && companies.length === 0 && (
              <p className="text-[12px] text-zinc-400">No contacts enrolled yet.</p>
            )}

            {companies && companies.length > 0 && (
              <ul className="space-y-1">
                {companies.map(co => (
                  <CompanyNode
                    key={co.companyName}
                    company={co}
                    expanded={openCompany === co.companyName}
                    onToggle={() => setOpenCompany(prev => prev === co.companyName ? null : co.companyName)}
                    openContact={openContact}
                    setOpenContact={setOpenContact}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <RightDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        ariaLabel={`${campaign.name} settings`}
        eyebrow="Campaign settings"
      >
        {drawerLoading || !drawerData ? (
          <p className="text-[13px] text-zinc-400">Loading...</p>
        ) : (
          <CampaignSettingsDrawer
            workspaceId={workspaceId}
            campaign={{ id: campaign.id, name: campaign.name, channel: channelLabel }}
            initial={drawerData}
            onArchive={() => {
              setDrawerOpen(false)
              router.refresh()
            }}
          />
        )}
      </RightDrawer>
    </li>
  )
}

function CompanyNode({
  company,
  expanded,
  onToggle,
  openContact,
  setOpenContact,
}: {
  company:         UnfurlCompany
  expanded:        boolean
  onToggle:        () => void
  openContact:     number | null
  setOpenContact:  (id: number | null) => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-white/[0.03] motion-reduce:transition-none"
      >
        <Chevron expanded={expanded} />
        <span className="font-semibold text-white">{company.companyName}</span>
        <span className="ml-auto text-[11px] tabular-nums text-zinc-500">{company.contactCount} {company.contactCount === 1 ? "person" : "people"}</span>
      </button>

      {expanded && (
        <ul className="ml-5 mt-1 space-y-1 border-l border-white/[0.04] pl-3">
          {company.contacts.map(c => (
            <ContactNode
              key={c.id}
              contact={c}
              expanded={openContact === c.id}
              onToggle={() => setOpenContact(openContact === c.id ? null : c.id)}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

function ContactNode({
  contact,
  expanded,
  onToggle,
}: {
  contact:  UnfurlContact
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-white/[0.02] motion-reduce:transition-none"
      >
        <Chevron expanded={expanded} small />
        <span className="font-medium text-zinc-100">{contact.fullName ?? "(no name)"}</span>
        {contact.jobTitle && <span className="text-zinc-400 truncate">{contact.jobTitle}</span>}
        <span className="ml-auto inline-flex items-center gap-2 text-[10px] tabular-nums text-zinc-500">
          <span>score {contact.signalScore}</span>
          <span>•</span>
          <span>{contact.signalCount} signals</span>
        </span>
      </button>

      {expanded && (
        <ul className="ml-6 mt-1 space-y-0.5">
          {contact.recentSignals.length === 0 && (
            <li className="px-2 py-1 text-[11px] text-zinc-500">No signals recorded.</li>
          )}
          {contact.recentSignals.map(s => (
            <li key={s.id} className="px-2 py-1 text-[11px] text-zinc-400">
              <span className="text-zinc-300">{s.verb ?? "signal"}</span>
              {s.description && <span className="text-zinc-500"> · {s.description}</span>}
              <span className="ml-2 text-zinc-600">
                {new Date(s.occurredAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </span>
              <span className="ml-2 tabular-nums text-zinc-500">+{s.scoreDelta}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-zinc-500">{label}</span>
      <span className="text-zinc-200">{value}</span>
    </span>
  )
}

function Chevron({ expanded, small }: { expanded: boolean; small?: boolean }) {
  const size = small ? 9 : 11
  return (
    <svg
      width={size}
      height={size}
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
