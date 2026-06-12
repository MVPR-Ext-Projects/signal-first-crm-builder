/**
 * Webhook destinations — copy-paste URLs for each external integration that
 * pushes events into this workspace (Teamfluence, HubSpot).
 *
 * URLs are derived from the inbound request host so the values stay correct
 * across your-app.vercel.app (prod), preview deployments, and local dev. The
 * client component renders copy buttons.
 */

import { cookies, headers } from "next/headers"
import { redirect } from "next/navigation"
import { getWorkspaceConfig, resolveTeamMembers } from "@/lib/workspace-config"
import { SettingsShell } from "../settings-shell"
import { WebhooksList } from "./webhooks-list"
import { DripifyUrlBuilder } from "./dripify-url-builder"

export const dynamic = "force-dynamic"

export default async function WebhooksPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}) {
  const { workspaceId } = await params
  const config = await getWorkspaceConfig(workspaceId)

  if (!config) {
    return (
      <div className="flex items-center justify-center py-32">
        <p className="text-[14px] text-zinc-400">Workspace not found.</p>
      </div>
    )
  }

  if (config.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) {
      redirect(`/dashboard/${workspaceId}/login`)
    }
  }

  // Build base URL from the inbound request so prod/preview/dev all show the
  // right host. Falls back to the canonical prod hostname if headers are
  // missing for any reason.
  const h = await headers()
  const proto = h.get("x-forwarded-proto") ?? "https"
  const host  = h.get("x-forwarded-host") ?? h.get("host") ?? "your-app.vercel.app"
  const base  = `${proto}://${host}`

  const endpoints = [
    {
      key:         "teamfluence" as const,
      name:        "Teamfluence",
      url:         `${base}/api/webhooks/${workspaceId}/teamfluence`,
      description: "LinkedIn engagement signals (post reactions, profile views, new connections, follows). Save this URL as the webhook destination in Teamfluence under your account's Integrations page.",
      auth:        "Workspace ID in the URL is the auth surface — Teamfluence doesn't support custom headers, so the UUID is the secret. Rotate by re-issuing the workspace if the URL ever leaks.",
      tip:         "Once saved, fire a test event from Teamfluence and check Vercel logs for a 200 response.",
    },
    {
      key:         "calendly" as const,
      name:        "Calendly",
      url:         `${base}/api/webhooks/${workspaceId}/calendly`,
      description: "Calendly meeting bookings (invitee.created + invitee.canceled). Each booking writes a calendly_bookings row and a booked_meeting signal on the matching contact.",
      auth:        "HMAC-SHA-256 signed. Register a webhook_subscription via Calendly's API; the response contains a signing_key. Paste it into the field below — the handler uses it to verify the Calendly-Webhook-Signature header.",
      tip:         "Register via POST https://api.calendly.com/webhook_subscriptions with events ['invitee.created','invitee.canceled'] and scope 'user' (or 'organization').",
      secretKey:   "calendly" as const,
      secretConfigured: !!config.webhookSecrets?.calendly,
    },
    {
      key:         "hubspot" as const,
      name:        "HubSpot",
      url:         `${base}/api/webhooks/${workspaceId}/hubspot`,
      description: "HubSpot contact events. Currently handles contact.creation and contact.propertyChange on hs_linkedin_url to queue Surfe enrichment.",
      auth:        "HubSpot signs requests with HMAC-SHA256 v3 using your app's client secret. The handler verifies the X-HubSpot-Signature-v3 header and rejects timestamps older than 5 minutes.",
      tip:         "Register subscriptions in your HubSpot Private App / Public App config. Make sure clientSecret is populated under workspace config.hubspot.clientSecret.",
    },
  ]

  const teamMembers = resolveTeamMembers(config)

  return (
    <SettingsShell
      workspaceId={workspaceId}
      active="webhooks"
      eyebrow={`${config.name ?? workspaceId} · Webhooks`}
      title="Webhook destinations"
      description="Paste these URLs into the corresponding integration so events land in the SDR dashboard. Each workspace has its own URL — sharing one across workspaces will cross-pollute signal data."
    >
      <WebhooksList workspaceId={workspaceId} endpoints={endpoints} />
      <DripifyUrlBuilder
        base={base}
        workspaceId={workspaceId}
        teamMembers={teamMembers}
        savedWebhooks={config.dripifyWebhooks ?? []}
      />
    </SettingsShell>
  )
}
