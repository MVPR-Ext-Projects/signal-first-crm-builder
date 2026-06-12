/**
 * POST /api/webhooks/[workspaceId]/stripe
 *
 * Inbound Stripe webhook for per-workspace revenue ingestion. Verifies the
 * Stripe-Signature header against WorkspaceConfig.stripe.webhookSecret, then
 * dispatches by event type into apps/web/lib/db/stripe-store.ts helpers.
 *
 * Auth: HMAC-SHA256 signature verification only. No cookie auth (Stripe
 * doesn't carry one). Workspace scoping is by URL slug.
 *
 * Idempotency: all event writes go through recordRevenueEvent() which
 * UNIQUE-conflicts on (workspace_id, stripe_event_id). A re-delivered event
 * is a no-op.
 *
 * Funnel side-effects:
 *   - First payment_succeeded -> applyFirstPaymentTransition (Customer Won).
 *   - Last active subscription canceled -> applyChurnTransition.
 *
 * Events we listen for (configure these on the Stripe webhook endpoint):
 *   customer.created / customer.updated
 *   customer.subscription.created / .updated / .deleted
 *   invoice.payment_succeeded
 *   invoice.payment_failed
 *   charge.refunded
 */

import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import {
  verifyWebhookSignature,
  subscriptionMonthlyAmountCents,
  getBalanceTransaction,
  getCharge,
  getProduct,
  type StripeCustomer,
  type StripeSubscription,
  type StripeInvoice,
  type StripeCharge,
  type StripeProduct,
  type StripePriceFull,
} from "@/lib/stripe"
import {
  upsertStripeCustomer,
  upsertStripeSubscription,
  recordRevenueEvent,
  isFirstPayment,
  countActiveSubscriptions,
  applyFirstPaymentTransition,
  applyChurnTransition,
  upsertStripeProduct,
  upsertStripePrice,
  upsertStripeInvoice,
} from "@/lib/db/stripe-store"
import { isDbConfigured, sql } from "@/lib/db"

interface StripeEvent {
  id:      string
  type:    string
  created: number
  data:    { object: unknown; previous_attributes?: Record<string, unknown> }
  livemode: boolean
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params

  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Unknown workspace" }, { status: 404 })

  const creds = config.stripe
  if (!creds?.apiKey) {
    return NextResponse.json({ error: "Stripe not configured for this workspace" }, { status: 400 })
  }
  if (!creds.webhookSecret) {
    return NextResponse.json(
      { error: "Stripe webhookSecret missing - cannot verify signature" },
      { status: 400 },
    )
  }

  const rawBody = await request.text()
  const sigHeader = request.headers.get("stripe-signature")
  const sigError = verifyWebhookSignature(rawBody, sigHeader, creds.webhookSecret)
  if (sigError) {
    console.warn(`[stripe-webhook] ${workspaceId} signature rejected: ${sigError}`)
    return NextResponse.json({ error: sigError }, { status: 400 })
  }

  let event: StripeEvent
  try {
    event = JSON.parse(rawBody) as StripeEvent
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DB not configured" }, { status: 500 })
  }

  try {
    await handleEvent(workspaceId, creds.apiKey, event)
    return NextResponse.json({ ok: true })
  } catch (err) {
    // Surface as a 500 so Stripe retries. Don't leak stack to the response.
    console.error(`[stripe-webhook] ${workspaceId} ${event.type} (${event.id}) failed:`, err)
    return NextResponse.json({ error: "Internal error processing webhook" }, { status: 500 })
  }
}

async function handleEvent(workspaceId: string, apiKey: string, event: StripeEvent): Promise<void> {
  const occurredAt = new Date(event.created * 1000)

  switch (event.type) {
    case "customer.created":
    case "customer.updated": {
      const customer = event.data.object as StripeCustomer
      await upsertStripeCustomer(workspaceId, customer)
      return
    }

    case "customer.subscription.created": {
      const sub = event.data.object as StripeSubscription
      const customerRow = await ensureStripeCustomer(workspaceId, apiKey, sub.customer)
      const monthly = subscriptionMonthlyAmountCents(sub)
      const subRow = await upsertStripeSubscription({
        workspaceId,
        customerRowId: customerRow.id,
        stripeSub:     sub,
        monthlyAmountCents: monthly,
      })
      await recordRevenueEvent({
        workspaceId,
        stripeCustomerId:    customerRow.id,
        stripeSubscriptionId: subRow.id,
        kind:                "subscription_started",
        mrrDeltaCents:       monthly,
        currency:            subRow.currency,
        stripeEventId:       event.id,
        occurredAt,
      })
      return
    }

    case "customer.subscription.updated": {
      const sub = event.data.object as StripeSubscription
      const customerRow = await ensureStripeCustomer(workspaceId, apiKey, sub.customer)
      const newMonthly = subscriptionMonthlyAmountCents(sub)

      // Read prior amount to compute the delta (expansion vs contraction).
      const db = sql()
      const prior = await db<{ unit_amount_cents: number; id: number }>`
        SELECT id, unit_amount_cents FROM stripe_subscriptions
        WHERE  workspace_id           = ${workspaceId}
          AND  stripe_subscription_id = ${sub.id}
        LIMIT  1
      `
      const priorMonthly = prior[0]?.unit_amount_cents ?? 0
      const subRow = await upsertStripeSubscription({
        workspaceId,
        customerRowId: customerRow.id,
        stripeSub:     sub,
        monthlyAmountCents: newMonthly,
      })

      const delta = newMonthly - priorMonthly
      if (delta !== 0) {
        await recordRevenueEvent({
          workspaceId,
          stripeCustomerId:     customerRow.id,
          stripeSubscriptionId: subRow.id,
          kind:                 delta > 0 ? "expansion" : "contraction",
          mrrDeltaCents:        delta,
          currency:             subRow.currency,
          stripeEventId:        event.id,
          occurredAt,
        })
      }
      return
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as StripeSubscription
      const customerRow = await ensureStripeCustomer(workspaceId, apiKey, sub.customer)
      const priorMonthly = subscriptionMonthlyAmountCents(sub)
      const subRow = await upsertStripeSubscription({
        workspaceId,
        customerRowId: customerRow.id,
        stripeSub:     sub,
        monthlyAmountCents: priorMonthly,
      })
      await recordRevenueEvent({
        workspaceId,
        stripeCustomerId:    customerRow.id,
        stripeSubscriptionId: subRow.id,
        kind:                "churn",
        mrrDeltaCents:       -priorMonthly,
        currency:            subRow.currency,
        stripeEventId:       event.id,
        occurredAt,
      })

      // If this was the last active subscription on the customer AND the
      // customer is matched to a gtm-os company, run the churn transition.
      const remaining = await countActiveSubscriptions(customerRow.id)
      if (remaining === 0 && customerRow.gtm_company_id) {
        await applyChurnTransition({
          workspaceId,
          gtmCompanyId: customerRow.gtm_company_id,
        })
      }
      return
    }

    case "invoice.payment_succeeded": {
      const invoice = event.data.object as StripeInvoice
      const customerRow = await ensureStripeCustomer(workspaceId, apiKey, invoice.customer)

      // Map invoice.subscription -> our subscription row, if present.
      let subscriptionRowId: number | null = null
      if (invoice.subscription) {
        const db = sql()
        const r = await db<{ id: number }>`
          SELECT id FROM stripe_subscriptions
          WHERE  workspace_id           = ${workspaceId}
            AND  stripe_subscription_id = ${invoice.subscription}
          LIMIT  1
        `
        subscriptionRowId = r[0]?.id ?? null
      }

      // Net amount: gross minus Stripe fee. Sourced from the charge's
      // balance_transaction. If we can't fetch it (no charge yet, or REST
      // call fails), fall back to amount_paid as the basis.
      const { gross, net, currency } = await readInvoiceAmounts(apiKey, invoice)
      const inserted = await recordRevenueEvent({
        workspaceId,
        stripeCustomerId:    customerRow.id,
        stripeSubscriptionId: subscriptionRowId,
        kind:                "payment_succeeded",
        grossAmountCents:    gross,
        netAmountCents:      net,
        currency,
        stripeEventId:       event.id,
        occurredAt,
      })

      // Customer Won transition - only on the FIRST successful payment AND
      // when the customer is matched to a gtm-os company. inserted is null
      // when the event was already recorded (idempotent re-delivery).
      if (inserted && customerRow.gtm_company_id) {
        const isFirst = await isFirstPayment(customerRow.id, inserted.id)
        if (isFirst) {
          await applyFirstPaymentTransition({
            workspaceId,
            gtmCompanyId: customerRow.gtm_company_id,
          })
        }
      }
      return
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as StripeInvoice
      const customerRow = await ensureStripeCustomer(workspaceId, apiKey, invoice.customer)
      await recordRevenueEvent({
        workspaceId,
        stripeCustomerId:    customerRow.id,
        stripeSubscriptionId: null,
        kind:                "payment_failed",
        grossAmountCents:    invoice.total,
        currency:            invoice.currency,
        stripeEventId:       event.id,
        occurredAt,
      })
      return
    }

    case "charge.refunded": {
      const charge = event.data.object as StripeCharge
      if (!charge.customer) return
      const customerRow = await ensureStripeCustomer(workspaceId, apiKey, charge.customer)
      await recordRevenueEvent({
        workspaceId,
        stripeCustomerId:    customerRow.id,
        stripeSubscriptionId: null,
        kind:                "payment_refunded",
        grossAmountCents:    -charge.amount_refunded,
        netAmountCents:      -charge.amount_refunded, // ignoring fee reversal nuance
        currency:            charge.currency,
        stripeEventId:       event.id,
        occurredAt,
      })
      return
    }

    case "product.created":
    case "product.updated":
    case "product.deleted": {
      const product = event.data.object as StripeProduct
      // product.deleted carries active=false; the upsert preserves the row
      // so historical references (prices, invoice lines) stay valid.
      await upsertStripeProduct({ workspaceId, product, stripeEventId: event.id })
      return
    }

    case "price.created":
    case "price.updated":
    case "price.deleted": {
      const price = event.data.object as StripePriceFull
      // Make sure the parent product row exists before inserting the price.
      const stored = await upsertStripePrice({ workspaceId, price })
      if (stored === null) {
        // Parent product unknown - backfill via REST, then retry.
        try {
          const product = await getProduct(apiKey, price.product)
          await upsertStripeProduct({ workspaceId, product, stripeEventId: event.id })
          await upsertStripePrice({ workspaceId, price })
        } catch (err) {
          console.warn(`[stripe-webhook] ${workspaceId} couldn't backfill product ${price.product} for price ${price.id}:`, err)
        }
      }
      return
    }

    case "invoice.created":
    case "invoice.finalized":
    case "invoice.updated":
    case "invoice.paid":
    case "invoice.voided":
    case "invoice.marked_uncollectible": {
      const invoice = event.data.object as StripeInvoice
      const customerRow = await ensureStripeCustomer(workspaceId, apiKey, invoice.customer)
      await upsertStripeInvoice({
        workspaceId,
        invoice,
        stripeCustomerRowId: customerRow.id,
      })
      return
    }

    default:
      // Subscribed-to but not yet handled. Log and ignore.
      console.log(`[stripe-webhook] ${workspaceId} ignoring event type: ${event.type}`)
  }
}

/**
 * Get or create the stripe_customers row for a Stripe customer id. Stripe
 * sometimes emits subscription/invoice events before the customer.created
 * event lands - in that case we GET /customers/<id> to backfill.
 */
async function ensureStripeCustomer(
  workspaceId: string,
  apiKey:      string,
  stripeCustomerId: string,
) {
  const db = sql()
  const existing = await db<{
    id:                 number
    workspace_id:       string
    stripe_customer_id: string
    gtm_company_id:     number | null
    email:              string | null
    name:               string | null
    match_method:       string
    matched_at:         Date | null
    created_at:         Date
    updated_at:         Date
  }>`
    SELECT * FROM stripe_customers
    WHERE  workspace_id       = ${workspaceId}
      AND  stripe_customer_id = ${stripeCustomerId}
    LIMIT  1
  `
  if (existing[0]) return existing[0]

  // Backfill via REST.
  const { getCustomer } = await import("@/lib/stripe")
  const fetched = await getCustomer(apiKey, stripeCustomerId)
  return upsertStripeCustomer(workspaceId, fetched)
}

async function readInvoiceAmounts(apiKey: string, invoice: StripeInvoice): Promise<{
  gross:    number
  net:      number | null
  currency: string
}> {
  const gross = invoice.amount_paid
  if (!invoice.charge) {
    return { gross, net: null, currency: invoice.currency }
  }
  try {
    const charge = await getCharge(apiKey, invoice.charge)
    if (!charge.balance_transaction) return { gross, net: null, currency: invoice.currency }
    const txn = await getBalanceTransaction(apiKey, charge.balance_transaction)
    return { gross, net: txn.net, currency: invoice.currency }
  } catch (err) {
    console.warn(`[stripe-webhook] readInvoiceAmounts (${invoice.id}) couldn't fetch net amount:`, err)
    return { gross, net: null, currency: invoice.currency }
  }
}
