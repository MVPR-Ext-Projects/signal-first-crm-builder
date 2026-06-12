/**
 * Daily Stripe reconciliation cron.
 *
 * Walks every workspace with a configured Stripe connection and reads the
 * current customer / subscription state from the Stripe REST API, upserting
 * anything that's missing from our local stripe_customers /
 * stripe_subscriptions tables. This is the safety net for webhooks that
 * never landed (transient delivery failures, signature mismatches, etc.).
 *
 * Does NOT replay revenue events - the unique on (workspace_id,
 * stripe_event_id) is what guarantees idempotency, and only the webhook path
 * has the Stripe event id. Drift on the revenue_events table is a separate
 * follow-up if observed.
 *
 * Schedule: daily 04:45 UTC (after allocate-platform-cost at 04:00, before
 * email-freshness at 11:00). See vercel.json.
 *
 * Auth: Bearer CRON_SECRET. Same pattern as the other crons in this app.
 */

import { NextRequest, NextResponse } from "next/server"
import { isDbConfigured } from "@/lib/db"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { Redis } from "@upstash/redis"
import {
  listCustomers,
  listSubscriptions,
  listAllProducts,
  listAllPrices,
  listInvoicesSince,
  subscriptionMonthlyAmountCents,
} from "@/lib/stripe"
import {
  upsertStripeCustomer,
  upsertStripeSubscription,
  upsertStripeProduct,
  upsertStripePrice,
  upsertStripeInvoice,
} from "@/lib/db/stripe-store"

export async function GET(req: NextRequest) {
  return run(req)
}
export async function POST(req: NextRequest) {
  return run(req)
}

async function run(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DB not configured" }, { status: 500 })
  }

  const workspaceIds = await listWorkspaceIds()
  type Counts = { products: number; prices: number; customers: number; subscriptions: number; invoices: number; skipped?: string }
  const byWorkspace: Record<string, Counts> = {}
  let totals = { products: 0, prices: 0, customers: 0, subscriptions: 0, invoices: 0 }

  // Reconcile recent invoices only - going further back is expensive and
  // mostly redundant since invoices rarely mutate after paid_at.
  const invoiceSinceUnix = Math.floor(Date.now() / 1000) - 24 * 60 * 60

  for (const workspaceId of workspaceIds) {
    const config = await getWorkspaceConfig(workspaceId)
    const creds  = config?.stripe
    if (!creds?.apiKey) continue

    const counts: Counts = { products: 0, prices: 0, customers: 0, subscriptions: 0, invoices: 0 }
    try {
      // Order matters: products before prices (price FKs product), customers
      // before subscriptions (subscription FKs customer), customers/prices/
      // subscriptions before invoices (lines may FK any of them).
      for await (const p of listAllProducts(creds.apiKey)) {
        await upsertStripeProduct({ workspaceId, product: p })
        counts.products++
      }
      for await (const p of listAllPrices(creds.apiKey)) {
        await upsertStripePrice({ workspaceId, price: p })
        counts.prices++
      }
      for await (const c of listCustomers(creds.apiKey)) {
        await upsertStripeCustomer(workspaceId, c)
        counts.customers++
      }
      for await (const sub of listSubscriptions(creds.apiKey, { status: "all" })) {
        const customerRowId = await lookupCustomerRowId(workspaceId, sub.customer)
        if (!customerRowId) continue
        await upsertStripeSubscription({
          workspaceId,
          customerRowId,
          stripeSub:          sub,
          monthlyAmountCents: subscriptionMonthlyAmountCents(sub),
        })
        counts.subscriptions++
      }
      for await (const invoice of listInvoicesSince(creds.apiKey, invoiceSinceUnix)) {
        const customerRowId = await lookupCustomerRowId(workspaceId, invoice.customer)
        if (!customerRowId) continue
        await upsertStripeInvoice({
          workspaceId,
          invoice,
          stripeCustomerRowId: customerRowId,
        })
        counts.invoices++
      }
    } catch (err) {
      byWorkspace[workspaceId] = { ...counts, skipped: (err as Error).message }
      continue
    }
    byWorkspace[workspaceId] = counts
    totals.products      += counts.products
    totals.prices        += counts.prices
    totals.customers     += counts.customers
    totals.subscriptions += counts.subscriptions
    totals.invoices      += counts.invoices
  }

  console.log(`[cron/stripe-reconcile] reconciled products=${totals.products} prices=${totals.prices} customers=${totals.customers} subscriptions=${totals.subscriptions} invoices=${totals.invoices} across ${workspaceIds.length} workspaces`)

  return NextResponse.json({
    ok:        true,
    ...totals,
    byWorkspace,
  })
}

async function lookupCustomerRowId(workspaceId: string, stripeCustomerId: string): Promise<number | null> {
  const { sql } = await import("@/lib/db")
  const db = sql()
  const rows = await db<{ id: number }>`
    SELECT id FROM stripe_customers
    WHERE  workspace_id       = ${workspaceId}
      AND  stripe_customer_id = ${stripeCustomerId}
    LIMIT  1
  `
  return rows[0]?.id ?? null
}

/**
 * Enumerate workspace ids by scanning Redis for `workspace:<id>:config` keys.
 * There's no central index of workspaces in this app today - the same
 * pattern is used by other crons that need to iterate every workspace.
 */
async function listWorkspaceIds(): Promise<string[]> {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return []
  const redis = new Redis({
    url:   process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  })
  const ids: string[] = []
  let cursor = "0"
  do {
    const result: [string, string[]] = await redis.scan(cursor, { match: "workspace:*:config", count: 200 })
    const [next, batch] = result
    for (const k of batch) {
      const m = /^workspace:([^:]+):config$/.exec(k)
      if (m) ids.push(m[1])
    }
    cursor = next
    // Initial call passes "0" and then the loop runs until Redis hands back
    // "0" again, signalling end-of-scan.
    if (cursor === "0") break
  } while (true)
  return ids
}
