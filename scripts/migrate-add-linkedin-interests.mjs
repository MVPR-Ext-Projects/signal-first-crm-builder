/**
 * Migration: add linkedin_interests table.
 *
 * Idempotent. Also DROPs the prior `contact_interests` table if it exists,
 * since that name was a short-lived intermediate from PR #31 that got renamed
 * before any production data landed in it. Safe because the table is empty
 * by definition (the feature was never enabled before this rename).
 *
 * Usage:
 *   node scripts/migrate-add-linkedin-interests.mjs
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
  `DROP TABLE IF EXISTS contact_interests`,
  `CREATE TABLE IF NOT EXISTS linkedin_interests (
    id            BIGSERIAL    PRIMARY KEY,
    workspace_id  TEXT         NOT NULL,
    contact_id    BIGINT       NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    fetched_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    total_count   INTEGER      NOT NULL DEFAULT 0,
    interests     JSONB        NOT NULL,
    UNIQUE (workspace_id, contact_id)
  )`,
  `CREATE INDEX IF NOT EXISTS linkedin_interests_workspace_idx
    ON linkedin_interests (workspace_id, fetched_at DESC)`,
]

for (const s of statements) {
  process.stdout.write(`-> ${s.slice(0, 80).replace(/\s+/g, " ")}${s.length > 80 ? "..." : ""} `)
  await sql(s)
  console.log("done")
}
console.log("\nMigration complete.")
