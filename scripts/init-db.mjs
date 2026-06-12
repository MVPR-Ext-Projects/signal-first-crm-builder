/**
 * One-off — run apps/web/lib/db/schema.sql against the configured Neon DB.
 *
 * Usage:
 *   node scripts/init-db.mjs
 *
 * Reads DATABASE_URL from .env.production.local (or .env.local).
 */

import { neon } from "@neondatabase/serverless"
import { readFileSync } from "fs"
import { config as loadEnv } from "dotenv"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(__dirname, "../.env.production.local") })
loadEnv({ path: resolve(__dirname, "../.env.local") })

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set — pull production env first")
  process.exit(1)
}

const sql = neon(process.env.DATABASE_URL)
const schema = readFileSync(resolve(__dirname, "../apps/web/lib/db/schema.sql"), "utf8")

// neon's HTTP driver doesn't accept multi-statement scripts directly,
// so we split on semicolons (naively, but the schema is simple).
// Strip comment-only lines, then split on `;` at end of statement.
const cleaned = schema
  .split("\n")
  .filter(line => !line.trim().startsWith("--"))
  .join("\n")
const statements = cleaned
  .split(/;\s*$/m)
  .map(s => s.trim())
  .filter(s => s.length > 0)

for (const stmt of statements) {
  const head = stmt.split("\n")[0].slice(0, 80)
  process.stdout.write(`  ${head} ... `)
  try {
    // neon HTTP driver: sql.query(text, params?) for plain SQL strings.
    // The function-call form sql(stmt) was removed in newer driver versions.
    await sql.query(stmt)
    console.log("ok")
  } catch (e) {
    console.log(`FAILED — ${e.message}`)
    process.exit(1)
  }
}

console.log("\nSchema applied. Tables:")
const tables = await sql`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public'
  ORDER BY table_name
`
for (const t of tables) console.log(`  ${t.table_name}`)
