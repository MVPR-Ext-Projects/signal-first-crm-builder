/**
 * AES-256-GCM encryption for sensitive fields stored in Redis.
 *
 * Encrypted values are prefixed with "enc:" so we can detect and decrypt them,
 * while still handling legacy plaintext values gracefully during migration.
 *
 * Format: enc:<base64 iv>:<base64 authTag>:<base64 ciphertext>
 *
 * Requires ENCRYPTION_KEY env var — a 64-char hex string (32 bytes).
 * Generate one with: openssl rand -hex 32
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto"

const ALGORITHM = "aes-256-gcm"
const IV_BYTES = 12
const PREFIX = "enc:"

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY
  if (!hex || hex.length !== 64) {
    throw new Error("ENCRYPTION_KEY must be a 64-char hex string (32 bytes). Generate with: openssl rand -hex 32")
  }
  return Buffer.from(hex, "hex")
}

export function encrypt(plaintext: string): string {
  const key = getKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${PREFIX}${iv.toString("base64")}:${authTag.toString("base64")}:${ciphertext.toString("base64")}`
}

export function decrypt(value: string): string {
  // Not encrypted (legacy plaintext) — return as-is
  if (!value.startsWith(PREFIX)) return value

  const parts = value.slice(PREFIX.length).split(":")
  if (parts.length !== 3) throw new Error("Invalid encrypted value format")

  const [ivB64, authTagB64, ciphertextB64] = parts
  const key = getKey()
  const iv = Buffer.from(ivB64, "base64")
  const authTag = Buffer.from(authTagB64, "base64")
  const ciphertext = Buffer.from(ciphertextB64, "base64")

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")
}

/** Encrypt a string only if it isn't already encrypted. */
export function encryptIfNeeded(value: string): string {
  return value.startsWith(PREFIX) ? value : encrypt(value)
}
