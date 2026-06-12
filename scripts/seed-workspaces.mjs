// Seeds an example workspace from seed/example-workspace.json.
// After scaffolding, replace the example with your own workspace config.

/**
 * Reads seed/example-workspace.json at the repo root, generates a fresh
 * workspace UUID, encrypts any fields whose values start with "enc:" using
 * the encryption helper, and writes the result to Upstash Redis under
 * `workspace:<id>:config`.
 *
 * Run with:
 *   node scripts/seed-workspaces.mjs
 *
 * Required env:
 *   KV_REST_API_URL       Upstash Redis URL
 *   KV_REST_API_TOKEN     Upstash Redis token
 *   ENCRYPTION_KEY        64-char hex (only needed if the seed has enc: values)
 *
 * Optional env:
 *   WORKSPACE_ID          override the generated UUID (e.g. to reseed an
 *                          existing workspace deterministically)
 *   SEED_FILE             override the default seed path
 *                          (defaults to seed/example-workspace.json)
 */

import { config } from "dotenv"
import { Redis } from "@upstash/redis"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { readFileSync } from "fs"
import { createCipheriv, randomBytes, randomUUID } from "crypto"

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, "../.env.local") })
config({ path: resolve(__dirname, "../apps/web/.env.local") })
config({ path: resolve(__dirname, "../.env.production.local") })

// ────────────────────────────────────────────────────────────────────────────
// Encryption helper
// ────────────────────────────────────────────────────────────────────────────

function encryptValue(plaintext) {
  const hex = process.env.ENCRYPTION_KEY
  if (!hex || hex.length !== 64) throw new Error("ENCRYPTION_KEY missing or invalid")
  if (plaintext.startsWith("enc:")) return plaintext // already encrypted
  const key = Buffer.from(hex, "hex")
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `enc:${iv.toString("base64")}:${authTag.toString("base64")}:${ciphertext.toString("base64")}`
}

/**
 * Walk the config tree and encrypt any string value that begins with "enc:".
 * The "enc:" prefix in the seed JSON is the author's intent marker - the
 * value AFTER the prefix is the plaintext we need to encrypt.
 *
 * Example seed entry:
 *   "teamfluenceApiKey": "enc:my-real-api-key"
 *   ->  after encrypt:    "enc:<iv>:<tag>:<ciphertext>"
 */
function encryptIfNeeded(value) {
  if (typeof value === "string") {
    if (value.startsWith("enc:") && value.split(":").length === 2) {
      const plaintext = value.slice("enc:".length)
      return encryptValue(plaintext)
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map(encryptIfNeeded)
  }
  if (value && typeof value === "object") {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = encryptIfNeeded(v)
    return out
  }
  return value
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

const seedPath = resolve(
  __dirname,
  "..",
  process.env.SEED_FILE ?? "seed/example-workspace.json"
)

let seed
try {
  seed = JSON.parse(readFileSync(seedPath, "utf8"))
} catch (err) {
  console.error(`✗ Could not read ${seedPath}`)
  console.error(`  ${err.message}`)
  console.error("  Create seed/example-workspace.json before running this script.")
  process.exit(1)
}

if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
  console.error("✗ KV_REST_API_URL and KV_REST_API_TOKEN must be set")
  console.error("  Pull with: vercel env pull .env.local --yes")
  process.exit(1)
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
})

const workspaceId = process.env.WORKSPACE_ID ?? seed.workspaceId ?? randomUUID()
const now = new Date().toISOString()

const config_ = encryptIfNeeded({
  ...seed,
  workspaceId,
  createdAt: seed.createdAt ?? now,
  updatedAt: now,
})

const key = `workspace:${workspaceId}:config`

async function seedWorkspace() {
  await redis.set(key, config_)
  console.log(`✓  Seeded workspace ${workspaceId}`)
  console.log("")
  console.log(`   Redis key:      ${key}`)
  console.log(`   Dashboard URL:  /dashboard/${workspaceId}`)
  console.log("")
  console.log("Next: open the dashboard URL on your deployment to verify the config.")
  process.exit(0)
}

seedWorkspace().catch((err) => {
  console.error(err)
  process.exit(1)
})
