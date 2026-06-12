/**
 * HubSpot webhook handler — receives contact events for a workspace.
 *
 * Handles contact.propertyChange on the LinkedIn URL property and
 * contact.creation events. When a contact has a LinkedIn URL and hasn't
 * been enriched yet (no email or job title), queues Surfe enrichment.
 *
 * HubSpot webhook registration (run once per client portal after provisioning):
 *   POST https://api.hubapi.com/webhooks/v3/{appId}/subscriptions
 *   {
 *     "eventType": "contact.propertyChange",
 *     "propertyName": "hs_linkedin_url",
 *     "active": true
 *   }
 *   Set targetUrl to: https://your-domain.com/api/webhooks/{workspaceId}/hubspot
 *
 * HubSpot signs requests with HMAC-SHA256 v3:
 *   hash = base64(SHA-256(clientSecret + method + uri + body + timestamp))
 *   Header: X-HubSpot-Signature-v3
 *   Header: X-HubSpot-Request-Timestamp (unix ms — reject if > 5 min old)
 */

import { NextRequest, NextResponse } from "next/server"
import { createHmac, timingSafeEqual } from "crypto"
import { getWorkspaceConfig, resolveHubSpotProperties } from "@/lib/workspace-config"
import { queueEnrichment } from "@/lib/enrichment"

const HS_BASE = "https://api.hubapi.com"

// ─── HubSpot webhook payload shapes ──────────────────────────────────────────

interface HubSpotWebhookEvent {
  eventId: number
  subscriptionType: string   // "contact.propertyChange" | "contact.creation"
  objectId: number           // HubSpot contact ID
  portalId: number
  occurredAt: number         // ms timestamp
  propertyName?: string
  propertyValue?: string
}

interface HubSpotContactProperties {
  email?: string
  jobtitle?: string
  hs_linkedin_url?: string
  [key: string]: string | undefined
}

// ─── Signature verification ───────────────────────────────────────────────────

/**
 * HubSpot v3 signature verification.
 *
 * Concatenate: clientSecret + method + uri + body + timestamp
 * Hash with SHA-256, base64 encode, compare to X-HubSpot-Signature-v3.
 * Also reject requests where timestamp is > 5 minutes old.
 */
function verifyHubSpotSignature(
  clientSecret: string,
  method: string,
  uri: string,
  body: string,
  signatureHeader: string | null,
  timestampHeader: string | null,
): boolean {
  if (!signatureHeader || !timestampHeader) return false

  // Reject stale requests (replay protection)
  const timestamp = Number(timestampHeader)
  if (isNaN(timestamp) || Date.now() - timestamp > 5 * 60 * 1000) return false

  const payload = `${clientSecret}${method}${uri}${body}${timestampHeader}`
  const expected = createHmac("sha256", clientSecret)
    .update(payload)
    .digest("base64")

  try {
    return timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected))
  } catch {
    return false
  }
}

// ─── HubSpot API helpers ──────────────────────────────────────────────────────

async function fetchContactProperties(
  contactId: string,
  properties: string[],
  accessToken: string,
): Promise<HubSpotContactProperties | null> {
  try {
    const qs = properties.map(p => `properties=${encodeURIComponent(p)}`).join("&")
    const res = await fetch(`${HS_BASE}/crm/v3/objects/contacts/${contactId}?${qs}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    })
    if (!res.ok) return null
    const data = await res.json() as { properties: HubSpotContactProperties }
    return data.properties
  } catch {
    return null
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params
  const rawBody = await req.text()

  const config = await getWorkspaceConfig(workspaceId)
  if (!config) {
    console.warn(`[webhook/hubspot] Unknown workspace: ${workspaceId}`)
    return NextResponse.json({ error: "Unknown workspace" }, { status: 404 })
  }

  if (!config.hubspot?.accessToken) {
    return NextResponse.json({ error: "HubSpot not configured for this workspace" }, { status: 400 })
  }

  // Verify signature if client secret is configured
  const clientSecret = config.hubspot.clientSecret
  if (clientSecret) {
    const valid = verifyHubSpotSignature(
      clientSecret,
      "POST",
      req.url,
      rawBody,
      req.headers.get("x-hubspot-signature-v3"),
      req.headers.get("x-hubspot-request-timestamp"),
    )
    if (!valid) {
      console.warn(`[webhook/hubspot] Invalid signature for workspace ${workspaceId}`)
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
    }
  }

  let events: HubSpotWebhookEvent[]
  try {
    events = JSON.parse(rawBody) as HubSpotWebhookEvent[]
    if (!Array.isArray(events)) events = [events]
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  console.log(`[webhook/hubspot] ${events.length} event(s) for workspace ${workspaceId}`)

  const props = resolveHubSpotProperties(config)
  const accessToken = config.hubspot.accessToken
  let queued = 0, skipped = 0

  for (const event of events) {
    const { subscriptionType, objectId, propertyName, propertyValue } = event
    const contactId = String(objectId)

    // Only handle contact creation and LinkedIn URL property changes
    const isLinkedinChange = subscriptionType === "contact.propertyChange"
      && propertyName === props.linkedinUrl
    const isCreation = subscriptionType === "contact.creation"

    if (!isLinkedinChange && !isCreation) {
      skipped++
      continue
    }

    // For property changes, the new LinkedIn URL is in the event itself.
    // For contact creation, fetch the contact to get its properties.
    let linkedinUrl: string | undefined
    let alreadyEnriched = false

    if (isLinkedinChange) {
      linkedinUrl = propertyValue || undefined
    } else {
      // contact.creation — fetch to see if it has a LinkedIn URL
      const contactProps = await fetchContactProperties(
        contactId,
        [props.linkedinUrl, props.jobTitle, "email"],
        accessToken,
      )
      linkedinUrl     = contactProps?.[props.linkedinUrl] || undefined
      alreadyEnriched = !!(contactProps?.email && contactProps?.[props.jobTitle])
    }

    if (!linkedinUrl) {
      console.log(`[webhook/hubspot] Contact ${contactId} — no LinkedIn URL, skipping`)
      skipped++
      continue
    }

    if (alreadyEnriched) {
      console.log(`[webhook/hubspot] Contact ${contactId} — already enriched, skipping`)
      skipped++
      continue
    }

    // For property changes, also check if already enriched before queuing
    if (isLinkedinChange) {
      const contactProps = await fetchContactProperties(
        contactId,
        [props.jobTitle, "email"],
        accessToken,
      )
      if (contactProps?.email && contactProps?.[props.jobTitle]) {
        console.log(`[webhook/hubspot] Contact ${contactId} — already enriched, skipping`)
        skipped++
        continue
      }
    }

    // Queue enrichment — crmRecordId is the HubSpot contact ID
    const result = await queueEnrichment(contactId, linkedinUrl, config)
    if (result.queued) {
      console.log(`[webhook/hubspot] Queued enrichment for contact ${contactId}: ${result.enrichmentId}`)
      queued++
    } else {
      skipped++
    }
  }

  return NextResponse.json({ ok: true, queued, skipped })
}
