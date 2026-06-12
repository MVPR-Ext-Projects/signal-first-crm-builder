/**
 * Channel Settings (replaces /settings/campaigns).
 *
 * After the Channels refactor, per-campaign editing (templates +
 * fingerprint + coverage attachments + archive) lives in the right-edge
 * drawer on /actions. This page holds what's left at the workspace
 * level: delivery-mechanism credentials for the channels that send.
 *
 * For now this is a thin index that surfaces credential status + deep
 * links to the existing forms (Outreach Settings, Company Messaging,
 * etc.). Pulling those forms inline is a follow-up cleanup, not a
 * blocker for the Channels refactor.
 */

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { listChannels } from "@/lib/db/channels"
import { SettingsShell } from "../settings-shell"

export const dynamic = "force-dynamic"

interface DeliveryStatus {
  label:         string
  configured:    boolean
  hint:          string
  manageHref:    string
  manageLabel:   string
  usedByChannels: string[]
}

export default async function ChannelSettingsPage({
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

  const channels = await listChannels(workspaceId)
  const channelsByDelivery = new Map<string, string[]>()
  for (const ch of channels) {
    const list = channelsByDelivery.get(ch.deliveryMechanism) ?? []
    list.push(ch.name)
    channelsByDelivery.set(ch.deliveryMechanism, list)
  }

  const deliveryStatuses: DeliveryStatus[] = [
    {
      label:          "Unipile (LinkedIn)",
      configured:     Boolean(config.messaging?.unipile?.apiKey),
      hint:           "Sends LinkedIn DMs + LinkedIn connection invites from your dashboard. API key, DSN, and connected-account ID.",
      manageHref:     `/dashboard/${workspaceId}/settings/outreach`,
      manageLabel:    "Manage in Outreach Settings",
      usedByChannels: channelsByDelivery.get("unipile") ?? [],
    },
    {
      label:          "Resend (Email)",
      configured:     Boolean(config.resend?.apiKey),
      hint:           "Sends transactional email + newsletter / product-update broadcasts. API key + verified sender addresses.",
      manageHref:     `/dashboard/${workspaceId}/settings/access`,
      manageLabel:    "Manage in Workspace settings",
      usedByChannels: channelsByDelivery.get("resend") ?? [],
    },
  ]

  return (
    <SettingsShell
      workspaceId={workspaceId}
      active="campaigns"
      eyebrow={`${config.name ?? workspaceId} · Channel Settings`}
      title="Channel Settings"
      description="Delivery-mechanism credentials for the channels you send through. Per-campaign editing (templates, fingerprint, coverage attachments) lives in the drawer on the Channels page."
    >
      <div className="space-y-8">
        <section className="space-y-4">
          <h2 className="text-[14px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Delivery mechanisms</h2>
          <ul className="space-y-3">
            {deliveryStatuses.map(d => (
              <li key={d.label} className="rounded-2xl border border-white/10 bg-white/[0.02] px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-[15px] font-semibold text-white">{d.label}</h3>
                      <StatusChip configured={d.configured} />
                    </div>
                    <p className="mt-1 text-[13px] text-zinc-400">{d.hint}</p>
                    {d.usedByChannels.length > 0 && (
                      <p className="mt-2 text-[12px] text-zinc-500">
                        Used by: <span className="text-zinc-300">{d.usedByChannels.join(", ")}</span>
                      </p>
                    )}
                  </div>
                  <a
                    href={d.manageHref}
                    className="rounded-xl border border-white/12 bg-white/[0.04] px-3 py-1.5 text-[12px] font-semibold text-zinc-100 transition-colors hover:border-white/24 motion-reduce:transition-none"
                  >
                    {d.manageLabel}
                  </a>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.02] px-5 py-4">
          <h2 className="text-[14px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">UTM scoring</h2>
          <p className="text-[13px] text-zinc-400">
            Per-campaign click scoring (the `clicked_link_score` that powers the click tracker) is now edited in each campaign&apos;s settings drawer on the{" "}
            <a className="text-white underline decoration-white/30 underline-offset-4 hover:decoration-white" href={`/dashboard/${workspaceId}/actions`}>
              Channels page
            </a>
            . Open a campaign row, click &quot;Edit settings&quot;, and adjust the score there.
          </p>
        </section>
      </div>
    </SettingsShell>
  )
}

function StatusChip({ configured }: { configured: boolean }) {
  return (
    <span className={`inline-flex items-center justify-center rounded-md px-2 py-0.5 text-[11px] font-semibold ${
      configured
        ? "bg-emerald-500/[0.12] text-emerald-200"
        : "bg-amber-500/[0.12] text-amber-200"
    }`}>
      {configured ? "Configured" : "Not set"}
    </span>
  )
}
