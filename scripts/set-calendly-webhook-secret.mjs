/**
 * Set webhookSecrets.calendly on a workspace's Redis config.
 *
 * Stores the Calendly webhook signing_key (returned when registering a
 * webhook_subscription via Calendly's API) so the handler at
 * apps/web/app/api/webhooks/[workspaceId]/calendly/route.ts can verify
 * incoming HMAC signatures.
 *
 * Encrypted at rest using the same AES-256-GCM scheme as the other webhook
 * secrets. Existing config fields are preserved.
 *
 * Usage:
 *   CALENDLY_SIGNING_KEY=<key> node scripts/set-calendly-webhook-secret.mjs
 *   # or, to target a non-default workspace:
 *   CALENDLY_SIGNING_KEY=<key> WORKSPACE_ID=<uuid> node scripts/set-calendly-webhook-secret.mjs
 *
 * Required env:
 *   CALENDLY_SIGNING_KEY  the signing_key returned by Calendly when the
 *                          webhook subscription was created
 *   ENCRYPTION_KEY        64-char hex, same as the rest of gtm-os
 *   KV_REST_API_URL       Upstash Redis URL
 *   KV_REST_API_TOKEN     Upstash Redis token
 *
 * Required env (continued):
 *   WORKSPACE_ID          target workspace UUID
 *
 * Idempotent: rerunning with the same key results in a fresh encrypted
 * envelope (random IV) but the same plaintext on decrypt.
 */

import { config } from "dotenv"
import { Redis } from "@upstash/redis"
import { createCipheriv, createDecipheriv, randomBytes } from "crypto"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, "../.env.local") })
config({ path: resolve(__dirname, "../apps/web/.env.local") })
config({ path: resolve(__dirname, "../.env.production.local") })
config({ path: resolve(__dirname, "../apps/web/.env.production.local") })

const signingKey = process.env.CALENDLY_SIGNING_KEY
const workspaceId = process.env.WORKSPACE_ID

if (!workspaceId) {
  console.error("✗ WORKSPACE_ID is required")
  process.exit(1)
}
if (!signingKey) {
  console.error("✗ CALENDLY_SIGNING_KEY is required")
  console.error("  Generate by registering a Calendly webhook_subscription, then re-run with the returned signing_key.")
  process.exit(1)
}
// ENCRYPTION_KEY is optional. When missing/empty, we store as plaintext to
// match the existing webhook-secret pattern in this workspace. The decrypt()
// path treats non-`enc:`-prefixed values as plaintext pass-throughs.
const encryptionKeyValid =
  typeof process.env.ENCRYPTION_KEY === "string" && process.env.ENCRYPTION_KEY.length === 64
if (!encryptionKeyValid) {
  console.warn("⚠  ENCRYPTION_KEY missing or not 64-char hex - storing the signing key as plaintext.")
  console.warn("   Matches the current pattern for other webhookSecrets fields on this workspace.")
}
if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
  console.error("✗ KV_REST_API_URL and KV_REST_API_TOKEN must be set")
  console.error("  Pull with: vercel env pull .env.local --yes  (or --environment=production)")
  process.exit(1)
}

const PREFIX = "enc:"

function encryptOrPassthrough(plaintext) {
  if (!encryptionKeyValid) return plaintext
  if (plaintext.startsWith(PREFIX)) return plaintext
  const key = Buffer.from(process.env.ENCRYPTION_KEY, "hex")
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${PREFIX}${iv.toString("base64")}:${authTag.toString("base64")}:${ciphertext.toString("base64")}`
}

function decryptOrPassthrough(value) {
  if (!value.startsWith(PREFIX)) return value
  const parts = value.slice(PREFIX.length).split(":")
  if (parts.length !== 3) throw new Error("Malformed encrypted value")
  const [ivB64, tagB64, ctB64] = parts
  const key = Buffer.from(process.env.ENCRYPTION_KEY, "hex")
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"))
  decipher.setAuthTag(Buffer.from(tagB64, "base64"))
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8")
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
})

const key = `workspace:${workspaceId}:config`
const existing = await redis.get(key)

if (!existing) {
  console.error(`✗ No workspace config at Redis key ${key}`)
  console.error("  Run scripts/seed-workspaces.mjs first, or double-check WORKSPACE_ID.")
  process.exit(1)
}

const stored = encryptOrPassthrough(signingKey)
const next = {
  ...existing,
  webhookSecrets: {
    ...(existing.webhookSecrets ?? {}),
    calendly: stored,
  },
}

await redis.set(key, next)
console.log(`✓ Wrote webhookSecrets.calendly to ${key} (${encryptionKeyValid ? "encrypted" : "plaintext"})`)

// Round-trip sanity check
const reread = await redis.get(key)
const roundTrip = decryptOrPassthrough(reread.webhookSecrets.calendly)
if (roundTrip === signingKey) {
  console.log(`✓ Round-trip verified (${roundTrip.length}-char signing key recovered)`)
} else {
  console.error("✗ Round-trip mismatch — wrote, but decrypt produced different value. Investigate.")
  process.exit(1)
}

console.log("\nNext: book a test meeting via one of the audience CTAs and confirm a row")
console.log("lands in calendly_bookings (run scripts/migrate-add-calendly-bookings-table.mjs first if not done).")
