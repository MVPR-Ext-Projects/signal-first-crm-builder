/**
 * Writing-style fingerprint generator.
 *
 * Runs the 63-dimension analyzer against one or more text samples and returns
 * a validated StyleProfile. The dimensions reference + scoring rubric live in
 * the SYSTEM_PROMPT - at ~5-10KB per call, it dominates token cost on refits.
 * TODO: turn on Anthropic prompt caching once refit volume justifies the
 * extra cache-write cost.
 *
 * Cost is logged to usage_log via the standard logAiTokens helper, tagged
 * with route="style/generator" plus optional metadata.
 *
 * Uses the AI SDK v6 structured-output API: generateText + Output.object({
 * schema }). generateObject is deprecated in v6.
 */

import { generateText, Output } from "ai"
import { z } from "zod"
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt"
import type { StyleProfile } from "./types"
import { logAiTokens } from "@/lib/usage-log"

const MODEL = "anthropic/claude-sonnet-4.6"

// ── Output schema (mirrors StyleProfile minus author_name / dimension_count,
//    which the generator wraps on after the LLM returns) ───────────────────

const SpectrumResultSchema = z.object({
  name:                z.string(),
  group:               z.string(),
  type:                z.literal("spectrum"),
  score:               z.number().min(0).max(100),
  pole_low:            z.string(),
  pole_high:           z.string(),
  confidence:          z.number().min(0).max(1),
  example:             z.string(),
  transformation_rule: z.string(),
})

const CategoricalResultSchema = z.object({
  name:                z.string(),
  group:               z.string(),
  type:                z.literal("categorical"),
  option:              z.enum(["A", "B", "C", "D"]),
  confidence:          z.number().min(0).max(1),
  example:             z.string(),
  transformation_rule: z.string(),
})

const DimensionResultSchema = z.discriminatedUnion("type", [
  SpectrumResultSchema,
  CategoricalResultSchema,
])

const ProfileBodySchema = z.object({
  word_count: z.number().int().nonnegative(),
  summary:    z.string(),
  key_traits: z.array(z.string()).length(7),
  dimensions: z.array(DimensionResultSchema),
})

export interface GenerateFingerprintArgs {
  /** Workspace this fingerprint belongs to - used for usage_log attribution. */
  workspaceId: string
  /** One or more writing samples. Concatenated with separators for the LLM. */
  samples:     string[]
  /** Display name for the prompt. Doesn't affect storage. Defaults to "this author". */
  authorName?: string
  /** Free-form metadata persisted to usage_log (e.g. cell coords, source). */
  metadata?:   Record<string, unknown>
}

/** Approximate word count - simple whitespace-split, good enough for the prompt header. */
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

/** Joins multiple samples with a labelled separator so the LLM doesn't blur them together. */
function joinSamples(samples: string[]): string {
  return samples
    .map((s, i) => `[Sample ${i + 1}]\n${s.trim()}`)
    .join("\n\n---\n\n")
}

export async function generateFingerprint(
  args: GenerateFingerprintArgs,
): Promise<StyleProfile> {
  const text       = joinSamples(args.samples)
  const wordCount  = countWords(text)
  const authorName = args.authorName ?? "this author"

  const result = await generateText({
    model:       MODEL,
    output:      Output.object({ schema: ProfileBodySchema }),
    system:      SYSTEM_PROMPT,
    prompt:      buildUserMessage(text, authorName, wordCount),
    // Low temperature - we want the same fingerprint twice if we feed the same
    // samples twice, not creative invention.
    temperature: 0.2,
  })

  void logAiTokens({
    workspaceId:  args.workspaceId,
    model:        MODEL,
    inputTokens:  result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
    metadata:     {
      ...args.metadata,
      route:        "style/generator",
      author_name:  authorName,
      sample_count: args.samples.length,
      word_count:   wordCount,
    },
  })

  const body = result.output

  return {
    author_name:     authorName,
    word_count:      body.word_count || wordCount,
    summary:         body.summary,
    key_traits:      body.key_traits,
    dimensions:      body.dimensions,
    dimension_count: body.dimensions.length,
  }
}
