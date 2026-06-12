/**
 * PATCH  /api/dashboard/[workspaceId]/channels/[channelId]
 * DELETE /api/dashboard/[workspaceId]/channels/[channelId]   - archives, not hard-deletes.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { updateChannel, archiveChannel, type DeliveryMechanism } from "@/lib/db/channels"

const VALID_DELIVERY: DeliveryMechanism[] = ["none", "unipile", "resend", "twilio_voice"]

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

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; channelId: string }> },
) {
  const { workspaceId, channelId } = await params
  const err = await auth(workspaceId)
  if (err) return err

  const body = await req.json().catch(() => null) as {
    name?: string; deliveryMechanism?: string; hasFingerprint?: boolean
  } | null
  if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 })

  if (body.deliveryMechanism !== undefined && !VALID_DELIVERY.includes(body.deliveryMechanism as DeliveryMechanism)) {
    return NextResponse.json(
      { error: `deliveryMechanism must be one of: ${VALID_DELIVERY.join(", ")}` },
      { status: 400 },
    )
  }

  const ok = await updateChannel({
    workspaceId,
    id:                channelId,
    name:              body.name,
    deliveryMechanism: body.deliveryMechanism as DeliveryMechanism | undefined,
    hasFingerprint:    body.hasFingerprint,
  })
  if (!ok) return NextResponse.json({ error: "Channel not found" }, { status: 404 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; channelId: string }> },
) {
  const { workspaceId, channelId } = await params
  const err = await auth(workspaceId)
  if (err) return err
  const ok = await archiveChannel(workspaceId, channelId)
  if (!ok) return NextResponse.json({ error: "Channel not found or already archived" }, { status: 404 })
  return NextResponse.json({ ok: true })
}
