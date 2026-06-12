/**
 * Universal UTM click tracker → gtm-os signal
 *
 * Receives clicks from non-email channels (LinkedIn, lead magnets,
 * Framer pages, any UTM-tagged link) and writes a `clicked_link` signal
 * to gtm-os before redirecting the user to the destination URL.
 *
 * All attribution writes land in the gtm-os Postgres projection directly;
 * the downstream CRM is repopulated by the configured CRM adapter.
 *
 * Usage:
 *   https://<attribution-host>/api/track
 *     ?redirect=https://example.com/case-study
 *     &utm_source=linkedin
 *     &utm_medium=CAMPAIGN_ID
 *     &utm_content=intro-dm
 *     &utm_term=PERSON_ID        ← CRM person record id (used to find the
 *                                  contact in gtm-os via contacts.crm_contact_id)
 *
 * Env vars required:
 *   DATABASE_URL    Neon connection string (gtm-os DB).
 *   WORKSPACE_ID    Default workspace id when utm_term resolves a contact.
 *
 * No auth required. Public endpoint.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node"
import { parseUtmsFromParams } from "../lib/utm.js"
import {
  findContactByCrmId,
  recordAttributionSignal,
  getCampaignClickScore,
  defaultWorkspaceId,
} from "../lib/signal-ingest.js"

// ---------------------------------------------------------------------------
// Bot / crawler filtering
// ---------------------------------------------------------------------------

const BOT_UA_PATTERNS = [
  /bot/i,
  /crawler/i,
  /spider/i,
  /slurp/i,
  /facebookexternalhit/i,
  /linkedinbot/i,
  /twitterbot/i,
  /whatsapp/i,
  /telegrambot/i,
  /curl/i,
  /wget/i,
  /python-requests/i,
  /go-http-client/i,
  /axios/i,
  /node-fetch/i,
  /uptimerobot/i,
]

function isBot(userAgent: string | undefined): boolean {
  if (!userAgent) return true // no UA → treat as programmatic
  return BOT_UA_PATTERNS.some((pattern) => pattern.test(userAgent))
}

// ---------------------------------------------------------------------------
// Redirect destination validation (allowlist)
// ---------------------------------------------------------------------------

const ALLOWED_REDIRECT_HOSTS = (process.env.ALLOWED_REDIRECT_HOSTS ?? "")
  .split(",")
  .map(h => h.trim())
  .filter(Boolean)

function validateRedirectUrl(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (!["http:", "https:"].includes(url.protocol)) return null
    if (!ALLOWED_REDIRECT_HOSTS.includes(url.hostname)) return null
    return url.toString()
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Attribution writer
// ---------------------------------------------------------------------------

async function writeAttribution(opts: {
  utms: ReturnType<typeof parseUtmsFromParams>
  redirectUrl: string
  userAgent: string | undefined
  ip: string | undefined
  timestamp: string
}): Promise<void> {
  const { utms, redirectUrl, userAgent, ip, timestamp } = opts

  // Need a person to attribute the click to. utm_term carries the CRM
  // record id we set when the link was generated; we map it to a gtm-os
  // contact via contacts.crm_contact_id.
  if (!utms.utmTerm) return
  const workspaceId = defaultWorkspaceId()
  if (!workspaceId) return

  const contact = await findContactByCrmId(workspaceId, utms.utmTerm)
  if (!contact) {
    console.log(`[track] no contact match for utm_term=${utms.utmTerm} in workspace ${workspaceId}`)
    return
  }

  const channelLabel = utms.utmSource ?? "unknown-channel"
  const description = [
    `Channel: ${utms.utmSource ?? "—"}`,
    `Campaign: ${utms.utmMedium ?? "—"}`,
    `Content: ${utms.utmContent ?? "—"}`,
    `Destination: ${redirectUrl}`,
    ip        ? `IP: ${ip}`                : null,
    userAgent ? `User-Agent: ${userAgent}` : null,
  ]
    .filter(Boolean)
    .join("\n")

  // Dedup key — a single click is one (utm_term, utm_medium, timestamp)
  // tuple. The timestamp portion makes repeat clicks distinct (Tom's spec:
  // multiple clicks on the same link by the same contact are tracked
  // separately, not deduped).
  const crmSignalId = `track:click:${utms.utmTerm}:${timestamp}`

  // Per-campaign click score (Task #23). utm_medium carries the campaign
  // id; look up its configured clicked_link_score. When the campaign
  // doesn't resolve (no id present, archived, or never created) fall
  // back to 0 - matching pre-Task-23 behaviour.
  let scoreDelta = 0
  if (utms.utmMedium) {
    const lookup = await getCampaignClickScore(contact.workspaceId, utms.utmMedium)
    if (lookup !== null) scoreDelta = lookup
  }

  await recordAttributionSignal({
    workspaceId: contact.workspaceId,
    contactId:   contact.id,
    crmSignalId,
    signalVerb:  "clicked_link",
    sourceType:  `Link click (${channelLabel})`,
    description,
    scoreDelta,
    occurredAt:  new Date(timestamp),
  })
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).send("Method Not Allowed")
  }

  const userAgent = req.headers["user-agent"]
  const ip = (req.headers["x-forwarded-for"] as string | undefined)
    ?.split(",")[0]
    ?.trim()
  const timestamp = new Date().toISOString()

  // Bot check — return 200 empty so crawlers don't retry
  if (isBot(userAgent)) {
    return res.status(200).send("")
  }

  // Parse UTMs from query params
  const utms = parseUtmsFromParams(
    req.query as Record<string, string | string[] | undefined>
  )

  // Validate redirect destination
  const rawRedirect =
    typeof req.query.redirect === "string" ? req.query.redirect : undefined
  const redirectUrl = validateRedirectUrl(rawRedirect)

  // Kick off attribution write — don't await before redirecting
  const attributionPromise = writeAttribution({
    utms,
    redirectUrl: redirectUrl ?? rawRedirect ?? "unknown",
    userAgent,
    ip,
    timestamp,
  })

  // Redirect immediately (or 200 if no valid destination)
  if (redirectUrl) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate")
    res.setHeader("Pragma", "no-cache")
    res.redirect(302, redirectUrl)
  } else {
    res.status(200).send("ok")
  }

  // Await after response — Vercel keeps the function alive until this resolves
  await attributionPromise.catch(err => {
    console.error("[track] attribution write failed:", err)
  })
}
