"use client"

import { useState } from "react"

interface TeamMember {
  id:   string
  name: string
}

interface SavedWebhook {
  id:               string
  actorId:          string
  campaignName:     string
  includeInReports: boolean
  createdAt:        string
}

export function DripifyUrlBuilder({
  base,
  workspaceId,
  teamMembers,
  savedWebhooks: initialSaved,
}: {
  base:          string
  workspaceId:   string
  teamMembers:   TeamMember[]
  savedWebhooks: SavedWebhook[]
}) {
  const [actorId,  setActorId]  = useState(teamMembers[0]?.id ?? "")
  const [campaign, setCampaign] = useState("")
  const [copied,   setCopied]   = useState(false)
  const [saved,    setSaved]    = useState<SavedWebhook[]>(initialSaved)
  const [saving,   setSaving]   = useState(false)

  const url = buildUrl(base, workspaceId, actorId, campaign)

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      const input = document.getElementById("dripify-url") as HTMLInputElement | null
      input?.select()
    }
  }

  async function patch(next: SavedWebhook[]) {
    await fetch(`/api/workspace/${workspaceId}/config`, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ dripifyWebhooks: next }),
    })
  }

  async function saveWebhook() {
    if (!campaign.trim()) return
    setSaving(true)
    const entry: SavedWebhook = {
      id:               crypto.randomUUID(),
      actorId,
      campaignName:     campaign.trim(),
      includeInReports: false,
      createdAt:        new Date().toISOString(),
    }
    const next = [...saved, entry]
    await patch(next)
    setSaved(next)
    setCampaign("")
    setSaving(false)
  }

  async function deleteWebhook(id: string) {
    const next = saved.filter(w => w.id !== id)
    await patch(next)
    setSaved(next)
  }

  async function toggleReports(id: string) {
    const next = saved.map(w =>
      w.id === id ? { ...w, includeInReports: !w.includeInReports } : w,
    )
    await patch(next)
    setSaved(next)
  }

  async function copyEntry(entry: SavedWebhook) {
    const entryUrl = buildUrl(base, workspaceId, entry.actorId, entry.campaignName)
    await navigator.clipboard.writeText(entryUrl).catch(() => {})
  }

  if (teamMembers.length === 0) {
    return (
      <p className="text-[13px] text-zinc-400">
        No team members configured. Add members under Settings → Team before generating a Dripify URL.
      </p>
    )
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-[15px] font-bold text-white">Dripify</h2>
        <span className="text-[10px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">
          POST · application/json
        </span>
      </header>

      <p className="mb-4 text-[13px] leading-[20px] text-zinc-300">
        LinkedIn outbound signals from Dripify campaigns (follows, connection requests, messages).
        Generate one URL per team member per campaign and paste it into Dripify&apos;s webhook settings.
      </p>

      {/* ── URL generator ── */}
      <div className="mb-3 flex gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-400">
            Actor
          </label>
          <select
            value={actorId}
            onChange={e => setActorId(e.target.value)}
            className="rounded-xl border border-white/12 bg-black/30 px-3 py-2 text-[13px] text-zinc-100 focus:border-[#2BA98B]/40 focus:outline-none"
          >
            {teamMembers.map(m => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-1 flex-col gap-1">
          <label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-400">
            Campaign name
          </label>
          <input
            type="text"
            value={campaign}
            onChange={e => setCampaign(e.target.value)}
            placeholder="e.g. Q2 Founders Follow"
            className="rounded-xl border border-white/12 bg-black/30 px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-600 focus:border-[#2BA98B]/40 focus:outline-none"
          />
        </div>
      </div>

      <div className="flex gap-2">
        <input
          id="dripify-url"
          type="text"
          readOnly
          value={url}
          onFocus={e => e.currentTarget.select()}
          className="flex-1 rounded-xl border border-white/12 bg-black/30 px-3 py-2 font-mono text-[12px] text-zinc-100 focus:border-[#2BA98B]/40 focus:outline-none"
        />
        <button
          type="button"
          onClick={copy}
          className="rounded-xl border border-white/14 bg-white/[0.04] px-4 py-2 text-[12px] font-medium text-zinc-200 transition-colors hover:border-[#2BA98B]/40 hover:bg-[#2BA98B]/[0.10] hover:text-white motion-reduce:transition-none"
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          onClick={saveWebhook}
          disabled={!campaign.trim() || saving}
          className="rounded-xl border border-white/14 bg-white/[0.04] px-4 py-2 text-[12px] font-medium text-zinc-200 transition-colors hover:border-[#2BA98B]/40 hover:bg-[#2BA98B]/[0.10] hover:text-white disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {/* ── Saved webhooks list ── */}
      {saved.length > 0 && (
        <div className="mt-5">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-400">
            Saved webhooks
          </p>
          <div className="space-y-2">
            {saved.map(entry => (
              <SavedRow
                key={entry.id}
                entry={entry}
                base={base}
                workspaceId={workspaceId}
                teamMembers={teamMembers}
                onCopy={() => copyEntry(entry)}
                onToggleReports={() => toggleReports(entry.id)}
                onDelete={() => deleteWebhook(entry.id)}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

function SavedRow({
  entry,
  base,
  workspaceId,
  teamMembers,
  onCopy,
  onToggleReports,
  onDelete,
}: {
  entry:          SavedWebhook
  base:           string
  workspaceId:    string
  teamMembers:    TeamMember[]
  onCopy:         () => void
  onToggleReports: () => void
  onDelete:       () => void
}) {
  const [copied, setCopied] = useState(false)
  const actorName = teamMembers.find(m => m.id === entry.actorId)?.name ?? entry.actorId

  function handleCopy() {
    onCopy()
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/8 bg-black/20 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-zinc-100">{entry.campaignName}</p>
        <p className="text-[11px] text-zinc-500">{actorName}</p>
      </div>

      {/* Include in reports toggle */}
      <label className="flex cursor-pointer items-center gap-1.5" title="Include in reports">
        <span className="text-[11px] text-zinc-500">Reports</span>
        <button
          type="button"
          onClick={onToggleReports}
          role="switch"
          aria-checked={entry.includeInReports}
          className={`relative h-5 w-9 rounded-full border transition-colors motion-reduce:transition-none ${
            entry.includeInReports
              ? "border-[#2BA98B]/60 bg-[#2BA98B]/30"
              : "border-white/12 bg-white/[0.04]"
          }`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full transition-all motion-reduce:transition-none ${
              entry.includeInReports
                ? "left-[18px] bg-[#2BA98B]"
                : "left-0.5 bg-zinc-500"
            }`}
          />
        </button>
      </label>

      <button
        type="button"
        onClick={handleCopy}
        className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] font-medium text-zinc-400 transition-colors hover:border-[#2BA98B]/30 hover:text-zinc-200 motion-reduce:transition-none"
      >
        {copied ? "Copied" : "Copy URL"}
      </button>

      <button
        type="button"
        onClick={onDelete}
        className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] font-medium text-zinc-500 transition-colors hover:border-red-500/30 hover:text-red-400 motion-reduce:transition-none"
        aria-label={`Delete ${entry.campaignName}`}
      >
        Delete
      </button>
    </div>
  )
}

function buildUrl(base: string, workspaceId: string, actorId: string, campaign: string): string {
  const params = new URLSearchParams()
  if (actorId)  params.set("actorId",  actorId)
  if (campaign) params.set("campaign", campaign)
  const qs = params.toString()
  return `${base}/api/webhooks/${workspaceId}/dripify${qs ? `?${qs}` : ""}`
}
