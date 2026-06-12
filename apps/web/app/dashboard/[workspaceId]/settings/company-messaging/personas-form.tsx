"use client"

/**
 * Personas form — the structured persona library.
 *
 * Each persona is rendered as a collapsible card (closed by default) so users
 * can scan the list at a glance and only expand the one they want to edit.
 * The "Add persona" affordance lives in a sticky toolbar at the top so adding
 * a new persona doesn't require scrolling to the bottom of a long list.
 *
 * Per persona we capture the rich schema mirrored from MVPR's call-intelligence
 * persona docs: identity (name, product, headline quote), match rules (job
 * titles + ICP groups), description (who-they-are + characteristics), jobs to
 * be done (primary / also-needs-to / emotional), value (props, pains,
 * outcomes, proof, objectives, opportunities), buying signals (objections,
 * CTAs, red flags), voice (voice-of-customer, value language) and selling
 * principles (positioning, language, DM principles, churn risk).
 *
 * Array fields render as <BulletList> chips: click a chip to edit it inline,
 * × to remove, "Add..." input below to append. Paragraph fields stay as
 * textareas. The "Upload doc" button on each card runs the parse-doc endpoint
 * and merges the structured result into the form for the user to review.
 *
 * Saves via PATCH /api/workspace/<id>/config — same endpoint as the rest of
 * settings. The PATCH does a top-level overwrite of messaging.personas, so
 * the whole array goes on every save.
 */

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useToast } from "../../toast"
import { PersonaChannelFingerprints } from "./persona-channel-fingerprints"

interface Persona {
  // Identity
  /** Stable UUID, assigned on creation. Keys style_fingerprints / style_samples. */
  id:               string
  name:             string
  product:          string
  headlineQuote:    string
  // Match rules
  matchPatterns:    string[]
  /** Optional company-size band — strict. Empty string = no constraint. */
  minEmployees:     string
  maxEmployees:     string
  /** Optional ISO-2 country allow-list — strict. */
  matchCountries:   string[]
  // Description
  whoTheyAre:       string
  characteristics:  string[]
  // Jobs to be done
  primaryJob:       string
  jobsToBeDone:     string[]
  emotionalJob:     string
  // Value
  valueProps:       string[]
  painPoints:       string[]
  desiredOutcomes:  string[]
  proofPoints:      string[]
  objectives:       string[]
  opportunities:    string[]
  // Buying signals
  commonObjections: string[]
  ctas:             string[]
  redFlags:         string[]
  // Voice
  voiceOfCustomer:  string[]
  valueLanguage:    string[]
  // Selling principles
  positioning:      string
  language:         string
  dmPrinciples:     string
  churnRisk:        string
}

function emptyPersona(): Persona {
  return {
    id: crypto.randomUUID(),
    name: "", product: "", headlineQuote: "",
    matchPatterns: [], minEmployees: "", maxEmployees: "", matchCountries: [],
    whoTheyAre: "", characteristics: [],
    primaryJob: "", jobsToBeDone: [], emotionalJob: "",
    valueProps: [], painPoints: [], desiredOutcomes: [],
    proofPoints: [], objectives: [], opportunities: [],
    commonObjections: [], ctas: [], redFlags: [],
    voiceOfCustomer: [], valueLanguage: [],
    positioning: "", language: "", dmPrinciples: "", churnRisk: "",
  }
}

/** Total filled-bullet count across all array fields — used in the collapsed-card summary. */
function richness(p: Persona): number {
  return (
    p.matchPatterns.length +
    p.characteristics.length +
    p.jobsToBeDone.length +
    p.valueProps.length + p.painPoints.length + p.desiredOutcomes.length +
    p.proofPoints.length + p.objectives.length + p.opportunities.length +
    p.commonObjections.length + p.ctas.length + p.redFlags.length +
    p.voiceOfCustomer.length + p.valueLanguage.length
  )
}

export function PersonasForm({
  workspaceId,
  initial,
}: {
  workspaceId: string
  initial: Persona[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [personas, setPersonas] = useState<Persona[]>(initial)
  const [saving, setSaving] = useState(false)
  const [reclassifying, setReclassifying] = useState(false)

  function addPersona() {
    setPersonas([emptyPersona(), ...personas])  // prepend so new card appears at top
  }
  function updatePersona(idx: number, patch: Partial<Persona>) {
    setPersonas(personas.map((p, i) => (i === idx ? { ...p, ...patch } : p)))
  }
  function removePersona(idx: number) {
    if (!window.confirm(`Remove "${personas[idx].name || `Persona ${idx + 1}`}"? This can't be undone until the next save.`)) return
    setPersonas(personas.filter((_, i) => i !== idx))
  }

  async function uploadAndParse(idx: number, file: File) {
    const toastLabel = file.name || "document"
    toast.info("Parsing document", `Reading ${toastLabel}…`)
    try {
      const fd = new FormData()
      fd.append("file", file)
      const res = await fetch(`/api/dashboard/${workspaceId}/personas/parse-doc`, {
        method: "POST",
        body:   fd,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        toast.error("Parse failed", err.error ?? `HTTP ${res.status}`)
        return
      }
      const { persona: parsed } = (await res.json()) as { persona: Partial<Persona> }
      const current = personas[idx]
      // Merge: parser fills empty fields, keeps user-typed values when the
      // parser produced nothing for that field. `id` is never overwritten -
      // the existing persona's stable id stays put across upload-parse runs.
      const merged: Persona = {
        id:               current.id,
        name:             parsed.name             || current.name,
        product:          parsed.product          || current.product,
        headlineQuote:    parsed.headlineQuote    || current.headlineQuote,
        matchPatterns:    parsed.matchPatterns?.length    ? parsed.matchPatterns    : current.matchPatterns,
        minEmployees:     parsed.minEmployees     || current.minEmployees,
        maxEmployees:     parsed.maxEmployees     || current.maxEmployees,
        matchCountries:   parsed.matchCountries?.length ? parsed.matchCountries : current.matchCountries,
        whoTheyAre:       parsed.whoTheyAre       || current.whoTheyAre,
        characteristics:  parsed.characteristics?.length  ? parsed.characteristics  : current.characteristics,
        primaryJob:       parsed.primaryJob       || current.primaryJob,
        jobsToBeDone:     parsed.jobsToBeDone?.length     ? parsed.jobsToBeDone     : current.jobsToBeDone,
        emotionalJob:     parsed.emotionalJob     || current.emotionalJob,
        valueProps:       parsed.valueProps?.length       ? parsed.valueProps       : current.valueProps,
        painPoints:       parsed.painPoints?.length       ? parsed.painPoints       : current.painPoints,
        desiredOutcomes:  parsed.desiredOutcomes?.length  ? parsed.desiredOutcomes  : current.desiredOutcomes,
        proofPoints:      parsed.proofPoints?.length      ? parsed.proofPoints      : current.proofPoints,
        objectives:       parsed.objectives?.length       ? parsed.objectives       : current.objectives,
        opportunities:    parsed.opportunities?.length    ? parsed.opportunities    : current.opportunities,
        commonObjections: parsed.commonObjections?.length ? parsed.commonObjections : current.commonObjections,
        ctas:             parsed.ctas?.length             ? parsed.ctas             : current.ctas,
        redFlags:         parsed.redFlags?.length         ? parsed.redFlags         : current.redFlags,
        voiceOfCustomer:  parsed.voiceOfCustomer?.length  ? parsed.voiceOfCustomer  : current.voiceOfCustomer,
        valueLanguage:    parsed.valueLanguage?.length    ? parsed.valueLanguage    : current.valueLanguage,
        positioning:      parsed.positioning      || current.positioning,
        language:         parsed.language         || current.language,
        dmPrinciples:     parsed.dmPrinciples     || current.dmPrinciples,
        churnRisk:        parsed.churnRisk        || current.churnRisk,
      }
      setPersonas(personas.map((p, i) => (i === idx ? merged : p)))
      toast.success("Parsed", "Review the populated fields and click Save.")
    } catch (e) {
      toast.error("Parse failed", (e as Error).message)
    }
  }

  async function handleReclassify() {
    if (reclassifying) return
    setReclassifying(true)
    toast.info("Reclassifying", "Running persona match across every contact in this workspace…")
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/personas/reclassify`, { method: "POST" })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        toast.error("Reclassify failed", err.error ?? `HTTP ${res.status}`)
        return
      }
      const { updated } = (await res.json()) as { updated: number }
      toast.success("Reclassified", `${updated} contact${updated === 1 ? "" : "s"} updated.`)
      router.refresh()
    } catch (e) {
      toast.error("Reclassify failed", (e as Error).message)
    } finally {
      setReclassifying(false)
    }
  }

  /**
   * Persist the current personas array. When silent=true, skips toasts and
   * router.refresh - used by the channel-fingerprint flow as a
   * save-personas-before-generate guard so persona ids are locked on the
   * server before the generator is asked to look one up.
   */
  async function savePersonas({ silent }: { silent: boolean }): Promise<boolean> {
    if (!silent) setSaving(true)
    const cleanArr = (a: string[]) => a.map(s => s.trim()).filter(Boolean)
    const parseInt10 = (s: string): number | undefined => {
      const n = parseInt(s.trim(), 10)
      return Number.isFinite(n) && n >= 0 ? n : undefined
    }
    // Filter out entirely-empty rows BEFORE cleaning — richness expects the
    // form-shape Persona (minEmployees as string), not the cleaned shape.
    const interesting = personas.filter(p =>
      p.name || p.product || richness(p) > 0 || p.whoTheyAre || p.positioning,
    )
    const cleaned = interesting
      .map(p => ({
        // Stable id - must round-trip through save or downstream
        // style_fingerprints rows would orphan on the next page load.
        id:               p.id,
        name:             p.name.trim(),
        product:          p.product.trim(),
        headlineQuote:    p.headlineQuote.trim(),
        matchPatterns:    cleanArr(p.matchPatterns),
        ...(parseInt10(p.minEmployees) !== undefined ? { minEmployees: parseInt10(p.minEmployees) } : {}),
        ...(parseInt10(p.maxEmployees) !== undefined ? { maxEmployees: parseInt10(p.maxEmployees) } : {}),
        matchCountries:   cleanArr(p.matchCountries).map(c => c.toUpperCase()),
        whoTheyAre:       p.whoTheyAre.trim(),
        characteristics:  cleanArr(p.characteristics),
        primaryJob:       p.primaryJob.trim(),
        jobsToBeDone:     cleanArr(p.jobsToBeDone),
        emotionalJob:     p.emotionalJob.trim(),
        valueProps:       cleanArr(p.valueProps),
        painPoints:       cleanArr(p.painPoints),
        desiredOutcomes:  cleanArr(p.desiredOutcomes),
        proofPoints:      cleanArr(p.proofPoints),
        objectives:       cleanArr(p.objectives),
        opportunities:    cleanArr(p.opportunities),
        commonObjections: cleanArr(p.commonObjections),
        ctas:             cleanArr(p.ctas),
        redFlags:         cleanArr(p.redFlags),
        voiceOfCustomer:  cleanArr(p.voiceOfCustomer),
        valueLanguage:    cleanArr(p.valueLanguage),
        positioning:      p.positioning.trim(),
        language:         p.language.trim(),
        dmPrinciples:     p.dmPrinciples.trim(),
        churnRisk:        p.churnRisk.trim(),
      }))
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messaging: { personas: cleaned } }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        if (!silent) toast.error("Save failed", err.error ?? `HTTP ${res.status}`)
        return false
      }
      if (!silent) {
        toast.success("Personas saved", `${cleaned.length} persona${cleaned.length === 1 ? "" : "s"} stored.`)
        router.refresh()
      }
      return true
    } catch (e) {
      if (!silent) toast.error("Save failed", (e as Error).message)
      return false
    } finally {
      if (!silent) setSaving(false)
    }
  }

  async function handleSave() {
    await savePersonas({ silent: false })
  }

  // Exposed to PersonaCard's channel-fingerprint guard. Silent (no toast,
  // no refresh) and throws on failure so the caller can abort the generate
  // flow when the save didn't actually land.
  async function silentSaveForGenerate() {
    const ok = await savePersonas({ silent: true })
    if (!ok) throw new Error("Could not save personas before generating fingerprint")
  }

  const dirty = JSON.stringify(personas) !== JSON.stringify(initial)

  return (
    <div className="space-y-6">
      <p className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-[13px] leading-[20px] text-zinc-300">
        Each persona has match rules — job-title substrings and an optional ICP-group narrow. At draft time
        the system picks the first persona whose match rules hit the lead, then injects that persona&rsquo;s
        full context (value props, pains, outcomes, voice, CTAs and language) into the LLM prompt.
        Click a card to expand it. Click any bullet to edit it; × to remove.
      </p>

      {/* Sticky add bar — top of list so adding doesn't require scrolling. */}
      <div className="sticky top-2 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-[#08302E]/85 px-4 py-3 backdrop-blur">
        <p className="text-[13px] text-zinc-300">
          {personas.length} persona{personas.length === 1 ? "" : "s"}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleReclassify}
            disabled={reclassifying || dirty}
            title={dirty ? "Save your changes first" : "Re-run persona match against every existing contact"}
            className="rounded-lg border border-white/14 bg-white/[0.04] px-3 py-2 text-[13px] font-medium text-zinc-200 transition-colors hover:border-[#2BA98B]/40 hover:bg-[#2BA98B]/[0.10] hover:text-white disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#2BA98B]/40 motion-reduce:transition-none"
          >
            {reclassifying ? "Reclassifying…" : "Reclassify contacts"}
          </button>
          <button
            type="button"
            onClick={addPersona}
            className="rounded-lg bg-[#2BA98B] px-4 py-2 text-[13px] font-bold text-white transition-colors hover:bg-[#239977] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60 motion-reduce:transition-none"
          >
            + Add persona
          </button>
        </div>
      </div>

      {personas.length === 0 && (
        <div className="rounded-2xl border border-dashed border-white/15 bg-white/[0.02] px-6 py-10 text-center">
          <p className="text-[14px] text-zinc-400">
            No personas yet. The Outreach Principles tab&rsquo;s fallback context will be used for every lead until you add one.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {personas.map((p, idx) => (
          <PersonaCard
            key={p.id}
            workspaceId={workspaceId}
            persona={p}
            onChange={patch => updatePersona(idx, patch)}
            onRemove={() => removePersona(idx)}
            onUpload={file => uploadAndParse(idx, file)}
            onSavePersonas={silentSaveForGenerate}
          />
        ))}
      </div>

      <div className="sticky bottom-4 flex items-center justify-between gap-3 rounded-2xl border border-[#2BA98B]/30 bg-[#2BA98B]/[0.08] px-5 py-4 backdrop-blur">
        <p className="text-[13px] text-zinc-200">
          {dirty ? "Unsaved changes." : "All synced."}
        </p>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !dirty}
          className="rounded-lg bg-[#2BA98B] px-5 py-2 text-[13px] font-bold text-white transition-colors hover:bg-[#239977] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
        >
          {saving ? "Saving..." : "Save changes"}
        </button>
      </div>
    </div>
  )
}

// ─── Card ────────────────────────────────────────────────────────────────────

function PersonaCard({
  workspaceId,
  persona,
  onChange,
  onRemove,
  onUpload,
  onSavePersonas,
}: {
  workspaceId:    string
  persona:        Persona
  onChange:       (patch: Partial<Persona>) => void
  onRemove:       () => void
  onUpload:       (file: File) => Promise<void> | void
  onSavePersonas: () => Promise<void>
}) {
  const r = richness(persona)
  const productLabel = persona.product.trim()
  return (
    <details className="group overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] open:border-[#2BA98B]/30 open:bg-[#2BA98B]/[0.04]">
      <summary className="flex cursor-pointer list-none items-center gap-4 px-5 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="shrink-0 text-zinc-400 transition-transform group-open:rotate-90 motion-reduce:transition-none"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="truncate text-[16px] font-bold text-white">
              {persona.name || "(unnamed persona)"}
            </span>
            {productLabel && (
              <span className="inline-flex items-center rounded-full bg-[#2BA98B]/[0.16] px-2.5 py-0.5 text-[11px] font-semibold text-[#2BA98B]">
                {productLabel}
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[12px] text-zinc-400">
            {persona.matchPatterns.length} match{persona.matchPatterns.length === 1 ? "" : "es"}
            {" · "}
            {r} bullet{r === 1 ? "" : "s"}
            {persona.headlineQuote && ` · "${persona.headlineQuote.slice(0, 80)}${persona.headlineQuote.length > 80 ? "…" : ""}"`}
          </p>
        </div>
      </summary>

      <div className="space-y-6 border-t border-white/[0.06] px-5 py-5">
        {/* Action row — upload + remove */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <UploadDocButton onFile={onUpload} />
          <button
            type="button"
            onClick={onRemove}
            className="rounded-lg border border-white/14 bg-white/[0.04] px-3 py-2 text-[12px] font-medium text-zinc-300 transition-colors hover:border-rose-400/40 hover:bg-rose-500/10 hover:text-rose-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-rose-400/40 motion-reduce:transition-none"
          >
            Remove persona
          </button>
        </div>

        {/* === Identity === */}
        <Subsection title="Identity">
          <Field
            label="Persona name"
            value={persona.name}
            onChange={v => onChange({ name: v })}
            placeholder="e.g. The Stretched Startup Comms Lead"
          />
          <Field
            label="Product they want to buy"
            value={persona.product}
            onChange={v => onChange({ product: v })}
            placeholder="e.g. PR Services, PR Operating System"
            hint="Which offering of yours this persona is interested in. Surfaces as a chip on the persona summary."
          />
          <Textarea
            label="Headline quote"
            value={persona.headlineQuote}
            onChange={v => onChange({ headlineQuote: v })}
            placeholder='"basically looking for something that can solve my need as if I had a person in house"'
            hint="One canonical customer quote that captures how this persona sounds."
            rows={2}
          />
        </Subsection>

        {/* === Match rules === */}
        <Subsection title="Match rules">
          <BulletList
            label="Job titles"
            value={persona.matchPatterns}
            onChange={v => onChange({ matchPatterns: v })}
            placeholder="comms lead"
            hint="Case-insensitive substrings of the lead's job title. Empty = match anything."
          />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Min employees (company size)"
              value={persona.minEmployees}
              onChange={v => onChange({ minEmployees: v })}
              placeholder="e.g. 1000"
              hint="Strict — leads at smaller companies won't match."
            />
            <Field
              label="Max employees"
              value={persona.maxEmployees}
              onChange={v => onChange({ maxEmployees: v })}
              placeholder="e.g. 50"
              hint="Strict — leads at larger companies won't match."
            />
          </div>
          <BulletList
            label="Country allow-list"
            value={persona.matchCountries}
            onChange={v => onChange({ matchCountries: v.map(c => c.toUpperCase()) })}
            placeholder="GB"
            hint="ISO-2 codes. Empty = no country filter. Strict — leads with unknown country won't match when this is set."
          />
        </Subsection>

        {/* === Description === */}
        <Subsection title="Who they are">
          <Textarea
            label="Description"
            value={persona.whoTheyAre}
            onChange={v => onChange({ whoTheyAre: v })}
            placeholder="A mid-level in-house communications professional who is the entire PR function at a startup or scaleup…"
            rows={5}
          />
          <BulletList
            label="Characteristics"
            value={persona.characteristics}
            onChange={v => onChange({ characteristics: v })}
            placeholder="They are the single bottleneck for all PR approvals."
            hint="4–6 short trait bullets — single-sentence statements."
          />
        </Subsection>

        {/* === Jobs to be done === */}
        <Subsection title="Jobs to be done">
          <Textarea
            label="Primary job"
            value={persona.primaryJob}
            onChange={v => onChange({ primaryJob: v })}
            placeholder="Maintain a focused, prioritised PR programme that generates visible media momentum…"
            rows={3}
          />
          <BulletList
            label="Also needs to"
            value={persona.jobsToBeDone}
            onChange={v => onChange({ jobsToBeDone: v })}
            placeholder="Get the CEO to show up consistently as a thought leader."
          />
          <Textarea
            label="Emotional job"
            value={persona.emotionalJob}
            onChange={v => onChange({ emotionalJob: v })}
            placeholder="They want to feel like their effort is translating into learning and progress…"
            rows={3}
          />
        </Subsection>

        {/* === Value === */}
        <Subsection title="Value">
          <BulletList
            label="Value propositions"
            value={persona.valueProps}
            onChange={v => onChange({ valueProps: v })}
            placeholder="One-person PR function feels like a full team."
            hint="Short value-prop bullets. Each one feeds into outbound message context."
          />
          <BulletList
            label="Pain points"
            value={persona.painPoints}
            onChange={v => onChange({ painPoints: v })}
            placeholder="Bandwidth constraints — solo bottleneck for approvals."
          />
          <BulletList
            label="Desired outcomes"
            value={persona.desiredOutcomes}
            onChange={v => onChange({ desiredOutcomes: v })}
            placeholder="A coordinated momentum push that reinforces investor signals."
          />
          <BulletList
            label="Proof points"
            value={persona.proofPoints}
            onChange={v => onChange({ proofPoints: v })}
            placeholder="Used by Stripe, Wise, Visa."
          />
          <BulletList
            label="Objectives (optional)"
            value={persona.objectives}
            onChange={v => onChange({ objectives: v })}
            placeholder="Hit Series-B fundraise within 6 months."
          />
          <BulletList
            label="Opportunities (optional)"
            value={persona.opportunities}
            onChange={v => onChange({ opportunities: v })}
            placeholder="Upsell coverage tracking once they hit 3+ markets."
          />
        </Subsection>

        {/* === Buying signals === */}
        <Subsection title="Buying signals">
          <BulletList
            label="Common objections"
            value={persona.commonObjections}
            onChange={v => onChange({ commonObjections: v })}
            placeholder="We already have an in-house comms team."
          />
          <BulletList
            label="CTAs that work"
            value={persona.ctas}
            onChange={v => onChange({ ctas: v })}
            placeholder="15-min intro call."
          />
          <BulletList
            label="Red flags"
            value={persona.redFlags}
            onChange={v => onChange({ redFlags: v })}
            placeholder="Has a dedicated PR team — not a solo operator."
            hint="Disqualifiers — signals that a contact is NOT this persona."
          />
        </Subsection>

        {/* === Voice === */}
        <Subsection title="Voice">
          <BulletList
            label="Voice of customer"
            value={persona.voiceOfCustomer}
            onChange={v => onChange({ voiceOfCustomer: v })}
            placeholder='"I feel like I am throwing effort into a void."'
            hint="Themes / quotes capturing how this persona talks."
          />
          <BulletList
            label="Value language"
            value={persona.valueLanguage}
            onChange={v => onChange({ valueLanguage: v })}
            placeholder="momentum"
            hint="Phrases the persona uses when describing value."
          />
        </Subsection>

        {/* === Selling principles === */}
        <Subsection title="Selling principles">
          <Textarea
            label="Positioning"
            value={persona.positioning}
            onChange={v => onChange({ positioning: v })}
            placeholder="Position the product as the strategic partner that makes a one-person PR function feel like a full team…"
            rows={4}
          />
          <Textarea
            label="Language / tone"
            value={persona.language}
            onChange={v => onChange({ language: v })}
            placeholder="Direct, no jargon, light humour. No exclamation marks."
            rows={2}
          />
          <Textarea
            label="DM / email principles"
            value={persona.dmPrinciples}
            onChange={v => onChange({ dmPrinciples: v })}
            placeholder="Do — open with the specific signal. Don't — pitch features."
            rows={3}
          />
          <Textarea
            label="Churn risk"
            value={persona.churnRisk}
            onChange={v => onChange({ churnRisk: v })}
            placeholder="If output cadence feels mismatched to the pace they need…"
            rows={3}
          />
        </Subsection>

        {/* === Channel voice fingerprints === */}
        <Subsection title="Channel voice">
          <PersonaChannelFingerprints
            workspaceId={workspaceId}
            personaId={persona.id}
            personaName={persona.name || "(unnamed persona)"}
            onSavePersonas={onSavePersonas}
          />
        </Subsection>
      </div>
    </details>
  )
}

// ─── BulletList — chip-edit-add UX ──────────────────────────────────────────

function BulletList({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label:        string
  value:        string[]
  onChange:     (next: string[]) => void
  placeholder?: string
  hint?:        string
}) {
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [draft, setDraft] = useState("")
  const [adding, setAdding] = useState("")

  function commitEdit(idx: number, next: string) {
    const trimmed = next.trim()
    if (!trimmed) {
      onChange(value.filter((_, i) => i !== idx))  // empty edit = remove
    } else {
      onChange(value.map((v, i) => (i === idx ? trimmed : v)))
    }
    setEditingIdx(null)
  }
  function startEdit(idx: number) {
    setDraft(value[idx])
    setEditingIdx(idx)
  }
  function remove(idx: number) {
    onChange(value.filter((_, i) => i !== idx))
  }
  function addBullet() {
    const trimmed = adding.trim()
    if (!trimmed) return
    onChange([...value, trimmed])
    setAdding("")
  }

  return (
    <div className="space-y-2">
      <label className="text-[13px] font-medium text-white">{label}</label>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((item, idx) => (
            <li key={idx}>
              {editingIdx === idx ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onBlur={e => commitEdit(idx, e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      commitEdit(idx, e.currentTarget.value)
                    }
                    if (e.key === "Escape") {
                      e.preventDefault()
                      setEditingIdx(null)
                    }
                  }}
                  className="rounded-full border border-[#2BA98B]/40 bg-[#2BA98B]/[0.10] px-3 py-1 text-[13px] text-white outline-none focus:border-[#2BA98B] focus:ring-1 focus:ring-[#2BA98B]/40"
                />
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.05] py-1 pl-3 pr-1 text-[13px] text-zinc-100">
                  <button
                    type="button"
                    onClick={() => startEdit(idx)}
                    className="text-left transition-colors hover:text-white focus-visible:outline-none focus-visible:underline motion-reduce:transition-none"
                    aria-label={`Edit "${item}"`}
                  >
                    {item}
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(idx)}
                    aria-label={`Remove "${item}"`}
                    className="-mr-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-rose-500/15 hover:text-rose-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-rose-400/40 motion-reduce:transition-none"
                  >
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={adding}
          onChange={e => setAdding(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") {
              e.preventDefault()
              addBullet()
            }
          }}
          placeholder={value.length === 0 ? `Add… (${placeholder ?? "press Enter"})` : "Add another…"}
          className="flex-1 rounded-lg border border-white/14 bg-white/[0.04] px-3 py-2 text-[13px] text-white placeholder-zinc-500 focus:border-[#2BA98B] focus:outline-none focus:ring-1 focus:ring-[#2BA98B]/40"
        />
        <button
          type="button"
          onClick={addBullet}
          disabled={!adding.trim()}
          className="rounded-lg border border-white/14 bg-white/[0.04] px-3 py-2 text-[12px] font-medium text-zinc-200 transition-colors hover:border-[#2BA98B]/40 hover:bg-[#2BA98B]/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#2BA98B]/40 motion-reduce:transition-none"
        >
          Add
        </button>
      </div>
      {hint && <p className="text-[12px] text-zinc-400">{hint}</p>}
    </div>
  )
}

// ─── Section heading ────────────────────────────────────────────────────────

function Subsection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h3 className="text-[12px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">{title}</h3>
      <div className="space-y-4">{children}</div>
    </section>
  )
}

// ─── Plain field + textarea ─────────────────────────────────────────────────

function Field({
  label, value, onChange, placeholder, hint,
}: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; hint?: string
}) {
  return (
    <div className="space-y-2">
      <label className="text-[13px] font-medium text-white">{label}</label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-white/14 bg-white/[0.04] px-3.5 py-2.5 text-[14px] text-white placeholder-zinc-500 focus:border-[#2BA98B] focus:outline-none focus:ring-1 focus:ring-[#2BA98B]/40"
      />
      {hint && <p className="text-[12px] text-zinc-400">{hint}</p>}
    </div>
  )
}

function Textarea({
  label, value, onChange, placeholder, hint, rows = 3,
}: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; hint?: string; rows?: number
}) {
  return (
    <div className="space-y-2">
      <label className="text-[13px] font-medium text-white">{label}</label>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="w-full resize-none rounded-lg border border-white/14 bg-white/[0.04] px-3.5 py-2.5 text-[14px] text-white placeholder-zinc-500 focus:border-[#2BA98B] focus:outline-none focus:ring-1 focus:ring-[#2BA98B]/40"
      />
      {hint && <p className="text-[12px] text-zinc-400">{hint}</p>}
    </div>
  )
}

// ─── Upload-doc button ──────────────────────────────────────────────────────

function UploadDocButton({ onFile }: { onFile: (file: File) => Promise<void> | void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true)
    try {
      await onFile(file)
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ""
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.md,.markdown,.txt,application/pdf,text/markdown,text/plain"
        onChange={handleChange}
        className="sr-only"
        aria-label="Upload persona document"
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="rounded-lg border border-white/14 bg-white/[0.04] px-3 py-2 text-[12px] font-medium text-zinc-200 transition-colors hover:border-[#2BA98B]/40 hover:bg-[#2BA98B]/[0.10] hover:text-white disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#2BA98B]/40 motion-reduce:transition-none"
      >
        {busy ? "Parsing…" : "Upload doc"}
      </button>
    </>
  )
}
