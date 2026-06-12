/**
 * GET    /api/dashboard/[workspaceId]/channels/[channelId]/fingerprint
 * POST   /api/dashboard/[workspaceId]/channels/[channelId]/fingerprint
 * DELETE /api/dashboard/[workspaceId]/channels/[channelId]/fingerprint
 *
 * Per-channel writing-style fingerprint editor for the Channel Settings
 * drawer. Resolves the channel's delivery mechanism into a StyleChannel
 * ('unipile' -> 'linkedin_dm', 'resend' -> 'email') and reads/writes the
 * existing scope='channel' fingerprint via the style-store helpers.
 *
 * This means all Unipile-delivery channels share one fingerprint; all
 * Resend-delivery channels share another. Per-channel-row fingerprint
 * storage is a Phase 2 follow-up.
 *
 * Hidden in the drawer for delivery=none / twilio_voice (voice and
 * no-delivery channels aren't fingerprint channels per CLAUDE.md).
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { sql, isDbConfigured } from "@/lib/db"
import { getChannelById } from "@/lib/db/channels"
import { generateFingerprint } from "@/lib/style/generator"
import {
  getActiveFingerprint,
  saveNewFingerprintVersion,
  type StyleChannel,
} from "@/lib/db/style-store"

const MIN_WORDS = 300
const MAX_SAMPLE_CHARS = 50_000

function deliveryToStyleChannel(delivery: string): StyleChannel | null {
  if (delivery === "unipile") return "linkedin_dm"
  if (delivery === "resend")  return "email"
  return null
}

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

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; channelId: string }> },
) {
  const { workspaceId, channelId } = await params
  const err = await auth(workspaceId)
  if (err) return err

  const channel = await getChannelById(workspaceId, channelId)
  if (!channel) return NextResponse.json({ error: "Channel not found" }, { status: 404 })

  const styleChannel = deliveryToStyleChannel(channel.deliveryMechanism)
  if (!styleChannel) return NextResponse.json({ fingerprint: null, styleChannel: null })

  const fp = await getActiveFingerprint({
    workspaceId,
    scope:     "channel",
    channel:   styleChannel,
    personaId: null,
  })
  return NextResponse.json({ fingerprint: fp, styleChannel })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; channelId: string }> },
) {
  const { workspaceId, channelId } = await params
  const err = await auth(workspaceId)
  if (err) return err

  const channel = await getChannelById(workspaceId, channelId)
  if (!channel) return NextResponse.json({ error: "Channel not found" }, { status: 404 })

  const styleChannel = deliveryToStyleChannel(channel.deliveryMechanism)
  if (!styleChannel) {
    return NextResponse.json(
      { error: "Writing-style fingerprints apply to Unipile + Resend channels only" },
      { status: 400 },
    )
  }

  const config = await getWorkspaceConfig(workspaceId)
  const body = await req.json().catch(() => null) as { samples?: unknown }
  if (!Array.isArray(body?.samples) || body.samples.length === 0) {
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
      metadata:   { scope: "channel", styleChannel },
    })
  } catch (e) {
    console.error(`[channel-fingerprint] generate failed:`, e)
    return NextResponse.json({ error: `Style analysis failed: ${(e as Error).message}` }, { status: 502 })
  }

  const saved = await saveNewFingerprintVersion({
    workspaceId,
    scope:     "channel",
    channel:   styleChannel,
    personaId: null,
    fingerprint,
    samplePos: samples.length,
    sampleNeg: 0,
    source:    "manual_upload",
  })

  return NextResponse.json({ fingerprint, version: saved.version, id: saved.id })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; channelId: string }> },
) {
  const { workspaceId, channelId } = await params
  const err = await auth(workspaceId)
  if (err) return err

  const channel = await getChannelById(workspaceId, channelId)
  if (!channel) return NextResponse.json({ error: "Channel not found" }, { status: 404 })

  const styleChannel = deliveryToStyleChannel(channel.deliveryMechanism)
  if (!styleChannel) return NextResponse.json({ ok: true })

  if (!isDbConfigured()) return NextResponse.json({ ok: true })
  const db = sql()
  await db`
    UPDATE style_fingerprints SET is_active = FALSE
    WHERE workspace_id = ${workspaceId}
      AND scope        = 'channel'
      AND channel      = ${styleChannel}
      AND persona_id   IS NULL
      AND campaign_id  IS NULL
      AND is_active    = TRUE
  `
  return NextResponse.json({ ok: true })
}
