/**
 * usage_log helper — the single chokepoint for writing cost-tracked events.
 *
 * Direct callers: AI generateText wrappers, Surfe enrichment, Apify scrapers,
 * Unipile send-DM, and the daily Vercel + Neon allocation cron. Reads live in
 * the cost dashboard pages.
 *
 * Rule of thumb: writes here must never block the user-visible action. Always
 * fire-and-forget (or at worst, await but swallow errors). Cost-logging
 * failures should never break a draft, an enrich, or a DM send.
 */

import { sql, isDbConfigured } from "./db"

export type UsageCategory = "enrichment" | "ai" | "messaging" | "platform"
export type UsageProvider =
  | "surfe"
  | "apify"
  | "anthropic"
  | "openai"
  | "unipile"
  | "resend"
  | "apollo"
  | "vercel"
  | "neon"

export interface UsageEntry {
  workspaceId:    string
  category:       UsageCategory
  provider:       UsageProvider
  /** Number of credits / tokens / runs / messages / GB-hours consumed. */
  units:          number
  /** Cost per unit in USD cents at write time. Frozen even if rates change later. */
  unitCostCents:  number
  /** Optional structured metadata. Keep small — analytics columns belong on the table. */
  metadata?:      Record<string, unknown>
  /** Override the timestamp. Defaults to NOW(). Use this for backfills / cron rows. */
  occurredAt?:    Date
}

/**
 * Insert a usage_log row. Swallows errors and logs to console — never throws,
 * never blocks. If the DB isn't configured, no-op (cost tracking is a free
 * extra; it shouldn't gate the underlying feature).
 */
export async function logUsage(entry: UsageEntry): Promise<void> {
  if (!isDbConfigured()) return
  if (!Number.isFinite(entry.units) || entry.units <= 0) return
  const total = entry.units * entry.unitCostCents
  try {
    const db = sql()
    await db`
      INSERT INTO usage_log (
        workspace_id, occurred_at, category, provider,
        units, unit_cost_cents, total_cost_cents, metadata
      )
      VALUES (
        ${entry.workspaceId},
        ${entry.occurredAt ?? new Date()},
        ${entry.category},
        ${entry.provider},
        ${entry.units},
        ${entry.unitCostCents},
        ${total},
        ${JSON.stringify(entry.metadata ?? {})}::jsonb
      )
    `
  } catch (err) {
    console.error(`[usage-log] failed to record ${entry.provider}:`, err)
  }
}

// ─── AI helpers ──────────────────────────────────────────────────────────────

import {
  ANTHROPIC_SONNET_INPUT_CENTS_PER_TOKEN,
  ANTHROPIC_SONNET_OUTPUT_CENTS_PER_TOKEN,
} from "./pricing"

/**
 * Convenience wrapper for AI calls — splits input + output tokens into two
 * usage_log rows so per-token pricing is preserved on each side. Either
 * counter being zero or undefined is fine; the row is skipped.
 */
export async function logAiTokens(args: {
  workspaceId:  string
  model:        string
  inputTokens:  number | undefined | null
  outputTokens: number | undefined | null
  metadata?:    Record<string, unknown>
}): Promise<void> {
  const { workspaceId, model, metadata } = args
  // Today the only model we route through the AI Gateway is Claude Sonnet 4.6.
  // When that changes, keyed lookups against pricing.ts.
  const isSonnet = model.includes("sonnet")
  const inRate  = isSonnet ? ANTHROPIC_SONNET_INPUT_CENTS_PER_TOKEN  : 0
  const outRate = isSonnet ? ANTHROPIC_SONNET_OUTPUT_CENTS_PER_TOKEN : 0

  if (args.inputTokens && args.inputTokens > 0 && inRate > 0) {
    await logUsage({
      workspaceId,
      category:      "ai",
      provider:      "anthropic",
      units:         args.inputTokens,
      unitCostCents: inRate,
      metadata:      { ...metadata, model, kind: "input" },
    })
  }
  if (args.outputTokens && args.outputTokens > 0 && outRate > 0) {
    await logUsage({
      workspaceId,
      category:      "ai",
      provider:      "anthropic",
      units:         args.outputTokens,
      unitCostCents: outRate,
      metadata:      { ...metadata, model, kind: "output" },
    })
  }
}
