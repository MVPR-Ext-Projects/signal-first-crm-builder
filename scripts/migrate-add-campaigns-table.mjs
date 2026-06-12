/**
 * Migration: campaigns table (Task #23).
 *
 * Per-campaign click scoring. When a workspace creates an outbound
 * campaign (LinkedIn DM blast, email send, lead-magnet promo) they pick
 * the engagement value of a click on a link in that campaign. UTMs on
 * the campaign links carry the campaign id (utm_medium); the click
 * tracker looks the score up here and records the click signal at
 * that score.
 *
 * Workspaces that don't bother creating a campaign still get attribution
 * - the click tracker falls back to scoreDelta=0 when the UTM doesn't
 * resolve to a known campaign, matching the pre-Task-23 behaviour.
 *
 * Schema:
 *   id                  TEXT         PK (workspace-scoped UUID minted at create)
 *   workspace_id        TEXT         NOT NULL
 *   name                TEXT         NOT NULL (display label)
 *   channel             TEXT         NOT NULL ('linkedin_dm' | 'email' | 'lead_magnet' | 'other')
 *   clicked_link_score  INT          NOT NULL DEFAULT 0 (points per click on a link in this campaign)
 *   created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
 *   archived_at         TIMESTAMPTZ  (nullable - soft delete)
 *
 * Index: (workspace_id, archived_at) for the "list active campaigns"
 * query the settings page uses.
 *
 * Strictly additive. Idempotent.
 *
 * Usage:
 *   node scripts/migrate-add-campaigns-table.mjs
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
  `CREATE TABLE IF NOT EXISTS campaigns (
    id                 TEXT         PRIMARY KEY,
    workspace_id       TEXT         NOT NULL,
    name               TEXT         NOT NULL,
    channel            TEXT         NOT NULL,
    clicked_link_score INT          NOT NULL DEFAULT 0,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    archived_at        TIMESTAMPTZ
  )`,

  `CREATE INDEX IF NOT EXISTS campaigns_workspace_active_idx
     ON campaigns (workspace_id, archived_at)`,
]

for (const s of statements) {
  process.stdout.write(`-> ${s.slice(0, 70).replace(/\s+/g, " ")}${s.length > 70 ? "..." : ""} `)
  await sql(s)
  console.log("OK")
}
console.log("\nMigration complete.")
