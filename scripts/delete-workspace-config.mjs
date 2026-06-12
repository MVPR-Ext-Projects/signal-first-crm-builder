/**
 * Delete a workspace's Redis config (the `workspace:<id>:config` key).
 *
 * Backs up the existing value to /tmp before deletion so the operation is
 * recoverable until the backup file is removed.
 *
 * Postgres rows for that workspace_id are NOT touched - they stay as
 * orphaned but inert data. Run a separate cascade-delete later if disk
 * reclamation is needed.
 *
 * Usage:
 *   WORKSPACE_ID=<uuid> node scripts/delete-workspace-config.mjs
 *
 * Required env: KV_REST_API_URL, KV_REST_API_TOKEN.
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
  console.error("✗ WORKSPACE_ID is required")
  process.exit(1)
}
if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
  console.error("✗ KV_REST_API_URL and KV_REST_API_TOKEN must be set")
  process.exit(1)
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
})

const key = `workspace:${workspaceId}:config`
const existing = await redis.get(key)

if (!existing) {
  console.log(`→ No config at ${key}. Already deleted (or never existed). Nothing to do.`)
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const backupPath = `/tmp/workspace-${workspaceId}-pre-delete-${stamp}.json`
writeFileSync(backupPath, JSON.stringify(existing, null, 2))
console.log(`✓ Backup written to ${backupPath}`)

const deleted = await redis.del(key)
console.log(`✓ Deleted ${key} (redis.del returned ${deleted})`)
console.log("")
console.log("Note: Postgres rows scoped by workspace_id are untouched (orphaned but inert).")
console.log(`Run TRUNCATE / DELETE WHERE workspace_id = '${workspaceId}' on Postgres tables`)
console.log("separately if you also want to reclaim DB rows.")
