/**
 * Read-only inspection: list the `enc:`-prefixed (encrypted-at-rest) fields
 * on every workspace, or a specific one. No writes, no decryption.
 *
 * Run this BEFORE any ENCRYPTION_KEY rotation or clear operation - it tells
 * you which workspaces / fields would become unreadable if the key changed.
 * The 2026-05-19 incident happened because nobody ran this kind of inspection
 * before rotating the key. Cleared fields and broken integrations followed.
 *
 * Output:
 *   - One line per workspace: ID, name, count of enc: fields
 *   - For workspaces with enc: fields: list of dotted paths
 *   - Whether `accessToken` is among them (because that's the dashboard
 *     password - clearing it has user-visible consequences)
 *
 * Usage:
 *   node scripts/inspect-workspace-encrypted-fields.mjs
 *   WORKSPACE_ID=<uuid> node scripts/inspect-workspace-encrypted-fields.mjs
 *
 * Env required: KV_REST_API_URL, KV_REST_API_TOKEN.
 */

import { config } from "dotenv"
import { Redis } from "@upstash/redis"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, "../.env.local") })
config({ path: resolve(__dirname, "../.env.production.local") })

if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
  console.error("✗ KV_REST_API_URL and KV_REST_API_TOKEN must be set")
  process.exit(1)
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
})

const targetWorkspace = process.env.WORKSPACE_ID

async function listWorkspaceKeys() {
  if (targetWorkspace) return [`workspace:${targetWorkspace}:config`]
  const keys = []
  let cursor = 0
  do {
    const [next, batch] = await redis.scan(cursor, { match: "workspace:*:config", count: 100 })
    keys.push(...batch)
    cursor = parseInt(next, 10)
  } while (cursor !== 0)
  return keys
}

function findEncPaths(obj, pathPrefix = "") {
  const found = []
  if (obj === null || typeof obj !== "object") return found
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => found.push(...findEncPaths(v, `${pathPrefix}[${i}]`)))
    return found
  }
  for (const [k, v] of Object.entries(obj)) {
    const here = pathPrefix ? `${pathPrefix}.${k}` : k
    if (typeof v === "string" && v.startsWith("enc:")) {
      found.push(here)
    } else if (v !== null && typeof v === "object") {
      found.push(...findEncPaths(v, here))
    }
  }
  return found
}

const keys = await listWorkspaceKeys()
if (keys.length === 0) {
  console.log("No workspace configs found.")
  process.exit(0)
}

console.log(`Scanning ${keys.length} workspace config(s)...`)
console.log()

let totalEncFields = 0
let workspacesWithEnc = 0
let workspacesWithEncryptedAccessToken = 0

for (const key of keys) {
  const cfg = await redis.get(key)
  if (!cfg) {
    console.log(`  ${key}: (empty / missing)`)
    continue
  }
  const id = key.replace(/^workspace:|:config$/g, "")
  const name = cfg.name ?? "(no name)"
  const encPaths = findEncPaths(cfg)
  const accessTokenEncrypted = encPaths.includes("accessToken")

  if (encPaths.length === 0) {
    console.log(`  ${id}  ${name}  (no enc:-prefixed fields)`)
    continue
  }
  workspacesWithEnc++
  totalEncFields += encPaths.length
  if (accessTokenEncrypted) workspacesWithEncryptedAccessToken++

  console.log(`  ${id}  ${name}  (${encPaths.length} enc:-prefixed field${encPaths.length > 1 ? "s" : ""})`)
  for (const p of encPaths) {
    const marker = p === "accessToken" ? " ⚠ DASHBOARD PASSWORD" : ""
    console.log(`    - ${p}${marker}`)
  }
}

console.log()
console.log(`Summary: ${workspacesWithEnc}/${keys.length} workspaces have enc:-prefixed fields, ${totalEncFields} total.`)
if (workspacesWithEncryptedAccessToken > 0) {
  console.log(`         ${workspacesWithEncryptedAccessToken} workspace(s) have an encrypted accessToken (dashboard password).`)
  console.log(`         Rotating ENCRYPTION_KEY without preserving these will silently open their auth gates.`)
}
