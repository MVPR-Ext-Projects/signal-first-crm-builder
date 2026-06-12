/**
 * Per-campaign writing-style fingerprint endpoints.
 *
 *   GET    /api/dashboard/[workspaceId]/campaigns/[campaignId]/fingerprint
 *          Returns the active campaign-scope fingerprint, or null when none.
 *   POST   /api/dashboard/[workspaceId]/campaigns/[campaignId]/fingerprint
 *          Body: { samples: string[] } - generates + saves a new version.
 *   DELETE /api/dashboard/[workspaceId]/campaigns/[campaignId]/fingerprint
 *          Deactivates the current campaign-scope row.
 *
 * Fingerprint applies only to written-channel campaigns (linkedin_dm, email).
 * Campaigns in other channels get a 400 on POST.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { sql, isDbConfigured } from "@/lib/db"
import { generateFingerprint } from "@/lib/style/generator"
import {
  getActiveFingerprint,
  saveNewFingerprintVersion,
  type StyleChannel,
} from "@/lib/db/style-store"

const MIN_WORDS = 300
const MAX_SAMPLE_CHARS = 50_000

async function auth(workspaceId: string): Promise<NextResponse | null> {
  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Unknown workspace" }, { status: 404 })
  if (config.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }
  return null
}

/** Look up the campaign's channel from the campaigns table. */
async function campaignChannel(workspaceId: string, campaignId: string): Promise<StyleChannel | null> {
  if (!isDbConfigured()) return null
  const db = sql()
  const rows = await db<{ channel: string }>`
    SELECT channel FROM campaigns
    WHERE workspace_id = ${workspaceId} AND id = ${campaignId}
    LIMIT 1
  `
  const ch = rows[0]?.channel
  if (ch === "linkedin_dm" || ch === "email") return ch
  return null
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; campaignId: string }> },
) {
  const { workspaceId, campaignId } = await params
  const err = await auth(workspaceId)
  if (err) return err

  const channel = await campaignChannel(workspaceId, campaignId)
  if (!channel) return NextResponse.json({ fingerprint: null, channel: null })

  const fp = await getActiveFingerprint({
    workspaceId,
    scope:      "campaign",
    channel,
    personaId:  null,
    campaignId,
  })
  return NextResponse.json({ fingerprint: fp, channel })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; campaignId: string }> },
) {
  const { workspaceId, campaignId } = await params
  const err = await auth(workspaceId)
  if (err) return err

  const channel = await campaignChannel(workspaceId, campaignId)
  if (!channel) {
    return NextResponse.json(
      { error: "Writing-style fingerprints apply to linkedin_dm and email campaigns only" },
      { status: 400 },
    )
  }

  const config = await getWorkspaceConfig(workspaceId)
  let body: { samples?: unknown }
  try { body = await req.json() } catch {
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
  const totalWords = samples.reduce((n, s) => n + s.trim().split(/\s+/).filter(Boolean).length, 0)
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
      authorName: config?.name ?? "this workspace",
      metadata:   { scope: "campaign", campaignId, channel },
    })
  } catch (e) {
    console.error(`[campaign-fingerprint] generate failed:`, e)
    return NextResponse.json({ error: `Style analysis failed: ${(e as Error).message}` }, { status: 502 })
  }

  const saved = await saveNewFingerprintVersion({
    workspaceId,
    scope:      "campaign",
    channel,
    personaId:  null,
    campaignId,
    fingerprint,
    samplePos:  samples.length,
    sampleNeg:  0,
    source:     "manual_upload",
  })

  return NextResponse.json({ fingerprint, version: saved.version, id: saved.id })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; campaignId: string }> },
) {
  const { workspaceId, campaignId } = await params
  const err = await auth(workspaceId)
  if (err) return err

  if (!isDbConfigured()) return NextResponse.json({ ok: true })
  const db = sql()
  await db`
    UPDATE style_fingerprints SET is_active = FALSE
    WHERE workspace_id = ${workspaceId}
      AND scope        = 'campaign'
      AND campaign_id  = ${campaignId}
      AND is_active    = TRUE
  `
  return NextResponse.json({ ok: true })
}
