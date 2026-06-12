/**
 * Add deal_mrr column to company_tags. Stores monthly recurring
 * revenue for the deal at this company, in the workspace's working
 * currency (GBP for MVPR). ARR can be derived as deal_mrr * 12 when
 * needed - no need to also store that.
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

const present = await sql.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'company_tags' AND column_name = 'deal_mrr'
`)
console.log(`deal_mrr column present: ${present.length > 0}`)

if (!APPLY) {
  console.log(present.length === 0
    ? "\nWould run: ALTER TABLE company_tags ADD COLUMN deal_mrr NUMERIC(10, 2);"
    : "\nNothing to do.")
  console.log("\nRe-run with --apply.")
  process.exit(0)
}

if (present.length === 0) {
  await sql.query(`ALTER TABLE company_tags ADD COLUMN deal_mrr NUMERIC(10, 2)`)
  console.log("Added deal_mrr column.")
} else {
  console.log("Already present, skipping.")
}
