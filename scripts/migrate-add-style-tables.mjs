/**
 * Migration: add style_fingerprints + style_samples tables and the
 * outreach_log.fingerprint_version_id column.
 *
 * Tables back the writing-style fingerprint feature (cozy-tiger plan at
 * ~/.claude/plans/we-have-made-a-cozy-tiger.md).
 *
 * Idempotent. Run once per environment.
 *
 *   node scripts/migrate-add-style-tables.mjs
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
  `CREATE TABLE IF NOT EXISTS style_fingerprints (
    id                 BIGSERIAL    PRIMARY KEY,
    workspace_id       TEXT         NOT NULL,
    scope              TEXT         NOT NULL,
    channel            TEXT,
    persona_id         TEXT,
    version            INT          NOT NULL DEFAULT 1,
    is_active          BOOLEAN      NOT NULL DEFAULT TRUE,
    fingerprint        JSONB        NOT NULL,
    sample_count_pos   INT          NOT NULL DEFAULT 0,
    sample_count_neg   INT          NOT NULL DEFAULT 0,
    source             TEXT         NOT NULL,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS style_fingerprints_active_uq
     ON style_fingerprints (workspace_id, scope, COALESCE(channel, ''), COALESCE(persona_id, ''))
     WHERE is_active = TRUE`,
  `CREATE INDEX IF NOT EXISTS style_fingerprints_cell_idx
     ON style_fingerprints (workspace_id, scope, channel, persona_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS style_samples (
    id                        BIGSERIAL    PRIMARY KEY,
    workspace_id              TEXT         NOT NULL,
    channel                   TEXT         NOT NULL,
    persona_id                TEXT,
    contact_id                BIGINT       REFERENCES contacts(id) ON DELETE SET NULL,
    source                    TEXT         NOT NULL,
    content                   TEXT         NOT NULL,
    outcome_score             NUMERIC(4,2),
    outcome_resolved_at       TIMESTAMPTZ,
    recipient_context         JSONB,
    contributed_to_fp_version INT,
    outreach_log_id           BIGINT       REFERENCES outreach_log(id) ON DELETE SET NULL,
    created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS style_samples_cell_idx
     ON style_samples (workspace_id, channel, persona_id, outcome_resolved_at DESC)`,
  `CREATE INDEX IF NOT EXISTS style_samples_pending_idx
     ON style_samples (workspace_id, channel, persona_id)
     WHERE contributed_to_fp_version IS NULL AND outcome_resolved_at IS NOT NULL`,
  `ALTER TABLE outreach_log
     ADD COLUMN IF NOT EXISTS fingerprint_version_id BIGINT REFERENCES style_fingerprints(id) ON DELETE SET NULL`,
]

for (const s of statements) {
  process.stdout.write(`-> ${s.slice(0, 70).replace(/\s+/g, " ")}${s.length > 70 ? "..." : ""} `)
  await sql(s)
  console.log("OK")
}
console.log("\nMigration complete.")
