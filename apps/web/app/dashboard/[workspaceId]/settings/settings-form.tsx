"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import type { SettingsInitialState, ResendSenderState } from "./page"

interface Props {
  workspaceId: string
  initial: SettingsInitialState
}

function parseList(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

function formatList(arr: string[]): string {
  return arr.join(", ")
}

export function SettingsForm({ workspaceId, initial }: Props) {
  const router = useRouter()

  // Token inputs: empty string means "no change". User pastes to overwrite.
  const [surfeKey, setSurfeKey] = useState("")
  const [apolloKey, setApolloKey] = useState("")
  const [mozApiKey, setMozApiKey] = useState("")
  const [apifyToken, setApifyToken] = useState("")
  const [apifyActorId, setApifyActorId] = useState(initial.apifyActorId)
  const [apifyMaxEmployees, setApifyMaxEmployees] = useState<string>(
    initial.apifyMaxEmployees != null ? String(initial.apifyMaxEmployees) : "",
  )
  const [apifyInterestsActorId, setApifyInterestsActorId] = useState(initial.apifyInterestsActorId)
  const [apifyXInterestsMaxResults, setApifyXInterestsMaxResults] = useState<string>(
    initial.apifyXInterestsMaxResults != null ? String(initial.apifyXInterestsMaxResults) : "",
  )

  // Unipile creds — apiKey is secret (TokenField), DSN + accountId are opaque
  // identifiers safe to display back, so we use plain fields.
  const [unipileApiKey, setUnipileApiKey]         = useState("")
  const [unipileDsn, setUnipileDsn]               = useState(initial.unipileDsn)
  const [unipileAccountId, setUnipileAccountId]   = useState(initial.unipileAccountId)

  // Resend — API key masked, senders and adminEmail are safe to load and display.
  const [resendKey, setResendKey]           = useState("")
  const [resendSenders, setResendSenders]   = useState<ResendSenderState[]>(initial.resendSenders)
  const [adminEmail, setAdminEmail]         = useState(initial.adminEmail)

  const [saving, setSaving] = useState(false)
  const [saved, setSaved]   = useState(false)
  const [error, setError]   = useState<string | null>(null)

  async function handleSave() {
    setSaving(true)
    setSaved(false)
    setError(null)

    const enrichment: Record<string, unknown> = {}
    if (surfeKey.trim())   enrichment.surfe = { apiKey: surfeKey.trim() }
    if (apolloKey.trim())  enrichment.apollo = { apiKey: apolloKey.trim() }
    if (mozApiKey.trim())  enrichment.moz   = { apiKey: mozApiKey.trim() }

    // Apify is the only provider with non-token sub-fields, so we re-send
    // actorId / maxEmployees alongside the token (if the user changed them)
    // even when the token itself is unchanged.
    const apifyChanged =
      apifyToken.trim() !== "" ||
      apifyActorId !== initial.apifyActorId ||
      apifyInterestsActorId !== initial.apifyInterestsActorId ||
      String(apifyMaxEmployees) !== (initial.apifyMaxEmployees != null ? String(initial.apifyMaxEmployees) : "") ||
      String(apifyXInterestsMaxResults) !== (initial.apifyXInterestsMaxResults != null ? String(initial.apifyXInterestsMaxResults) : "")

    if (apifyChanged) {
      const apify: Record<string, unknown> = {}
      if (apifyToken.trim()) apify.apiToken = apifyToken.trim()
      if (apifyActorId.trim()) apify.actorId = apifyActorId.trim()
      if (apifyInterestsActorId.trim()) apify.interestsActorId = apifyInterestsActorId.trim()
      const max = parseInt(apifyMaxEmployees, 10)
      if (!Number.isNaN(max) && max > 0) apify.maxEmployees = max
      const xMax = parseInt(apifyXInterestsMaxResults, 10)
      if (!Number.isNaN(xMax) && xMax > 0) apify.xInterestsMaxResults = xMax
      // If the user is updating actorId/maxEmployees but hasn't pasted a new
      // token, we need the existing token to survive the merge. The PATCH
      // endpoint deep-merges enrichment.apify, so omitting apiToken here
      // preserves it. Only include the keys the user actually set.
      enrichment.apify = apify
    }

    // Unipile — same partial-update pattern. The PATCH endpoint deep-merges
    // messaging.unipile, so we only send the fields the user actually edited;
    // un-touched fields stay as-is in Redis.
    const messaging: Record<string, unknown> = {}
    const unipileChanged =
      unipileApiKey.trim() !== "" ||
      unipileDsn !== initial.unipileDsn ||
      unipileAccountId !== initial.unipileAccountId
    if (unipileChanged) {
      const unipile: Record<string, unknown> = {}
      if (unipileApiKey.trim())     unipile.apiKey    = unipileApiKey.trim()
      if (unipileDsn.trim())        unipile.dsn       = unipileDsn.trim()
      if (unipileAccountId.trim())  unipile.accountId = unipileAccountId.trim()
      messaging.unipile = unipile
    }

    const resendChanged =
      resendKey.trim() !== "" ||
      JSON.stringify(resendSenders) !== JSON.stringify(initial.resendSenders)
    const resendBody: Record<string, unknown> = {}
    if (resendChanged) {
      if (resendKey.trim()) resendBody.apiKey = resendKey.trim()
      resendBody.senders = resendSenders
        .filter(s => s.email.trim())
        .map(s => ({ email: s.email.trim(), name: s.name.trim() || undefined, role: s.role }))
    }

    const body: Record<string, unknown> = {}
    if (Object.keys(enrichment).length > 0)  body.enrichment = enrichment
    if (Object.keys(messaging).length  > 0)  body.messaging  = messaging
    if (Object.keys(resendBody).length > 0)  body.resend     = resendBody
    if (adminEmail.trim() !== initial.adminEmail) body.adminEmail = adminEmail.trim() || null

    try {
      const res = await fetch(`/api/workspace/${workspaceId}/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: res.statusText }))
        setError(errBody.error ?? `HTTP ${res.status}`)
        return
      }
      setSaved(true)
      // Clear token inputs so the masked-state display is consistent.
      setSurfeKey("")
      setApolloKey("")
      setMozApiKey("")
      setApifyToken("")
      setUnipileApiKey("")
      setResendKey("")
      // Refresh the server component so the "configured" badges update.
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-10">
      {/* Enrichment tokens */}
      <Section
        title="Enrichment tokens"
        hint="Encrypted at rest. Paste a new value to overwrite, leave blank to keep the existing one."
      >
        <TokenField
          label="Surfe API key"
          configured={initial.configured.surfe}
          value={surfeKey}
          onChange={setSurfeKey}
          placeholder="Paste Surfe API key"
          setupLink={{ href: "https://app.surfe.com/settings/integrations", label: "Get Surfe API key" }}
        />
        <TokenField
          label="Apollo.io API key"
          configured={initial.configured.apollo}
          value={apolloKey}
          onChange={setApolloKey}
          placeholder="Paste Apollo API key"
        />

        <TokenField
          label="Moz API key"
          configured={initial.configured.moz}
          value={mozApiKey}
          onChange={setMozApiKey}
          placeholder="Paste Moz API key"
          hint="Powers the Fetch DA action on the Companies tab (domain authority, backlinks, referring domains)."
        />

        <TokenField
          label="Apify API token"
          configured={initial.configured.apify}
          value={apifyToken}
          onChange={setApifyToken}
          placeholder="apify_api_..."
          hint="Powers the Fetch employees action on the Companies tab."
          setupLink={{ href: "https://console.apify.com/account/integrations", label: "Get Apify token" }}
        />

        {/* Apify advanced */}
        <details className="rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3">
          <summary className="cursor-pointer text-[12px] font-medium text-zinc-300 hover:text-white">
            Apify advanced settings
          </summary>
          <div className="mt-4 space-y-4">
            <PlainField
              label="Company employees actor ID"
              value={apifyActorId}
              onChange={setApifyActorId}
              placeholder="apimaestro~linkedin-company-employees-scraper-no-cookies"
              hint="Override the default LinkedIn employee scraper. Leave blank to use the default."
            />
            <PlainField
              label="Profile interests actor ID (LinkedIn)"
              value={apifyInterestsActorId}
              onChange={setApifyInterestsActorId}
              placeholder="(no default — pick an actor that scrapes LinkedIn following)"
              hint="Used by the Fetch interests action on each contact. No default — apimaestro doesn't publish a working profile-following scraper, so configure your own."
            />
            <PlainField
              label="Max employees per fetch"
              value={apifyMaxEmployees}
              onChange={setApifyMaxEmployees}
              placeholder="30"
              hint="Caps the per-call cost. Defaults to 30."
              inputMode="numeric"
            />
            <PlainField
              label="Max X interests per fetch"
              value={apifyXInterestsMaxResults}
              onChange={setApifyXInterestsMaxResults}
              placeholder="1000"
              hint="Caps how many followed accounts apidojo's X scraper returns per contact. Defaults to 1000."
              inputMode="numeric"
            />
          </div>
        </details>
      </Section>

      {/* Messaging providers — channel credentials only. The substance of
          outreach (context, principles, templates) lives under Outreach Settings. */}
      <Section
        title="Messaging providers"
        hint="Channel credentials for the LLM-drafted messages. Outreach context, pacing principles, and templates live under Outreach Settings."
      >
        <TokenField
          label="Unipile API key"
          configured={initial.configured.unipile}
          value={unipileApiKey}
          onChange={setUnipileApiKey}
          placeholder="Paste Unipile API key"
          setupLink={{ href: "https://app.unipile.com", label: "Open Unipile dashboard" }}
        />
        <PlainField
          label="DSN (per-tenant base URL)"
          value={unipileDsn}
          onChange={setUnipileDsn}
          placeholder="https://api6.unipile.com:13670"
          hint="Find this in your Unipile dashboard — it's unique to your tenant."
        />
        <PlainField
          label="LinkedIn account ID"
          value={unipileAccountId}
          onChange={setUnipileAccountId}
          placeholder="The connected LinkedIn account inside Unipile"
        />
        <LinkedinConnectionsSyncButton workspaceId={workspaceId} configured={initial.configured.unipile} />
      </Section>

      {/* Resend — workspace notification emails */}
      <Section
        title="Notification emails"
        hint="Resend credentials for workspace notification emails. Add one address per use case — the system picks the right sender automatically."
      >
        <TokenField
          label="Resend API key"
          configured={initial.configured.resend}
          value={resendKey}
          onChange={setResendKey}
          placeholder="re_..."
          setupLink={{ href: "https://resend.com/api-keys", label: "Get Resend API key" }}
        />

        <PlainField
          label="Your notification email"
          value={adminEmail}
          onChange={setAdminEmail}
          placeholder="you@example.com"
          hint="Where you receive workspace notifications. Leave blank to disable inbound notifications."
          inputMode="text"
        />

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-[13px] font-medium text-white">From addresses</label>
            <button
              type="button"
              onClick={() => setResendSenders(s => [...s, { email: "", name: "", role: "default" }])}
              className="text-[12px] font-medium text-[#2BA98B] hover:text-[#239977]"
            >
              + Add address
            </button>
          </div>

          {resendSenders.length === 0 && (
            <p className="text-[12px] text-zinc-500">No senders configured. Falls back to the RESEND_FROM_EMAIL environment variable.</p>
          )}

          {resendSenders.map((sender, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto_auto] gap-2 items-start">
              <input
                type="email"
                value={sender.email}
                onChange={e => setResendSenders(s => s.map((x, j) => j === i ? { ...x, email: e.target.value } : x))}
                placeholder="deals@example.com"
                className="rounded-lg border border-white/14 bg-white/[0.04] px-3 py-2 text-[13px] text-white placeholder-zinc-500 focus:border-[#2BA98B] focus:outline-none focus:ring-1 focus:ring-[#2BA98B]/40"
              />
              <input
                type="text"
                value={sender.name}
                onChange={e => setResendSenders(s => s.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                placeholder="Display name (optional)"
                className="rounded-lg border border-white/14 bg-white/[0.04] px-3 py-2 text-[13px] text-white placeholder-zinc-500 focus:border-[#2BA98B] focus:outline-none focus:ring-1 focus:ring-[#2BA98B]/40"
              />
              <select
                value={sender.role}
                onChange={e => setResendSenders(s => s.map((x, j) => j === i ? { ...x, role: e.target.value as ResendSenderState["role"] } : x))}
                className="rounded-lg border border-white/14 bg-[#0D1F1E] px-3 py-2 text-[13px] text-white focus:border-[#2BA98B] focus:outline-none focus:ring-1 focus:ring-[#2BA98B]/40"
              >
                <option value="default">Default</option>
              </select>
              <button
                type="button"
                onClick={() => setResendSenders(s => s.filter((_, j) => j !== i))}
                className="mt-0.5 text-zinc-500 hover:text-rose-400 text-[18px] leading-none px-1"
                aria-label="Remove sender"
              >
                ×
              </button>
            </div>
          ))}

          {resendSenders.length > 0 && (
            <p className="text-[12px] text-zinc-500">
              Each address must be verified in your Resend account.
            </p>
          )}
        </div>
      </Section>

      {/* Save bar */}
      <div className="sticky bottom-4 flex items-center justify-between gap-3 rounded-2xl border border-[#2BA98B]/30 bg-[#2BA98B]/[0.08] px-5 py-4 backdrop-blur">
        <div className="text-[13px]">
          {error && <span className="text-rose-400">{error}</span>}
          {saved && !error && <span className="text-emerald-400">Saved.</span>}
          {!saved && !error && <span className="text-zinc-300">Changes are saved per workspace.</span>}
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-lg bg-[#2BA98B] px-5 py-2 text-[13px] font-bold text-white transition-colors hover:bg-[#239977] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
        >
          {saving ? "Saving..." : "Save changes"}
        </button>
      </div>
    </div>
  )
}

function Section({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-5 rounded-2xl border border-white/10 bg-white/[0.03] p-6">
      <div className="border-b border-white/[0.08] pb-3">
        <h2 className="text-[16px] font-bold text-white">{title}</h2>
        {hint && <p className="mt-1 text-[13px] leading-[19px] text-zinc-400">{hint}</p>}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  )
}

function TokenField({
  label,
  configured,
  value,
  onChange,
  placeholder,
  hint,
  setupLink,
}: {
  label: string
  configured: boolean
  value: string
  onChange: (v: string) => void
  placeholder: string
  hint?: string
  setupLink?: { href: string; label: string }
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-[13px] font-medium text-white">{label}</label>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.06em] ${
            configured
              ? "bg-emerald-500/16 text-emerald-300"
              : "bg-white/[0.06] text-zinc-400"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${configured ? "bg-emerald-400" : "bg-zinc-500"}`} />
          {configured ? "Configured" : "Not set"}
        </span>
      </div>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={configured ? "•••••••••••• (paste to replace)" : placeholder}
        className="w-full rounded-lg border border-white/14 bg-white/[0.04] px-3.5 py-2.5 text-[14px] text-white placeholder-zinc-500 focus:border-[#2BA98B] focus:outline-none focus:ring-1 focus:ring-[#2BA98B]/40 font-mono"
      />
      {hint && <p className="text-[12px] text-zinc-400">{hint}</p>}
      {setupLink && (
        <a
          href={setupLink.href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block text-[12px] text-[#2BA98B] hover:underline"
        >
          {setupLink.label} ↗
        </a>
      )}
    </div>
  )
}

function PlainField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  inputMode,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  hint?: string
  inputMode?: "numeric" | "text"
}) {
  return (
    <div className="space-y-2">
      <label className="text-[13px] font-medium text-white">{label}</label>
      <input
        type="text"
        inputMode={inputMode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-white/14 bg-white/[0.04] px-3.5 py-2.5 text-[14px] text-white placeholder-zinc-500 focus:border-[#2BA98B] focus:outline-none focus:ring-1 focus:ring-[#2BA98B]/40"
      />
      {hint && <p className="text-[12px] text-zinc-400">{hint}</p>}
    </div>
  )
}

function TextareaField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  rows = 4,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  hint?: string
  rows?: number
}) {
  return (
    <div className="space-y-2">
      <label className="text-[13px] font-medium text-white">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="w-full resize-none rounded-lg border border-white/14 bg-white/[0.04] px-3.5 py-2.5 text-[14px] text-white placeholder-zinc-500 focus:border-[#2BA98B] focus:outline-none focus:ring-1 focus:ring-[#2BA98B]/40"
      />
      {hint && <p className="text-[12px] text-zinc-400">{hint}</p>}
    </div>
  )
}

function LinkedinConnectionsSyncButton({
  workspaceId,
  configured,
}: {
  workspaceId: string
  configured:  boolean
}) {
  const [busy, setBusy]       = useState(false)
  const [result, setResult]   = useState<{
    slugs: number; flipped: number; stamped: number; dryRun: boolean;
    sampleSlugs?: string[]; sampleRelations?: unknown[];
  } | null>(null)
  const [error, setError]     = useState<string | null>(null)

  async function run(opts: { dryRun: boolean; pages?: number } = { dryRun: false }) {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const q = new URLSearchParams()
      if (opts.dryRun) q.set("dryRun", "1")
      if (opts.pages) q.set("pages", String(opts.pages))
      const res = await fetch(`/api/dashboard/${workspaceId}/linkedin-connections-sync${q.toString() ? `?${q}` : ""}`, { method: "POST" })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); return }
      setResult({
        slugs:           data.slugsFetched ?? 0,
        flipped:         data.rowsFlipped ?? 0,
        stamped:         data.rowsStampedMemberId ?? 0,
        dryRun:          !!data.dryRun,
        sampleSlugs:     data.sampleSlugs,
        sampleRelations: data.sampleRelations,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-white">Sync 1st-degree connections from LinkedIn</p>
          <p className="mt-0.5 text-[12px] text-zinc-400">
            Pulls every 1st-degree connection from Unipile and flips matching contacts to connected. Existing FALSE overrides are preserved.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => run({ dryRun: true, pages: 1 })}
            disabled={busy || !configured}
            title="Fetch 1 page and dump the raw shape, no DB writes"
            className="rounded-lg border border-white/[0.10] px-2.5 py-1.5 text-[12px] text-zinc-300 transition-colors hover:border-white/[0.18] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "..." : "Test (1 page)"}
          </button>
          <button
            type="button"
            onClick={() => run({ dryRun: false })}
            disabled={busy || !configured}
            title={!configured ? "Configure Unipile first" : "Run a one-off sync"}
            className="rounded-lg bg-[#2BA98B] px-3 py-1.5 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Syncing…" : "Run sync"}
          </button>
        </div>
      </div>
      {result && (
        <div className="mt-2 space-y-1.5">
          <p className="text-[12px] text-[#6EE7B7]">
            {result.dryRun
              ? `Dry run: fetched ${result.slugs} slug${result.slugs === 1 ? "" : "s"}, no DB writes.`
              : `Fetched ${result.slugs} LinkedIn connections; flipped ${result.flipped} contact${result.flipped === 1 ? "" : "s"} to connected; stamped ${result.stamped} member_id${result.stamped === 1 ? "" : "s"}.`}
          </p>
          {result.sampleSlugs && result.sampleSlugs.length > 0 && (
            <p className="font-mono text-[11px] text-zinc-400">
              Sample slugs: {result.sampleSlugs.slice(0, 10).join(", ")}
            </p>
          )}
          {result.sampleRelations && result.sampleRelations.length > 0 && (
            <details>
              <summary className="cursor-pointer text-[11px] text-zinc-500 hover:text-zinc-300">Raw sample relations (first {result.sampleRelations.length})</summary>
              <pre className="mt-1.5 max-h-72 overflow-auto rounded border border-white/[0.06] bg-black/30 p-2 font-mono text-[10px] text-zinc-300">
{JSON.stringify(result.sampleRelations, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-[12px] text-rose-400">{error}</p>}
    </div>
  )
}

