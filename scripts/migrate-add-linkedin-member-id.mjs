/**
 * Add linkedin_member_id TEXT column to contacts. Stores LinkedIn's
 * stable URN (e.g. "ACoAAA...") - the slug part of a profile URL is
 * vanity and can change; member_id can't. Unipile, Teamfluence and most
 * enrichment providers can resolve a contact by member_id when the slug
 * fails. Indexed for matching at sync time.
 *
 * Dry-run by default; --apply commits.
 */
import { neon } from "@neondatabase/serverless"
import { config as loadEnv } from "dotenv"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(__dirname, "../apps/web/.env.local") })
const sql = neon(process.env.DATABASE_URL)
const APPLY = process.argv.includes("--apply")

const cols = await sql.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'contacts' AND column_name = 'linkedin_member_id'
`)
console.log(`linkedin_member_id column present: ${cols.length > 0}`)

const idx = await sql.query(`
  SELECT indexname FROM pg_indexes
  WHERE  tablename = 'contacts' AND indexname = 'contacts_workspace_member_id_idx'
`)
console.log(`workspace,member_id index present: ${idx.length > 0}`)

if (!APPLY) {
  console.log("\nWould run:")
  if (cols.length === 0) console.log("  ALTER TABLE contacts ADD COLUMN linkedin_member_id TEXT;")
  if (idx.length === 0)  console.log("  CREATE INDEX contacts_workspace_member_id_idx ON contacts (workspace_id, linkedin_member_id) WHERE linkedin_member_id IS NOT NULL;")
  console.log("\nRe-run with --apply.")
  process.exit(0)
}

if (cols.length === 0) {
  await sql.query(`ALTER TABLE contacts ADD COLUMN linkedin_member_id TEXT`)
  console.log("Added linkedin_member_id column.")
}
if (idx.length === 0) {
  await sql.query(`CREATE INDEX contacts_workspace_member_id_idx ON contacts (workspace_id, linkedin_member_id) WHERE linkedin_member_id IS NOT NULL`)
  console.log("Created contacts_workspace_member_id_idx.")
}
console.log("\nDone.")
