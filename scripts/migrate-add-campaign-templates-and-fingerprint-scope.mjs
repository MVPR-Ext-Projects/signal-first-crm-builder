/**
 * Migration: per-campaign editable templates + per-campaign writing-style
 * fingerprint scope.
 *
 * Adds:
 *   - campaign_templates                 - one row per template variant per campaign.
 *                                          LinkedIn DM uses { body }; Email + Newsletter
 *                                          use { subject, html, body } where body is
 *                                          the plain-text fallback.
 *   - style_fingerprints.campaign_id     - new column. NULL for non-campaign scopes.
 *     Active-uniqueness index rebuilt to include campaign_id in the COALESCE list so
 *     each (workspace, scope, channel, persona, campaign) cell can have exactly one
 *     active row.
 *
 * Resolution order at draft time (lib/style/fetch-fingerprints.ts) becomes
 *   corporate < channel < channel_persona < campaign
 * with campaign winning whenever a draft is made for a specific campaign and
 * a campaign-scope fingerprint exists.
 *
 * Idempotent. Strictly additive. Safe to run multiple times.
 *
 * Usage:
 *   node scripts/migrate-add-campaign-templates-and-fingerprint-scope.mjs
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
  `CREATE TABLE IF NOT EXISTS campaign_templates (
    id            TEXT         PRIMARY KEY,
    workspace_id  TEXT         NOT NULL,
    campaign_id   TEXT         NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    name          TEXT         NOT NULL,
    subject       TEXT,
    html          TEXT,
    body          TEXT         NOT NULL,
    is_default    BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS campaign_templates_workspace_campaign_idx
    ON campaign_templates (workspace_id, campaign_id)`,

  // Only one default per campaign. Partial unique index.
  `CREATE UNIQUE INDEX IF NOT EXISTS campaign_templates_default_uq
    ON campaign_templates (workspace_id, campaign_id)
    WHERE is_default = TRUE`,

  // Add campaign_id column to style_fingerprints.
  `ALTER TABLE style_fingerprints ADD COLUMN IF NOT EXISTS campaign_id TEXT`,

  // Rebuild the active-uniqueness index to include campaign_id. The old
  // index name stays the same so this is a true replace.
  `DROP INDEX IF EXISTS style_fingerprints_active_uq`,

  `CREATE UNIQUE INDEX IF NOT EXISTS style_fingerprints_active_uq
    ON style_fingerprints (
      workspace_id, scope,
      COALESCE(channel,     ''),
      COALESCE(persona_id,  ''),
      COALESCE(campaign_id, '')
    )
    WHERE is_active = TRUE`,

  `CREATE INDEX IF NOT EXISTS style_fingerprints_campaign_idx
    ON style_fingerprints (workspace_id, campaign_id)
    WHERE campaign_id IS NOT NULL`,
]

for (const s of statements) {
  process.stdout.write(`→ ${s.slice(0, 80).replace(/\s+/g, " ")}${s.length > 80 ? "…" : ""} `)
  await sql.query(s)
  console.log("✓")
}
console.log("\nMigration complete.")
