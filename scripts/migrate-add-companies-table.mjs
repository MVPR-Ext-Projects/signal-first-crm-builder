/**
 * Migration: add the companies table + new contact columns for the dedup
 * waterfalls. Phase 0 of the gtm-os dedup master plan.
 *
 * What this adds:
 *   - companies                              (new table, identity-ranked: linkedin_url > domain > canonical_name)
 *   - companies_workspace_linkedin_idx       (UNIQUE partial — race protection)
 *   - companies_workspace_domain_idx         (UNIQUE partial — race protection)
 *   - companies_workspace_name_idx           (lookup index for fallback step 3)
 *   - contacts.gtm_company_id                (BIGINT FK to companies.id; populated by Phase 2)
 *   - contacts.company_domain                (TEXT — captured from Dripify companyWebsite + Teamfluence company.domain)
 *   - contacts.company_website               (TEXT — raw website URL when supplied)
 *   - contacts_workspace_gtm_company_idx     (lookup index for dashboard joins)
 *
 * Note on naming: a `company_id TEXT` column already exists on contacts and is
 * used for the Attio company record_id (also Surfe's company id in some paths).
 * To avoid the clash this migration adds `gtm_company_id BIGINT` as the FK to
 * the new internal companies table. Renaming the existing column to
 * `attio_company_id` is part of the separate Attio restructure work.
 *
 * Idempotent — safe to run multiple times. Strictly additive: no drops, no
 * renames, no constraint tightening that would break existing data.
 *
 * Usage:
 *   node scripts/migrate-add-companies-table.mjs
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
  `CREATE TABLE IF NOT EXISTS companies (
    id                  BIGSERIAL    PRIMARY KEY,
    workspace_id        TEXT         NOT NULL,
    -- Identity columns, ranked strongest → weakest by the Companies waterfall:
    --   1. linkedin_url   linkedin.com/company/<slug>, normalized at write
    --   2. domain         e.g. example.com, normalized (lowercase, no www, no protocol)
    --   3. canonical_name lowercase + trimmed + legal-suffixes stripped
    -- Any of the three may be NULL on creation; the unique partial indexes
    -- below enforce one row per (workspace, linkedin_url) and (workspace, domain)
    -- where present, so the race "two webhooks both miss the find and try to
    -- insert" resolves cleanly via INSERT ... ON CONFLICT DO NOTHING + re-SELECT.
    linkedin_url        TEXT,
    domain              TEXT,
    canonical_name      TEXT         NOT NULL,
    raw_name            TEXT         NOT NULL,
    -- Parent/child relationship for regional offices (e.g. Acme APAC →
    -- Acme). Populated by a separate heuristic / human review, not by the
    -- waterfall itself. Always nullable, always overridable.
    parent_company_id   BIGINT,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS companies_workspace_linkedin_idx
    ON companies (workspace_id, linkedin_url)
    WHERE linkedin_url IS NOT NULL`,

  `CREATE UNIQUE INDEX IF NOT EXISTS companies_workspace_domain_idx
    ON companies (workspace_id, domain)
    WHERE domain IS NOT NULL`,

  `CREATE INDEX IF NOT EXISTS companies_workspace_name_idx
    ON companies (workspace_id, canonical_name)`,

  `CREATE INDEX IF NOT EXISTS companies_parent_idx
    ON companies (parent_company_id)
    WHERE parent_company_id IS NOT NULL`,

  // New contact columns. gtm_company_id intentionally distinct from the
  // existing company_id (which is the Attio record_id / Surfe id and will be
  // renamed to attio_company_id by the Attio restructure work).
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS gtm_company_id BIGINT`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_domain TEXT`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_website TEXT`,

  `CREATE INDEX IF NOT EXISTS contacts_workspace_gtm_company_idx
    ON contacts (workspace_id, gtm_company_id)
    WHERE gtm_company_id IS NOT NULL`,
]

for (const s of statements) {
  process.stdout.write(`→ ${s.slice(0, 80).replace(/\s+/g, " ")}${s.length > 80 ? "…" : ""} `)
  await sql(s)
  console.log("✓")
}
console.log("\nMigration complete.")
