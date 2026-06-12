/**
 * POST /api/dashboard/[workspaceId]/style/generate-cell
 *
 * Generates a (channel) or (channel, persona) writing-style fingerprint
 * from pasted positive and (optionally) negative samples.
 *
 *   Body: {
 *     channel:           'linkedin_dm' | 'email'
 *     scope?:            'channel' | 'channel_persona' (default 'channel_persona')
 *     persona_id?:       string  - required when scope='channel_persona';
 *                                  forbidden when scope='channel'. Must match
 *                                  an existing persona's id on
 *                                  WorkspaceConfig.messaging.personas[].id
 *     positive_samples:  string[]
 *     negative_samples?: string[]
 *   }
 *
 * v1 generates the fingerprint from POSITIVE samples only. Negatives are
 * stored as style_samples rows with outcome_score=-1 so the Phase 4 refit
 * cron can incorporate them when 20+ resolved samples accumulate. Channel-
 * scope samples are stored with persona_id=NULL.
 *
 * Auth: same dashboard cookie as the page. Persona-save-before-generate
 * guard lives in the UI (channel_persona scope only) - the caller PATCHes
 * /api/workspace/<id>/config with the current personas array first so the
 * persona_id resolves.
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

const VALID_CHANNELS = new Set<StyleChannel>(["linkedin_dm", "email"])
const VALID_CELL_SCOPES = new Set<StyleScope>(["channel", "channel_persona"])
const MIN_WORDS = 300
const MAX_SAMPLE_CHARS = 50_000

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

  let body: {
    channel?:          unknown
    scope?:            unknown
    persona_id?:       unknown
    positive_samples?: unknown
    negative_samples?: unknown
  }
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

  // Persona must exist on the saved config when we're scoping to one.
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

  const positives = Array.isArray(body.positive_samples) ? body.positive_samples : []
  const negatives = Array.isArray(body.negative_samples) ? body.negative_samples : []
  const cleanList = (arr: unknown[]) =>
    arr
      .filter((s): s is string => typeof s === "string")
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => s.slice(0, MAX_SAMPLE_CHARS))
  const positiveSamples = cleanList(positives)
  const negativeSamples = cleanList(negatives)

  if (positiveSamples.length === 0) {
    return NextResponse.json({ error: "positive_samples must contain at least one non-empty string" }, { status: 400 })
  }

  const totalWords = positiveSamples.reduce(
    (n, s) => n + s.split(/\s+/).filter(Boolean).length,
    0,
  )
  if (totalWords < MIN_WORDS) {
    return NextResponse.json(
      { error: `Need at least ${MIN_WORDS} words across positive samples (got ${totalWords})` },
      { status: 422 },
    )
  }

  // Run the analyzer on positives.
  let fingerprint
  try {
    fingerprint = await generateFingerprint({
      workspaceId,
      samples:    positiveSamples,
      authorName,
      metadata:   { scope: scopeParam, channel, persona_id: personaId },
    })
  } catch (err) {
    console.error(`[style/generate-cell] generate failed:`, err)
    return NextResponse.json(
      { error: `Style analysis failed: ${(err as Error).message}` },
      { status: 502 },
    )
  }

  // Save the new fingerprint version. Deactivates any prior active row.
  const saved = await saveNewFingerprintVersion({
    workspaceId,
    scope:       scopeParam,
    channel,
    personaId,
    fingerprint,
    samplePos:   positiveSamples.length,
    sampleNeg:   negativeSamples.length,
    source:      "manual_upload",
  })

  // Persist the raw samples so the Phase 4 refit cron has data to work with.
  // Positives get outcome_score=+3 (treat as 'replied' equivalent), negatives -1.
  // Resolved-at = now so the cron sees them as eligible immediately.
  if (positiveSamples.length > 0 || negativeSamples.length > 0) {
    const db = sql()
    for (const text of positiveSamples) {
      await db`
        INSERT INTO style_samples (
          workspace_id, channel, persona_id, source, content,
          outcome_score, outcome_resolved_at
        ) VALUES (
          ${workspaceId}, ${channel}, ${personaId}, 'manual_upload', ${text},
          3.0, NOW()
        )
      `
    }
    for (const text of negativeSamples) {
      await db`
        INSERT INTO style_samples (
          workspace_id, channel, persona_id, source, content,
          outcome_score, outcome_resolved_at
        ) VALUES (
          ${workspaceId}, ${channel}, ${personaId}, 'manual_upload', ${text},
          -1.0, NOW()
        )
      `
    }
  }

  return NextResponse.json({
    fingerprint,
    version:           saved.version,
    id:                saved.id,
    positive_count:    positiveSamples.length,
    negative_count:    negativeSamples.length,
  })
}
