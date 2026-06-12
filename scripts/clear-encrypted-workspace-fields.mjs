/**
 * Recovery script: clear `enc:`-prefixed fields on a workspace config.
 *
 * Context (2026-05-19): the production ENCRYPTION_KEY was rotated as a
 * hygiene task. Some Redis fields had been encrypted with the previous
 * key (which is no longer recoverable), so the new key couldn't decrypt
 * them. getWorkspaceConfig threw on every dashboard page render and
 * webhook handler.
 *
 * This script walks the workspace config tree and replaces every
 * `enc:`-prefixed string with the empty string. After it runs, the
 * decrypt path treats those fields as plaintext pass-throughs (empty),
 * so getWorkspaceConfig succeeds.
 *
 * Integrations whose secrets get cleared will fail until plaintext
 * values are re-sourced and written back via the dashboard UI or
 * seed-workspaces.mjs (Step 2 of the recovery plan).
 *
 * SAFETY:
 * - WORKSPACE_ID is required (no default - the old MVPR default was a
 *   foot-gun).
 * - `accessToken` (the dashboard auth password) is preserved by default
 *   to avoid silently opening the auth gate. Pass --include-access-token
 *   to also clear it.
 * - Use --dry-run to list affected fields without writing.
 * - A backup of the pre-mutation config is written to /tmp before any
 *   write.
 *
 * Usage:
 *   WORKSPACE_ID=<uuid> node scripts/clear-encrypted-workspace-fields.mjs --dry-run
 *   WORKSPACE_ID=<uuid> node scripts/clear-encrypted-workspace-fields.mjs
 *   WORKSPACE_ID=<uuid> node scripts/clear-encrypted-workspace-fields.mjs --include-access-token
 *
 * Env required: KV_REST_API_URL, KV_REST_API_TOKEN (already in .env.local).
 */

import { config } from "dotenv"
import { Redis } from "@upstash/redis"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { writeFileSync } from "fs"

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, "../.env.local") })
config({ path: resolve(__dirname, "../.env.production.local") })

const workspaceId = process.env.WORKSPACE_ID
if (!workspaceId) {
  console.error("✗ WORKSPACE_ID is required (no default - pass an explicit UUID)")
  console.error("  Usage: WORKSPACE_ID=<uuid> node scripts/clear-encrypted-workspace-fields.mjs [--dry-run] [--include-access-token]")
  process.exit(1)
}

const args = new Set(process.argv.slice(2))
const dryRun = args.has("--dry-run")
const includeAccessToken = args.has("--include-access-token")

if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
  console.error("✗ KV_REST_API_URL and KV_REST_API_TOKEN must be set")
  process.exit(1)
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
})

const key = `workspace:${workspaceId}:config`
const before = await redis.get(key)

if (!before) {
  console.error(`✗ No workspace config at Redis key ${key}`)
  process.exit(1)
}

const clearedPaths = []
const preservedAccessToken = []

function clean(obj, pathPrefix = "") {
  if (obj === null || typeof obj !== "object") return obj
  if (Array.isArray(obj)) return obj.map((v, i) => clean(v, `${pathPrefix}[${i}]`))
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    const here = pathPrefix ? `${pathPrefix}.${k}` : k
    if (typeof v === "string" && v.startsWith("enc:")) {
      // Preserve the top-level accessToken (dashboard auth password)
      // unless explicitly opted in. Path "accessToken" at the root means
      // pathPrefix is "", here === "accessToken".
      if (here === "accessToken" && !includeAccessToken) {
        preservedAccessToken.push(here)
        out[k] = v
      } else {
        clearedPaths.push(here)
        out[k] = ""
      }
    } else if (v !== null && typeof v === "object") {
      out[k] = clean(v, here)
    } else {
      out[k] = v
    }
  }
  return out
}

const after = clean(before)

if (clearedPaths.length === 0 && preservedAccessToken.length === 0) {
  console.log("→ No enc:-prefixed fields found. Nothing to clear.")
  process.exit(0)
}

console.log(`Workspace: ${workspaceId}`)
if (dryRun) console.log("Mode: dry-run (no writes)")
console.log()

if (preservedAccessToken.length > 0) {
  console.log(`→ Preserving accessToken (dashboard password). Pass --include-access-token to clear it too.`)
}

if (clearedPaths.length === 0) {
  console.log("→ No fields would be cleared after preservation rules.")
  process.exit(0)
}

console.log(`→ ${dryRun ? "Would clear" : "Will clear"} ${clearedPaths.length} encrypted field(s):`)
for (const p of clearedPaths) console.log(`    - ${p}`)

if (dryRun) {
  console.log("\nDry-run complete. Re-run without --dry-run to apply.")
  process.exit(0)
}

// Backup to /tmp with timestamp before any mutation.
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const backupPath = `/tmp/workspace-${workspaceId}-backup-${stamp}.json`
writeFileSync(backupPath, JSON.stringify(before, null, 2))
console.log(`\n✓ Backup written to ${backupPath}`)

await redis.set(key, after)
console.log(`✓ Wrote cleaned config back to ${key}`)

console.log("\nNext:")
console.log("  1. Verify the workspace's dashboard pages no longer 500 (curl + grep body for 'Page couldn\\'t load')")
console.log("  2. Re-source plaintext values for each cleared field via the dashboard settings UI")
console.log("     (https://your-app.vercel.app/dashboard/<id>/settings) or scripts/seed-workspaces.mjs")
if (includeAccessToken) {
  console.log("  3. The dashboard auth gate is now OPEN. Restore a password via the in-CRM")
  console.log("     /dashboard/<id>/settings/access page or scripts/set-dashboard-password.mjs")
}
