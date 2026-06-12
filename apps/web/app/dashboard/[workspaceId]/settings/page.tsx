/**
 * Workspace Settings page.
 *
 * Self-service config for an existing workspace: enrichment API tokens, ICP
 * keywords, internal-employee filters. Same auth gate as the SDR dashboard.
 *
 * Tokens are never echoed back to the client. The server tells the client
 * which providers are *configured* and the user pastes a new value to
 * overwrite (or leaves blank to keep). Save calls PATCH /api/workspace/...
 * which deep-merges enrichment so a partial update doesn't wipe other keys.
 */

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { SettingsShell } from "./settings-shell"
import { SettingsForm } from "./settings-form"

export const dynamic = "force-dynamic"

interface ConfiguredFlags {
  surfe: boolean
  apollo: boolean
  apify: boolean
  moz: boolean
  unipile: boolean
  resend: boolean
}

export interface ResendSenderState {
  email: string
  name:  string
  role:  'default'
}

export interface SettingsInitialState {
  configured: ConfiguredFlags
  apifyActorId: string
  apifyMaxEmployees: number | null
  apifyInterestsActorId: string
  /** Cap on X-interests results per fetch. Actor itself is hardcoded. */
  apifyXInterestsMaxResults: number | null
  /** Plain text — Unipile DSN/accountId aren't secrets, just opaque IDs. */
  unipileDsn: string
  unipileAccountId: string
  /** Resend senders are safe to expose; only the API key is masked. */
  resendSenders: ResendSenderState[]
  /** Workspace notification email. */
  adminEmail: string
}

export default async function SettingsPage({
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

  const initial: SettingsInitialState = {
    configured: {
      surfe:   !!config.enrichment?.surfe?.apiKey,
      apollo:  !!config.enrichment?.apollo?.apiKey,
      apify:   !!config.enrichment?.apify?.apiToken,
      moz:     !!config.enrichment?.moz?.apiKey,
      unipile: !!config.messaging?.unipile?.apiKey,
      resend:  !!config.resend?.apiKey,
    },
    apifyActorId:           config.enrichment?.apify?.actorId          ?? "",
    apifyMaxEmployees:      config.enrichment?.apify?.maxEmployees     ?? null,
    apifyInterestsActorId:  config.enrichment?.apify?.interestsActorId ?? "",
    apifyXInterestsMaxResults: config.enrichment?.apify?.xInterestsMaxResults ?? null,
    unipileDsn:          config.messaging?.unipile?.dsn               ?? "",
    unipileAccountId:    config.messaging?.unipile?.accountId         ?? "",
    resendSenders:       (config.resend?.senders ?? []).map(s => ({
      email: s.email,
      name:  s.name ?? "",
      role:  s.role,
    })),
    adminEmail: config.adminEmail ?? "",
  }

  return (
    <SettingsShell
      workspaceId={workspaceId}
      active="enrichment"
      eyebrow={`${config.name ?? workspaceId} · Configuration`}
      title={config.name ?? workspaceId}
      description="Tokens are encrypted at rest. Leave a field blank to keep the saved value."
    >
      <SettingsForm workspaceId={workspaceId} initial={initial} />
    </SettingsShell>
  )
}
