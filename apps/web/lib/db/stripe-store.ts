/**
 * Stripe ingestion - DB-side operations.
 *
 * Used by the webhook handler (apps/web/app/api/webhooks/[workspaceId]/stripe)
 * and the daily reconcile cron. Pure DB - the REST calls live in
 * apps/web/lib/stripe.ts.
 *
 * Key behaviours implemented here:
 *   - Stripe customer -> gtm-os company match waterfall (email-domain ->
 *     name-fuzzy -> unmatched).
 *   - Subscription ordinal numbering within a customer (drives Track B vs C).
 *   - Idempotent event store (UNIQUE on stripe_event_id).
 *   - Funnel side-effects: first payment_succeeded -> Customer Won;
 *     last subscription churn -> clear manual_stage + set
 *     previous_customer_since + record transition row with score-derived stage.
 */

import { sql, isDbConfigured } from "./index"
import { emailDomainFor, normaliseEmail } from "../stripe"
import type {
  StripeCustomer,
  StripeSubscription,
  StripeProduct,
  StripePriceFull,
  StripeInvoice,
  StripeInvoiceLine,
} from "../stripe"

const DEFAULT_COMMISSION_WINDOW_MONTHS = 12
const CUSTOMER_WON_STAGE = "Customer Won"

export interface StripeCustomerRow {
  id:                 number
  workspace_id:       string
  stripe_customer_id: string
  gtm_company_id:     number | null
  email:              string | null
  name:               string | null
  match_method:       string
  matched_at:         Date | null
  /**
   * Workspace-curated classification. See BILLING.md. Conventional values:
   *   'untracked' (test / internal / excluded), 'recurring_subscriber',
   *   'announcement_only', 'free_tier', NULL (default, treated as regular).
   */
  customer_type:      string | null
  created_at:         Date
  updated_at:         Date
}

export interface StripeSubscriptionRow {
  id:                     number
  workspace_id:           string
  stripe_customer_id:     number
  stripe_subscription_id: string
  ordinal:                number
  plan_nickname:          string | null
  unit_amount_cents:      number
  currency:               string
  interval:               string
  status:                 string
  started_at:             Date
  initial_term_ends_at:   Date
  current_period_start:   Date | null
  current_period_end:     Date | null
  canceled_at:            Date | null
  created_at:             Date
  updated_at:             Date
}

// ─── Match waterfall ─────────────────────────────────────────────────────────

interface MatchResult {
  gtm_company_id: number | null
  match_method:   "auto_domain" | "auto_name_fuzzy" | "unmatched"
}

/**
 * Email-domain match -> name-fuzzy fallback -> unmatched.
 *
 * Personal-provider domains (gmail.com etc.) are NOT auto-matched - they go to
 * the manual queue. Same for ambiguous matches (two companies share a domain
 * in this workspace, unlikely but possible).
 */
export async function matchCustomerToCompany(
  workspaceId: string,
  email:       string | null,
  name:        string | null,
): Promise<MatchResult> {
  if (!isDbConfigured()) return { gtm_company_id: null, match_method: "unmatched" }
  const db = sql()

  const domain = emailDomainFor(email)
  if (domain && !isPersonalDomain(domain)) {
    const rows = await db<{ id: number }>`
      SELECT id FROM companies
      WHERE workspace_id = ${workspaceId}
        AND domain       = ${domain}
      LIMIT 2
    `
    if (rows.length === 1) {
      return { gtm_company_id: rows[0].id, match_method: "auto_domain" }
    }
    // 0 or >=2 -> fall through. >=2 is rare; the manual UI surfaces the
    // ambiguity so the user picks the right company.
  }

  if (name && name.trim().length > 2) {
    // `companies.canonical_name` is already lowercased + legal-suffix-stripped
    // by the contacts/companies dedup waterfall, so case-insensitive equality
    // on it absorbs most legitimate variations ("Acme Inc." / "Acme Ltd" /
    // "Acme" all normalise to the same canonical). pg_trgm isn't installed
    // on Neon here so this stops short of trigram-based fuzzy - leftover
    // mismatches drop to the manual queue.
    const canonical = name.trim().toLowerCase()
    const rows = await db<{ id: number }>`
      SELECT id FROM companies
      WHERE  workspace_id          = ${workspaceId}
        AND  LOWER(canonical_name) = ${canonical}
      LIMIT  2
    `
    if (rows.length === 1) {
      return { gtm_company_id: rows[0].id, match_method: "auto_name_fuzzy" }
    }
    // 0 or >=2 -> manual queue.
  }

  return { gtm_company_id: null, match_method: "unmatched" }
}

const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk",
  "hotmail.com", "hotmail.co.uk", "outlook.com", "live.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com",
])
function isPersonalDomain(domain: string): boolean {
  return PERSONAL_DOMAINS.has(domain)
}

// ─── Upsert helpers ──────────────────────────────────────────────────────────

/**
 * Insert or refresh a stripe_customers row. Runs the match waterfall only on
 * first insert; subsequent webhook deliveries leave the existing match alone
 * (callers can re-run match explicitly via re-match endpoints if needed).
 */
export async function upsertStripeCustomer(
  workspaceId: string,
  c:           StripeCustomer,
): Promise<StripeCustomerRow> {
  if (!isDbConfigured()) throw new Error("DB not configured")
  const db = sql()
  const email = normaliseEmail(c.email)
  const name  = c.name?.trim() || null

  const existing = await db<StripeCustomerRow>`
    SELECT * FROM stripe_customers
    WHERE  workspace_id       = ${workspaceId}
      AND  stripe_customer_id = ${c.id}
    LIMIT  1
  `
  if (existing[0]) {
    // Refresh fluid fields; never overwrite the match decision automatically.
    const rows = await db<StripeCustomerRow>`
      UPDATE stripe_customers
      SET    email      = ${email},
             name       = ${name},
             updated_at = NOW()
      WHERE  id = ${existing[0].id}
      RETURNING *
    `
    return rows[0]
  }

  const match = await matchCustomerToCompany(workspaceId, email, name)
  const rows = await db<StripeCustomerRow>`
    INSERT INTO stripe_customers (
      workspace_id, stripe_customer_id, gtm_company_id, email, name,
      match_method, matched_at
    )
    VALUES (
      ${workspaceId}, ${c.id}, ${match.gtm_company_id}, ${email}, ${name},
      ${match.match_method},
      ${match.gtm_company_id ? new Date() : null}
    )
    RETURNING *
  `
  return rows[0]
}

/**
 * Insert or refresh a stripe_subscriptions row. Ordinal is computed at insert
 * time as the count of prior subscriptions for the same customer plus one.
 *
 * `commissionWindowMonths` defaults to 12 (the standard attribution
 * window for reporting).
 */
export async function upsertStripeSubscription(args: {
  workspaceId:             string
  customerRowId:           number
  stripeSub:               StripeSubscription
  monthlyAmountCents:      number
  commissionWindowMonths?: number
}): Promise<StripeSubscriptionRow> {
  if (!isDbConfigured()) throw new Error("DB not configured")
  const db = sql()
  const { workspaceId, customerRowId, stripeSub, monthlyAmountCents } = args
  const windowMonths = args.commissionWindowMonths ?? DEFAULT_COMMISSION_WINDOW_MONTHS

  const existing = await db<StripeSubscriptionRow>`
    SELECT * FROM stripe_subscriptions
    WHERE  workspace_id           = ${workspaceId}
      AND  stripe_subscription_id = ${stripeSub.id}
    LIMIT  1
  `

  const firstItem = stripeSub.items.data[0]
  const interval  = firstItem?.price.recurring?.interval ?? "month"
  const currency  = firstItem?.price.currency ?? "usd"
  const nickname  = firstItem?.price.nickname ?? null
  const startedAt = new Date(stripeSub.start_date * 1000)
  const canceledAt = stripeSub.canceled_at ? new Date(stripeSub.canceled_at * 1000) : null
  const currentPeriodStart = stripeSub.current_period_start ? new Date(stripeSub.current_period_start * 1000) : null
  const currentPeriodEnd   = stripeSub.current_period_end   ? new Date(stripeSub.current_period_end   * 1000) : null

  if (existing[0]) {
    const rows = await db<StripeSubscriptionRow>`
      UPDATE stripe_subscriptions
      SET    plan_nickname        = ${nickname},
             unit_amount_cents    = ${monthlyAmountCents},
             currency             = ${currency},
             interval             = ${interval},
             status               = ${stripeSub.status},
             canceled_at          = ${canceledAt},
             current_period_start = ${currentPeriodStart},
             current_period_end   = ${currentPeriodEnd},
             updated_at           = NOW()
      WHERE  id = ${existing[0].id}
      RETURNING *
    `
    return rows[0]
  }

  // Compute ordinal. Race-safe enough for webhook throughput; if two
  // subscriptions land simultaneously the second one's ordinal could collide
  // with the first - acceptable for now since Stripe rarely emits two
  // customer.subscription.created events for the same customer in the same
  // millisecond. Tighten to FOR UPDATE if it ever bites.
  const ord = await db<{ next_ordinal: number }>`
    SELECT COALESCE(MAX(ordinal), 0) + 1 AS next_ordinal
    FROM   stripe_subscriptions
    WHERE  stripe_customer_id = ${customerRowId}
  `
  const ordinal = ord[0].next_ordinal
  const initialTermEndsAt = new Date(startedAt)
  initialTermEndsAt.setMonth(initialTermEndsAt.getMonth() + windowMonths)

  const rows = await db<StripeSubscriptionRow>`
    INSERT INTO stripe_subscriptions (
      workspace_id, stripe_customer_id, stripe_subscription_id, ordinal,
      plan_nickname, unit_amount_cents, currency, interval, status,
      started_at, initial_term_ends_at, canceled_at,
      current_period_start, current_period_end
    )
    VALUES (
      ${workspaceId}, ${customerRowId}, ${stripeSub.id}, ${ordinal},
      ${nickname}, ${monthlyAmountCents}, ${currency}, ${interval}, ${stripeSub.status},
      ${startedAt}, ${initialTermEndsAt}, ${canceledAt},
      ${currentPeriodStart}, ${currentPeriodEnd}
    )
    RETURNING *
  `
  return rows[0]
}

// ─── Revenue events ──────────────────────────────────────────────────────────

export type RevenueEventKind =
  | "subscription_started"
  | "expansion"
  | "contraction"
  | "churn"
  | "payment_succeeded"
  | "payment_refunded"
  | "payment_failed"

export interface RecordRevenueEventArgs {
  workspaceId:        string
  stripeCustomerId:   number
  stripeSubscriptionId: number | null
  kind:               RevenueEventKind
  mrrDeltaCents?:     number | null
  grossAmountCents?:  number | null
  netAmountCents?:    number | null
  currency?:          string | null
  stripeEventId:      string
  occurredAt:         Date
}

/**
 * Idempotent insert. Returns the inserted row, or null when the (workspace_id,
 * stripe_event_id) was already present - that's how we tell "this is a
 * re-delivered webhook" apart from "first time we're seeing this event".
 */
export async function recordRevenueEvent(args: RecordRevenueEventArgs): Promise<{ id: number } | null> {
  if (!isDbConfigured()) return null
  const db = sql()
  const rows = await db<{ id: number }>`
    INSERT INTO stripe_revenue_events (
      workspace_id, stripe_customer_id, stripe_subscription_id, kind,
      mrr_delta_cents, gross_amount_cents, net_amount_cents, currency,
      stripe_event_id, occurred_at
    )
    VALUES (
      ${args.workspaceId}, ${args.stripeCustomerId}, ${args.stripeSubscriptionId}, ${args.kind},
      ${args.mrrDeltaCents ?? null}, ${args.grossAmountCents ?? null},
      ${args.netAmountCents ?? null}, ${args.currency ?? null},
      ${args.stripeEventId}, ${args.occurredAt}
    )
    ON CONFLICT (workspace_id, stripe_event_id) DO NOTHING
    RETURNING id
  `
  return rows[0] ?? null
}

/** Is `newEventId` the first payment_succeeded row for this customer? */
export async function isFirstPayment(stripeCustomerId: number, newEventId: number): Promise<boolean> {
  if (!isDbConfigured()) return false
  const db = sql()
  const rows = await db`
    SELECT 1 FROM stripe_revenue_events
    WHERE  stripe_customer_id = ${stripeCustomerId}
      AND  kind               = 'payment_succeeded'
      AND  id                 <> ${newEventId}
    LIMIT  1
  `
  return rows.length === 0
}

/** Count subscriptions that aren't in a terminal cancelled state. */
export async function countActiveSubscriptions(stripeCustomerId: number): Promise<number> {
  if (!isDbConfigured()) return 0
  const db = sql()
  const rows = await db<{ count: string }>`
    SELECT COUNT(*)::text AS count
    FROM   stripe_subscriptions
    WHERE  stripe_customer_id = ${stripeCustomerId}
      AND  status NOT IN ('canceled', 'incomplete_expired')
  `
  return Number(rows[0]?.count ?? 0)
}

// ─── Funnel transitions ──────────────────────────────────────────────────────

/**
 * Flow A: flip the matched company to 'Customer Won' on first payment.
 * Idempotent - skips when company_tags.manual_stage is already 'Customer Won'.
 * Returns true when a transition was written (caller can use it for telemetry).
 */
export async function applyFirstPaymentTransition(args: {
  workspaceId: string
  gtmCompanyId: number
}): Promise<boolean> {
  if (!isDbConfigured()) return false
  const db = sql()

  const companyRows = await db<{ canonical_name: string }>`
    SELECT canonical_name FROM companies WHERE id = ${args.gtmCompanyId} LIMIT 1
  `
  const companyName = companyRows[0]?.canonical_name
  if (!companyName) return false

  // Read current stage, derived from company_tags.manual_stage if set.
  const current = await db<{ manual_stage: string | null }>`
    SELECT manual_stage FROM company_tags
    WHERE  workspace_id = ${args.workspaceId}
      AND  company_name = ${companyName}
    LIMIT  1
  `
  if (current[0]?.manual_stage === CUSTOMER_WON_STAGE) return false
  const fromStage = current[0]?.manual_stage ?? null

  await db`
    INSERT INTO company_tags (workspace_id, company_name, manual_stage, updated_at)
    VALUES (${args.workspaceId}, ${companyName}, ${CUSTOMER_WON_STAGE}, NOW())
    ON CONFLICT (workspace_id, company_name)
    DO UPDATE SET manual_stage = EXCLUDED.manual_stage, updated_at = NOW()
  `
  await db`
    INSERT INTO company_stage_transitions (
      workspace_id, company_name, from_stage, to_stage, trigger
    )
    VALUES (
      ${args.workspaceId}, ${companyName}, ${fromStage}, ${CUSTOMER_WON_STAGE}, 'auto'
    )
  `
  return true
}

/**
 * Flow B: last subscription cancelled -> clear manual_stage, set
 * previous_customer_since, record transition with score-derived to_stage.
 * Idempotent - skips when previous_customer_since is already set AND
 * manual_stage is NULL (the company is already in the "previous customer"
 * state).
 */
export async function applyChurnTransition(args: {
  workspaceId: string
  gtmCompanyId: number
}): Promise<boolean> {
  if (!isDbConfigured()) return false
  const db = sql()

  const companyRows = await db<{ canonical_name: string }>`
    SELECT canonical_name FROM companies WHERE id = ${args.gtmCompanyId} LIMIT 1
  `
  const companyName = companyRows[0]?.canonical_name
  if (!companyName) return false

  // Derive the score-based stage from the company's contacts' signal_score sum.
  // Thresholds match contact-store.ts: <3 Prospect, 3-5 Signal Found, 6-25
  // Engaged, >=26 High Signal.
  const stageRow = await db<{ to_stage: string }>`
    WITH company_score AS (
      SELECT COALESCE(SUM(signal_score), 0)::int AS score
      FROM   contacts
      WHERE  workspace_id = ${args.workspaceId}
        AND  company_name = ${companyName}
    )
    SELECT CASE
      WHEN score >= 26 THEN 'High Signal'
      WHEN score >= 6  THEN 'Engaged'
      WHEN score >= 3  THEN 'Signal Found'
      ELSE 'Prospect'
    END AS to_stage
    FROM company_score
  `
  const toStage = stageRow[0]?.to_stage ?? "Prospect"

  // Idempotent: if already in the "previous customer" state, no-op.
  const tagRow = await db<{ manual_stage: string | null; previous_customer_since: Date | null }>`
    SELECT manual_stage, previous_customer_since
    FROM   company_tags
    WHERE  workspace_id = ${args.workspaceId}
      AND  company_name = ${companyName}
    LIMIT  1
  `
  if (tagRow[0] && tagRow[0].manual_stage === null && tagRow[0].previous_customer_since !== null) {
    return false
  }
  const fromStage = tagRow[0]?.manual_stage ?? null

  await db`
    INSERT INTO company_tags (
      workspace_id, company_name, manual_stage, previous_customer_since, updated_at
    )
    VALUES (
      ${args.workspaceId}, ${companyName}, NULL, NOW(), NOW()
    )
    ON CONFLICT (workspace_id, company_name)
    DO UPDATE SET manual_stage           = NULL,
                  previous_customer_since = NOW(),
                  updated_at              = NOW()
  `
  await db`
    INSERT INTO company_stage_transitions (
      workspace_id, company_name, from_stage, to_stage, trigger
    )
    VALUES (
      ${args.workspaceId}, ${companyName}, ${fromStage}, ${toStage}, 'auto'
    )
  `
  return true
}

// ─── Products / prices / invoices ────────────────────────────────────────────

export interface StripeProductRow {
  id:                number
  workspace_id:      string
  stripe_product_id: string
  name:              string | null
  description:       string | null
  active:            boolean
  name_history:      Array<{ name: string | null; observed_at: string; stripe_event_id?: string | null }>
  metadata:          Record<string, string>
  created_at:        Date
  updated_at:        Date
}

const PRODUCT_NAME_HISTORY_CAP = 50

/**
 * Upsert a stripe_products row. When the name changed since the last write,
 * append a {name, observed_at, stripe_event_id} entry to name_history. The
 * array is capped at PRODUCT_NAME_HISTORY_CAP to keep the row bounded - if
 * a product is renamed more than that, oldest entries fall off (the audit
 * trail in name_history is a convenience, not the source of truth).
 */
export async function upsertStripeProduct(args: {
  workspaceId:     string
  product:         StripeProduct
  stripeEventId?:  string
}): Promise<StripeProductRow> {
  if (!isDbConfigured()) throw new Error("DB not configured")
  const db = sql()
  const { workspaceId, product, stripeEventId } = args
  const name = product.name?.trim() || null

  const existing = await db<StripeProductRow>`
    SELECT * FROM stripe_products
    WHERE  workspace_id      = ${workspaceId}
      AND  stripe_product_id = ${product.id}
    LIMIT  1
  `
  if (!existing[0]) {
    const seedHistory = [{
      name,
      observed_at: new Date().toISOString(),
      stripe_event_id: stripeEventId ?? null,
    }]
    const rows = await db<StripeProductRow>`
      INSERT INTO stripe_products (
        workspace_id, stripe_product_id, name, description, active,
        name_history, metadata
      )
      VALUES (
        ${workspaceId}, ${product.id}, ${name}, ${product.description ?? null}, ${product.active},
        ${JSON.stringify(seedHistory)}::jsonb,
        ${JSON.stringify(product.metadata ?? {})}::jsonb
      )
      RETURNING *
    `
    return rows[0]
  }

  const renamed = (existing[0].name ?? null) !== name
  let nextHistory = existing[0].name_history ?? []
  if (renamed) {
    nextHistory = [...nextHistory, {
      name,
      observed_at: new Date().toISOString(),
      stripe_event_id: stripeEventId ?? null,
    }]
    if (nextHistory.length > PRODUCT_NAME_HISTORY_CAP) {
      nextHistory = nextHistory.slice(-PRODUCT_NAME_HISTORY_CAP)
    }
  }

  const rows = await db<StripeProductRow>`
    UPDATE stripe_products
    SET    name         = ${name},
           description  = ${product.description ?? null},
           active       = ${product.active},
           name_history = ${JSON.stringify(nextHistory)}::jsonb,
           metadata     = ${JSON.stringify(product.metadata ?? {})}::jsonb,
           updated_at   = NOW()
    WHERE  id = ${existing[0].id}
    RETURNING *
  `
  return rows[0]
}

export interface StripePriceRow {
  id:                  number
  workspace_id:        string
  stripe_price_id:     string
  stripe_product_row:  number
  stripe_product_id:   string
  nickname:            string | null
  currency:            string
  unit_amount_cents:   number | null
  interval:            string | null
  active:              boolean
  created_at:          Date
  updated_at:          Date
}

/**
 * Upsert a stripe_prices row. Requires the product to already exist in
 * stripe_products (caller's responsibility - typically the webhook handler
 * upserts the product first, then the price).
 */
export async function upsertStripePrice(args: {
  workspaceId: string
  price:       StripePriceFull
}): Promise<StripePriceRow | null> {
  if (!isDbConfigured()) throw new Error("DB not configured")
  const db = sql()
  const { workspaceId, price } = args

  const productRows = await db<{ id: number }>`
    SELECT id FROM stripe_products
    WHERE  workspace_id      = ${workspaceId}
      AND  stripe_product_id = ${price.product}
    LIMIT  1
  `
  if (!productRows[0]) {
    // Caller should upsert the product first. Returning null lets the
    // webhook handler queue a backfill (we'll catch it on the daily cron).
    return null
  }
  const productRowId = productRows[0].id
  const interval = price.recurring?.interval ?? null

  const rows = await db<StripePriceRow>`
    INSERT INTO stripe_prices (
      workspace_id, stripe_price_id, stripe_product_row, stripe_product_id,
      nickname, currency, unit_amount_cents, interval, active
    )
    VALUES (
      ${workspaceId}, ${price.id}, ${productRowId}, ${price.product},
      ${price.nickname ?? null}, ${price.currency}, ${price.unit_amount ?? null},
      ${interval}, ${price.active}
    )
    ON CONFLICT (workspace_id, stripe_price_id)
    DO UPDATE SET
      nickname          = EXCLUDED.nickname,
      currency          = EXCLUDED.currency,
      unit_amount_cents = EXCLUDED.unit_amount_cents,
      interval          = EXCLUDED.interval,
      active            = EXCLUDED.active,
      updated_at        = NOW()
    RETURNING *
  `
  return rows[0]
}

export interface StripeInvoiceRow {
  id:                       number
  workspace_id:             string
  stripe_invoice_id:        string
  stripe_customer_id:       number
  stripe_subscription_id:   number | null
  status:                   string
  currency:                 string
  subtotal_cents:           number
  tax_cents:                number
  discount_cents:           number
  total_cents:              number
  amount_paid_cents:        number
  amount_remaining_cents:   number
  hosted_invoice_url:       string | null
  stripe_created_at:        Date
  finalized_at:             Date | null
  paid_at:                  Date | null
  voided_at:                Date | null
  created_at:               Date
  updated_at:               Date
}

/**
 * Upsert an invoice and its lines.
 *
 * Lines are upserted individually rather than delete-then-reinsert: Stripe
 * delivers tightly-coupled invoice events (created / finalized / paid /
 * updated) in parallel, and a multi-statement DELETE+INSERT cycle races on
 * the (workspace_id, stripe_line_id) unique constraint, causing every
 * second event to 500 and require Stripe's auto-retry. ON CONFLICT DO UPDATE
 * makes line writes idempotent under concurrency at the cost of leaving
 * orphan rows when a proration line disappears between events - acceptable
 * because (a) Stripe rarely removes lines from finalized invoices, and (b)
 * stale lines can be cleaned up offline if a workspace ever sees the issue.
 *
 * Returns the invoice row; the line count is implicit (caller can re-read
 * stripe_invoice_lines if they need it).
 */
export async function upsertStripeInvoice(args: {
  workspaceId:        string
  invoice:            StripeInvoice
  stripeCustomerRowId: number
}): Promise<StripeInvoiceRow> {
  if (!isDbConfigured()) throw new Error("DB not configured")
  const db = sql()
  const { workspaceId, invoice, stripeCustomerRowId } = args

  // Resolve our subscription row id from the Stripe subscription id (if any).
  let subscriptionRowId: number | null = null
  if (invoice.subscription) {
    const r = await db<{ id: number }>`
      SELECT id FROM stripe_subscriptions
      WHERE  workspace_id           = ${workspaceId}
        AND  stripe_subscription_id = ${invoice.subscription}
      LIMIT  1
    `
    subscriptionRowId = r[0]?.id ?? null
  }

  const stripeCreatedAt = new Date(invoice.created * 1000)
  const finalizedAt = invoice.status_transitions.finalized_at ? new Date(invoice.status_transitions.finalized_at * 1000) : null
  const paidAt = invoice.status_transitions.paid_at ? new Date(invoice.status_transitions.paid_at * 1000) : null
  const voidedAt = invoice.status_transitions.voided_at ? new Date(invoice.status_transitions.voided_at * 1000) : null
  const discountCents = (invoice.total_discount_amounts ?? []).reduce((s, d) => s + (d.amount ?? 0), 0)

  const invoiceRows = await db<StripeInvoiceRow>`
    INSERT INTO stripe_invoices (
      workspace_id, stripe_invoice_id, stripe_customer_id, stripe_subscription_id,
      status, currency,
      subtotal_cents, tax_cents, discount_cents, total_cents,
      amount_paid_cents, amount_remaining_cents,
      hosted_invoice_url, stripe_created_at, finalized_at, paid_at, voided_at
    )
    VALUES (
      ${workspaceId}, ${invoice.id}, ${stripeCustomerRowId}, ${subscriptionRowId},
      ${invoice.status}, ${invoice.currency},
      ${invoice.subtotal}, ${invoice.tax ?? 0}, ${discountCents}, ${invoice.total},
      ${invoice.amount_paid}, ${invoice.amount_remaining},
      ${invoice.hosted_invoice_url ?? null}, ${stripeCreatedAt}, ${finalizedAt}, ${paidAt}, ${voidedAt}
    )
    ON CONFLICT (workspace_id, stripe_invoice_id)
    DO UPDATE SET
      stripe_subscription_id = EXCLUDED.stripe_subscription_id,
      status                 = EXCLUDED.status,
      currency               = EXCLUDED.currency,
      subtotal_cents         = EXCLUDED.subtotal_cents,
      tax_cents              = EXCLUDED.tax_cents,
      discount_cents         = EXCLUDED.discount_cents,
      total_cents            = EXCLUDED.total_cents,
      amount_paid_cents      = EXCLUDED.amount_paid_cents,
      amount_remaining_cents = EXCLUDED.amount_remaining_cents,
      hosted_invoice_url     = EXCLUDED.hosted_invoice_url,
      finalized_at           = EXCLUDED.finalized_at,
      paid_at                = EXCLUDED.paid_at,
      voided_at              = EXCLUDED.voided_at,
      updated_at             = NOW()
    RETURNING *
  `
  const invoiceRow = invoiceRows[0]

  // Upsert each line. See doc-comment on this function for why this is an
  // upsert rather than DELETE+INSERT.
  for (const line of invoice.lines.data) {
    let priceRowId: number | null = null
    if (line.price?.id) {
      const r = await db<{ id: number }>`
        SELECT id FROM stripe_prices
        WHERE  workspace_id    = ${workspaceId}
          AND  stripe_price_id = ${line.price.id}
        LIMIT  1
      `
      priceRowId = r[0]?.id ?? null
    }
    let lineSubscriptionRowId: number | null = subscriptionRowId
    if (line.subscription && line.subscription !== invoice.subscription) {
      const r = await db<{ id: number }>`
        SELECT id FROM stripe_subscriptions
        WHERE  workspace_id           = ${workspaceId}
          AND  stripe_subscription_id = ${line.subscription}
        LIMIT  1
      `
      lineSubscriptionRowId = r[0]?.id ?? null
    }
    const periodStart = line.period?.start ? new Date(line.period.start * 1000) : null
    const periodEnd   = line.period?.end   ? new Date(line.period.end * 1000)   : null
    await db`
      INSERT INTO stripe_invoice_lines (
        workspace_id, stripe_invoice_row, stripe_line_id, stripe_price_row,
        stripe_subscription_row, description, quantity, amount_cents, currency,
        period_start, period_end, proration
      )
      VALUES (
        ${workspaceId}, ${invoiceRow.id}, ${line.id}, ${priceRowId},
        ${lineSubscriptionRowId}, ${line.description ?? null}, ${line.quantity ?? 1},
        ${line.amount}, ${line.currency},
        ${periodStart}, ${periodEnd}, ${line.proration}
      )
      ON CONFLICT (workspace_id, stripe_line_id)
      DO UPDATE SET
        stripe_invoice_row      = EXCLUDED.stripe_invoice_row,
        stripe_price_row        = EXCLUDED.stripe_price_row,
        stripe_subscription_row = EXCLUDED.stripe_subscription_row,
        description             = EXCLUDED.description,
        quantity                = EXCLUDED.quantity,
        amount_cents            = EXCLUDED.amount_cents,
        currency                = EXCLUDED.currency,
        period_start            = EXCLUDED.period_start,
        period_end              = EXCLUDED.period_end,
        proration               = EXCLUDED.proration
    `
  }

  return invoiceRow
}
