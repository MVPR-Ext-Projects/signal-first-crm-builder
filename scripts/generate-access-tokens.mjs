/**
 * Generate dashboard access tokens for one or more workspaces.
 *
 * For each workspace:
 *   - If an accessToken already exists in Redis, skips it (non-destructive)
 *   - If no accessToken exists, generates a random 32-char hex token and saves it
 *
 * Run with:
 *   WORKSPACE_IDS=<uuid1>,<uuid2> node scripts/generate-access-tokens.mjs
 *
 * Requires KV_REST_API_URL and KV_REST_API_TOKEN in env
 * (pull from Vercel: vercel env pull .env.local --yes)
 *
 * Share the printed tokens with each workspace owner - they use it as their dashboard password.
 */

import { config } from "dotenv"
import { Redis } from "@upstash/redis"
import { randomBytes } from "crypto"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, "../apps/web/.env.local") })

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
})

// Workspace IDs to process - supply via WORKSPACE_IDS env (comma-separated)
const idsRaw = process.env.WORKSPACE_IDS ?? process.env.WORKSPACE_ID ?? ""
const workspaces = idsRaw
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean)
  .map((workspaceId) => ({ workspaceId, name: workspaceId.slice(0, 8) }))

if (workspaces.length === 0) {
  console.error("✗ WORKSPACE_IDS (comma-separated UUIDs) is required")
  process.exit(1)
}

async function generateTokens() {
  console.log("Generating dashboard access tokens...\n")

  const results = []

  for (const ws of workspaces) {
    const key = `workspace:${ws.workspaceId}:config`
    const existing = await redis.get(key)

    if (!existing) {
      console.warn(`⚠  ${ws.name} (${ws.workspaceId}) — no config found in Redis, skipping`)
      console.warn(`   Run seed-workspaces.mjs first to create the workspace config.\n`)
      continue
    }

    if (existing.accessToken) {
      console.log(`✓  ${ws.name} — already has a token (unchanged)`)
      results.push({ name: ws.name, token: existing.accessToken, status: "existing" })
      continue
    }

    // Generate a new 32-char hex token
    const token = randomBytes(16).toString("hex")

    await redis.set(key, {
      ...existing,
      accessToken: token,
      updatedAt: new Date().toISOString(),
    })

    console.log(`✓  ${ws.name} — token generated and saved`)
    results.push({ name: ws.name, token, status: "new" })
  }

  // Print summary table
  if (results.length > 0) {
    console.log("\n─────────────────────────────────────────────────────────")
    console.log("  Dashboard access tokens (share with each client):")
    console.log("─────────────────────────────────────────────────────────")
    for (const r of results) {
      const tag = r.status === "new" ? " [NEW]" : ""
      console.log(`  ${r.name.padEnd(18)} ${r.token}${tag}`)
    }
    console.log("─────────────────────────────────────────────────────────")
    console.log("\nStore these somewhere safe — they cannot be recovered from")
    console.log("Redis without running this script again (tokens are visible")
    console.log("in the raw config, not hashed).\n")
  }

  process.exit(0)
}

generateTokens().catch((err) => {
  console.error(err)
  process.exit(1)
})
