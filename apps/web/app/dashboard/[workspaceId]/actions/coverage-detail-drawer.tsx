"use client"

/**
 * CoverageDetailDrawer - right-edge slide-in panel showing a single
 * coverage row plus the linked announcement (if any). Fetched lazily on
 * open so the parent panel doesn't carry the full payload upfront.
 *
 * Action menu: spawn a new email / LinkedIn DM / newsletter campaign
 * seeded from the article, or attach the article to an existing
 * campaign. Either lands a campaign_coverage row so /reports/pr (PR 5)
 * can attribute downstream sends back to PR coverage.
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import type { CoverageRow, AnnouncementRow } from "@/lib/db/coverage"

interface DetailResponse {
  coverage:     CoverageRow
  announcement: AnnouncementRow | null
}

export function CoverageDetailDrawer({
  workspaceId,
  coverageId,
  onClose,
}: {
  workspaceId: string
  coverageId:  string | null
  onClose:     () => void
}) {
  const [data,    setData]    = useState<DetailResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    if (!coverageId) {
      setData(null)
      setError(null)
      return
    }
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      setData(null)
      try {
        const res = await fetch(`/api/dashboard/${workspaceId}/coverage/${encodeURIComponent(coverageId!)}`)
        const body = await res.json().catch(() => ({}))
        if (!res.ok) {
          if (!cancelled) setError(body.error ?? `HTTP ${res.status}`)
          return
        }
        if (!cancelled) setData(body as DetailResponse)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [coverageId, workspaceId])

  // Close on Escape
  useEffect(() => {
    if (!coverageId) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [coverageId, onClose])

  if (!coverageId) return null

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Coverage detail">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />

      {/* Drawer */}
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-[640px] flex-col bg-[#0B0B0E] shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/[0.08] px-6 py-4">
          <p className="text-[12px] font-bold uppercase tracking-[0.10em] text-zinc-500">PR coverage</p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-white motion-reduce:transition-none"
            aria-label="Close detail"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading && <p className="text-[13px] text-zinc-400">Loading...</p>}
          {error && <p className="text-[13px] text-red-400">Failed to load: {error}</p>}

          {data && (
            <>
              <CoverageBody coverage={data.coverage} />
              {data.announcement && <AnnouncementBody announcement={data.announcement} />}
              <UseCoveragePanel
                workspaceId={workspaceId}
                coverage={data.coverage}
              />
            </>
          )}
        </div>
      </aside>
    </div>
  )
}

function CoverageBody({ coverage: c }: { coverage: CoverageRow }) {
  return (
    <section className="space-y-4">
      {c.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={c.image} alt="" className="h-40 w-full rounded-xl object-cover" />
      )}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center justify-center rounded-md px-2 py-0.5 text-[11px] font-semibold ${
            c.isOrganic
              ? "bg-emerald-500/[0.12] text-emerald-200"
              : "bg-amber-500/[0.12] text-amber-200"
          }`}>
            {c.isOrganic ? "Earned" : "Placed"}
          </span>
          <span className="inline-flex items-center justify-center rounded-md border border-white/10 px-2 py-0.5 text-[11px] font-medium text-zinc-300 capitalize">
            {c.tier}
          </span>
          {c.domainAuthority != null && (
            <span className="inline-flex items-center justify-center rounded-md bg-white/[0.06] px-2 py-0.5 text-[11px] font-bold tabular-nums text-zinc-200">
              DA {c.domainAuthority}
            </span>
          )}
        </div>

        <h3 className="text-[20px] font-bold leading-tight text-white">{c.title}</h3>
        <p className="text-[13px] text-zinc-400">
          <span className="text-zinc-200">{c.publicationName}</span>
          <span className="mx-1.5 text-zinc-600">·</span>
          {c.journalistName}
          <span className="mx-1.5 text-zinc-600">·</span>
          {new Date(c.publishedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
        </p>
      </div>

      {c.link && (
        <a
          href={c.link}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-xl border border-white/12 bg-white/[0.04] px-3 py-2 text-[13px] font-semibold text-white transition-colors hover:border-white/24 motion-reduce:transition-none"
        >
          Open article
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </a>
      )}

      {c.summary && (
        <p className="text-[14px] leading-[22px] text-zinc-200 whitespace-pre-wrap">{c.summary}</p>
      )}

      {c.topics.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.10em] text-zinc-500">Topics</p>
          <div className="flex flex-wrap gap-1.5">
            {c.topics.map(t => (
              <span key={t} className="rounded-md bg-white/[0.04] px-2 py-0.5 text-[12px] text-zinc-300">{t}</span>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

function AnnouncementBody({ announcement: a }: { announcement: AnnouncementRow }) {
  return (
    <section className="mt-6 rounded-xl border border-white/10 bg-white/[0.02] p-5">
      <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Linked announcement</p>
      <h4 className="text-[15px] font-bold text-white">{a.title}</h4>
      <p className="mt-1 text-[12px] text-zinc-400 capitalize">
        {a.announcementType.replace(/-announcement$/, "").replace(/-/g, " ")}
        <span className="mx-1.5 text-zinc-600">·</span>
        {new Date(a.startTime).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
      </p>

      {a.stats && (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Coverage ratio"   value={pct(a.stats.coverageRatio)} />
          <Stat label="Messages sent"    value={a.stats.messagesSent.toString()} />
          <Stat label="Messages back"    value={a.stats.messagesReceived.toString()} />
          <Stat label="Open ratio"       value={pct(a.stats.openRatio)} />
        </div>
      )}
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/[0.03] px-3 py-2">
      <p className="text-[10px] font-bold uppercase tracking-[0.10em] text-zinc-500">{label}</p>
      <p className="mt-0.5 text-[15px] font-bold tabular-nums text-white">{value}</p>
    </div>
  )
}

interface CampaignSummary {
  id:       string
  name:     string
  channel:  string
}

type NewChannel = "email" | "linkedin_dm" | "newsletter"

const NEW_CHANNEL_LABELS: Record<NewChannel, string> = {
  email:       "Email",
  linkedin_dm: "LinkedIn DM",
  newsletter:  "Newsletter",
}

function UseCoveragePanel({
  workspaceId,
  coverage,
}: {
  workspaceId: string
  coverage:    CoverageRow
}) {
  const router = useRouter()

  // ── New campaign ─────────────────────────────────────────────────────────
  const [newChannel, setNewChannel] = useState<NewChannel | null>(null)
  const [newName,    setNewName]    = useState("")
  const [newBusy,    setNewBusy]    = useState(false)
  const [newError,   setNewError]   = useState<string | null>(null)
  const [newSuccess, setNewSuccess] = useState<{ id: string; name: string } | null>(null)

  function pickChannel(ch: NewChannel) {
    setNewChannel(ch)
    setNewName(`${coverage.title}`.slice(0, 200))
    setNewError(null)
    setNewSuccess(null)
  }

  async function createCampaign() {
    if (!newChannel) return
    setNewBusy(true)
    setNewError(null)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/campaigns/from-coverage`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          coverageId: coverage.mvprId,
          channel:    newChannel,
          name:       newName.trim() || undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setNewError(data.error ?? `HTTP ${res.status}`)
        return
      }
      setNewSuccess({ id: data.campaignId, name: newName.trim() || `Coverage: ${coverage.title}` })
      setNewChannel(null)
      router.refresh()
    } catch (e) {
      setNewError(e instanceof Error ? e.message : String(e))
    } finally {
      setNewBusy(false)
    }
  }

  // ── Attach to existing ───────────────────────────────────────────────────
  const [campaigns,      setCampaigns]      = useState<CampaignSummary[] | null>(null)
  const [campaignsBusy,  setCampaignsBusy]  = useState(false)
  const [pickedCampaign, setPickedCampaign] = useState<string>("")
  const [attachBusy,     setAttachBusy]     = useState(false)
  const [attachError,    setAttachError]    = useState<string | null>(null)
  const [attachSuccess,  setAttachSuccess]  = useState<{ id: string; name: string } | null>(null)

  async function loadCampaigns() {
    if (campaigns) return
    setCampaignsBusy(true)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/campaigns`)
      const data = await res.json().catch(() => ({}))
      if (res.ok && Array.isArray(data.campaigns)) {
        setCampaigns(data.campaigns.map((c: CampaignSummary) => ({ id: c.id, name: c.name, channel: c.channel })))
      } else {
        setCampaigns([])
      }
    } catch {
      setCampaigns([])
    } finally {
      setCampaignsBusy(false)
    }
  }

  async function attachToExisting() {
    if (!pickedCampaign) return
    setAttachBusy(true)
    setAttachError(null)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/campaigns/${pickedCampaign}/coverage`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ coverageId: coverage.mvprId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setAttachError(data.error ?? `HTTP ${res.status}`)
        return
      }
      const c = campaigns?.find(x => x.id === pickedCampaign)
      setAttachSuccess({ id: pickedCampaign, name: c?.name ?? pickedCampaign })
      router.refresh()
    } catch (e) {
      setAttachError(e instanceof Error ? e.message : String(e))
    } finally {
      setAttachBusy(false)
    }
  }

  return (
    <section className="mt-6 space-y-4 rounded-xl border border-white/10 bg-white/[0.02] p-5">
      <div>
        <p className="text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Use this coverage</p>
        <p className="mt-1 text-[12px] text-zinc-400">
          Spin up a campaign pre-seeded with this article, or attach it to a campaign that&apos;s already running.
        </p>
      </div>

      {/* New campaign */}
      <div className="space-y-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.10em] text-zinc-500">Start a new campaign</p>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(NEW_CHANNEL_LABELS) as NewChannel[]).map(ch => {
            const active = newChannel === ch
            return (
              <button
                key={ch}
                type="button"
                onClick={() => pickChannel(ch)}
                aria-pressed={active}
                className={`rounded-xl border px-3 py-1.5 text-[12px] font-semibold transition-colors motion-reduce:transition-none ${
                  active
                    ? "border-white/30 bg-white/[0.08] text-white"
                    : "border-white/12 bg-white/[0.04] text-zinc-200 hover:border-white/24"
                }`}
              >
                {NEW_CHANNEL_LABELS[ch]}
              </button>
            )
          })}
        </div>

        {newChannel && (
          <div className="space-y-2 rounded-lg border border-white/10 bg-white/[0.02] p-3">
            <label className="block text-[11px] font-medium text-zinc-400">Campaign name</label>
            <input
              type="text"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[13px] text-zinc-100 placeholder:text-zinc-500 focus:border-white/24 focus:outline-none"
            />
            <p className="text-[11px] text-zinc-500">
              The new campaign&apos;s default template will be pre-seeded with this article&apos;s
              {newChannel === "linkedin_dm" ? " title, summary, and link." : " title (as subject) and summary + link (as body)."}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={createCampaign}
                disabled={newBusy || !newName.trim()}
                className="rounded-xl bg-[#2BA98B] px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-[#249A7E] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
              >
                {newBusy ? "Creating..." : `Create ${NEW_CHANNEL_LABELS[newChannel]} campaign`}
              </button>
              <button
                type="button"
                onClick={() => { setNewChannel(null); setNewError(null) }}
                className="rounded-xl border border-white/10 px-3 py-1.5 text-[12px] text-zinc-300 hover:border-white/24"
              >
                Cancel
              </button>
            </div>
            {newError && <p className="text-[12px] text-red-400">{newError}</p>}
          </div>
        )}

        {newSuccess && (
          <p className="text-[12px] text-emerald-300">
            Created <a
              className="underline decoration-emerald-300/50 underline-offset-4 hover:decoration-emerald-300"
              href={`/dashboard/${workspaceId}/settings/campaigns/${newSuccess.id}`}
            >{newSuccess.name}</a>. Open it to edit the seeded template or add a campaign fingerprint.
          </p>
        )}
      </div>

      <hr className="border-white/[0.06]" />

      {/* Attach to existing */}
      <div className="space-y-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.10em] text-zinc-500">Or attach to a running campaign</p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={pickedCampaign}
            onChange={e => setPickedCampaign(e.target.value)}
            onFocus={loadCampaigns}
            disabled={campaignsBusy}
            className="min-w-[220px] rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-zinc-200 focus:border-white/24 focus:outline-none disabled:opacity-50"
          >
            <option value="">{campaignsBusy ? "Loading..." : campaigns ? "Pick a campaign..." : "Click to load campaigns"}</option>
            {campaigns?.map(c => (
              <option key={c.id} value={c.id}>{c.name} ({c.channel.replace(/_/g, " ")})</option>
            ))}
          </select>
          <button
            type="button"
            onClick={attachToExisting}
            disabled={!pickedCampaign || attachBusy}
            className="rounded-xl bg-white/[0.08] px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-white/[0.12] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
          >
            {attachBusy ? "Attaching..." : "Attach"}
          </button>
        </div>
        {attachError && <p className="text-[12px] text-red-400">{attachError}</p>}
        {attachSuccess && (
          <p className="text-[12px] text-emerald-300">
            Attached to <a
              className="underline decoration-emerald-300/50 underline-offset-4 hover:decoration-emerald-300"
              href={`/dashboard/${workspaceId}/settings/campaigns/${attachSuccess.id}`}
            >{attachSuccess.name}</a>.
          </p>
        )}
      </div>
    </section>
  )
}

function pct(n: number): string {
  if (!Number.isFinite(n)) return "-"
  // MVPR ratios appear to be 0..1; render as percentage.
  return `${Math.round(n * 100)}%`
}
