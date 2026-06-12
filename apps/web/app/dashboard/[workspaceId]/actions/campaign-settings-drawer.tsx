"use client"

/**
 * CampaignSettingsDrawer - drawer body containing the per-campaign
 * configuration surface: template list editor, writing-style
 * fingerprint editor, coverage attachments list, archive.
 *
 * Mounted inside RightDrawer. Lazy-loads its own data when opened
 * (templates, fingerprint, attached coverage) so the parent channel
 * card doesn't carry the payload upfront for every campaign row.
 *
 * Replaces the standalone /settings/campaigns/[id] page; that route
 * remains a deep-link fallback until PR D removes it.
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import type { CampaignTemplateRow } from "@/lib/db/campaign-templates"

interface CampaignSummary {
  id:        string
  name:      string
  channel:   string
}

interface FingerprintSnapshot {
  id:        number
  version:   number
  createdAt: string
  samplePos: number
}

interface AttachedCoverage {
  mvprId:          string
  title:           string
  publicationName: string
}

interface InitialData {
  templates:      CampaignTemplateRow[]
  fingerprint:    FingerprintSnapshot | null
  coverage:       AttachedCoverage[]
  channelLabel:   string  // e.g. "LinkedIn DM" - drives field set + fingerprint availability
  supportsFingerprint: boolean
}

export function CampaignSettingsDrawer({
  workspaceId,
  campaign,
  initial,
  onArchive,
}: {
  workspaceId: string
  campaign:    CampaignSummary
  initial:     InitialData
  onArchive:   () => void
}) {
  const router = useRouter()

  // ── Templates ─────────────────────────────────────────────────────────────
  const usesSubjectAndHtml = initial.channelLabel === "Email" || initial.channelLabel === "Newsletter" || initial.channelLabel === "Direct Email"
  const [templates, setTemplates] = useState<CampaignTemplateRow[]>(initial.templates)
  const [newTemplateName, setNewTemplateName] = useState("")
  const [busyTemplate, setBusyTemplate] = useState(false)
  const [tplError, setTplError] = useState<string | null>(null)

  async function addTemplate() {
    if (!newTemplateName.trim()) { setTplError("Name is required."); return }
    setTplError(null)
    setBusyTemplate(true)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/campaigns/${campaign.id}/templates`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ name: newTemplateName.trim(), body: "", isDefault: templates.length === 0 }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setTplError(data.error ?? `HTTP ${res.status}`); return }
      setTemplates(prev => [
        ...prev,
        {
          id:          data.id,
          workspaceId,
          campaignId:  campaign.id,
          name:        newTemplateName.trim(),
          subject:     null,
          html:        null,
          body:        "",
          isDefault:   prev.length === 0,
          createdAt:   new Date().toISOString(),
          updatedAt:   new Date().toISOString(),
        },
      ])
      setNewTemplateName("")
      router.refresh()
    } catch (e) {
      setTplError(e instanceof Error ? e.message : String(e))
    } finally { setBusyTemplate(false) }
  }

  async function patchTemplate(id: string, patch: Partial<Pick<CampaignTemplateRow, "name" | "subject" | "html" | "body" | "isDefault">>) {
    setTemplates(prev => prev.map(t => {
      if (t.id === id) return { ...t, ...patch }
      if (patch.isDefault === true) return { ...t, isDefault: false }
      return t
    }))
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/campaigns/${campaign.id}/templates/${id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(patch),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setTplError(data.error ?? `HTTP ${res.status}`)
      }
    } catch (e) {
      setTplError(e instanceof Error ? e.message : String(e))
    }
  }

  async function deleteTemplate(id: string) {
    if (!confirm("Delete this template?")) return
    setTemplates(prev => prev.filter(t => t.id !== id))
    try {
      await fetch(`/api/dashboard/${workspaceId}/campaigns/${campaign.id}/templates/${id}`, { method: "DELETE" })
      router.refresh()
    } catch (e) {
      setTplError(e instanceof Error ? e.message : String(e))
    }
  }

  // ── Fingerprint ───────────────────────────────────────────────────────────
  const [fpSnap, setFpSnap] = useState<FingerprintSnapshot | null>(initial.fingerprint)
  const [fpSamples, setFpSamples] = useState("")
  const [fpBusy, setFpBusy] = useState(false)
  const [fpError, setFpError] = useState<string | null>(null)

  async function generateFingerprint() {
    const trimmed = fpSamples.trim()
    if (!trimmed) { setFpError("Paste at least one sample."); return }
    setFpError(null)
    setFpBusy(true)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/campaigns/${campaign.id}/fingerprint`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ samples: trimmed.split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean) }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setFpError(data.error ?? `HTTP ${res.status}`); return }
      setFpSnap({
        id:        data.id,
        version:   data.version,
        createdAt: new Date().toISOString(),
        samplePos: trimmed.split(/\n\s*\n+/).filter(Boolean).length,
      })
      setFpSamples("")
      router.refresh()
    } catch (e) {
      setFpError(e instanceof Error ? e.message : String(e))
    } finally { setFpBusy(false) }
  }

  async function clearFingerprint() {
    if (!confirm("Clear this campaign's fingerprint? Drafts fall back to channel-persona / channel / corporate.")) return
    try {
      await fetch(`/api/dashboard/${workspaceId}/campaigns/${campaign.id}/fingerprint`, { method: "DELETE" })
      setFpSnap(null)
      router.refresh()
    } catch (e) {
      setFpError(e instanceof Error ? e.message : String(e))
    }
  }

  // ── Coverage attachments ──────────────────────────────────────────────────
  const [coverage] = useState<AttachedCoverage[]>(initial.coverage)

  // ── Archive ───────────────────────────────────────────────────────────────
  const [archiveBusy, setArchiveBusy] = useState(false)
  async function archive() {
    if (!confirm(`Archive "${campaign.name}"? Existing sends + stats remain attributable but the campaign won't accept new enrolments.`)) return
    setArchiveBusy(true)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/campaigns/${campaign.id}`, { method: "DELETE" })
      if (res.ok) onArchive()
    } finally { setArchiveBusy(false) }
  }

  return (
    <div className="space-y-7">
      <header>
        <h2 className="text-[20px] font-bold text-white">{campaign.name}</h2>
        <p className="mt-1 text-[13px] text-zinc-400 capitalize">{initial.channelLabel}</p>
      </header>

      {/* Templates */}
      <section className="space-y-3">
        <div>
          <h3 className="text-[13px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Templates</h3>
          <p className="mt-1 text-[12px] text-zinc-400">
            Editable copy for this campaign. The default is pre-seeded into drafts; non-defaults are alternates.
          </p>
        </div>

        <div className="flex gap-2 items-center">
          <input
            type="text"
            value={newTemplateName}
            onChange={e => setNewTemplateName(e.target.value)}
            placeholder="Template name"
            className="flex-1 rounded-lg border border-white/12 bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-zinc-100 placeholder:text-zinc-500 focus:border-white/24 focus:outline-none"
          />
          <button
            type="button"
            onClick={addTemplate}
            disabled={busyTemplate}
            className="rounded-lg bg-[#2BA98B] px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-[#249A7E] disabled:opacity-50 motion-reduce:transition-none"
          >{busyTemplate ? "Adding..." : "Add"}</button>
        </div>
        {tplError && <p className="text-[12px] text-red-400">{tplError}</p>}

        {templates.length === 0 ? (
          <p className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-[12px] text-zinc-400">No templates yet.</p>
        ) : (
          <ul className="space-y-3">
            {templates.map(t => (
              <li key={t.id} className="rounded-lg border border-white/10 bg-white/[0.02] p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    defaultValue={t.name}
                    onBlur={e => { const v = e.target.value.trim(); if (v && v !== t.name) patchTemplate(t.id, { name: v }) }}
                    className="flex-1 rounded border border-white/10 bg-white/[0.04] px-2 py-1 text-[12px] font-semibold text-white focus:border-white/24 focus:outline-none"
                  />
                  <label className="inline-flex items-center gap-1.5 text-[11px] text-zinc-300">
                    <input
                      type="checkbox"
                      checked={t.isDefault}
                      onChange={e => { if (e.target.checked) patchTemplate(t.id, { isDefault: true }) }}
                    />
                    Default
                  </label>
                  <button
                    type="button"
                    onClick={() => deleteTemplate(t.id)}
                    className="rounded border border-white/10 px-2 py-1 text-[11px] text-zinc-400 hover:border-red-500/30 hover:text-red-200"
                  >Delete</button>
                </div>
                {usesSubjectAndHtml && (
                  <input
                    type="text"
                    defaultValue={t.subject ?? ""}
                    onBlur={e => { const v = e.target.value; if (v !== (t.subject ?? "")) patchTemplate(t.id, { subject: v || null }) }}
                    placeholder="Subject"
                    className="w-full rounded border border-white/10 bg-white/[0.04] px-2 py-1 text-[12px] text-zinc-100 placeholder:text-zinc-500 focus:border-white/24 focus:outline-none"
                  />
                )}
                {usesSubjectAndHtml && (
                  <textarea
                    defaultValue={t.html ?? ""}
                    onBlur={e => { const v = e.target.value; if (v !== (t.html ?? "")) patchTemplate(t.id, { html: v || null }) }}
                    placeholder="HTML body"
                    rows={6}
                    className="w-full rounded border border-white/10 bg-white/[0.04] px-2 py-1 text-[12px] font-mono text-zinc-100 placeholder:text-zinc-500 focus:border-white/24 focus:outline-none"
                  />
                )}
                <textarea
                  defaultValue={t.body}
                  onBlur={e => { const v = e.target.value; if (v !== t.body) patchTemplate(t.id, { body: v }) }}
                  placeholder={usesSubjectAndHtml ? "Plain-text body (fallback)" : "Body"}
                  rows={5}
                  className="w-full rounded border border-white/10 bg-white/[0.04] px-2 py-1 text-[12px] text-zinc-100 placeholder:text-zinc-500 focus:border-white/24 focus:outline-none"
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Fingerprint */}
      {initial.supportsFingerprint && (
        <section className="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <div>
            <h3 className="text-[13px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Writing-style fingerprint</h3>
            <p className="mt-1 text-[12px] text-zinc-400">
              Overrides persona + channel + corporate at draft time.
            </p>
          </div>
          {fpSnap ? (
            <dl className="grid grid-cols-3 gap-x-3 gap-y-1 text-[11px]">
              <dt className="text-zinc-500">Version</dt>
              <dd className="col-span-2 font-mono tabular-nums text-white">v{fpSnap.version}</dd>
              <dt className="text-zinc-500">Generated</dt>
              <dd className="col-span-2 text-white">{new Date(fpSnap.createdAt).toLocaleDateString()}</dd>
              <dt className="text-zinc-500">Samples</dt>
              <dd className="col-span-2 font-mono tabular-nums text-white">{fpSnap.samplePos}</dd>
            </dl>
          ) : (
            <p className="text-[12px] text-zinc-400">No campaign fingerprint yet.</p>
          )}
          <textarea
            value={fpSamples}
            onChange={e => setFpSamples(e.target.value)}
            placeholder="Paste 3+ samples (300+ words total). Blank line between samples."
            rows={7}
            className="w-full rounded border border-white/10 bg-white/[0.04] px-2 py-1 text-[12px] text-zinc-100 placeholder:text-zinc-500 focus:border-white/24 focus:outline-none"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={generateFingerprint}
              disabled={fpBusy}
              className="rounded-lg bg-[#2BA98B] px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-[#249A7E] disabled:opacity-50"
            >{fpBusy ? "Generating..." : fpSnap ? "Replace" : "Generate"}</button>
            {fpSnap && (
              <button
                type="button"
                onClick={clearFingerprint}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-[12px] font-semibold text-zinc-300 hover:border-red-500/30 hover:text-red-200"
              >Clear</button>
            )}
          </div>
          {fpError && <p className="text-[12px] text-red-400">{fpError}</p>}
        </section>
      )}

      {/* Coverage attachments */}
      <section className="space-y-3">
        <h3 className="text-[13px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Attached PR coverage</h3>
        {coverage.length === 0 ? (
          <p className="text-[12px] text-zinc-400">No coverage attached yet. Use the &quot;Use this coverage&quot; flow on the PR coverage card to attach an article to this campaign.</p>
        ) : (
          <ul className="divide-y divide-white/[0.04] rounded-lg border border-white/10 bg-white/[0.02]">
            {coverage.map(c => (
              <li key={c.mvprId} className="px-3 py-2 text-[12px]">
                <p className="text-zinc-100">{c.title}</p>
                <p className="text-zinc-500">{c.publicationName}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Archive */}
      <section className="rounded-xl border border-dashed border-red-500/30 p-4">
        <h3 className="text-[12px] font-bold uppercase tracking-[0.10em] text-red-200">Danger zone</h3>
        <p className="mt-1 text-[12px] text-zinc-400">
          Archiving hides the campaign from active lists. Existing sends remain attributable.
        </p>
        <button
          type="button"
          onClick={archive}
          disabled={archiveBusy}
          className="mt-3 rounded-lg border border-red-500/30 px-3 py-1.5 text-[12px] font-semibold text-red-200 hover:bg-red-500/[0.06] disabled:opacity-50"
        >{archiveBusy ? "Archiving..." : "Archive campaign"}</button>
      </section>
    </div>
  )
}
