/**
 * Hardcoded per-unit costs for cost-tracking.
 *
 * All values in USD cents. These are what *we* pay each provider — when
 * computing a billable invoice for a workspace later, a markup is applied
 * on top.
 *
 * Source the rates from each provider's pricing page. Update when plans change.
 * Updates apply to *new* usage_log rows only; historical rows freeze the rate
 * at write time, so trends stay comparable across rate changes.
 */

// ─── AI ──────────────────────────────────────────────────────────────────────
// Vercel AI Gateway routes to Anthropic. Pricing is per-token, billed in
// fractions of a cent — multiply by token count, not cents-per-call.

/** anthropic/claude-sonnet-4.6 — $3 / 1M input tokens = 0.0003 cents/token */
export const ANTHROPIC_SONNET_INPUT_CENTS_PER_TOKEN  = 3 / 10_000
/** anthropic/claude-sonnet-4.6 — $15 / 1M output tokens = 0.0015 cents/token */
export const ANTHROPIC_SONNET_OUTPUT_CENTS_PER_TOKEN = 15 / 10_000

// ─── Enrichment ──────────────────────────────────────────────────────────────

/**
 * Surfe — billed per "credit". An email reveal = 1 credit, mobile = 1 credit.
 * Their Pro plan (the one most relevant to GTM-OS) is roughly $0.05/credit.
 * If a workspace negotiates a different plan we'll add per-workspace overrides
 * later — see lib/pricing.ts comment above.
 */
export const SURFE_CENTS_PER_CREDIT = 5

/**
 * Apify — billed per "compute unit", which varies wildly per actor. Rather
 * than fetch the actual run cost from /actor-runs/{id} (extra round-trip),
 * we use a flat estimate per actor type. Refine later by hitting the runs
 * endpoint when accuracy matters.
 *
 *   - apidojo/twitter-scraper-lite        — light X scrape, ~$0.02/run
 *   - apimaestro/linkedin-company-employees-scraper-no-cookies — heavier, ~$0.20/run
 *   - profile-interests (LinkedIn)        — heavier still when configured, ~$0.15/run
 */
export const APIFY_X_INTERESTS_CENTS_PER_RUN     = 2
export const APIFY_COMPANY_EMPLOYEES_CENTS_PER_RUN = 20
export const APIFY_LINKEDIN_INTERESTS_CENTS_PER_RUN = 15

// ─── Messaging ───────────────────────────────────────────────────────────────

/**
 * Unipile — bills monthly per connected account, not per message. We
 * amortise: assume ~500 messages per month per account at ~$50/mo plan.
 * Per-send cost ≈ $0.10. Wildly approximate but lets us attribute platform
 * cost to the workspace doing the sending.
 */
export const UNIPILE_CENTS_PER_MESSAGE = 10

// ─── Platform (Vercel + Neon) ────────────────────────────────────────────────
// These are total monthly platform costs across ALL workspaces — the daily
// allocation cron splits them per workspace by share-of-events. Update after
// each invoice or plan change.
//
// Approximate by design (a workspace doing 90% of yesterday's work pays ~90%
// of yesterday's platform allocation). Real Vercel/Neon API integration is
// tracked as a follow-up.

/** Vercel team plan (Pro $20/mo) — update if you change plan. */
export const VERCEL_MONTHLY_CENTS = 2000

/** Neon plan after the recent upgrade — set this from your latest invoice. */
export const NEON_MONTHLY_CENTS   = 1900
