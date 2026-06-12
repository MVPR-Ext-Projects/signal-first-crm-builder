"use client"

/**
 * ChannelSettingsDrawer - per-channel configuration. Mounted inside
 * RightDrawer.
 *
 * Strict scope: settings only.
 *   - Channel basics: name, delivery mechanism, has-fingerprint, archive
 *   - Delivery API: which service this channel sends through + its
 *     API key (shared across all channels of the same delivery mechanism)
 *   - Writing-style fingerprint: the workspace's scope='channel'
 *     fingerprint for this channel's StyleChannel mapping
 *
 * Does NOT contain: Companies/People/Signals tree, senders list, coverage
 * list. Those live in the channel card's expand-on-click area + dedicated
 * settings sub-pages.
 */

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import type { ChannelRow, DeliveryMechanism } from "@/lib/db/channels"

const DELIVERY_LABELS: Record<DeliveryMechanism, string> = {
  none:         "No delivery",
  unipile:      "LinkedIn DM via Unipile",
  resend:       "Email via Resend",
  twilio_voice: "Voice calls via Twilio (coming soon)",
}

interface FingerprintSnap {
  id:        number
  version:   number
  createdAt: string
  samplePos: number
}

interface UnipileCreds {
  apiKey:    string
  dsn:       string
  accountId: string
}

interface ResendStatus {
  hasApiKey: boolean
}

export function ChannelSettingsDrawer({
  workspaceId,
  channel,
  onArchived,
}: {
  workspaceId: string
  channel:     ChannelRow
  onArchived:  () => void
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()

  // ── Basics ────────────────────────────────────────────────────────────────
  const [name, setName] = useState(channel.name)
  const [delivery, setDelivery] = useState<DeliveryMechanism>(channel.deliveryMechanism)
  const [hasFingerprint, setHasFingerprint] = useState(channel.hasFingerprint)
  const [basicsBusy, setBasicsBusy] = useState(false)
  const [basicsError, setBasicsError] = useState<string | null>(null)
  const [basicsSaved, setBasicsSaved] = useState(false)

  async function saveBasics() {
    setBasicsBusy(true)
    setBasicsError(null)
    setBasicsSaved(false)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/channels/${channel.id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          name:              name.trim(),
          deliveryMechanism: delivery,
          hasFingerprint,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setBasicsError(data.error ?? `HTTP ${res.status}`); return }
      setBasicsSaved(true)
      startTransition(() => router.refresh())
    } catch (e) {
      setBasicsError(e instanceof Error ? e.message : String(e))
    } finally {
      setBasicsBusy(false)
    }
  }

  async function archive() {
    if (!confirm(`Archive "${channel.name}"? Campaigns under this channel + their data remain attributable.`)) return
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/channels/${channel.id}`, { method: "DELETE" })
      if (res.ok) onArchived()
    } catch (e) {
      setBasicsError(e instanceof Error ? e.message : String(e))
    }
  }

  // ── Unipile creds ─────────────────────────────────────────────────────────
  const [unipile, setUnipile] = useState<UnipileCreds | null>(null)
  const [unipileApiKeyDraft, setUnipileApiKeyDraft] = useState("")
  const [unipileDsnDraft, setUnipileDsnDraft] = useState("")
  const [unipileAccountDraft, setUnipileAccountDraft] = useState("")
  const [unipileSaved, setUnipileSaved] = useState(false)
  const [unipileError, setUnipileError] = useState<string | null>(null)
  const [unipileBusy, setUnipileBusy] = useState(false)

  // ── Resend creds ──────────────────────────────────────────────────────────
  const [resend, setResend] = useState<ResendStatus | null>(null)
  const [resendKeyDraft, setResendKeyDraft] = useState("")
  const [resendSaved, setResendSaved] = useState(false)
  const [resendError, setResendError] = useState<string | null>(null)
  const [resendBusy, setResendBusy] = useState(false)

  useEffect(() => {
    if (delivery !== "unipile" && delivery !== "resend") return
    let cancelled = false
    async function load() {
      const res = await fetch(`/api/workspace/${workspaceId}/config`)
      if (!res.ok) return
      const data = await res.json().catch(() => ({})) as {
        messaging?: { unipile?: { apiKey?: string; dsn?: string; accountId?: string } }
        resend?:    { apiKey?: string }
      }
      if (cancelled) return
      if (delivery === "unipile") {
        const u = data.messaging?.unipile
        setUnipile({
          apiKey:    u?.apiKey    ?? "",
          dsn:       u?.dsn       ?? "",
          accountId: u?.accountId ?? "",
        })
        setUnipileDsnDraft(u?.dsn ?? "")
        setUnipileAccountDraft(u?.accountId ?? "")
      } else {
        setResend({ hasApiKey: Boolean(data.resend?.apiKey) })
      }
    }
    load()
    return () => { cancelled = true }
  }, [delivery, workspaceId])

  async function saveUnipile() {
    setUnipileBusy(true)
    setUnipileError(null)
    setUnipileSaved(false)
    try {
      const body: Record<string, string> = {}
      if (unipileApiKeyDraft.trim().length > 0) body.apiKey = unipileApiKeyDraft.trim()
      if (unipileDsnDraft !== (unipile?.dsn ?? "")) body.dsn = unipileDsnDraft.trim()
      if (unipileAccountDraft !== (unipile?.accountId ?? "")) body.accountId = unipileAccountDraft.trim()
      if (Object.keys(body).length === 0) { setUnipileError("Nothing to save."); return }
      const res = await fetch(`/api/dashboard/${workspaceId}/settings/unipile-creds`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setUnipileError(data.error ?? `HTTP ${res.status}`); return }
      setUnipileSaved(true)
      setUnipileApiKeyDraft("")
      if (body.apiKey) setUnipile(prev => prev ? { ...prev, apiKey: "encrypted" } : prev)
    } catch (e) {
      setUnipileError(e instanceof Error ? e.message : String(e))
    } finally { setUnipileBusy(false) }
  }

  async function saveResend() {
    setResendBusy(true)
    setResendError(null)
    setResendSaved(false)
    try {
      if (!resendKeyDraft.trim()) { setResendError("API key is required."); return }
      const res = await fetch(`/api/dashboard/${workspaceId}/settings/resend-creds`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ apiKey: resendKeyDraft.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setResendError(data.error ?? `HTTP ${res.status}`); return }
      setResendSaved(true)
      setResendKeyDraft("")
      setResend({ hasApiKey: true })
    } catch (e) {
      setResendError(e instanceof Error ? e.message : String(e))
    } finally { setResendBusy(false) }
  }

  // ── Fingerprint ───────────────────────────────────────────────────────────
  const supportsFingerprint = delivery === "unipile" || delivery === "resend"
  const [fp, setFp] = useState<FingerprintSnap | null>(null)
  const [fpSamples, setFpSamples] = useState("")
  const [fpBusy, setFpBusy] = useState(false)
  const [fpError, setFpError] = useState<string | null>(null)
  const [fpStyleChannel, setFpStyleChannel] = useState<string | null>(null)

  useEffect(() => {
    if (!supportsFingerprint) return
    let cancelled = false
    async function load() {
      const res = await fetch(`/api/dashboard/${workspaceId}/channels/${channel.id}/fingerprint`)
      if (!res.ok) return
      const data = await res.json().catch(() => ({})) as {
        fingerprint: FingerprintSnap | null
        styleChannel: string | null
      }
      if (cancelled) return
      setFp(data.fingerprint ?? null)
      setFpStyleChannel(data.styleChannel)
    }
    load()
    return () => { cancelled = true }
  }, [supportsFingerprint, workspaceId, channel.id])

  async function generateFp() {
    const trimmed = fpSamples.trim()
    if (!trimmed) { setFpError("Paste at least one sample."); return }
    setFpError(null)
    setFpBusy(true)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/channels/${channel.id}/fingerprint`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ samples: trimmed.split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean) }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setFpError(data.error ?? `HTTP ${res.status}`); return }
      setFp({ id: data.id, version: data.version, createdAt: new Date().toISOString(), samplePos: trimmed.split(/\n\s*\n+/).filter(Boolean).length })
      setFpSamples("")
    } catch (e) {
      setFpError(e instanceof Error ? e.message : String(e))
    } finally { setFpBusy(false) }
  }

  async function clearFp() {
    if (!confirm("Clear this channel's fingerprint? Drafts fall back to corporate voice.")) return
    try {
      await fetch(`/api/dashboard/${workspaceId}/channels/${channel.id}/fingerprint`, { method: "DELETE" })
      setFp(null)
    } catch (e) {
      setFpError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="space-y-7">
      <header>
        <h2 className="text-[20px] font-bold text-white">{channel.name}</h2>
        <p className="mt-1 text-[13px] text-zinc-400">{DELIVERY_LABELS[channel.deliveryMechanism]}</p>
      </header>

      {/* Basics */}
      <section className="space-y-3">
        <h3 className="text-[13px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Channel basics</h3>

        <div className="space-y-1.5">
          <label className="block text-[11px] text-zinc-400" htmlFor={`ch-name-${channel.id}`}>Name</label>
          <input
            id={`ch-name-${channel.id}`}
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-[13px] text-zinc-100 focus:border-white/24 focus:outline-none"
          />
        </div>

        <div className="space-y-1.5">
          <label className="block text-[11px] text-zinc-400" htmlFor={`ch-delivery-${channel.id}`}>Delivery mechanism</label>
          <select
            id={`ch-delivery-${channel.id}`}
            value={delivery}
            onChange={e => setDelivery(e.target.value as DeliveryMechanism)}
            className="w-full rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-[13px] text-zinc-100 focus:border-white/24 focus:outline-none"
          >
            {(Object.keys(DELIVERY_LABELS) as DeliveryMechanism[]).map(d => (
              <option key={d} value={d}>{DELIVERY_LABELS[d]}</option>
            ))}
          </select>
        </div>

        <label className="flex items-center gap-2 text-[12px] text-zinc-200">
          <input
            type="checkbox"
            checked={hasFingerprint}
            onChange={e => setHasFingerprint(e.target.checked)}
            disabled={!supportsFingerprint}
          />
          Enable writing-style fingerprint
          {!supportsFingerprint && <span className="text-zinc-500">(written channels only)</span>}
        </label>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={saveBasics}
            disabled={basicsBusy}
            className="rounded-xl bg-[#2BA98B] px-4 py-2 text-[12px] font-semibold text-white hover:bg-[#249A7E] disabled:opacity-50"
          >{basicsBusy ? "Saving..." : "Save"}</button>
          {basicsSaved && <span className="text-[12px] text-emerald-300">Saved.</span>}
          {basicsError && <span className="text-[12px] text-red-400">{basicsError}</span>}
        </div>
      </section>

      {/* Delivery API */}
      {delivery === "unipile" && (
        <section className="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <div>
            <h3 className="text-[13px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Delivery API</h3>
            <p className="mt-1 text-[12px] text-zinc-400">
              Sends LinkedIn DMs via Unipile. Shared across every Unipile-delivery channel.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="block text-[11px] text-zinc-400" htmlFor={`up-key-${channel.id}`}>
              API key {unipile?.apiKey && <span className="text-zinc-500">(saved - paste a new value to rotate)</span>}
            </label>
            <input
              id={`up-key-${channel.id}`}
              type="password"
              value={unipileApiKeyDraft}
              onChange={e => setUnipileApiKeyDraft(e.target.value)}
              placeholder={unipile?.apiKey ? "••••••••••••••••" : "Paste your Unipile API key"}
              className="w-full rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-[13px] font-mono text-zinc-100 placeholder:text-zinc-500 focus:border-white/24 focus:outline-none"
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-[11px] text-zinc-400" htmlFor={`up-dsn-${channel.id}`}>DSN</label>
            <input
              id={`up-dsn-${channel.id}`}
              type="text"
              value={unipileDsnDraft}
              onChange={e => setUnipileDsnDraft(e.target.value)}
              placeholder="https://api6.unipile.com:13670"
              className="w-full rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-[13px] font-mono text-zinc-100 placeholder:text-zinc-500 focus:border-white/24 focus:outline-none"
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-[11px] text-zinc-400" htmlFor={`up-acct-${channel.id}`}>Connected account ID</label>
            <input
              id={`up-acct-${channel.id}`}
              type="text"
              value={unipileAccountDraft}
              onChange={e => setUnipileAccountDraft(e.target.value)}
              className="w-full rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-[13px] font-mono text-zinc-100 focus:border-white/24 focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={saveUnipile}
              disabled={unipileBusy}
              className="rounded-xl bg-[#2BA98B] px-4 py-2 text-[12px] font-semibold text-white hover:bg-[#249A7E] disabled:opacity-50"
            >{unipileBusy ? "Saving..." : "Save Unipile credentials"}</button>
            {unipileSaved && <span className="text-[12px] text-emerald-300">Saved.</span>}
            {unipileError && <span className="text-[12px] text-red-400">{unipileError}</span>}
          </div>
        </section>
      )}

      {delivery === "resend" && (
        <section className="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <div>
            <h3 className="text-[13px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Delivery API</h3>
            <p className="mt-1 text-[12px] text-zinc-400">
              Sends email via Resend. Shared across every Resend-delivery channel.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="block text-[11px] text-zinc-400" htmlFor={`rs-key-${channel.id}`}>
              API key {resend?.hasApiKey && <span className="text-zinc-500">(saved - paste a new value to rotate)</span>}
            </label>
            <input
              id={`rs-key-${channel.id}`}
              type="password"
              value={resendKeyDraft}
              onChange={e => setResendKeyDraft(e.target.value)}
              placeholder={resend?.hasApiKey ? "••••••••••••••••" : "Paste your Resend API key"}
              className="w-full rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-[13px] font-mono text-zinc-100 placeholder:text-zinc-500 focus:border-white/24 focus:outline-none"
            />
          </div>

          <p className="text-[12px] text-zinc-400">
            Sender management (verified from-addresses) lives on the{" "}
            <a className="text-white underline decoration-white/30 underline-offset-4 hover:decoration-white" href={`/dashboard/${workspaceId}/settings/access`}>
              Access & password settings page
            </a>{" "}- it's a workspace-wide list, not per-channel.
          </p>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={saveResend}
              disabled={resendBusy}
              className="rounded-xl bg-[#2BA98B] px-4 py-2 text-[12px] font-semibold text-white hover:bg-[#249A7E] disabled:opacity-50"
            >{resendBusy ? "Saving..." : "Save Resend API key"}</button>
            {resendSaved && <span className="text-[12px] text-emerald-300">Saved.</span>}
            {resendError && <span className="text-[12px] text-red-400">{resendError}</span>}
          </div>
        </section>
      )}

      {delivery === "twilio_voice" && (
        <section className="space-y-2 rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-4">
          <h3 className="text-[13px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Delivery API</h3>
          <p className="text-[12px] text-zinc-400">
            Voice calls via Twilio. Integration is on the roadmap - this delivery mechanism is reserved for the upcoming Twilio click-to-call work. No credentials to set yet.
          </p>
        </section>
      )}

      {channel.name === "PR coverage" && (
        <MvprSourceSection workspaceId={workspaceId} />
      )}

      {/* Fingerprint */}
      {supportsFingerprint && (
        <section className="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <div>
            <h3 className="text-[13px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Writing-style fingerprint</h3>
            <p className="mt-1 text-[12px] text-zinc-400">
              {fpStyleChannel === "linkedin_dm" ? "LinkedIn DM voice." : "Email voice."} Shared across every {delivery === "unipile" ? "Unipile" : "Resend"}-delivery channel; persona + campaign fingerprints layer on top at draft time.
            </p>
          </div>

          {fp ? (
            <dl className="grid grid-cols-3 gap-x-3 gap-y-1 text-[11px]">
              <dt className="text-zinc-500">Version</dt>
              <dd className="col-span-2 font-mono tabular-nums text-white">v{fp.version}</dd>
              <dt className="text-zinc-500">Generated</dt>
              <dd className="col-span-2 text-white">{new Date(fp.createdAt).toLocaleDateString()}</dd>
              <dt className="text-zinc-500">Samples</dt>
              <dd className="col-span-2 font-mono tabular-nums text-white">{fp.samplePos}</dd>
            </dl>
          ) : (
            <p className="text-[12px] text-zinc-400">No fingerprint yet. Drafts fall back to corporate voice.</p>
          )}

          <textarea
            value={fpSamples}
            onChange={e => setFpSamples(e.target.value)}
            placeholder="Paste 3+ samples (300+ words total). Blank line between samples."
            rows={7}
            className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-500 focus:border-white/24 focus:outline-none"
          />

          <div className="flex gap-2">
            <button
              type="button"
              onClick={generateFp}
              disabled={fpBusy}
              className="rounded-xl bg-[#2BA98B] px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-[#249A7E] disabled:opacity-50"
            >{fpBusy ? "Generating..." : fp ? "Replace" : "Generate"}</button>
            {fp && (
              <button
                type="button"
                onClick={clearFp}
                className="rounded-xl border border-white/10 px-3 py-1.5 text-[12px] font-semibold text-zinc-300 hover:border-red-500/30 hover:text-red-200"
              >Clear</button>
            )}
          </div>
          {fpError && <p className="text-[12px] text-red-400">{fpError}</p>}
        </section>
      )}

      {/* Archive - hidden for seeded "PR coverage" channel since it has no
          campaigns + would orphan coverage data. */}
      {channel.name !== "PR coverage" && (
      <section className="rounded-xl border border-dashed border-red-500/30 p-4">
        <h3 className="text-[12px] font-bold uppercase tracking-[0.10em] text-red-200">Danger zone</h3>
        <p className="mt-1 text-[12px] text-zinc-400">
          Archiving hides this channel + its campaign list from the Channels page. Historical sends remain attributable; nothing is deleted.
        </p>
        <button
          type="button"
          onClick={archive}
          className="mt-3 rounded-lg border border-red-500/30 px-3 py-1.5 text-[12px] font-semibold text-red-200 hover:bg-red-500/[0.06]"
        >Archive channel</button>
      </section>
      )}
    </div>
  )
}

/**
 * MvprSourceSection - the PR coverage channel's source-management surface.
 * Inlines the API key + baseUrl + Test + Sync controls so the user doesn't
 * have to bounce to /settings/pr. Lazy-loads state on mount.
 */
function MvprSourceSection({ workspaceId }: { workspaceId: string }) {
  const router = useRouter()
  const [state, setState] = useState<{
    hasApiKey:              boolean
    baseUrl:                string
    lastCoverageSyncAt:     string | null
    lastAnnouncementSyncAt: string | null
  } | null>(null)
  const [apiKey, setApiKey] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [busy, setBusy] = useState<"" | "save" | "test" | "sync">("")
  const [error, setError] = useState<string | null>(null)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [testMsg, setTestMsg] = useState<string | null>(null)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const res = await fetch(`/api/dashboard/${workspaceId}/settings/pr`)
      if (!res.ok || cancelled) return
      const data = await res.json().catch(() => null)
      if (!data || cancelled) return
      setState(data)
      setBaseUrl(data.baseUrl ?? "")
    }
    load()
    return () => { cancelled = true }
  }, [workspaceId])

  async function save() {
    setBusy("save")
    setError(null)
    setSavedMsg(null)
    try {
      const body: Record<string, string> = {}
      if (apiKey.trim().length > 0) body.apiKey = apiKey.trim()
      if (state && baseUrl.trim() !== state.baseUrl) body.baseUrl = baseUrl.trim()
      if (Object.keys(body).length === 0) { setError("Nothing to save."); return }
      const res = await fetch(`/api/dashboard/${workspaceId}/settings/pr`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); return }
      setSavedMsg("Saved.")
      if (body.apiKey) {
        setApiKey("")
        setState(prev => prev ? { ...prev, hasApiKey: true } : prev)
      }
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy("") }
  }

  async function test() {
    setBusy("test")
    setError(null)
    setTestMsg(null)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/settings/pr/test`, { method: "POST" })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        setTestMsg(`Connection failed: ${data.error ?? `HTTP ${res.status}`}`)
        return
      }
      setTestMsg(
        data.sample
          ? `Connected. Latest coverage: "${data.sample.title}" - ${data.sample.publication}.`
          : "Connected. No coverage rows yet.",
      )
    } catch (e) {
      setTestMsg(`Connection failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally { setBusy("") }
  }

  async function syncNow() {
    setBusy("sync")
    setError(null)
    setSyncMsg(null)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/settings/pr/sync`, { method: "POST" })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setSyncMsg(`Sync failed: ${data.error ?? `HTTP ${res.status}`}`); return }
      const errs = (data.errors?.length ?? 0) > 0 ? ` (${data.errors.length} non-fatal errors)` : ""
      setSyncMsg(`Synced ${data.coveragesIngested ?? 0} coverages + ${data.announcementsIngested ?? 0} announcements + ${data.threadsIngested ?? 0} threads + ${data.influencersUpserted ?? 0} influencers${errs}.`)
      router.refresh()
    } catch (e) {
      setSyncMsg(`Sync failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally { setBusy("") }
  }

  const keyPresent = state?.hasApiKey ?? false

  return (
    <section className="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div>
        <h3 className="text-[13px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">PR coverage source</h3>
        <p className="mt-1 text-[12px] text-zinc-400">
          PR-platform API credentials. The base URL is per-tenant - paste the full URL from your PR platform&apos;s API page.
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="block text-[11px] text-zinc-400" htmlFor="pr-platform-base-url">Base URL</label>
        <input
          id="pr-platform-base-url"
          type="text"
          value={baseUrl}
          onChange={e => setBaseUrl(e.target.value)}
          placeholder="https://<pr-platform-host>/api/v1/companies/<your-company-id>/"
          className="w-full rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-[13px] font-mono text-zinc-100 placeholder:text-zinc-500 focus:border-white/24 focus:outline-none"
        />
      </div>

      <div className="space-y-1.5">
        <label className="block text-[11px] text-zinc-400" htmlFor="pr-platform-api-key">
          API key {keyPresent && <span className="text-zinc-500">(saved - paste a new value to rotate)</span>}
        </label>
        <input
          id="pr-platform-api-key"
          type="password"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          placeholder={keyPresent ? "••••••••••••••••" : "Paste your PR-platform API key"}
          className="w-full rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-[13px] font-mono text-zinc-100 placeholder:text-zinc-500 focus:border-white/24 focus:outline-none"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy === "save"}
          className="rounded-xl bg-[#2BA98B] px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-[#249A7E] disabled:opacity-50"
        >{busy === "save" ? "Saving..." : "Save"}</button>
        <button
          type="button"
          onClick={test}
          disabled={busy === "test" || !keyPresent}
          className="rounded-xl border border-white/12 bg-white/[0.04] px-3 py-1.5 text-[12px] font-semibold text-zinc-100 hover:border-white/24 disabled:opacity-50"
          title={keyPresent ? "Verify the saved credentials" : "Save an API key first"}
        >{busy === "test" ? "Testing..." : "Test connection"}</button>
        <button
          type="button"
          onClick={syncNow}
          disabled={busy === "sync" || !keyPresent}
          className="rounded-xl border border-white/12 bg-white/[0.04] px-3 py-1.5 text-[12px] font-semibold text-zinc-100 hover:border-white/24 disabled:opacity-50"
          title={keyPresent ? "Pull coverage + announcements immediately" : "Save an API key first"}
        >{busy === "sync" ? "Syncing..." : "Sync now"}</button>
      </div>

      {savedMsg && <p className="text-[12px] text-emerald-300">{savedMsg}</p>}
      {testMsg  && <p className="text-[12px] text-zinc-300">{testMsg}</p>}
      {syncMsg  && <p className="text-[12px] text-zinc-300">{syncMsg}</p>}
      {error    && <p className="text-[12px] text-red-400">{error}</p>}

      {state && (
        <p className="text-[11px] text-zinc-500">
          Last coverage sync: {formatStamp(state.lastCoverageSyncAt)} · announcements: {formatStamp(state.lastAnnouncementSyncAt)}. Automatic pull every 6 hours.
        </p>
      )}
    </section>
  )
}

function formatStamp(iso: string | null): string {
  if (!iso) return "never"
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}
