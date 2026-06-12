/**
 * Prospect types — workspace-level editable list of company tag values + the
 * subset that's pre-unchecked on the Companies page chip filter.
 *
 * The actual tagging happens on the Companies dashboard (per-company pill).
 * This page only governs the available values + which are default-excluded.
 */

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import {
  getWorkspaceConfig,
  resolveProspectTypes,
  resolveDefaultExcludedProspectTypes,
} from "@/lib/workspace-config"
import { SettingsShell } from "../settings-shell"
import { ProspectTypesForm } from "./prospect-types-form"

export const dynamic = "force-dynamic"

export default async function ProspectTypesPage({
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

  const initialTypes    = resolveProspectTypes(config)
  const initialExcluded = resolveDefaultExcludedProspectTypes(config)

  return (
    <SettingsShell
      workspaceId={workspaceId}
      active="prospectTypes"
      eyebrow={`${config.name ?? workspaceId} · Custom Tags`}
      title="Custom Tags"
      description="Tag values you can apply to companies on the Companies dashboard. Tag a company in the row to mark it as Investor / Software / Services / Partner / Excluded — or whatever values you set here. Tick the default-excluded box to keep that type pre-unchecked on the chip filter; companies tagged exclusively with a default-excluded value are hidden until the user ticks the chip."
    >
      <ProspectTypesForm
        workspaceId={workspaceId}
        initialTypes={initialTypes}
        initialExcluded={initialExcluded}
      />
    </SettingsShell>
  )
}
