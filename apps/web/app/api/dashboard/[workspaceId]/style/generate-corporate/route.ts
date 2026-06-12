/**
 * POST /api/dashboard/[workspaceId]/style/generate-corporate
 *
 * Generates the workspace-level corporate-voice fingerprint from one or
 * more pasted writing samples and stores it in two places:
 *
 *   1. style_fingerprints (scope='corporate', channel + persona_id NULL).
 *      The canonical record. Versioned; older versions retained.
 *   2. WorkspaceConfig.messaging.companyFingerprint - mirror for the
 *      drafter so it can read the active corporate voice without a DB
 *      round-trip on every draft.
 *
 * Body: { samples: string[] } - at least one non-empty sample, total
 * length >= 300 words (analyzer minimum per the methodology doc).
 *
 * Auth: same dashboard cookie as the page.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig, patchWorkspaceConfig } from "@/lib/workspace-config"
import { generateFingerprint } from "@/lib/style/generator"
import { saveNewFingerprintVersion } from "@/lib/db/style-store"

const MIN_WORDS = 300
const MAX_SAMPLE_CHARS = 50_000 // ~12k tokens per sample - generous; the rubric is the heavy side

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

  let body: { samples?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Expected JSON body" }, { status: 400 })
  }

  if (!Array.isArray(body.samples) || body.samples.length === 0) {
    return NextResponse.json({ error: "samples must be a non-empty array of strings" }, { status: 400 })
  }
  const samples = body.samples
    .filter((s): s is string => typeof s === "string")
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.slice(0, MAX_SAMPLE_CHARS))

  if (samples.length === 0) {
    return NextResponse.json({ error: "No non-empty samples provided" }, { status: 400 })
  }

  const totalWords = samples.reduce(
    (n, s) => n + s.trim().split(/\s+/).filter(Boolean).length,
    0,
  )
  if (totalWords < MIN_WORDS) {
    return NextResponse.json(
      { error: `Need at least ${MIN_WORDS} words across all samples (got ${totalWords})` },
      { status: 422 },
    )
  }

  let fingerprint
  try {
    fingerprint = await generateFingerprint({
      workspaceId,
      samples,
      authorName: config.name ?? "this workspace",
      metadata:   { scope: "corporate" },
    })
  } catch (err) {
    console.error(`[style/generate-corporate] generate failed:`, err)
    return NextResponse.json(
      { error: `Style analysis failed: ${(err as Error).message}` },
      { status: 502 },
    )
  }

  const saved = await saveNewFingerprintVersion({
    workspaceId,
    scope:       "corporate",
    channel:     null,
    personaId:   null,
    fingerprint,
    samplePos:   samples.length, // corporate generation has no negatives - all pasted samples are positives
    sampleNeg:   0,
    source:      "manual_upload",
  })

  // Mirror onto WorkspaceConfig.messaging.companyFingerprint so the drafter
  // reads it without joining style_fingerprints on every draft.
  await patchWorkspaceConfig(workspaceId, {
    messaging: { companyFingerprint: fingerprint },
  })

  return NextResponse.json({
    fingerprint,
    version: saved.version,
    id:      saved.id,
  })
}
