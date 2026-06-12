"use client"

/**
 * ActionFingerprintPanel - right-rail panel on each written-channel Action
 * Card (LinkedIn DM, Direct Email). Surfaces the active channel-level
 * writing-style fingerprint for the Action Set:
 *
 *   - Version + last-refit date + mined-sample counts
 *   - "Refit now" button -> POST style/mine-from-sends with scope='channel'
 *   - Edit link -> /settings/company-messaging (where the full editor lives)
 *
 * The channel-only fingerprint (scope='channel' in style_fingerprints) is
 * the Action-Set umbrella voice that applies when no persona match has a
 * more specific (channel, persona) cell. The full per-persona editor still
 * lives in Settings; this panel is the surfacing + refit affordance on
 * the operational Actions page.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"

interface Snapshot {
  id:               number | null
  version:          number | null
  createdAt:        string | null
  samplePos:        number | null
  sampleNeg:        number | null
}

export function ActionFingerprintPanel({
  workspaceId,
  channel,
  channelLabel,
  initial,
}: {
  workspaceId:  string
  channel:      "linkedin_dm" | "email"
  channelLabel: string
  initial:      Snapshot
}) {
  const router = useRouter()
  const [busy, setBusy]       = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [snap, setSnap]       = useState<Snapshot>(initial)
  const hasFingerprint = snap.id !== null

  async function refit() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/dashboard/${workspaceId}/style/mine-from-sends`,
        {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ channel, scope: "channel" }),
        },
      )
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`)
        setBusy(false)
        return
      }
      setSnap({
        id:        data.id        ?? null,
        version:   data.version   ?? null,
        createdAt: new Date().toISOString(),
        samplePos: data.positive_count ?? null,
        sampleNeg: data.negative_count ?? null,
      })
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const lastRefitLabel = snap.createdAt
    ? new Date(snap.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    : "Never"
  const editHref = `/dashboard/${workspaceId}/settings/company-messaging`

  return (
    <div className="border-l border-white/[0.06] p-5 flex flex-col gap-4 min-w-0">
      <div>
        <p className="text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Writing-style fingerprint</p>
        <p className="mt-1 text-[12px] text-zinc-400">
          Channel-wide voice for {channelLabel} drafts. Persona-specific voice still wins when a persona matches.
        </p>
      </div>

      {hasFingerprint ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[12px]">
          <dt className="text-zinc-500">Version</dt>
          <dd className="font-mono tabular-nums text-white text-right">v{snap.version}</dd>
          <dt className="text-zinc-500">Last refit</dt>
          <dd className="text-white text-right">{lastRefitLabel}</dd>
          <dt className="text-zinc-500">Positive samples</dt>
          <dd className="font-mono tabular-nums text-white text-right">{snap.samplePos ?? 0}</dd>
          <dt className="text-zinc-500">Negative samples</dt>
          <dd className="font-mono tabular-nums text-white text-right">{snap.sampleNeg ?? 0}</dd>
        </dl>
      ) : (
        <p className="text-[12px] text-zinc-400">
          No channel-wide fingerprint yet. Mine from recent responded sends, or paste samples in
          {" "}
          <a className="text-[#2BA98B] hover:underline" href={editHref}>Company Messaging</a>.
        </p>
      )}

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={refit}
          disabled={busy}
          className="inline-flex items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] px-3 py-2 text-[12px] font-medium text-white hover:bg-white/[0.10] disabled:opacity-60"
        >
          {busy ? "Refitting..." : hasFingerprint ? "Refit from recent sends" : "Mine from recent sends"}
        </button>
        <a
          href={editHref}
          className="inline-flex items-center justify-center rounded-lg border border-white/[0.06] px-3 py-2 text-[12px] font-medium text-zinc-300 hover:text-white hover:border-white/10"
        >
          Edit in Company Messaging
        </a>
      </div>

      {error && (
        <p className="text-[11px] text-red-300">{error}</p>
      )}
    </div>
  )
}
