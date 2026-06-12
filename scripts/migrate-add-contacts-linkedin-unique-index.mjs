/**
 * Migration: unique partial index on contacts(workspace_id, linkedin_url).
 *
 * Mirrors the equivalent index on companies that keeps the companies
 * waterfall clean at the DB level. With this in place, future races /
 * code paths that bypass the People waterfall will get a unique-
 * constraint violation rather than silently inserting a duplicate.
 *
 * Pre-requisite: run scripts/retro-people-dedup-merger.mjs first.
 * Postgres will refuse to build the index if duplicate linkedin_url
 * values still exist within a workspace.
 *
 * The index is partial:
 *   - WHERE linkedin_url IS NOT NULL: contacts without a URL aren't
 *     subject to the uniqueness constraint.
 *   - The normalized comparison uses the same expression as the
 *     waterfall lookup so the constraint matches the waterfall's
 *     concept of "same URL".
 *
 * Usage:
 *   node scripts/migrate-add-contacts-linkedin-unique-index.mjs
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

// The index is on the normalized form so the constraint matches the
// waterfall's lookup expression. Implemented as a unique partial
// expression index.
const stmt = `
  CREATE UNIQUE INDEX IF NOT EXISTS contacts_workspace_linkedin_norm_uidx
    ON contacts (
      workspace_id,
      lower(regexp_replace(
        regexp_replace(linkedin_url, '^https?://(www\\.)?', ''),
        '/+$', ''
      ))
    )
    WHERE linkedin_url IS NOT NULL AND linkedin_url != ''
`

process.stdout.write(`-> creating contacts_workspace_linkedin_norm_uidx ... `)
await sql(stmt)
console.log("OK")
console.log("\nMigration complete.")
