/**
 * Temporary debug endpoint — REMOVE BEFORE LANDING.
 *
 * Returns a SHA-256 hash of selected env vars so we can verify Vercel actually
 * has the same value the local shell does, without leaking the secret itself.
 * Compare locally with: shasum -a 256 <(printf "%s" "$CRON_SECRET")
 */
import { NextResponse } from "next/server"
import { createHash } from "crypto"

export const dynamic = "force-dynamic"

function fingerprint(value: string | undefined) {
  if (!value) return { set: false, length: 0, sha256: null }
  return {
    set: true,
    length: value.length,
    sha256: createHash("sha256").update(value).digest("hex"),
  }
}

export async function GET() {
  return NextResponse.json({
    CRON_SECRET: fingerprint(process.env.CRON_SECRET),
    ENCRYPTION_KEY: fingerprint(process.env.ENCRYPTION_KEY),
    KV_REST_API_URL: fingerprint(process.env.KV_REST_API_URL),
    KV_REST_API_TOKEN: fingerprint(process.env.KV_REST_API_TOKEN),
  })
}
