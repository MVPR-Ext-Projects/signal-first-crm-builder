"use client"

/**
 * Corporate Voice section of the Company Messaging settings page.
 *
 * Renders the workspace-level writing-style fingerprint and the
 * paste-samples-and-generate flow that creates / replaces it. Backed by
 * POST /api/dashboard/<wsId>/style/generate-corporate, which writes both
 * a style_fingerprints row (scope='corporate') and mirrors the StyleProfile
 * onto WorkspaceConfig.messaging.companyFingerprint.
 *
 * The drafter combines this corporate voice with the matched persona's
 * channel-specific fingerprint at draft time.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useToast } from "../../toast"
import type { StyleProfile } from "@/lib/style/types"

/** Splits a single pasted blob into samples on blank-line runs or "---" separators. */
function splitSamples(blob: string): string[] {
  const parts = blob
    .split(/\n{3,}|\n-{3,}\n/)
    .map(s => s.trim())
    .filter(Boolean)
  return parts.length > 0 ? parts : (blob.trim() ? [blob.trim()] : [])
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

export function CorporateVoiceForm({
  workspaceId,
  initial,
}: {
  workspaceId: string
  initial:     StyleProfile | null
}) {
  const router = useRouter()
  const toast  = useToast()

  const [current, setCurrent]     = useState<StyleProfile | null>(initial)
  const [samples, setSamples]     = useState("")
  const [generating, setGenerating] = useState(false)
  const [expanded, setExpanded]   = useState(!initial)

  const sampleWordCount = wordCount(samples)

  async function handleGenerate() {
    const list = splitSamples(samples)
    if (list.length === 0) {
      toast.error("No samples", "Paste some writing first.")
      return
    }
    setGenerating(true)
    toast.info("Generating", "Running the 63-dimension analyzer. ~30 seconds.")
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/style/generate-corporate`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ samples: list }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        toast.error("Generation failed", err.error ?? `HTTP ${res.status}`)
        return
      }
      const { fingerprint, version } = await res.json() as { fingerprint: StyleProfile; version: number }
      setCurrent(fingerprint)
      setSamples("")
      setExpanded(false)
      toast.success("Corporate voice saved", `v${version} is now the active corporate fingerprint.`)
      router.refresh()
    } catch (e) {
      toast.error("Generation failed", (e as Error).message)
    } finally {
      setGenerating(false)
    }
  }

  return (
    <section className="space-y-4 rounded-2xl border border-white/10 bg-[#08302E]/40 px-5 py-5">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <h2 className="text-[18px] font-bold text-white">Corporate voice</h2>
          <p className="mt-1 text-[13px] leading-[20px] text-zinc-300">
            The umbrella writing-style fingerprint for this workspace. Combined with each
            persona&rsquo;s channel-specific voice at draft time.
          </p>
        </div>
        {current && !expanded && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="shrink-0 rounded-lg border border-white/10 px-3 py-1.5 text-[13px] font-medium text-zinc-200 hover:bg-white/[0.04]"
          >
            Replace
          </button>
        )}
      </header>

      {current && (
        <div className="space-y-3 rounded-xl border border-white/10 bg-black/20 px-4 py-4">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">Summary</p>
            <p className="mt-1 text-[14px] leading-[21px] text-zinc-100">{current.summary}</p>
          </div>
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">Key traits</p>
            <ul className="mt-1 space-y-1">
              {current.key_traits.map((t, i) => (
                <li key={i} className="text-[13px] leading-[19px] text-zinc-200">
                  <span className="text-zinc-500">{i + 1}.</span> {t}
                </li>
              ))}
            </ul>
          </div>
          <p className="text-[12px] text-zinc-500">
            {current.dimension_count} dimensions analysed · {current.word_count.toLocaleString()} words of input
          </p>
        </div>
      )}

      {expanded && (
        <div className="space-y-3">
          <label className="block text-[13px] font-medium text-zinc-200">
            Paste 3-5 strong writing samples (separate with blank lines or <code>---</code>):
          </label>
          <textarea
            value={samples}
            onChange={e => setSamples(e.target.value)}
            disabled={generating}
            placeholder="Paste a blog post, then a few standout LinkedIn posts, then an investor email. The more varied + on-brand the better. Aim for 1,500+ words."
            className="h-72 w-full rounded-xl border border-white/10 bg-black/30 px-3.5 py-3 text-[14px] leading-[21px] text-zinc-100 placeholder:text-zinc-500 focus:border-[#2BA98B]/60 focus:outline-none"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[12px] text-zinc-500">
              {sampleWordCount.toLocaleString()} words · {sampleWordCount >= 300 ? "ready" : `need ${300 - sampleWordCount} more`}
            </p>
            <div className="flex gap-2">
              {current && (
                <button
                  type="button"
                  onClick={() => { setSamples(""); setExpanded(false) }}
                  disabled={generating}
                  className="rounded-lg border border-white/10 px-3.5 py-2 text-[13px] font-medium text-zinc-300 hover:bg-white/[0.04] disabled:opacity-50"
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                onClick={handleGenerate}
                disabled={generating || sampleWordCount < 300}
                className="rounded-lg bg-[#2BA98B] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#2BA98B]/90 disabled:opacity-50"
              >
                {generating ? "Generating..." : current ? "Regenerate" : "Generate fingerprint"}
              </button>
            </div>
          </div>
        </div>
      )}

      {!current && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="rounded-lg bg-[#2BA98B] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#2BA98B]/90"
        >
          Generate corporate voice
        </button>
      )}
    </section>
  )
}
