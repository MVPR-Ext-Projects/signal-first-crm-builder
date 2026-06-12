/**
 * GET  /api/dashboard/[workspaceId]/channels - list channels
 * POST /api/dashboard/[workspaceId]/channels - create
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { listChannels, createChannel, type DeliveryMechanism } from "@/lib/db/channels"

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

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params
  const err = await auth(workspaceId)
  if (err) return err
  const channels = await listChannels(workspaceId)
  return NextResponse.json({ channels })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params
  const err = await auth(workspaceId)
  if (err) return err

  const body = await req.json().catch(() => null) as {
    name?: string; deliveryMechanism?: string; hasFingerprint?: boolean
  } | null
  if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 })

  const name = (body.name ?? "").trim()
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 })

  const dm = body.deliveryMechanism as DeliveryMechanism | undefined
  if (!dm || !VALID_DELIVERY.includes(dm)) {
    return NextResponse.json(
      { error: `deliveryMechanism must be one of: ${VALID_DELIVERY.join(", ")}` },
      { status: 400 },
    )
  }

  const id = await createChannel({
    workspaceId,
    name,
    deliveryMechanism: dm,
    hasFingerprint:    Boolean(body.hasFingerprint),
  })
  return NextResponse.json({ ok: true, id })
}
