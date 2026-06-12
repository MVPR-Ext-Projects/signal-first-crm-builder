/**
 * Outreach Settings — the substance of outbound messaging.
 *
 *  • Fallback DM context: free-text positioning the LLM uses when no persona
 *    matches a lead. Has a "Generate from persona" affordance — pick a persona,
 *    AI drafts the context based on that persona's analysis, user edits / saves /
 *    regenerates.
 *  • Outreach principles: pacing rules fed into every draft.
 *  • Templates: reusable message scaffolding tagged by persona / stage /
 *    prospect type. The /draft-dm route picks matching templates and injects
 *    them as reference material.
 *
 * Channel credentials (Unipile API key, DSN, account id) live separately under
 * the main Settings → Messaging providers section.
 */

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { getWorkspaceConfig, resolveProspectTypes } from "@/lib/workspace-config"
import { SettingsShell } from "../settings-shell"
import { OutreachForm } from "./outreach-form"

export const dynamic = "force-dynamic"

const STAGES = [
  "Prospect",
  "Signal Found",
  "Engaged",
  "High Signal",
  "Discovery Call",
  "Requested Information",
  "Sent Information",
  "Follow Up Call",
  "Diligence",
  "Contract Negotiation",
]

export default async function OutreachSettingsPage({
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

  const personaNames = (config.messaging?.personas ?? [])
    .map(p => p.name?.trim())
    .filter((n): n is string => !!n)

  return (
    <SettingsShell
      workspaceId={workspaceId}
      active="outreach"
      eyebrow={`${config.name ?? workspaceId} · Outreach Settings`}
      title="Outreach Settings"
      description="The fallback DM context, outreach pacing principles, and reusable message templates the AI draws from when drafting LinkedIn DMs and emails."
    >
      <OutreachForm
        workspaceId={workspaceId}
        initialContext={config.messaging?.outreachContext ?? ""}
        initialPrinciples={config.messaging?.outreachPrinciples ?? ""}
        initialTemplates={config.messaging?.templates ?? []}
        initialEmailFreshnessDays={config.messaging?.emailFreshnessDays ?? 365}
        availablePersonas={personaNames}
        availableProspectTypes={resolveProspectTypes(config)}
        availableStages={STAGES}
      />
    </SettingsShell>
  )
}
