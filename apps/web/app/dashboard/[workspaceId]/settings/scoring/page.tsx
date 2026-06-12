import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { getWorkspaceConfig, DEFAULT_VERB_WEIGHTS, resolveThresholds } from "@/lib/workspace-config"
import { SettingsShell } from "../settings-shell"
import { ScoringForm } from "./scoring-form"

export const dynamic = "force-dynamic"

export default async function ScoringPage({
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

  // Merge saved weights over defaults so the form always has a value for every verb
  const savedWeights = config.scoring?.verbWeights ?? {}
  const currentWeights: Record<string, number> = { ...DEFAULT_VERB_WEIGHTS, ...savedWeights }
  const currentThresholds = resolveThresholds(config)

  return (
    <SettingsShell
      workspaceId={workspaceId}
      active="scoring"
      eyebrow="Settings"
      title="Engagement scoring"
      description="Set how many points each LinkedIn engagement type is worth, and the signal_score thresholds that move a contact through the score-derived part of the funnel (Prospect → High Signal). Changes affect new signals immediately. Use Recalculate to apply updated weights and thresholds to your existing contact history."
    >
      <ScoringForm
        workspaceId={workspaceId}
        initialWeights={currentWeights}
        initialThresholds={currentThresholds}
      />
    </SettingsShell>
  )
}
