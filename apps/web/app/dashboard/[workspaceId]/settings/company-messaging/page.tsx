/**
 * Company Messaging - workspace-level voice hub. Two sections:
 *
 *   1. Corporate voice (Phase 2 next slice) - the workspace's umbrella
 *      writing-style fingerprint, generated from positive samples the user
 *      pastes in. Stored on WorkspaceConfig.messaging.companyFingerprint and
 *      mirrored as a style_fingerprints row (scope='corporate').
 *
 *   2. Personas - the buyer-persona library this page started as. Each
 *      persona has match rules + free-text voice blocks the LLM uses at
 *      draft time. Per-(persona, channel) fingerprints are added as
 *      sub-tabs on each persona card.
 *
 * Renamed from "Personas" in the cozy-tiger plan. Old URL
 * /settings/personas now redirects here. PDF/Markdown upload + AI-driven
 * auto-fill of the persona blocks lands as an "Upload persona doc"
 * affordance on each card.
 */

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { SettingsShell } from "../settings-shell"
import { CorporateVoiceForm } from "./corporate-voice-form"
import { PersonasForm } from "./personas-form"

export const dynamic = "force-dynamic"

export default async function PersonasPage({
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

  // valueProp (legacy single-string) → valueProps (new bullet array). Keep
  // the old text content as the first bullet so nothing visible is lost.
  // Persona `id` is hydrated for any persona persisted before stable-ids
  // landed; the next save through PATCH /api/workspace/<id>/config writes
  // it back so it sticks.
  const initial = (config.messaging?.personas ?? []).map(p => {
    const legacyValueProps = p.valueProp?.trim() ? [p.valueProp.trim()] : []
    return {
      id:               p.id               ?? crypto.randomUUID(),
      name:             p.name             ?? "",
      product:          p.product          ?? "",
      headlineQuote:    p.headlineQuote    ?? "",
      matchPatterns:    p.matchPatterns    ?? [],
      minEmployees:     p.minEmployees != null ? String(p.minEmployees) : "",
      maxEmployees:     p.maxEmployees != null ? String(p.maxEmployees) : "",
      matchCountries:   p.matchCountries  ?? [],
      whoTheyAre:       p.whoTheyAre       ?? "",
      characteristics:  p.characteristics  ?? [],
      primaryJob:       p.primaryJob       ?? "",
      jobsToBeDone:     p.jobsToBeDone     ?? [],
      emotionalJob:     p.emotionalJob     ?? "",
      valueProps:       p.valueProps?.length ? p.valueProps : legacyValueProps,
      painPoints:       p.painPoints       ?? [],
      desiredOutcomes:  p.desiredOutcomes  ?? [],
      proofPoints:      p.proofPoints      ?? [],
      objectives:       p.objectives       ?? [],
      opportunities:    p.opportunities    ?? [],
      commonObjections: p.commonObjections ?? [],
      ctas:             p.ctas             ?? [],
      redFlags:         p.redFlags         ?? [],
      voiceOfCustomer:  p.voiceOfCustomer  ?? [],
      valueLanguage:    p.valueLanguage    ?? [],
      positioning:      p.positioning      ?? "",
      language:         p.language         ?? "",
      dmPrinciples:     p.dmPrinciples     ?? "",
      churnRisk:        p.churnRisk        ?? "",
    }
  })

  return (
    <SettingsShell
      workspaceId={workspaceId}
      active="companyMessaging"
      eyebrow={`${config.name ?? workspaceId} · Company Messaging`}
      title="Company Messaging"
      description="Define how this workspace sounds. The corporate voice fingerprint sets the umbrella tone for all outbound. Personas below define who you're writing to and feed their channel-specific voice into the LLM at draft time."
    >
      <div className="space-y-8">
        <CorporateVoiceForm
          workspaceId={workspaceId}
          initial={config.messaging?.companyFingerprint ?? null}
        />
        <PersonasForm workspaceId={workspaceId} initial={initial} />
      </div>
    </SettingsShell>
  )
}
