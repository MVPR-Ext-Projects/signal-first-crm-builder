"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import type { SalesMotion, BusinessModel } from "@signal-first/blueprint-schema"

const SALES_MOTIONS: { value: SalesMotion; label: string; description: string }[] = [
  { value: "outbound", label: "Outbound", description: "You find and contact prospects proactively" },
  { value: "inbound", label: "Inbound", description: "Prospects come to you through content, SEO, or PR" },
  { value: "plg", label: "Product-led", description: "Users try the product before talking to sales" },
  { value: "hybrid", label: "Hybrid", description: "Mix of inbound and outbound" },
  { value: "partner-led", label: "Partner-led", description: "Sales driven through referrals and partnerships" },
]

const BUSINESS_MODELS: { value: BusinessModel; label: string }[] = [
  { value: "b2b", label: "B2B (selling to businesses)" },
  { value: "b2c", label: "B2C (selling to consumers)" },
  { value: "b2b2c", label: "B2B2C (business platform, consumer end-users)" },
  { value: "marketplace", label: "Marketplace (connecting two sides)" },
]

const COMMON_CRMS = [
  "HubSpot", "Attio", "Salesforce", "Pipedrive", "Close", "Zoho",
  "Monday CRM", "Notion", "Spreadsheets", "None",
]

const SIGNAL_TOOLS = [
  "LinkedIn Sales Navigator", "Teamfluence", "Dripify", "Expandi",
  "Waalaxy", "PhantomBuster", "MeetAlfred",
]

const ENRICHMENT_TOOLS = [
  "Surfe", "Clay", "Apollo.io", "Clearbit", "Hunter.io",
  "ZoomInfo", "Lusha", "Snov.io",
]

const MARKETING_CHANNELS = [
  "LinkedIn Personal Posts", "LinkedIn Company Page", "LinkedIn Ads",
  "LinkedIn Outbound (DMs)", "Email Outbound", "PR / Press Coverage",
  "Events", "Podcast", "Newsletter", "Blog / SEO", "Partnerships",
  "Paid Meta / Google Ads",
]

const ENTITY_SCALE_OPTIONS = [
  "< 500 contacts", "500–2,000", "2,000–10,000", "10,000–50,000", "50,000+",
]

export default function QuestionnairePage() {
  const router = useRouter()
  const [form, setForm] = useState({
    icpDescription: "",
    salesMotion: "" as SalesMotion | "",
    businessModel: "" as BusinessModel | "",
    personaTypesRaw: "",
    buyerPersonasRaw: "",
    existingCrm: "",
    existingCrmCustom: "",
    entityScale: "",
    targetingB2BProfessionals: false,
    linkedinBrandBuilding: false,
    signalToolsSelected: [] as string[],
    enrichmentToolsSelected: [] as string[],
    marketingChannelsSelected: [] as string[],
    hasFirefliesTranscripts: false,
    toolsCustom: "",
    additionalContext: "",
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggleArr(key: "signalToolsSelected" | "enrichmentToolsSelected" | "marketingChannelsSelected", val: string) {
    setForm((f) => ({
      ...f,
      [key]: f[key].includes(val) ? f[key].filter((t) => t !== val) : [...f[key], val],
    }))
  }

  const isValid =
    form.icpDescription.trim().length > 10 &&
    form.salesMotion !== "" &&
    form.businessModel !== ""

  async function handleSubmit() {
    if (!isValid) return
    setSaving(true)
    setError(null)

    const existingCrm = form.existingCrm === "Other"
      ? form.existingCrmCustom.trim() || "Other"
      : form.existingCrm || undefined

    const customTools = form.toolsCustom.split(",").map((t) => t.trim()).filter(Boolean)

    const payload = {
      icpDescription: form.icpDescription.trim(),
      salesMotion: form.salesMotion as SalesMotion,
      businessModel: form.businessModel as BusinessModel,
      personaTypes: form.personaTypesRaw.split("\n").map((s) => s.trim()).filter(Boolean),
      buyerPersonas: form.buyerPersonasRaw.split("\n").map((s) => s.trim()).filter(Boolean),
      toolsUsed: customTools,
      existingCrm,
      entityScale: form.entityScale || undefined,
      targetingB2BProfessionals: form.targetingB2BProfessionals,
      linkedinBrandBuilding: form.linkedinBrandBuilding,
      signalTools: form.signalToolsSelected.length ? form.signalToolsSelected : undefined,
      enrichmentTools: form.enrichmentToolsSelected.length ? form.enrichmentToolsSelected : undefined,
      marketingChannels: form.marketingChannelsSelected.length ? form.marketingChannelsSelected : undefined,
      hasFirefliesTranscripts: form.hasFirefliesTranscripts,
      additionalContext: form.additionalContext.trim() || undefined,
    }

    try {
      const res = await fetch("/api/wizard/save-questionnaire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error("Save failed")
      router.push("/wizard/analyzing")
    } catch {
      setError("Failed to save — please try again")
      setSaving(false)
    }
  }

  return (
    <div className="space-y-10">
      <div className="space-y-3">
        <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">
          Step 2 of 4 · Business profile
        </p>
        <h1 className="text-[30px] font-bold tracking-[-0.02em] text-white">Tell us about your business</h1>
        <p className="max-w-[640px] text-[15px] leading-[23px] text-zinc-300">
          This shapes the CRM structure for your go-to-market motion. The more specific you are, the better the blueprint.
        </p>
      </div>

      {/* ── Section: About your business ── */}
      <Section title="About your business">
        <Field label="Describe your ideal customer" required>
          <textarea
            rows={3}
            placeholder="e.g. Series A-C B2B SaaS companies in fintech and HR tech, 50-500 employees, UK/US, scaling their marketing function"
            value={form.icpDescription}
            onChange={(e) => setForm((f) => ({ ...f, icpDescription: e.target.value }))}
            className={textarea}
          />
        </Field>

        <Field label="Business model" required>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {BUSINESS_MODELS.map(({ value, label }) => (
              <Chip key={value} active={form.businessModel === value} onClick={() => setForm((f) => ({ ...f, businessModel: value }))}>
                {label}
              </Chip>
            ))}
          </div>
        </Field>

        <Field label="Primary sales motion" required>
          <div className="space-y-2">
            {SALES_MOTIONS.map(({ value, label, description }) => (
              <button
                key={value}
                onClick={() => setForm((f) => ({ ...f, salesMotion: value }))}
                className={`flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60 ${
                  form.salesMotion === value
                    ? "border-[#2BA98B] bg-[#2BA98B]/[0.10]"
                    : "border-white/12 bg-white/[0.03] hover:border-white/24"
                }`}
              >
                <span className={`mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 ${form.salesMotion === value ? "border-[#2BA98B] bg-[#2BA98B]" : "border-white/30"}`} />
                <span>
                  <span className="block text-[14px] font-semibold text-white">{label}</span>
                  <span className="text-[12px] text-zinc-400">{description}</span>
                </span>
              </button>
            ))}
          </div>
        </Field>

        <Field label="Who do you sell to?" hint="Job titles, one per line">
          <textarea rows={3} placeholder={"VP Marketing\nHead of Communications\nCMO"} value={form.personaTypesRaw}
            onChange={(e) => setForm((f) => ({ ...f, personaTypesRaw: e.target.value }))} className={textarea} />
        </Field>

        <Field label="Who else is involved in buying decisions?" hint="Optional — one per line">
          <textarea rows={2} placeholder={"CEO\nCTO\nProcurement"} value={form.buyerPersonasRaw}
            onChange={(e) => setForm((f) => ({ ...f, buyerPersonasRaw: e.target.value }))} className={textarea} />
        </Field>
      </Section>

      {/* ── Section: CRM & data ── */}
      <Section title="Your current CRM & data">
        <Field label="What CRM do you currently use?">
          <div className="flex flex-wrap gap-2">
            {COMMON_CRMS.map((crm) => (
              <Chip key={crm} active={form.existingCrm === crm} onClick={() => setForm((f) => ({ ...f, existingCrm: crm }))}>
                {crm}
              </Chip>
            ))}
            <Chip active={form.existingCrm === "Other"} onClick={() => setForm((f) => ({ ...f, existingCrm: "Other" }))}>
              Other
            </Chip>
          </div>
          {form.existingCrm === "Other" && (
            <input type="text" placeholder="Which CRM?" value={form.existingCrmCustom}
              onChange={(e) => setForm((f) => ({ ...f, existingCrmCustom: e.target.value }))} className={`mt-2 ${input}`} />
          )}
        </Field>

        <Field label="Roughly how many contacts or companies are in your universe?">
          <div className="flex flex-wrap gap-2">
            {ENTITY_SCALE_OPTIONS.map((opt) => (
              <Chip key={opt} active={form.entityScale === opt} onClick={() => setForm((f) => ({ ...f, entityScale: opt }))}>
                {opt}
              </Chip>
            ))}
          </div>
        </Field>
      </Section>

      {/* ── Section: LinkedIn & signals ── */}
      <Section title="LinkedIn & signal collection">
        <p className="text-[14px] leading-[21px] text-zinc-300">
          Signals are the core of the methodology — engagement events that indicate buying intent. Most signals come from LinkedIn activity.
        </p>

        <div className="space-y-3">
          <Toggle
            label="We're targeting B2B professionals on LinkedIn"
            description="LinkedIn will be the primary source of engagement signals"
            value={form.targetingB2BProfessionals}
            onChange={(v) => setForm((f) => ({ ...f, targetingB2BProfessionals: v }))}
          />
          <Toggle
            label="We're building a personal or company brand on LinkedIn"
            description="We post content and want to track which posts generate signals"
            value={form.linkedinBrandBuilding}
            onChange={(v) => setForm((f) => ({ ...f, linkedinBrandBuilding: v }))}
          />
        </div>

        <Field label="LinkedIn & signal collection tools" hint="Select all that apply">
          <div className="flex flex-wrap gap-2">
            {SIGNAL_TOOLS.map((tool) => (
              <Chip key={tool} active={form.signalToolsSelected.includes(tool)}
                onClick={() => toggleArr("signalToolsSelected", tool)}>{tool}</Chip>
            ))}
          </div>
        </Field>

        <Field label="Enrichment tools" hint="Used to turn LinkedIn profiles into full contact records">
          <div className="flex flex-wrap gap-2">
            {ENRICHMENT_TOOLS.map((tool) => (
              <Chip key={tool} active={form.enrichmentToolsSelected.includes(tool)}
                onClick={() => toggleArr("enrichmentToolsSelected", tool)}>{tool}</Chip>
            ))}
          </div>
        </Field>
      </Section>

      {/* ── Section: Channels & integrations ── */}
      <Section title="Marketing channels & integrations">
        <Field label="Which channels are you actively using or planning to use?">
          <div className="flex flex-wrap gap-2">
            {MARKETING_CHANNELS.map((ch) => (
              <Chip key={ch} active={form.marketingChannelsSelected.includes(ch)}
                onClick={() => toggleArr("marketingChannelsSelected", ch)}>{ch}</Chip>
            ))}
          </div>
        </Field>

        <div className="space-y-3">
          <Toggle
            label="We use Fireflies (or similar) for call transcripts"
            description="We can import transcripts to automatically build a repository of customer pain points"
            value={form.hasFirefliesTranscripts}
            onChange={(v) => setForm((f) => ({ ...f, hasFirefliesTranscripts: v }))}
          />
        </div>

        <Field label="Any other tools?" hint="Comma-separated">
          <input type="text" placeholder="e.g. Notion, Slack, Google Ads" value={form.toolsCustom}
            onChange={(e) => setForm((f) => ({ ...f, toolsCustom: e.target.value }))} className={input} />
        </Field>
      </Section>

      {/* ── Section: Anything else ── */}
      <Section title="Anything else?">
        <Field label="Additional context" hint="Optional">
          <textarea rows={2} placeholder="e.g. We're pre-launch, raising a Series A, UK market only, sell into enterprise comms teams…"
            value={form.additionalContext} onChange={(e) => setForm((f) => ({ ...f, additionalContext: e.target.value }))}
            className={textarea} />
        </Field>
      </Section>

      {error && <p className="text-[13px] text-rose-400">{error}</p>}

      <div className="flex items-center justify-between border-t border-white/10 pt-6">
        <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">Step 2 of 4</p>
        <button onClick={handleSubmit} disabled={!isValid || saving}
          className="rounded-lg bg-[#2BA98B] px-5 py-2.5 text-[14px] font-bold text-white transition-colors hover:bg-[#239977] disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none">
          {saving ? "Saving…" : "Generate my blueprint →"}
        </button>
      </div>
    </div>
  )
}

// ─── Shared style tokens ──────────────────────────────────────────────────────

const textarea = "w-full rounded-lg border border-white/14 bg-white/[0.04] px-4 py-3 text-[14px] text-white placeholder-zinc-500 focus:border-[#2BA98B] focus:outline-none focus:ring-1 focus:ring-[#2BA98B]/40"
const input = "w-full rounded-lg border border-white/14 bg-white/[0.04] px-4 py-2.5 text-[14px] text-white placeholder-zinc-500 focus:border-[#2BA98B] focus:outline-none focus:ring-1 focus:ring-[#2BA98B]/40"

// ─── Components ───────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-5">
      <h2 className="text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B] border-b border-white/[0.08] pb-2">{title}</h2>
      {children}
    </div>
  )
}

function Field({ label, hint, required, children }: {
  label: string; hint?: string; required?: boolean; children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <label className="flex items-baseline gap-2 text-[14px] font-medium text-white">
        <span>{label}</span>
        {required && <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-[#2BA98B]">Required</span>}
        {hint && <span className="text-[12px] font-normal text-zinc-400">{hint}</span>}
      </label>
      {children}
    </div>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`rounded-full border px-3.5 py-1.5 text-[13px] transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60 ${
        active ? "border-[#2BA98B] bg-[#2BA98B]/[0.16] font-semibold text-white" : "border-white/14 text-zinc-300 hover:border-white/30"
      }`}>
      {children}
    </button>
  )
}

function Toggle({ label, description, value, onChange }: {
  label: string; description: string; value: boolean; onChange: (v: boolean) => void
}) {
  return (
    <button onClick={() => onChange(!value)}
      className={`flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60 ${
        value ? "border-[#2BA98B] bg-[#2BA98B]/[0.10]" : "border-white/12 bg-white/[0.03] hover:border-white/24"
      }`}>
      <span className={`mt-0.5 h-4 w-4 shrink-0 rounded border-2 flex items-center justify-center ${
        value ? "border-[#2BA98B] bg-[#2BA98B]" : "border-white/30"
      }`}>
        {value && <span className="text-white text-[10px] leading-none">✓</span>}
      </span>
      <span>
        <span className="block text-[14px] font-semibold text-white">{label}</span>
        <span className="text-[12px] text-zinc-400">{description}</span>
      </span>
    </button>
  )
}
