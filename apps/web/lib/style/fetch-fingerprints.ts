/**
 * Shared fingerprint-fetch helper for draft endpoints.
 *
 * Reads the three fingerprint layers (corporate, channel, channel_persona)
 * and renders them as the markdown block used at draft time. Returns the
 * most-specific DB version id (channel_persona > channel > null for
 * corporate, which is mirrored on the workspace config not in the table)
 * so the caller can stamp outreach_log.fingerprint_version_id.
 *
 * Resolution order, least-to-most specific: corporate < channel <
 * channel_persona. The channel-only layer always loads when available so
 * that contacts without a persona match still get an Action-Set-level
 * voice instead of falling straight to corporate.
 *
 * Channel-scoped - each draft endpoint (draft-dm, draft-email, future
 * draft-message) calls this once per request.
 */

import type { WorkspaceConfig } from "@/lib/workspace-config"
import type { StyleProfile } from "./types"
import { isDbConfigured } from "@/lib/db"
import { getActiveFingerprint, type StyleChannel } from "@/lib/db/style-store"
import { renderStackedFingerprints } from "./prompt-render"

export interface FetchedFingerprints {
  /** Markdown block to inject into the prompt. Null when no layer is available. */
  promptBlock:          string | null
  /** Resolved corporate StyleProfile (mirrored on WorkspaceConfig.messaging.companyFingerprint). */
  corporate:            StyleProfile | null
  /** Resolved channel-only StyleProfile (Action-Set umbrella voice). Null when none has been generated. */
  channel:              StyleProfile | null
  /** Resolved (channel, persona) StyleProfile. Null when none has been generated. */
  cell:                 StyleProfile | null
  /** Resolved campaign-scope StyleProfile. Null when no campaign was passed or none has been generated for it. */
  campaign:             StyleProfile | null
  /** style_fingerprints.id of the most-specific fingerprint used (campaign > channel_persona > channel). Null when only corporate is in play. */
  fingerprintVersionId: number | null
}

export async function fetchFingerprintsForDraft(args: {
  workspaceId: string
  config:      WorkspaceConfig
  channel:     StyleChannel
  /** Display name of the matched persona, used for prompt labelling. */
  personaName: string | undefined
  /** Stable UUID of the matched persona. When absent, channel and corporate are used. */
  personaId:   string | undefined
  /** Campaign id. When set + a campaign-scope fingerprint exists, it becomes the most-specific layer. */
  campaignId?: string | undefined
  /** Optional campaign display name for prompt labelling. */
  campaignName?: string | undefined
}): Promise<FetchedFingerprints> {
  const corporate = args.config.messaging?.companyFingerprint ?? null

  let channelRow:  Awaited<ReturnType<typeof getActiveFingerprint>> | null = null
  let cellRow:     Awaited<ReturnType<typeof getActiveFingerprint>> | null = null
  let campaignRow: Awaited<ReturnType<typeof getActiveFingerprint>> | null = null

  if (isDbConfigured()) {
    // Channel-only layer is always candidate; persona layer only when a
    // persona matched; campaign layer only when a campaign is in scope.
    // All three issued in parallel - same table.
    const [channelResult, cellResult, campaignResult] = await Promise.all([
      getActiveFingerprint({
        workspaceId: args.workspaceId,
        scope:       "channel",
        channel:     args.channel,
        personaId:   null,
      }),
      args.personaId
        ? getActiveFingerprint({
            workspaceId: args.workspaceId,
            scope:       "channel_persona",
            channel:     args.channel,
            personaId:   args.personaId,
          })
        : Promise.resolve(null),
      args.campaignId
        ? getActiveFingerprint({
            workspaceId: args.workspaceId,
            scope:       "campaign",
            channel:     args.channel,
            personaId:   null,
            campaignId:  args.campaignId,
          })
        : Promise.resolve(null),
    ])
    channelRow  = channelResult
    cellRow     = cellResult
    campaignRow = campaignResult
  }

  const channelLabel = args.channel === "linkedin_dm" ? "LinkedIn DM" : "Email"
  const promptBlock = renderStackedFingerprints({
    corporate,
    channelOnly:    channelRow?.fingerprint  ?? null,
    channelPersona: cellRow?.fingerprint     ?? null,
    campaign:       campaignRow?.fingerprint ?? null,
    channelLabel,
    personaLabel:   args.personaName,
    campaignLabel:  args.campaignName,
  })

  return {
    promptBlock,
    corporate,
    channel:              channelRow?.fingerprint  ?? null,
    cell:                 cellRow?.fingerprint     ?? null,
    campaign:             campaignRow?.fingerprint ?? null,
    fingerprintVersionId: campaignRow?.id ?? cellRow?.id ?? channelRow?.id ?? null,
  }
}
