/**
 * Stripe Settings - per-workspace Stripe connection for revenue ingestion.
 *
 * Users paste a restricted Stripe API key + webhook signing secret here and
 * Stripe revenue events flow into the gtm-os data model (stripe_customers,
 * stripe_subscriptions, stripe_revenue_events, stripe_products,
 * stripe_invoices, ...). The CAC picture and MRR/LTV/NDR dashboards
 * depend on this connection.
 *
 * The actual credentials never leave the server: the form shows
 * "configured" indicators rather than the keys, and the PATCH route only
 * accepts new values to write (it doesn't echo old ones back).
 */

import { cookies, headers } from "next/headers"
import { redirect } from "next/navigation"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { SettingsShell } from "../settings-shell"
import { StripeForm } from "./stripe-form"

export const dynamic = "force-dynamic"

export default async function StripeSettingsPage({
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

  // Build the webhook URL the user pastes into Stripe. Honours the proxy /
  // forwarded-host headers so we get the canonical https://your-app.vercel.app
  // origin even when running on a preview domain.
  const hdrs = await headers()
  const host = hdrs.get("x-forwarded-host") ?? hdrs.get("host") ?? "your-app.vercel.app"
  const proto = hdrs.get("x-forwarded-proto") ?? "https"
  const webhookUrl = `${proto}://${host}/api/webhooks/${workspaceId}/stripe`

  return (
    <SettingsShell
      workspaceId={workspaceId}
      active="stripe"
      eyebrow={`${config.name ?? workspaceId} · Stripe (revenue)`}
      title="Stripe revenue connection"
      description="Connect your Stripe account so customers, subscriptions, invoices and payments flow into the dashboard. Drives LTV / MRR / NDR reporting and the auto Customer-Won transition on first payment."
    >
      <StripeForm
        workspaceId={workspaceId}
        configured={!!config.stripe?.apiKey}
        webhookSecretConfigured={!!config.stripe?.webhookSecret}
        initialMode={config.stripe?.mode ?? "live"}
        webhookUrl={webhookUrl}
      />
    </SettingsShell>
  )
}
