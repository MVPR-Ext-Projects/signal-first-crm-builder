"use client"

/**
 * Per-(persona, channel) writing-style fingerprint editor. Rendered as a
 * Subsection inside each persona card on the Company Messaging page.
 *
 * Three flows:
 *
 *   1. View current active fingerprint (GET /style/cell).
 *   2. Bootstrap from pasted positive / negative samples
 *      (POST /style/generate-cell).
 *   3. Mine from historical sends - scans outreach_log for sends to this
 *      persona on this channel, scores them via the locked outcome rubric,
 *      generates a fingerprint from the positive bucket
 *      (POST /style/mine-from-sends).
 *
 * Save-personas-before-generate guard: both bootstrap flows call
 * `onSavePersonas()` first. Persona stable IDs are hydrated on page load
 * but only persisted on save; without this guard the persona_id sent to
 * the generator would not exist on the server's saved config until a
 * subsequent unrelated save happens.
 */

import { useEffect, useState } from "react"
import { useToast } from "../../toast"
import type { StyleProfile } from "@/lib/style/types"

type Channel = "linkedin_dm" | "email"

const CHANNELS: { value: Channel; label: string }[] = [
  { value: "linkedin_dm", label: "LinkedIn DM" },
  { value: "email",       label: "Email" },
]

function splitSamples(blob: string): string[] {
  const parts = blob.split(/\n{3,}|\n-{3,}\n/).map(s => s.trim()).filter(Boolean)
  return parts.length > 0 ? parts : (blob.trim() ? [blob.trim()] : [])
}

export function PersonaChannelFingerprints({
  workspaceId,
  personaId,
  personaName,
  onSavePersonas,
}: {
  workspaceId:    string
  personaId:      string
  personaName:    string
  /** Persists the current personas array; channel-fingerprint flows await this before generating. */
  onSavePersonas: () => Promise<void>
}) {
  const toast = useToast()
  const [channel, setChannel]         = useState<Channel>("linkedin_dm")
  const [fingerprint, setFingerprint] = useState<StyleProfile | null>(null)
  const [version, setVersion]         = useState<number | null>(null)
  const [loading, setLoading]         = useState(false)
  const [positive, setPositive]       = useState("")
  const [negative, setNegative]       = useState("")
  const [submitting, setSubmitting]   = useState(false)

  // Re-fetch the active fingerprint whenever the tab or persona changes.
  useEffect(() => {
    let cancelled = false
    async function fetchActive() {
      setLoading(true)
      try {
        const url = `/api/dashboard/${workspaceId}/style/cell?channel=${channel}&persona_id=${encodeURIComponent(personaId)}`
        const res = await fetch(url)
        if (!res.ok) {
          if (!cancelled) { setFingerprint(null); setVersion(null) }
          return
        }
        const data = await res.json() as { fingerprint: StyleProfile | null; version: number | null }
        if (!cancelled) { setFingerprint(data.fingerprint); setVersion(data.version) }
      } catch {
        if (!cancelled) { setFingerprint(null); setVersion(null) }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchActive()
    return () => { cancelled = true }
  }, [workspaceId, personaId, channel])

  async function handleGenerate() {
    const pos = splitSamples(positive)
    const neg = splitSamples(negative)
    if (pos.length === 0) {
      toast.error("No positive samples", "Paste at least one example that worked.")
      return
    }
    setSubmitting(true)
    toast.info("Generating", "Saving personas, then running the analyzer. ~30 seconds.")
    try {
      await onSavePersonas()
      const res = await fetch(`/api/dashboard/${workspaceId}/style/generate-cell`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel,
          persona_id:       personaId,
          positive_samples: pos,
          negative_samples: neg,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        toast.error("Generation failed", err.error ?? `HTTP ${res.status}`)
        return
      }
      const data = await res.json() as { fingerprint: StyleProfile; version: number }
      setFingerprint(data.fingerprint)
      setVersion(data.version)
      setPositive("")
      setNegative("")
      toast.success("Fingerprint saved", `v${data.version} is active for ${personaName} on ${channel === "linkedin_dm" ? "LinkedIn DM" : "Email"}.`)
    } catch (e) {
      toast.error("Generation failed", (e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleMine() {
    setSubmitting(true)
    toast.info("Mining", `Scoring historical ${channel === "linkedin_dm" ? "DM" : "email"} sends for ${personaName}.`)
    try {
      await onSavePersonas()
      const res = await fetch(`/api/dashboard/${workspaceId}/style/mine-from-sends`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, persona_id: personaId }),
      })
      const data = await res.json() as {
        fingerprint?:    StyleProfile
        version?:        number
        error?:          string
        sends_examined?: number
        positive_count?: number
        negative_count?: number
      }
      if (!res.ok) {
        toast.error("Mining failed", data.error ?? `HTTP ${res.status}`)
        return
      }
      if (data.fingerprint && data.version != null) {
        setFingerprint(data.fingerprint)
        setVersion(data.version)
      }
      toast.success(
        "Mined fingerprint",
        `v${data.version} - ${data.positive_count}+ / ${data.negative_count}- from ${data.sends_examined} sends.`,
      )
    } catch (e) {
      toast.error("Mining failed", (e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-3">
      {/* Channel tabs */}
      <div className="flex gap-1 border-b border-white/10">
        {CHANNELS.map(c => (
          <button
            key={c.value}
            type="button"
            onClick={() => setChannel(c.value)}
            disabled={submitting}
            className={`px-3 py-2 text-[13px] font-medium transition-colors ${
              channel === c.value
                ? "border-b-2 border-[#2BA98B] text-white"
                : "text-zinc-400 hover:text-zinc-200"
            } disabled:opacity-50`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {/* Current fingerprint preview */}
      {loading ? (
        <p className="text-[13px] text-zinc-500">Loading fingerprint...</p>
      ) : fingerprint ? (
        <div className="space-y-2 rounded-xl border border-white/10 bg-black/20 px-4 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">
              Active fingerprint
            </p>
            {version != null && (
              <span className="text-[11px] text-zinc-500">v{version}</span>
            )}
          </div>
          <p className="text-[13px] leading-[19px] text-zinc-100">{fingerprint.summary}</p>
          <ul className="space-y-0.5">
            {fingerprint.key_traits.slice(0, 5).map((t, i) => (
              <li key={i} className="text-[12px] leading-[18px] text-zinc-300">- {t}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-white/15 bg-white/[0.02] px-4 py-3 text-[13px] leading-[20px] text-zinc-400">
          No fingerprint for this channel yet. The drafter falls back to the corporate voice
          until you generate one. Paste samples below or mine from historical sends.
        </p>
      )}

      {/* Sample input */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-[12px] font-medium text-zinc-300">
            Positive samples (replied / booked)
          </label>
          <textarea
            value={positive}
            onChange={e => setPositive(e.target.value)}
            disabled={submitting}
            placeholder="Paste your strongest messages on this channel for this persona. Separate with blank lines."
            className="h-44 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[13px] leading-[19px] text-zinc-100 placeholder:text-zinc-600 focus:border-[#2BA98B]/60 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-[12px] font-medium text-zinc-300">
            Negative samples (no reply / unsubscribed) - optional
          </label>
          <textarea
            value={negative}
            onChange={e => setNegative(e.target.value)}
            disabled={submitting}
            placeholder="Messages that flopped. Useful for the refit loop; not used in this first fingerprint generation."
            className="h-44 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[13px] leading-[19px] text-zinc-100 placeholder:text-zinc-600 focus:border-[#2BA98B]/60 focus:outline-none"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={handleMine}
          disabled={submitting}
          className="rounded-lg border border-white/10 px-3.5 py-2 text-[13px] font-medium text-zinc-200 hover:bg-white/[0.04] disabled:opacity-50"
        >
          Mine from existing sends
        </button>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={submitting || !positive.trim()}
          className="rounded-lg bg-[#2BA98B] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#239977] disabled:opacity-50"
        >
          {submitting ? "Working..." : fingerprint ? "Regenerate" : "Generate fingerprint"}
        </button>
      </div>
    </div>
  )
}
