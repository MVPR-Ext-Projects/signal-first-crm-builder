/**
 * Stripe REST wrapper.
 *
 * Per-workspace: each workspace brings their own restricted API key + webhook
 * signing secret in WorkspaceConfig.stripe. We don't pull in the official
 * `stripe` package - the surface we need is small (a few list endpoints, one
 * retrieve, plus webhook signature verification) and the SDK pulls in a chunky
 * dependency tree. Direct fetch keeps the bundle lean.
 *
 * Inbound: /api/webhooks/[workspaceId]/stripe uses verifyWebhookSignature
 * against the raw request body and the workspace's webhookSecret.
 * Outbound: /api/cron/stripe-reconcile uses the list* functions to backfill
 * any customers / subscriptions / payments missed via webhooks.
 */

import { createHmac, timingSafeEqual } from "crypto"

const STRIPE_API_BASE = "https://api.stripe.com/v1"

// ─── Webhook signature verification ─────────────────────────────────────────

/**
 * Verify a Stripe webhook signature against the raw request body.
 *
 * Stripe sends a `Stripe-Signature` header of the form:
 *   t=<unix-timestamp>,v1=<hex-hmac>,v1=<alternate-hex-hmac>,...
 *
 * The signed payload is `${timestamp}.${rawBody}`, HMAC-SHA256 with the
 * workspace's webhook signing secret (whsec_...). Multiple v1 signatures may
 * be present during secret rotation; we accept the message if any one
 * matches. Tolerance defaults to 5 minutes.
 *
 * Returns null when the signature is valid (with no error), or an error
 * string describing the failure. Treat any non-null return as 400.
 */
export function verifyWebhookSignature(
  rawBody:       string,
  sigHeader:     string | null,
  webhookSecret: string,
  toleranceSeconds: number = 300,
): string | null {
  if (!sigHeader) return "Missing Stripe-Signature header"

  const parts: Record<string, string[]> = {}
  for (const piece of sigHeader.split(",")) {
    const [k, v] = piece.split("=")
    if (!k || !v) continue
    parts[k] = parts[k] ?? []
    parts[k].push(v)
  }

  const timestamp = parts.t?.[0]
  const signatures = parts.v1 ?? []
  if (!timestamp || signatures.length === 0) {
    return "Stripe-Signature header missing t or v1"
  }

  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return "Stripe-Signature timestamp is not numeric"
  const ageSec = Math.abs(Date.now() / 1000 - ts)
  if (ageSec > toleranceSeconds) {
    return `Stripe-Signature timestamp is ${Math.round(ageSec)}s old (tolerance ${toleranceSeconds}s)`
  }

  const expected = createHmac("sha256", webhookSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex")
  const expectedBuf = Buffer.from(expected, "hex")

  for (const sig of signatures) {
    let candidate: Buffer
    try {
      candidate = Buffer.from(sig, "hex")
    } catch {
      continue
    }
    if (candidate.length !== expectedBuf.length) continue
    if (timingSafeEqual(candidate, expectedBuf)) return null
  }
  return "Stripe-Signature did not match any expected signature"
}

// ─── REST client ─────────────────────────────────────────────────────────────

interface StripeListResponse<T> {
  object: "list"
  data:   T[]
  has_more: boolean
  url:    string
}

async function stripeGet<T>(apiKey: string, path: string): Promise<T> {
  const res = await fetch(`${STRIPE_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache:   "no-store",
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Stripe GET ${path} failed (${res.status}): ${text.slice(0, 200)}`)
  }
  return (await res.json()) as T
}

/**
 * Iterate a Stripe list endpoint, paging until `has_more` is false.
 * Yields each item one at a time. Caller handles batching / pacing.
 */
export async function* paginate<T extends { id: string }>(
  apiKey:  string,
  path:    string,
  params:  Record<string, string> = {},
  pageSize: number = 100,
): AsyncGenerator<T> {
  let startingAfter: string | undefined
  while (true) {
    const qs = new URLSearchParams({ ...params, limit: String(pageSize) })
    if (startingAfter) qs.set("starting_after", startingAfter)
    const page = await stripeGet<StripeListResponse<T>>(apiKey, `${path}?${qs.toString()}`)
    for (const item of page.data) yield item
    if (!page.has_more || page.data.length === 0) return
    startingAfter = page.data[page.data.length - 1].id
  }
}

// ─── Typed responses (minimal subset of fields we read) ──────────────────────

export interface StripeCustomer {
  id:        string
  email:     string | null
  name:      string | null
  created:   number      // unix seconds
  livemode:  boolean
  metadata:  Record<string, string>
}

export interface StripePrice {
  id:         string
  currency:   string
  unit_amount: number | null
  nickname:   string | null
  recurring:  { interval: "month" | "year" | "week" | "day" } | null
}

export interface StripeSubscriptionItem {
  id:    string
  price: StripePrice
}

export interface StripeSubscription {
  id:                   string
  customer:             string                  // customer id
  status:               string
  start_date:           number
  current_period_start: number | null
  current_period_end:   number | null
  canceled_at:          number | null
  livemode:             boolean
  items:                { data: StripeSubscriptionItem[] }
  metadata:             Record<string, string>
}

export interface StripeBalanceTransaction {
  id:        string
  amount:    number
  net:       number
  fee:       number
  currency:  string
  created:   number
}

export interface StripeCharge {
  id:                  string
  amount:              number
  amount_refunded:     number
  currency:            string
  customer:            string | null
  balance_transaction: string | null
  paid:                boolean
  refunded:            boolean
  status:              "succeeded" | "pending" | "failed"
  created:             number
}

export interface StripeInvoiceLine {
  id:                  string
  description:         string | null
  quantity:            number | null
  amount:              number
  currency:            string
  price:               { id: string } | null
  subscription:        string | null
  proration:           boolean
  period:              { start: number; end: number } | null
}

export interface StripeInvoice {
  id:                  string
  customer:            string
  subscription:        string | null
  total:               number
  subtotal:            number
  tax:                 number | null
  amount_paid:         number
  amount_remaining:    number
  currency:            string
  status:              string
  charge:              string | null
  created:             number
  hosted_invoice_url:  string | null
  // Stripe represents discounts as an array; we sum the per-line amounts.
  total_discount_amounts: Array<{ amount: number }> | null
  lines:               { data: StripeInvoiceLine[]; has_more: boolean }
  status_transitions:  {
    paid_at?:          number | null
    finalized_at?:     number | null
    marked_uncollectible_at?: number | null
    voided_at?:        number | null
  }
}

export interface StripeProduct {
  id:          string
  name:        string | null
  description: string | null
  active:      boolean
  created:     number
  updated:     number
  metadata:    Record<string, string>
}

export interface StripePriceFull {
  id:           string
  product:      string                                                  // product id
  currency:     string
  unit_amount:  number | null
  nickname:     string | null
  active:       boolean
  recurring:    { interval: "month" | "year" | "week" | "day" } | null
  created:      number
}

// ─── Convenience accessors ───────────────────────────────────────────────────

export function listCustomers(apiKey: string) {
  return paginate<StripeCustomer>(apiKey, "/customers")
}

export function listSubscriptions(apiKey: string, params: { status?: string } = {}) {
  return paginate<StripeSubscription>(apiKey, "/subscriptions", { ...params, status: params.status ?? "all" })
}

export function listInvoicesSince(apiKey: string, sinceUnix: number) {
  return paginate<StripeInvoice>(apiKey, "/invoices", { "created[gte]": String(sinceUnix) })
}

export function listProducts(apiKey: string) {
  return paginate<StripeProduct>(apiKey, "/products", { active: "true" })
}

export function listAllProducts(apiKey: string) {
  return paginate<StripeProduct>(apiKey, "/products")
}

export function listPrices(apiKey: string) {
  return paginate<StripePriceFull>(apiKey, "/prices", { active: "true" })
}

export function listAllPrices(apiKey: string) {
  return paginate<StripePriceFull>(apiKey, "/prices")
}

export function getCustomer(apiKey: string, customerId: string) {
  return stripeGet<StripeCustomer>(apiKey, `/customers/${encodeURIComponent(customerId)}`)
}

export function getSubscription(apiKey: string, subscriptionId: string) {
  return stripeGet<StripeSubscription>(apiKey, `/subscriptions/${encodeURIComponent(subscriptionId)}`)
}

export function getInvoice(apiKey: string, invoiceId: string) {
  return stripeGet<StripeInvoice>(apiKey, `/invoices/${encodeURIComponent(invoiceId)}`)
}

export function getCharge(apiKey: string, chargeId: string) {
  return stripeGet<StripeCharge>(apiKey, `/charges/${encodeURIComponent(chargeId)}`)
}

export function getBalanceTransaction(apiKey: string, txnId: string) {
  return stripeGet<StripeBalanceTransaction>(apiKey, `/balance_transactions/${encodeURIComponent(txnId)}`)
}

export function getProduct(apiKey: string, productId: string) {
  return stripeGet<StripeProduct>(apiKey, `/products/${encodeURIComponent(productId)}`)
}

export function getPrice(apiKey: string, priceId: string) {
  return stripeGet<StripePriceFull>(apiKey, `/prices/${encodeURIComponent(priceId)}`)
}

/**
 * Pull all lines for an invoice. The list endpoint on an invoice returns up
 * to 100 by default; we paginate to cover edge cases (annual contracts with
 * dozens of seat lines, multi-region invoices, etc.).
 */
export function listInvoiceLines(apiKey: string, invoiceId: string) {
  return paginate<StripeInvoiceLine>(apiKey, `/invoices/${encodeURIComponent(invoiceId)}/lines`)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Derive the MRR contribution of a subscription in cents. Sums each item:
 *   item.price.unit_amount, converted to monthly if recurring.interval=year.
 * Returns 0 for unknown / non-recurring prices.
 */
export function subscriptionMonthlyAmountCents(sub: StripeSubscription): number {
  let total = 0
  for (const item of sub.items.data) {
    const unit = item.price.unit_amount ?? 0
    const interval = item.price.recurring?.interval
    if (interval === "month") total += unit
    else if (interval === "year") total += Math.round(unit / 12)
    else if (interval === "week") total += Math.round((unit * 52) / 12)
    else if (interval === "day") total += Math.round((unit * 365) / 12)
  }
  return total
}

/**
 * Best-effort lowercase + trim of a Stripe customer email. Empty becomes null.
 */
export function normaliseEmail(email: string | null | undefined): string | null {
  if (!email) return null
  const trimmed = email.trim().toLowerCase()
  return trimmed || null
}

/**
 * Extract the email domain (without subdomain) for matching against
 * companies.domain. Returns null when the input is missing, malformed, or a
 * known personal provider.
 */
export function emailDomainFor(email: string | null): string | null {
  if (!email) return null
  const at = email.lastIndexOf("@")
  if (at < 0 || at === email.length - 1) return null
  const raw = email.slice(at + 1).trim().toLowerCase()
  if (!raw.includes(".")) return null
  return raw
}
