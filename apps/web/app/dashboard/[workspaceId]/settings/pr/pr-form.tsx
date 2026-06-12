"use client"

/**
 * PrForm - MVPR API key + base URL editor, with Test + Sync-now actions.
 *
 * apiKey is write-only (we never round-trip the value back to the
 * client). hasApiKey + an empty input means "leave existing key alone";
 * typing anything replaces it.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"

interface TestResponse {
  ok:     boolean
  count?: number
  error?: string
  sample?: { title: string; publication: string } | null
}

interface SyncResponse {
  workspaceId:           string
  coveragesIngested:     number
  announcementsIngested: number
  threadsIngested:       number
  influencersUpserted:   number
  errors:                string[]
}

export function PrForm({
  workspaceId,
  hasApiKey,
  baseUrl: initialBaseUrl,
  lastCoverageSyncAt,
  lastAnnouncementSyncAt,
}: {
  workspaceId:            string
  hasApiKey:              boolean
  baseUrl:                string
  lastCoverageSyncAt:     string | null
  lastAnnouncementSyncAt: string | null
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()

  const [apiKey,  setApiKey]  = useState("")
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl)
  const [keyPresent, setKeyPresent] = useState(hasApiKey)

  const [saving,  setSaving]  = useState(false)
  const [testing, setTesting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [savedMsg, setSavedMsg]   = useState<string | null>(null)
  const [testMsg,  setTestMsg]    = useState<string | null>(null)
  const [syncMsg,  setSyncMsg]    = useState<string | null>(null)

  async function save() {
    setError(null)
    setSavedMsg(null)
    setSaving(true)
    try {
      const body: Record<string, string> = {}
      if (apiKey.trim().length > 0) body.apiKey = apiKey.trim()
      if (baseUrl.trim() !== initialBaseUrl) body.baseUrl = baseUrl.trim()
      if (Object.keys(body).length === 0) {
        setError("Nothing to save.")
        return
      }
      const res = await fetch(`/api/dashboard/${workspaceId}/settings/pr`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`)
        return
      }
      setSavedMsg("Saved.")
      if (body.apiKey) {
        setKeyPresent(true)
        setApiKey("")
      }
      startTransition(() => router.refresh())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function test() {
    setError(null)
    setTestMsg(null)
    setTesting(true)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/settings/pr/test`, { method: "POST" })
      const data = (await res.json().catch(() => ({}))) as TestResponse
      if (!res.ok || !data.ok) {
        setTestMsg(`Connection failed: ${data.error ?? `HTTP ${res.status}`}`)
        return
      }
      const sample = data.sample
      setTestMsg(
        sample
          ? `Connected. Latest coverage: "${sample.title}" - ${sample.publication}.`
          : `Connected. No coverage rows yet.`,
      )
    } catch (e) {
      setTestMsg(`Connection failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setTesting(false)
    }
  }

  async function syncNow() {
    setError(null)
    setSyncMsg(null)
    setSyncing(true)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/settings/pr/sync`, { method: "POST" })
      const data = (await res.json().catch(() => ({}))) as SyncResponse | { error?: string }
      if (!res.ok) {
        setSyncMsg(`Sync failed: ${("error" in data && data.error) || `HTTP ${res.status}`}`)
        return
      }
      const r = data as SyncResponse
      const errs = r.errors.length > 0 ? ` (${r.errors.length} non-fatal errors)` : ""
      setSyncMsg(`Synced ${r.coveragesIngested} coverages + ${r.announcementsIngested} announcements + ${r.threadsIngested} threads + ${r.influencersUpserted} influencers${errs}.`)
      startTransition(() => router.refresh())
    } catch (e) {
      setSyncMsg(`Sync failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h2 className="text-[14px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Credentials</h2>

        <div className="space-y-2">
          <label className="block text-[12px] font-medium text-zinc-300" htmlFor="mvpr-base-url">Base URL</label>
          <input
            id="mvpr-base-url"
            type="text"
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            placeholder="https://<mvpr-host>/api/v1/companies/<your-company-id>/"
            className="w-full rounded-xl border border-white/12 bg-white/[0.04] px-3 py-2 text-[13px] font-mono text-zinc-100 placeholder:text-zinc-500 focus:border-[#2BA98B]/40 focus:outline-none"
          />
          <p className="text-[12px] text-zinc-500">
            Copy the full URL from MVPR&apos;s API page. The trailing company id is per-tenant.
          </p>
        </div>

        <div className="space-y-2">
          <label className="block text-[12px] font-medium text-zinc-300" htmlFor="mvpr-api-key">
            API key {keyPresent && <span className="text-zinc-500">(saved - paste a new value to rotate)</span>}
          </label>
          <input
            id="mvpr-api-key"
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder={keyPresent ? "••••••••••••••••" : "Paste your MVPR API key"}
            className="w-full rounded-xl border border-white/12 bg-white/[0.04] px-3 py-2 text-[13px] font-mono text-zinc-100 placeholder:text-zinc-500 focus:border-[#2BA98B]/40 focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-xl bg-[#2BA98B] px-4 py-2 text-[12px] font-semibold text-white transition-colors hover:bg-[#249A7E] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            type="button"
            onClick={test}
            disabled={testing || !keyPresent}
            className="rounded-xl border border-white/12 bg-white/[0.04] px-4 py-2 text-[12px] font-semibold text-zinc-100 transition-colors hover:border-white/24 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
            title={keyPresent ? "Verify the saved credentials work" : "Save an API key first"}
          >
            {testing ? "Testing..." : "Test connection"}
          </button>
          <button
            type="button"
            onClick={syncNow}
            disabled={syncing || !keyPresent}
            className="rounded-xl border border-white/12 bg-white/[0.04] px-4 py-2 text-[12px] font-semibold text-zinc-100 transition-colors hover:border-white/24 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
            title={keyPresent ? "Pull coverage + announcements immediately" : "Save an API key first"}
          >
            {syncing ? "Syncing..." : "Sync now"}
          </button>
        </div>

        {savedMsg && <p className="text-[12px] text-emerald-300">{savedMsg}</p>}
        {testMsg  && <p className="text-[12px] text-zinc-300">{testMsg}</p>}
        {syncMsg  && <p className="text-[12px] text-zinc-300">{syncMsg}</p>}
        {error    && <p className="text-[12px] text-red-400">{error}</p>}
      </section>

      <section className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.02] px-5 py-4">
        <h2 className="text-[12px] font-bold uppercase tracking-[0.10em] text-zinc-400">Last sync</h2>
        <p className="text-[13px] text-zinc-300">
          Coverages: <span className="tabular-nums text-white">{formatStamp(lastCoverageSyncAt)}</span>
        </p>
        <p className="text-[13px] text-zinc-300">
          Announcements: <span className="tabular-nums text-white">{formatStamp(lastAnnouncementSyncAt)}</span>
        </p>
        <p className="text-[12px] text-zinc-500">
          Automatic pull runs every 6 hours. Coverage rows land in <code className="text-zinc-300">mvpr_coverage</code>; announcements in <code className="text-zinc-300">mvpr_announcements</code>.
        </p>
      </section>
    </div>
  )
}

function formatStamp(iso: string | null): string {
  if (!iso) return "never"
  const d = new Date(iso)
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}
