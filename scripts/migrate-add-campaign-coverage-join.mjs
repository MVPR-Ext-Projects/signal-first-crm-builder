/**
 * Migration: campaign_coverage join table.
 *
 * Records "this campaign was created from / uses this piece of coverage".
 * The Use-this-coverage action on a coverage drawer either creates a new
 * campaign + attaches the coverage, or attaches the coverage to an
 * existing campaign. Either way a row lands here so /reports/pr (PR 5)
 * can show coverage -> campaign attribution.
 *
 * Composite FK to mvpr_coverage(workspace_id, mvpr_id) so workspaces
 * never see each other's join rows even if mvpr_id ever collided.
 * ON DELETE CASCADE on the campaigns FK so archiving a campaign also
 * drops its coverage attachments.
 *
 * Idempotent. Strictly additive. Safe to run multiple times.
 *
 * Usage:
 *   node scripts/migrate-add-campaign-coverage-join.mjs
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
  `CREATE TABLE IF NOT EXISTS campaign_coverage (
    workspace_id      TEXT         NOT NULL,
    campaign_id       TEXT         NOT NULL,
    coverage_mvpr_id  TEXT         NOT NULL,
    attached_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, campaign_id, coverage_mvpr_id),
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, coverage_mvpr_id)
      REFERENCES mvpr_coverage(workspace_id, mvpr_id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS campaign_coverage_campaign_idx
    ON campaign_coverage (workspace_id, campaign_id)`,

  `CREATE INDEX IF NOT EXISTS campaign_coverage_coverage_idx
    ON campaign_coverage (workspace_id, coverage_mvpr_id)`,
]

for (const s of statements) {
  process.stdout.write(`→ ${s.slice(0, 80).replace(/\s+/g, " ")}${s.length > 80 ? "…" : ""} `)
  await sql.query(s)
  console.log("✓")
}
console.log("\nMigration complete.")
