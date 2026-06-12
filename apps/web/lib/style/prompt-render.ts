/**
 * Render a StyleProfile as a compact markdown block for use inside a draft
 * prompt. The full 63-dimension table would blow the context budget, so we
 * surface only the parts that drive output the most: the summary, the 7 key
 * traits, and the top-N transformation rules ordered by confidence.
 */

import type { StyleProfile, DimensionResult } from "./types"

/** Max transformation_rule entries per block. Tuned for prompt-budget friendliness. */
const DEFAULT_MAX_RULES = 10

/** Minimum confidence to surface a transformation rule. Below this we treat the dimension as not-applicable. */
const MIN_RULE_CONFIDENCE = 0.7

export interface RenderOptions {
  /** Markdown heading used to label the block (e.g. "Corporate voice"). */
  label:     string
  /** Cap on transformation rules to include. Defaults to 10. */
  maxRules?: number
}

/** True iff this dimension result has a transformation rule strong enough to apply. */
function isUsable(d: DimensionResult): boolean {
  return d.confidence >= MIN_RULE_CONFIDENCE && !!d.transformation_rule?.trim()
}

function dimensionLine(d: DimensionResult): string {
  if (d.type === "spectrum") {
    return `- (${d.confidence.toFixed(2)} confidence; score ${d.score}/100, ${d.pole_low} -> ${d.pole_high}) ${d.transformation_rule.trim()}`
  }
  return `- (${d.confidence.toFixed(2)} confidence; option ${d.option}) ${d.transformation_rule.trim()}`
}

/**
 * Build a markdown block for a single fingerprint. Returns null when the
 * profile is too sparse to be useful (no key traits AND no high-confidence
 * dimensions).
 */
export function renderFingerprintBlock(
  fp: StyleProfile,
  opts: RenderOptions,
): string | null {
  const max = opts.maxRules ?? DEFAULT_MAX_RULES
  const usable = fp.dimensions
    .filter(isUsable)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, max)

  if (fp.key_traits.length === 0 && usable.length === 0) return null

  const out: string[] = []
  out.push(`## ${opts.label}`)
  if (fp.summary?.trim()) {
    out.push(fp.summary.trim())
  }
  if (fp.key_traits.length > 0) {
    out.push("### Key traits (apply consistently)")
    for (const t of fp.key_traits) {
      out.push(`- ${t}`)
    }
  }
  if (usable.length > 0) {
    out.push("### Transformation rules")
    for (const d of usable) {
      out.push(dimensionLine(d))
    }
  }
  return out.join("\n")
}

/**
 * Convenience: render up to four fingerprint layers as adjacent blocks,
 * ordered least-to-most specific so the LLM sees the most-specific layer
 * last (recency bias). Stacking order: corporate -> channel-only ->
 * channel-persona -> campaign. Any layer can be omitted; returns null when
 * none of the layers are present.
 */
export function renderStackedFingerprints(args: {
  corporate?:      StyleProfile | null
  /** Action-Set umbrella voice for the channel, independent of persona. */
  channelOnly?:    StyleProfile | null
  channelPersona?: StyleProfile | null
  /** Per-campaign voice. Most-specific layer when a draft is bound to a campaign. */
  campaign?:       StyleProfile | null
  channelLabel?:   string
  personaLabel?:   string
  campaignLabel?:  string
}): string | null {
  const blocks: string[] = []

  if (args.corporate) {
    const c = renderFingerprintBlock(args.corporate, { label: "Corporate voice fingerprint" })
    if (c) blocks.push(c)
  }
  if (args.channelOnly) {
    const label = `${args.channelLabel ?? "Channel"} voice (channel-wide default)`
    const co = renderFingerprintBlock(args.channelOnly, { label })
    if (co) blocks.push(co)
  }
  if (args.channelPersona) {
    const label = `${args.channelLabel ?? "Channel"} voice for ${args.personaLabel ?? "this persona"}`
    const cp = renderFingerprintBlock(args.channelPersona, { label })
    if (cp) blocks.push(cp)
  }
  if (args.campaign) {
    const label = `Campaign voice${args.campaignLabel ? ` (${args.campaignLabel})` : ""}`
    const cm = renderFingerprintBlock(args.campaign, { label })
    if (cm) blocks.push(cm)
  }
  if (blocks.length === 0) return null
  return blocks.join("\n\n")
}
