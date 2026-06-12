/**
 * Migration: add the lifecycle + DNC + enrichment-candidates columns
 *           on contacts (Phase 0 leftovers from the dedup master plan).
 *
 * Strictly additive — every column is nullable or has a sensible default.
 * Idempotent — safe to re-run.
 *
 * Columns added:
 *
 *   corporate_email_*               Corporate-email lifecycle. The
 *                                   contact's `email` column stays as
 *                                   "any email we have"; corporate_email
 *                                   is specifically the validated
 *                                   corporate one. NULL when we don't
 *                                   have one (yet). status moves through
 *                                   confirmed → stale (cron) → either
 *                                   re-confirmed or not_found.
 *
 *   linkedin_url_*                  LinkedIn URL lifecycle. Active URLs
 *                                   don't decay; inactive flagged when
 *                                   Unipile fails to resolve / DMs hard-
 *                                   fail (policy: 2 hard fails in 48h).
 *
 *   do_not_contact_*                DNC marker. Set when AI classifier
 *                                   detects "not interested" intent in
 *                                   first reply, on bounce/complain, or
 *                                   manually. Decays at do_not_contact_until.
 *                                   `do_not_contact_source` is free-text
 *                                   (non-enum) per Tom's call — accommodates
 *                                   future channels without schema migration.
 *
 *   company_status                  "departed" when call notes flag the
 *                                   contact as no longer at the company.
 *                                   NULL otherwise (current employee).
 *
 *   needs_enrichment / reason       Drives the Enrichment Candidates page.
 *                                   Set by LinkedIn-URL invalidation, email
 *                                   freshness cron, or "no longer at company"
 *                                   detection.
 *
 * Indexes:
 *
 *   contacts_dnc_active_idx         Speeds up "is this contact currently
 *                                   DNC'd?" filters in outbound campaign
 *                                   builders.
 *
 *   contacts_needs_enrichment_idx   Speeds up the Enrichment Candidates
 *                                   page query.
 *
 * Usage:
 *   node scripts/migrate-add-lifecycle-and-dnc-columns.mjs
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
  console.error("✗ Missing DATABASE_URL")
  process.exit(1)
}

const sql = neon(process.env.DATABASE_URL)

const statements = [
  // ── Corporate email lifecycle ───────────────────────────────────────
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS corporate_email                TEXT`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS corporate_email_status         TEXT`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS corporate_email_confirmed_at   TIMESTAMPTZ`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS corporate_email_invalidated_at TIMESTAMPTZ`,

  // ── LinkedIn URL lifecycle ──────────────────────────────────────────
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS linkedin_url_status            TEXT`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS linkedin_url_confirmed_at      TIMESTAMPTZ`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS linkedin_url_invalidated_at    TIMESTAMPTZ`,

  // ── Do-Not-Contact marker ───────────────────────────────────────────
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS do_not_contact                       BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS do_not_contact_until                 TIMESTAMPTZ`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS do_not_contact_reason_classification TEXT`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS do_not_contact_reason_snippet        TEXT`,
  // Free-text on purpose (not an enum) so future channels can land here
  // without a schema migration. Conventional values today:
  // 'linkedin_dm', 'email', 'manual'.
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS do_not_contact_source                TEXT`,

  // ── Departed-from-company flag (Phase 5 — call-note "no longer here") ─
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_status                 TEXT`,

  // ── Enrichment Candidates page ──────────────────────────────────────
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS needs_enrichment               BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS enrichment_reason              TEXT`,

  // ── Indexes ─────────────────────────────────────────────────────────
  // Active-DNC filter. Partial index on rows where do_not_contact_until
  // is set; the runtime query adds AND do_not_contact_until > now().
  `CREATE INDEX IF NOT EXISTS contacts_dnc_active_idx
     ON contacts (workspace_id, do_not_contact_until)
     WHERE do_not_contact_until IS NOT NULL`,

  // Enrichment Candidates page query. Partial — only the rows we care
  // about, kept small relative to the contact table.
  `CREATE INDEX IF NOT EXISTS contacts_needs_enrichment_idx
     ON contacts (workspace_id, updated_at DESC)
     WHERE needs_enrichment`,

  // Freshness-cron support — find confirmed corporate emails that haven't
  // been re-validated in a while.
  `CREATE INDEX IF NOT EXISTS contacts_corporate_email_stale_idx
     ON contacts (workspace_id, corporate_email_confirmed_at)
     WHERE corporate_email_status = 'confirmed'`,
]

for (const s of statements) {
  process.stdout.write(`→ ${s.slice(0, 80).replace(/\s+/g, " ")}${s.length > 80 ? "…" : ""} `)
  await sql(s)
  console.log("✓")
}
console.log("\nMigration complete.")
