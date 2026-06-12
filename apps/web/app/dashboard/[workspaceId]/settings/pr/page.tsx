/**
 * Settings → PR coverage.
 *
 * Workspace's MVPR REST API credentials (apiKey + baseUrl) + Test +
 * Sync-now actions. Data flows in via /api/cron/mvpr-coverage-sync
 * every 6h; the Sync now button calls /settings/pr/sync to trigger
 * an immediate pull for this workspace.
 */

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { getSyncState } from "@/lib/db/coverage"
import { SettingsShell } from "../settings-shell"
import { PrForm } from "./pr-form"

export const dynamic = "force-dynamic"

export default async function PrSettingsPage({
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

  const syncState = await getSyncState(workspaceId)

  return (
    <SettingsShell
      workspaceId={workspaceId}
      active="pr"
      eyebrow={`${config.name ?? workspaceId} · PR coverage`}
      title="PR coverage"
      description="Connect this workspace's MVPR API so PR coverage and announcements flow into the Campaigns section. The base URL is per-tenant (your MVPR company id is embedded in the path) - copy it from MVPR's API page."
    >
      <PrForm
        workspaceId={workspaceId}
        hasApiKey={Boolean(config.mvpr?.apiKey)}
        baseUrl={config.mvpr?.baseUrl ?? ""}
        lastCoverageSyncAt={syncState?.lastCoverageSyncAt ?? null}
        lastAnnouncementSyncAt={syncState?.lastAnnouncementSyncAt ?? null}
      />
    </SettingsShell>
  )
}
