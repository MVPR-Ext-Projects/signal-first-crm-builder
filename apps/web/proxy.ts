/**
 * Dashboard auth middleware.
 *
 * Runs on the Edge before any layout / page streams, so we can issue a clean
 * HTTP 307 redirect to `/login` when the auth cookie doesn't match - rather
 * than the meta-refresh fallback that Next.js falls back to when redirect()
 * is called from a Server Component after streaming has started.
 *
 * Matches all paths under /dashboard/<workspaceId>/* except /login itself.
 * Reads `workspace:<id>:config` from Upstash via REST, decrypts the
 * `accessToken` field (handles both plaintext and AES-256-GCM enc:- prefixed
 * values), then compares with the `dashboard_auth_<id>` cookie.
 *
 * Failure modes are intentionally fail-OPEN (let the page-level auth gate
 * handle it via meta refresh) - we don't want Redis hiccups to lock anyone
 * out:
 *   - Redis fetch fails / config missing -> pass through
 *   - accessToken empty / missing -> pass through (no gate configured)
 *   - Decrypt fails (e.g. ENCRYPTION_KEY mismatch) -> pass through
 *
 * The page-level checks in companies/page.tsx, sdr/page.tsx,
 * settings/access/page.tsx etc. remain as defence in depth.
 */

import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

// Next.js 16: proxy.ts always runs on the Node.js runtime. Don't add a
// `runtime` export here - the build refuses route-segment-config in proxy
// files. fetch + crypto.subtle are both available on Node.

const ENC_PREFIX = "enc:"

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

async function decryptEdge(value: string): Promise<string | null> {
  if (!value.startsWith(ENC_PREFIX)) return value
  const parts = value.slice(ENC_PREFIX.length).split(":")
  if (parts.length !== 3) return null
  const [ivB64, tagB64, ctB64] = parts

  const keyHex = process.env.ENCRYPTION_KEY
  if (!keyHex || keyHex.length !== 64) return null

  try {
    const keyBytes = hexToBytes(keyHex)
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    )
    // Web Crypto AES-GCM expects auth tag appended to ciphertext.
    const ct = b64ToBytes(ctB64)
    const tag = b64ToBytes(tagB64)
    const combined = new Uint8Array(ct.length + tag.length)
    combined.set(ct)
    combined.set(tag, ct.length)
    const ivBytes = b64ToBytes(ivB64)
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: ivBytes.buffer.slice(ivBytes.byteOffset, ivBytes.byteOffset + ivBytes.byteLength) as ArrayBuffer,
      },
      key,
      combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength) as ArrayBuffer,
    )
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}

async function readAccessToken(workspaceId: string): Promise<string | null> {
  const url = process.env.KV_REST_API_URL
  const token = process.env.KV_REST_API_TOKEN
  if (!url || !token) return null

  const res = await fetch(`${url}/get/workspace:${workspaceId}:config`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  })
  if (!res.ok) return null

  const data = await res.json().catch(() => null) as { result?: unknown } | null
  const raw = data?.result
  if (!raw) return null

  let parsed: { accessToken?: string }
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : (raw as { accessToken?: string })
  } catch {
    return null
  }

  const stored = parsed.accessToken
  if (!stored || typeof stored !== "string") return null

  return decryptEdge(stored)
}

export async function proxy(req: NextRequest) {
  const pathname = req.nextUrl.pathname

  // Match /dashboard/<workspaceId>/<rest>. Skip workspace-root and /login.
  const m = pathname.match(/^\/dashboard\/([^/]+)(\/.*)?$/)
  if (!m) return NextResponse.next()

  const [, workspaceId, rest = ""] = m
  if (rest === "" || rest === "/" || rest === "/login" || rest.startsWith("/login/")) {
    return NextResponse.next()
  }

  let accessToken: string | null = null
  try {
    accessToken = await readAccessToken(workspaceId)
  } catch {
    return NextResponse.next() // fail open on any read error
  }

  // No password configured -> page-level code handles the open-gate state.
  if (!accessToken) return NextResponse.next()

  const cookie = req.cookies.get(`dashboard_auth_${workspaceId}`)?.value
  if (cookie === accessToken) return NextResponse.next()

  const loginUrl = new URL(`/dashboard/${workspaceId}/login`, req.url)
  return NextResponse.redirect(loginUrl)
}

export const config = {
  // Catch every page under /dashboard/<id>/; skip _next/static, _next/image,
  // and the favicon to avoid pointless Redis hits.
  matcher: ["/dashboard/((?!_next|favicon).*)"],
}
