/**
 * Set the dashboard login password (top-level `accessToken`) on a workspace.
 *
 * Context: the recovery clear-encrypted-workspace-fields.mjs script blanked
 * this field along with the other enc:-prefixed values, which has the side
 * effect of leaving the dashboard auth gate open AND hiding Change Password /
 * Sign Out in the avatar dropdown (both gated on hasAccessToken).
 *
 * This script restores it. Reads DASHBOARD_PASSWORD from env, writes it
 * as the top-level accessToken on the workspace Redis config.
 *
 * After running:
 *   1. Sign in at /dashboard/<workspaceId>/login with the password you set.
 *   2. The auth cookie gets set to match.
 *   3. Change Password + Sign Out reappear in the avatar dropdown.
 *
 * Usage:
 *   WORKSPACE_ID=<uuid> DASHBOARD_PASSWORD=<password> node scripts/set-dashboard-password.mjs
 *
 * Required env: KV_REST_API_URL, KV_REST_API_TOKEN (already in .env.local).
 */

import { config } from "dotenv"
import { Redis } from "@upstash/redis"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, "../.env.local") })
config({ path: resolve(__dirname, "../.env.production.local") })

const workspaceId = process.env.WORKSPACE_ID
const password = process.env.DASHBOARD_PASSWORD

if (!workspaceId) {
  console.error("✗ WORKSPACE_ID is required")
  console.error("  Run as: WORKSPACE_ID=<uuid> DASHBOARD_PASSWORD=<pw> node scripts/set-dashboard-password.mjs")
  process.exit(1)
}
if (!password) {
  console.error("✗ DASHBOARD_PASSWORD is required")
  console.error("  Add a line `DASHBOARD_PASSWORD=<your password>` to .env.local and re-run.")
  process.exit(1)
}
if (password.length < 8) {
  console.error(`✗ Password must be at least 8 characters (you supplied ${password.length})`)
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
  console.error(`✗ No workspace config at ${key}`)
  process.exit(1)
}

await redis.set(key, { ...existing, accessToken: password })
console.log(`✓ Wrote accessToken (${password.length} chars) to ${key}`)
console.log("")
console.log("Next:")
console.log(`  1. Visit /dashboard/${workspaceId}/login on your deployment`)
console.log("  2. Sign in with the password you just set.")
console.log("  3. The avatar dropdown will show Change Password + Sign Out again.")
console.log("")
console.log("Optional cleanup: remove the DASHBOARD_PASSWORD line from .env.local now that it's stored in Redis.")
