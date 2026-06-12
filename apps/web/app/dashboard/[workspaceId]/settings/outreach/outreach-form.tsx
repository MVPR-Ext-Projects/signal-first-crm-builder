"use client"

/**
 * OutreachForm — fallback DM context (with AI generate), outreach principles
 * pacing rules, and the per-(persona × stage × prospect type) template list
 * the LLM draws from when drafting.
 *
 * Saves via PATCH /api/workspace/[id]/config (deep-merged into messaging).
 * Generate-from-persona hits POST /api/dashboard/[id]/outreach/generate-context
 * which returns a draft text the user can edit before saving.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"

interface Template {
  id:             string
  title:          string
  body:           string
  personas?:      string[]
  stages?:        string[]
  prospectTypes?: string[]
}

function newId(): string {
  return Math.random().toString(36).slice(2, 11) + Date.now().toString(36).slice(-4)
}

export function OutreachForm({
  workspaceId,
  initialContext,
  initialPrinciples,
  initialTemplates,
  initialEmailFreshnessDays,
  availablePersonas,
  availableProspectTypes,
  availableStages,
}: {
  workspaceId:               string
  initialContext:            string
  initialPrinciples:         string
  initialTemplates:          Template[]
  initialEmailFreshnessDays: number
  availablePersonas:         string[]
  availableProspectTypes:    string[]
  availableStages:           string[]
}) {
  const router = useRouter()
  const [context,    setContext]    = useState(initialContext)
  const [principles, setPrinciples] = useState(initialPrinciples)
  const [templates,  setTemplates]  = useState<Template[]>(initialTemplates)
  // Email-freshness threshold in days (Task #22). Drives the daily
  // /api/cron/email-freshness pass that flips stale confirmed corporate
  // emails into status='stale' + needs_enrichment=TRUE.
  const [emailFreshnessDays, setEmailFreshnessDays] = useState<number>(initialEmailFreshnessDays)
  const [saving,     setSaving]     = useState(false)
  const [saved,      setSaved]      = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  // Generate-context state — separate persona picker so the user can preview
  // a draft against any persona without committing it as the saved value.
  const [genPersona,   setGenPersona]   = useState<string>(availablePersonas[0] ?? "")
  const [generating,   setGenerating]   = useState(false)
  const [generateErr,  setGenerateErr]  = useState<string | null>(null)

  function addTemplate() {
    setTemplates([...templates, { id: newId(), title: "", body: "" }])
    setSaved(false)
  }
  function removeTemplate(id: string) {
    setTemplates(templates.filter(t => t.id !== id))
    setSaved(false)
  }
  function updateTemplate(id: string, patch: Partial<Template>) {
    setTemplates(templates.map(t => t.id === id ? { ...t, ...patch } : t))
    setSaved(false)
  }
  function toggleTag(id: string, key: "personas" | "stages" | "prospectTypes", value: string) {
    const t = templates.find(x => x.id === id)
    if (!t) return
    const cur = t[key] ?? []
    const next = cur.includes(value) ? cur.filter(v => v !== value) : [...cur, value]
    updateTemplate(id, { [key]: next })
  }

  async function generateContext() {
    if (!genPersona) {
      setGenerateErr("Pick a persona first.")
      return
    }
    setGenerating(true)
    setGenerateErr(null)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/outreach/generate-context`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ personaName: genPersona }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setGenerateErr(body.error ?? `HTTP ${res.status}`)
        return
      }
      const draft = (body.context ?? "").trim()
      if (!draft) {
        setGenerateErr("Empty draft returned.")
        return
      }
      setContext(draft)
      setSaved(false)
    } catch (e) {
      setGenerateErr((e as Error).message)
    } finally {
      setGenerating(false)
    }
  }

  async function save() {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const cleanTemplates = templates
        .filter(t => t.title.trim() || t.body.trim())
        .map(t => ({
          id:    t.id,
          title: t.title.trim(),
          body:  t.body.trim(),
          ...(t.personas?.length      ? { personas:      t.personas }      : {}),
          ...(t.stages?.length        ? { stages:        t.stages }        : {}),
          ...(t.prospectTypes?.length ? { prospectTypes: t.prospectTypes } : {}),
        }))
      const res = await fetch(`/api/workspace/${workspaceId}/config`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          messaging: {
            outreachContext:    context,
            outreachPrinciples: principles,
            templates:          cleanTemplates,
            emailFreshnessDays: Number.isFinite(emailFreshnessDays) && emailFreshnessDays > 0
              ? Math.round(emailFreshnessDays)
              : 365,
          },
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        setError(body.error ?? `HTTP ${res.status}`)
        return
      }
      setSaved(true)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-10">
      {/* Fallback DM context with Generate-from-persona */}
      <section className="space-y-3">
        <h2 className="text-[14px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Fallback DM context</h2>
        <p className="text-[13px] text-zinc-400">
          Used when no persona on the Personas tab matches the lead. Plain text, ~300 words max. Generate a starting draft from any of your configured personas, edit, and save.
        </p>
        {availablePersonas.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-[11px] font-bold uppercase tracking-[0.06em] text-zinc-500">Generate from persona</label>
            <select
              value={genPersona}
              onChange={e => setGenPersona(e.target.value)}
              disabled={generating}
              className="cursor-pointer rounded-lg border border-white/12 bg-white/[0.04] px-3 py-1.5 text-[12px] font-medium text-zinc-100 outline-none focus:border-[#2BA98B]/40"
            >
              {availablePersonas.map(name => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={generateContext}
              disabled={generating}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/14 bg-white/[0.04] px-3 py-1.5 text-[12px] font-medium text-zinc-200 transition-colors hover:border-[#2BA98B]/40 hover:bg-[#2BA98B]/[0.10] hover:text-white disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7-3.3" />
                <polyline points="21 4 21 12 13 12" />
              </svg>
              {generating ? "Generating…" : context.trim() ? "Regenerate" : "Generate"}
            </button>
            {generateErr && <span className="text-[11px] text-rose-300">{generateErr}</span>}
          </div>
        )}
        <textarea
          value={context}
          onChange={e => { setContext(e.target.value); setSaved(false) }}
          placeholder="What you sell, who you sell to, and the tone you want. Or click Generate above."
          rows={6}
          className="w-full rounded-xl border border-white/12 bg-white/[0.04] px-3 py-2 text-[13px] leading-[20px] text-zinc-100 placeholder:text-zinc-500 focus:border-[#2BA98B]/40 focus:outline-none"
        />
      </section>

      {/* Email freshness */}
      <section className="space-y-3">
        <h2 className="text-[14px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Email freshness</h2>
        <p className="text-[13px] text-zinc-400">
          How long a confirmed corporate email stays trusted before the daily
          cron flips it to stale and queues the contact for re-enrichment.
          Default 365 days.
        </p>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={1}
            max={3650}
            step={1}
            value={emailFreshnessDays}
            onChange={e => {
              const n = parseInt(e.target.value, 10)
              setEmailFreshnessDays(Number.isFinite(n) ? n : 0)
              setSaved(false)
            }}
            className="w-28 rounded-xl border border-white/12 bg-white/[0.04] px-3 py-2 text-[13px] text-zinc-100 tabular-nums focus:border-[#2BA98B]/40 focus:outline-none"
          />
          <span className="text-[13px] text-zinc-400">days</span>
        </div>
      </section>

      {/* Outreach principles */}
      <section className="space-y-3">
        <h2 className="text-[14px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Outreach principles</h2>
        <p className="text-[13px] text-zinc-400">
          Pacing rules fed into every draft prompt — when to push for a CTA vs stay informational.
        </p>
        <textarea
          value={principles}
          onChange={e => { setPrinciples(e.target.value); setSaved(false) }}
          placeholder="e.g. Stay informational for the first two messages — share content the lead has already engaged with, ask one open question. Only introduce a CTA (15-min call, link to a deck) once they've replied positively or engaged a third time."
          rows={5}
          className="w-full rounded-xl border border-white/12 bg-white/[0.04] px-3 py-2 text-[13px] leading-[20px] text-zinc-100 placeholder:text-zinc-500 focus:border-[#2BA98B]/40 focus:outline-none"
        />
      </section>

      {/* Templates */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[14px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Templates</h2>
          <button
            type="button"
            onClick={addTemplate}
            className="rounded-lg border border-white/14 bg-white/[0.04] px-3 py-1.5 text-[12px] font-medium text-zinc-200 transition-colors hover:border-[#2BA98B]/40 hover:bg-[#2BA98B]/[0.10] hover:text-white motion-reduce:transition-none"
          >
            + Add template
          </button>
        </div>
        <p className="text-[13px] text-zinc-400">
          Reusable message scaffolding the LLM draws from at draft time. Tag a template with persona / stage / prospect type to scope it; leave a tag list empty to mark the template general-purpose.
        </p>

        {templates.length === 0 ? (
          <p className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-6 text-center text-[13px] text-zinc-500">
            No templates yet. Add one to give the LLM proven message shapes to draw from.
          </p>
        ) : (
          <ul className="space-y-3">
            {templates.map(t => (
              <li key={t.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                <div className="flex items-center gap-3">
                  <input
                    type="text"
                    value={t.title}
                    onChange={e => updateTemplate(t.id, { title: e.target.value })}
                    placeholder="Title (e.g. First-touch crypto founder)"
                    className="flex-1 rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-[14px] font-medium text-zinc-100 placeholder:text-zinc-500 focus:border-[#2BA98B]/40 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => removeTemplate(t.id)}
                    className="rounded-lg px-2 py-1 text-[11px] text-zinc-500 transition-colors hover:text-rose-300 motion-reduce:transition-none"
                  >
                    Remove
                  </button>
                </div>

                <textarea
                  value={t.body}
                  onChange={e => updateTemplate(t.id, { body: e.target.value })}
                  placeholder="The message text or scaffolding. Use placeholders like {firstName} if helpful — the LLM will fill them in at draft time."
                  rows={5}
                  className="mt-3 w-full rounded-xl border border-white/12 bg-white/[0.04] px-3 py-2 text-[13px] leading-[20px] text-zinc-100 placeholder:text-zinc-500 focus:border-[#2BA98B]/40 focus:outline-none"
                />

                <div className="mt-3 space-y-3">
                  <ChipSet
                    label="Personas"
                    available={availablePersonas}
                    selected={t.personas ?? []}
                    onToggle={v => toggleTag(t.id, "personas", v)}
                    emptyHint="Add personas in Settings → Personas to scope templates by buyer fit."
                  />
                  <ChipSet
                    label="Stages"
                    available={availableStages}
                    selected={t.stages ?? []}
                    onToggle={v => toggleTag(t.id, "stages", v)}
                  />
                  <ChipSet
                    label="Custom Tags"
                    available={availableProspectTypes}
                    selected={t.prospectTypes ?? []}
                    onToggle={v => toggleTag(t.id, "prospectTypes", v)}
                    emptyHint="Add custom tags in Settings → Custom Tags to scope templates by company category."
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Save bar */}
      <div className="sticky bottom-4 flex items-center justify-between gap-3 rounded-2xl border border-[#2BA98B]/30 bg-[#2BA98B]/[0.08] px-5 py-4 backdrop-blur">
        <div className="text-[13px]">
          {error && <span className="text-rose-400">{error}</span>}
          {saved && !error && <span className="text-emerald-400">Saved.</span>}
          {!saved && !error && <span className="text-zinc-300">Changes apply on the next draft.</span>}
        </div>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-xl bg-[#2BA98B] px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[#249A7E] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  )
}

function ChipSet({
  label, available, selected, onToggle, emptyHint,
}: {
  label:     string
  available: string[]
  selected:  string[]
  onToggle:  (value: string) => void
  emptyHint?: string
}) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.06em] text-zinc-500">{label}</p>
      {available.length === 0 ? (
        <p className="text-[12px] text-zinc-500">{emptyHint ?? "—"}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {available.map(value => {
            const isOn = selected.includes(value)
            return (
              <button
                key={value}
                type="button"
                onClick={() => onToggle(value)}
                aria-pressed={isOn}
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#2BA98B]/40 ${
                  isOn
                    ? "border-[#2BA98B]/40 bg-[#2BA98B]/[0.16] text-white"
                    : "border-white/10 bg-transparent text-zinc-400 hover:border-white/20 hover:text-zinc-200"
                }`}
              >
                {isOn && (
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#2BA98B" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
                {value}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
