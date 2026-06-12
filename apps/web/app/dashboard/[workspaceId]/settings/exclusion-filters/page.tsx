/**
 * Exclusion filters — the rules that drop signals before they ever surface
 * in the People queue. Renamed from "Internal filter" so the section reads
 * as it acts (filtering OUT noise) and now sits as its own Settings tab.
 *
 * Three lists, each comma-separated:
 *  • Email domains — anyone whose verified email matches is purged after Surfe.
 *  • Company names — case-insensitive substring match against contact's company.
 *  • Agency team-member emails — skip Teamfluence webhook events whose
 *    team_member_email matches (operator profiles tracked under the same TF
 *    account that shouldn't pollute customer signal data).
 */

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { SettingsShell } from "../settings-shell"
import { ExclusionFiltersForm } from "./exclusion-filters-form"

export const dynamic = "force-dynamic"

export default async function ExclusionFiltersPage({
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
      active="exclusion"
      eyebrow={`${config.name ?? workspaceId} · Exclusion filters`}
      title="Exclusion filters"
      description="Drop signals from your own employees and any agency operators whose Teamfluence profiles get tracked alongside yours. These filters apply at ingestion (webhook) and at enrichment time, so excluded contacts never reach the queue."
    >
      <ExclusionFiltersForm
        workspaceId={workspaceId}
        initialEmailDomains={config.internalEmailDomains ?? []}
        initialCompanyNames={config.internalCompanyNames ?? []}
        initialAgencyEmails={config.agencyTeamMemberEmails ?? []}
        initialLinkedinUrls={config.internalLinkedinUrls ?? []}
      />
    </SettingsShell>
  )
}
