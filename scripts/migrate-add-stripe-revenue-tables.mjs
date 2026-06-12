/**
 * Migration: Stripe revenue ingestion tables (Phase A).
 *
 * Per-workspace Stripe connections feed three tables that together let us
 * compute LTV, MRR, NDR and ACV per gtm-os company:
 *   stripe_customers       - bridge between Stripe Customer and gtm-os company
 *   stripe_subscriptions   - one row per Stripe Subscription (= "account")
 *   stripe_revenue_events  - append-only event stream (MRR + payment events)
 *
 * Plus an ALTER on company_tags adding previous_customer_since to mark
 * companies that have ever been a customer (set on churn, retained on
 * re-purchase).
 *
 * Strictly additive. Idempotent (CREATE TABLE / INDEX IF NOT EXISTS, ADD
 * COLUMN IF NOT EXISTS). Uses sql.query() per the post-tightening Neon
 * serverless SDK (see scripts/migrate-add-linkedin-invite-queue.mjs).
 *
 * Usage:
 *   node scripts/migrate-add-stripe-revenue-tables.mjs
 */

import { neon } from "@neondatabase/serverless"
import { config as loadEnv } from "dotenv"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(__dirname, "../.env.production.local") })
loadEnv({ path: resolve(__dirname, "../.env.local") })
loadEnv({ path: resolve(__dirname, "../apps/web/.env.production.local") })
loadEnv({ path: resolve(__dirname, "../apps/web/.env.local") })

if (!process.env.DATABASE_URL) {
  console.error("Missing DATABASE_URL")
  process.exit(1)
}

const sql = neon(process.env.DATABASE_URL)

const statements = [
  `CREATE TABLE IF NOT EXISTS stripe_customers (
    id                 BIGSERIAL    PRIMARY KEY,
    workspace_id       TEXT         NOT NULL,
    stripe_customer_id TEXT         NOT NULL,
    gtm_company_id     BIGINT       REFERENCES companies(id) ON DELETE SET NULL,
    email              TEXT,
    name               TEXT,
    match_method       TEXT         NOT NULL DEFAULT 'unmatched',
    matched_at         TIMESTAMPTZ,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, stripe_customer_id)
  )`,

  `CREATE INDEX IF NOT EXISTS stripe_customers_workspace_company_idx
     ON stripe_customers (workspace_id, gtm_company_id)
     WHERE gtm_company_id IS NOT NULL`,

  `CREATE INDEX IF NOT EXISTS stripe_customers_workspace_unmatched_idx
     ON stripe_customers (workspace_id, updated_at DESC)
     WHERE gtm_company_id IS NULL`,

  `CREATE TABLE IF NOT EXISTS stripe_subscriptions (
    id                     BIGSERIAL    PRIMARY KEY,
    workspace_id           TEXT         NOT NULL,
    stripe_customer_id     BIGINT       NOT NULL REFERENCES stripe_customers(id) ON DELETE CASCADE,
    stripe_subscription_id TEXT         NOT NULL,
    ordinal                INT          NOT NULL,
    plan_nickname          TEXT,
    unit_amount_cents      INT          NOT NULL,
    currency               TEXT         NOT NULL,
    interval               TEXT         NOT NULL,
    status                 TEXT         NOT NULL,
    started_at             TIMESTAMPTZ  NOT NULL,
    initial_term_ends_at   TIMESTAMPTZ  NOT NULL,
    canceled_at            TIMESTAMPTZ,
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, stripe_subscription_id)
  )`,

  `CREATE INDEX IF NOT EXISTS stripe_subscriptions_customer_idx
     ON stripe_subscriptions (stripe_customer_id, ordinal)`,

  `CREATE INDEX IF NOT EXISTS stripe_subscriptions_customer_active_idx
     ON stripe_subscriptions (stripe_customer_id)
     WHERE status NOT IN ('canceled', 'incomplete_expired')`,

  `CREATE TABLE IF NOT EXISTS stripe_revenue_events (
    id                     BIGSERIAL    PRIMARY KEY,
    workspace_id           TEXT         NOT NULL,
    stripe_customer_id     BIGINT       NOT NULL REFERENCES stripe_customers(id) ON DELETE CASCADE,
    stripe_subscription_id BIGINT       REFERENCES stripe_subscriptions(id) ON DELETE SET NULL,
    kind                   TEXT         NOT NULL,
    mrr_delta_cents        INT,
    gross_amount_cents     INT,
    net_amount_cents       INT,
    currency               TEXT,
    stripe_event_id        TEXT,
    occurred_at            TIMESTAMPTZ  NOT NULL,
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, stripe_event_id)
  )`,

  `CREATE INDEX IF NOT EXISTS stripe_revenue_events_customer_time_idx
     ON stripe_revenue_events (stripe_customer_id, occurred_at DESC)`,

  `CREATE INDEX IF NOT EXISTS stripe_revenue_events_workspace_kind_time_idx
     ON stripe_revenue_events (workspace_id, kind, occurred_at DESC)`,

  `CREATE INDEX IF NOT EXISTS stripe_revenue_events_customer_first_payment_idx
     ON stripe_revenue_events (stripe_customer_id, occurred_at)
     WHERE kind = 'payment_succeeded'`,

  `ALTER TABLE company_tags
     ADD COLUMN IF NOT EXISTS previous_customer_since TIMESTAMPTZ`,

  `CREATE INDEX IF NOT EXISTS company_tags_previous_customer_idx
     ON company_tags (workspace_id, previous_customer_since)
     WHERE previous_customer_since IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS stripe_products (
    id                BIGSERIAL    PRIMARY KEY,
    workspace_id      TEXT         NOT NULL,
    stripe_product_id TEXT         NOT NULL,
    name              TEXT,
    description       TEXT,
    active            BOOLEAN      NOT NULL DEFAULT TRUE,
    name_history      JSONB        NOT NULL DEFAULT '[]'::jsonb,
    metadata          JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, stripe_product_id)
  )`,

  `CREATE INDEX IF NOT EXISTS stripe_products_workspace_active_idx
     ON stripe_products (workspace_id, active)`,

  `CREATE TABLE IF NOT EXISTS stripe_prices (
    id                  BIGSERIAL    PRIMARY KEY,
    workspace_id        TEXT         NOT NULL,
    stripe_price_id     TEXT         NOT NULL,
    stripe_product_row  BIGINT       NOT NULL REFERENCES stripe_products(id) ON DELETE CASCADE,
    stripe_product_id   TEXT         NOT NULL,
    nickname            TEXT,
    currency            TEXT         NOT NULL,
    unit_amount_cents   INT,
    interval            TEXT,
    active              BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, stripe_price_id)
  )`,

  `CREATE INDEX IF NOT EXISTS stripe_prices_workspace_product_idx
     ON stripe_prices (workspace_id, stripe_product_row)`,

  `CREATE TABLE IF NOT EXISTS stripe_product_aliases (
    id                  BIGSERIAL    PRIMARY KEY,
    workspace_id        TEXT         NOT NULL,
    canonical_key       TEXT         NOT NULL,
    stripe_product_row  BIGINT       NOT NULL REFERENCES stripe_products(id) ON DELETE CASCADE,
    notes               TEXT,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, stripe_product_row)
  )`,

  `CREATE INDEX IF NOT EXISTS stripe_product_aliases_canonical_idx
     ON stripe_product_aliases (workspace_id, canonical_key)`,

  `CREATE TABLE IF NOT EXISTS stripe_invoices (
    id                     BIGSERIAL    PRIMARY KEY,
    workspace_id           TEXT         NOT NULL,
    stripe_invoice_id      TEXT         NOT NULL,
    stripe_customer_id     BIGINT       NOT NULL REFERENCES stripe_customers(id) ON DELETE CASCADE,
    stripe_subscription_id BIGINT       REFERENCES stripe_subscriptions(id) ON DELETE SET NULL,
    status                 TEXT         NOT NULL,
    currency               TEXT         NOT NULL,
    subtotal_cents         INT          NOT NULL DEFAULT 0,
    tax_cents              INT          NOT NULL DEFAULT 0,
    discount_cents         INT          NOT NULL DEFAULT 0,
    total_cents            INT          NOT NULL DEFAULT 0,
    amount_paid_cents      INT          NOT NULL DEFAULT 0,
    amount_remaining_cents INT          NOT NULL DEFAULT 0,
    hosted_invoice_url     TEXT,
    stripe_created_at      TIMESTAMPTZ  NOT NULL,
    finalized_at           TIMESTAMPTZ,
    paid_at                TIMESTAMPTZ,
    voided_at              TIMESTAMPTZ,
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, stripe_invoice_id)
  )`,

  `CREATE INDEX IF NOT EXISTS stripe_invoices_customer_time_idx
     ON stripe_invoices (stripe_customer_id, stripe_created_at DESC)`,

  `CREATE INDEX IF NOT EXISTS stripe_invoices_workspace_status_idx
     ON stripe_invoices (workspace_id, status, stripe_created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS stripe_invoice_lines (
    id                       BIGSERIAL    PRIMARY KEY,
    workspace_id             TEXT         NOT NULL,
    stripe_invoice_row       BIGINT       NOT NULL REFERENCES stripe_invoices(id) ON DELETE CASCADE,
    stripe_line_id           TEXT         NOT NULL,
    stripe_price_row         BIGINT       REFERENCES stripe_prices(id) ON DELETE SET NULL,
    stripe_subscription_row  BIGINT       REFERENCES stripe_subscriptions(id) ON DELETE SET NULL,
    description              TEXT,
    quantity                 INT          NOT NULL DEFAULT 1,
    amount_cents             INT          NOT NULL DEFAULT 0,
    currency                 TEXT         NOT NULL,
    period_start             TIMESTAMPTZ,
    period_end               TIMESTAMPTZ,
    proration                BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, stripe_line_id)
  )`,

  `CREATE INDEX IF NOT EXISTS stripe_invoice_lines_invoice_idx
     ON stripe_invoice_lines (stripe_invoice_row)`,

  `CREATE INDEX IF NOT EXISTS stripe_invoice_lines_price_idx
     ON stripe_invoice_lines (stripe_price_row)
     WHERE stripe_price_row IS NOT NULL`,
]

for (const s of statements) {
  process.stdout.write(`-> ${s.slice(0, 70).replace(/\s+/g, " ")}${s.length > 70 ? "..." : ""} `)
  await sql.query(s)
  console.log("OK")
}
console.log("\nMigration complete.")
