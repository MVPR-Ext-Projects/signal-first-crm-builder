/**
 * Team filters — manages the workspace's team-member roster. Each member
 * is a name; assignment to companies is manual via the inline picker on
 * the Companies page (writes to company_tags.assigned_team_member_id).
 */

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { SettingsShell } from "../settings-shell"
import { TeamFiltersForm } from "./team-filters-form"

export const dynamic = "force-dynamic"

export default async function TeamFiltersPage({
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

  return (
    <SettingsShell
      workspaceId={workspaceId}
      active="team"
      eyebrow={`${config.name ?? workspaceId} · Team filters`}
      title="Team filters"
      description="The SDRs on your team. Once added, each company row on the Companies page exposes an Assign picker that maps a company to one of these names; the SDR / Companies pages can then filter by that assignment."
    >
      <TeamFiltersForm
        workspaceId={workspaceId}
        initialMembers={config.teamMembers ?? []}
      />
    </SettingsShell>
  )
}
