/**
 * Migration: add `twitter_url` column to contacts + new `x_following` table.
 *
 * Mirrors the `linkedin_interests` pattern so cross-platform follow data can
 * be joined the same way:
 *   contacts.id ←─ linkedin_interests.contact_id
 *               ←─ x_following.contact_id
 *
 * x_following.following JSONB shape:
 *   {
 *     following: [
 *       { name, handle, profileUrl, bio?, followerCount?, verified? },
 *       …
 *     ]
 *   }
 *
 * The single `following` array is intentional — X doesn't categorize follows
 * the way LinkedIn does (Top Voices / Companies / Groups / Newsletters), so
 * the per-platform shape is flat.
 *
 * Idempotent.
 *
 * Usage:
 *   node scripts/migrate-add-x-following.mjs
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

// x_following was the original name when this migration first ran; we
// renamed to x_interests for symmetry with linkedin_interests. Both sides of
// the rename live here so the migration is idempotent: drop the old (always
// empty by the time anyone reads this) and create the new.
const statements = [
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS twitter_url TEXT`,
  `DROP TABLE IF EXISTS x_following`,
  `CREATE TABLE IF NOT EXISTS x_interests (
     id            BIGSERIAL    PRIMARY KEY,
     workspace_id  TEXT         NOT NULL,
     contact_id    BIGINT       NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
     fetched_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
     total_count   INTEGER      NOT NULL DEFAULT 0,
     interests     JSONB        NOT NULL,
     UNIQUE (workspace_id, contact_id)
   )`,
  `CREATE INDEX IF NOT EXISTS x_interests_workspace_idx
     ON x_interests (workspace_id, fetched_at DESC)`,
]

for (const s of statements) {
  process.stdout.write(`-> ${s.slice(0, 80).replace(/\s+/g, " ")}${s.length > 80 ? "…" : ""} `)
  await sql.query(s)
  console.log("done")
}
console.log("\nMigration complete.")
