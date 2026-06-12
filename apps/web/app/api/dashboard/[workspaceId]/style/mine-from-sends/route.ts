/**
 * POST /api/dashboard/[workspaceId]/style/mine-from-sends
 *
 * Bootstraps a channel or (channel, persona) fingerprint from this
 * workspace's existing outreach_log history. Pipeline:
 *
 *   1. Find sends matching the cell - outreach_log filtered by channel
 *      (linkedin_dm => 'dm'). For scope='channel_persona', also filtered
 *      by persona name (outreach_log.persona stores the matched persona's
 *      display name, not its id). For scope='channel', the persona filter
 *      is dropped so sends across all personas contribute.
 *   2. For each send, score the engagement that followed via the locked
 *      outcome scorer (see lib/style/outcome-scorer.ts).
 *   3. Split into positive (score >= 1) and negative (score <= -1) buckets,
 *      capped to the most recent 20 of each.
 *   4. Run the analyzer on positives, save the new fingerprint version.
 *   5. Persist all scored samples to style_samples so the Phase 4 refit
 *      cron has data to build on. Channel-scope rows get persona_id=NULL.
 *
 * Body: {
 *   channel:     'linkedin_dm' | 'email'
 *   scope?:      'channel' | 'channel_persona' (default 'channel_persona')
 *   persona_id?: string  - required when scope='channel_persona'; forbidden
 *                          when scope='channel'.
 * }
 * Auth: dashboard cookie.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { sql } from "@/lib/db"
import { generateFingerprint } from "@/lib/style/generator"
import {
  saveNewFingerprintVersion,
  type StyleChannel,
  type StyleScope,
} from "@/lib/db/style-store"
import { scoreSendOutcome } from "@/lib/style/outcome-scorer"

const VALID_CHANNELS = new Set<StyleChannel>(["linkedin_dm", "email"])
const VALID_CELL_SCOPES = new Set<StyleScope>(["channel", "channel_persona"])
const LOOKBACK_DAYS  = 90    // sends older than this are usually outdated voice
const MAX_SENDS      = 200   // cap the historical pull
const MAX_BUCKET     = 20    // most-recent N per bucket

/** Map style channel -> outreach_log.channel value. */
function outreachChannel(style: StyleChannel): "dm" | "email" {
  return style === "linkedin_dm" ? "dm" : "email"
}

function channelLabel(c: StyleChannel): string {
  return c === "linkedin_dm" ? "LinkedIn DM" : "Email"
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params

  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Unknown workspace" }, { status: 404 })
  if (config.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  let body: { channel?: unknown; scope?: unknown; persona_id?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Expected JSON body" }, { status: 400 })
  }

  const channel = body.channel as StyleChannel
  if (typeof channel !== "string" || !VALID_CHANNELS.has(channel)) {
    return NextResponse.json({ error: "channel must be 'linkedin_dm' or 'email'" }, { status: 400 })
  }
  const scopeParam = (typeof body.scope === "string" ? body.scope : "channel_persona") as StyleScope
  if (!VALID_CELL_SCOPES.has(scopeParam)) {
    return NextResponse.json({ error: "scope must be 'channel' or 'channel_persona'" }, { status: 400 })
  }
  const rawPersonaId = body.persona_id
  if (scopeParam === "channel_persona") {
    if (typeof rawPersonaId !== "string" || !rawPersonaId) {
      return NextResponse.json({ error: "persona_id is required when scope='channel_persona'" }, { status: 400 })
    }
  } else if (rawPersonaId !== undefined && rawPersonaId !== null && rawPersonaId !== "") {
    return NextResponse.json({ error: "persona_id must be omitted when scope='channel'" }, { status: 400 })
  }

  type Persona = NonNullable<NonNullable<typeof config.messaging>["personas"]>[number]
  let persona: Persona | undefined = undefined
  if (scopeParam === "channel_persona") {
    persona = config.messaging?.personas?.find(p => p.id === rawPersonaId)
    if (!persona) {
      return NextResponse.json({
        error: "Unknown persona_id. Save personas first.",
      }, { status: 422 })
    }
  }
  const personaId  = scopeParam === "channel_persona" ? (rawPersonaId as string) : null
  const authorName = persona ? `${persona.name} (${channel})` : `Channel voice (${channelLabel(channel)})`

  // Pull recent sends matching the cell. For channel_persona, narrow to the
  // persona's display name. For channel, aggregate across all personas.
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000)
  const dbCh  = outreachChannel(channel)
  const db    = sql()
  const sends = persona
    ? await db<{
        id: number; contact_id: number; message_preview: string | null;
        occurred_at: Date;
      }>`
        SELECT id, contact_id, message_preview, occurred_at
        FROM outreach_log
        WHERE workspace_id = ${workspaceId}
          AND channel      = ${dbCh}
          AND persona      = ${persona.name}
          AND occurred_at >= ${since}
          AND message_preview IS NOT NULL
        ORDER BY occurred_at DESC
        LIMIT ${MAX_SENDS}
      `
    : await db<{
        id: number; contact_id: number; message_preview: string | null;
        occurred_at: Date;
      }>`
        SELECT id, contact_id, message_preview, occurred_at
        FROM outreach_log
        WHERE workspace_id = ${workspaceId}
          AND channel      = ${dbCh}
          AND occurred_at >= ${since}
          AND message_preview IS NOT NULL
        ORDER BY occurred_at DESC
        LIMIT ${MAX_SENDS}
      `

  if (sends.length === 0) {
    const audience = persona ? `persona "${persona.name}"` : `the ${channelLabel(channel)} channel`
    return NextResponse.json({
      error: `No ${channel} sends found for ${audience} in the last ${LOOKBACK_DAYS} days.`,
    }, { status: 422 })
  }

  // Score each send.
  const scored: Array<{
    sendId:    number
    contactId: number
    content:   string
    sentAt:    Date
    score:     number
  }> = []
  for (const s of sends) {
    if (!s.message_preview) continue
    const result = await scoreSendOutcome({
      workspaceId,
      contactId: s.contact_id,
      sentAt:    s.occurred_at,
    })
    scored.push({
      sendId:    s.id,
      contactId: s.contact_id,
      content:   s.message_preview,
      sentAt:    s.occurred_at,
      score:     result.score,
    })
  }

  // Bucket + cap.
  const positives = scored.filter(s => s.score >= 1).slice(0, MAX_BUCKET)
  const negatives = scored.filter(s => s.score <= -1).slice(0, MAX_BUCKET)

  if (positives.length === 0) {
    const audience = persona ? `"${persona.name}"` : `the ${channelLabel(channel)} channel`
    return NextResponse.json({
      error: `Found ${sends.length} ${channel} send(s) for ${audience} but none scored positively. Try pasting samples instead.`,
      sends_examined: sends.length,
    }, { status: 422 })
  }

  // Run the analyzer on positive bodies.
  let fingerprint
  try {
    fingerprint = await generateFingerprint({
      workspaceId,
      samples:    positives.map(p => p.content),
      authorName,
      metadata:   { scope: scopeParam, channel, persona_id: personaId, source: "mined" },
    })
  } catch (err) {
    console.error(`[style/mine-from-sends] generate failed:`, err)
    return NextResponse.json(
      { error: `Style analysis failed: ${(err as Error).message}` },
      { status: 502 },
    )
  }

  // Save the fingerprint version.
  const saved = await saveNewFingerprintVersion({
    workspaceId,
    scope:       scopeParam,
    channel,
    personaId,
    fingerprint,
    samplePos:   positives.length,
    sampleNeg:   negatives.length,
    source:      "mined_from_outreach_log",
  })

  // Persist samples to style_samples for the refit cron.
  for (const s of [...positives, ...negatives]) {
    await db`
      INSERT INTO style_samples (
        workspace_id, channel, persona_id, contact_id, source, content,
        outcome_score, outcome_resolved_at, outreach_log_id
      ) VALUES (
        ${workspaceId}, ${channel}, ${personaId}, ${s.contactId},
        'mined_from_outreach_log', ${s.content},
        ${s.score}, NOW(), ${s.sendId}
      )
    `
  }

  return NextResponse.json({
    fingerprint,
    version:        saved.version,
    id:             saved.id,
    sends_examined: sends.length,
    positive_count: positives.length,
    negative_count: negatives.length,
  })
}
