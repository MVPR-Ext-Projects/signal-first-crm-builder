/**
 * Migration: add the influencers entity + the influencer↔prospect M2M.
 *
 * Influencers are first-class and SEPARATE from contacts. An influencer can be
 * a person (journalist, an individual a prospect follows) or an organization
 * (publication, news site, podcast). Many-to-many with contacts:
 *   influencer.influences  -> contacts        (by influencer_id)
 *   contact.influenced_by   -> influencers     (by contact_id)
 *
 * The existing contacts.influenced_by JSONB column stays as a denormalized
 * read-cache (drives the SDR "Influenced by" panel); influencer_influences is
 * the relational source of truth. MVPR writes journalists + publications into
 * influencers. See ADR-015.
 *
 * Idempotent. Safe to re-run.
 *
 * Usage:
 *   node scripts/migrate-add-influencers.mjs
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
  `CREATE TABLE IF NOT EXISTS influencers (
    id                  BIGSERIAL    PRIMARY KEY,
    workspace_id        TEXT         NOT NULL,
    kind                TEXT         NOT NULL,
    type                TEXT         NOT NULL,
    name                TEXT         NOT NULL,
    linkedin_url        TEXT,
    domain              TEXT,
    twitter_url         TEXT,
    website             TEXT,
    mvpr_journalist_id  TEXT,
    mvpr_publication_id TEXT,
    crm_influencer_id   TEXT,
    metadata            JSONB,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS influencers_workspace_linkedin_idx
    ON influencers (workspace_id, linkedin_url) WHERE linkedin_url IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS influencers_workspace_domain_idx
    ON influencers (workspace_id, domain) WHERE domain IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS influencers_workspace_mvpr_journalist_idx
    ON influencers (workspace_id, mvpr_journalist_id) WHERE mvpr_journalist_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS influencers_workspace_mvpr_publication_idx
    ON influencers (workspace_id, mvpr_publication_id) WHERE mvpr_publication_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS influencers_workspace_type_idx
    ON influencers (workspace_id, type)`,
  `CREATE INDEX IF NOT EXISTS influencers_workspace_name_idx
    ON influencers (workspace_id, name)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS influencers_workspace_crm_id_idx
    ON influencers (workspace_id, crm_influencer_id) WHERE crm_influencer_id IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS influencer_influences (
    workspace_id   TEXT        NOT NULL,
    influencer_id  BIGINT      NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
    contact_id     BIGINT      NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    source         TEXT,
    weight         INTEGER,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, influencer_id, contact_id)
  )`,

  `CREATE INDEX IF NOT EXISTS influencer_influences_contact_idx
    ON influencer_influences (workspace_id, contact_id)`,
  `CREATE INDEX IF NOT EXISTS influencer_influences_influencer_idx
    ON influencer_influences (workspace_id, influencer_id)`,
]

for (const s of statements) {
  process.stdout.write(`→ ${s.slice(0, 80).replace(/\s+/g, " ")}${s.length > 80 ? "…" : ""} `)
  await sql(s)
  console.log("✓")
}
console.log("\nMigration complete.")
