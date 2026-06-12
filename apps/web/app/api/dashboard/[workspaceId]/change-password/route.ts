/**
 * POST /api/dashboard/[workspaceId]/change-password
 *
 * Self-service password rotation for the SDR dashboard.
 *
 * Authentication: requires the existing dashboard cookie. Plus the user must
 * re-enter the current password — the cookie alone isn't enough, so a
 * compromised laptop can't silently rotate credentials.
 *
 * On success: encrypts + persists the new token via saveWorkspaceConfig
 * (saveWorkspaceConfig handles the encryption), and refreshes the auth cookie
 * so the user stays signed in.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig, saveWorkspaceConfig } from "@/lib/workspace-config"

const MIN_LENGTH = 8

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params

  const config = await getWorkspaceConfig(workspaceId)
  if (!config) {
    return NextResponse.json({ error: "Unknown workspace" }, { status: 404 })
  }

  // Distinguish first-time setup from rotation. When accessToken is empty,
  // the workspace's auth gate is open and we accept the new password without
  // requiring a current one. After this call lands, the gate closes for
  // anyone who doesn't have the cookie - which the call itself sets.
  //
  // This mirrors the recovery path after an ENCRYPTION_KEY rotation cleared
  // accessToken: the first authenticated session (here, the user submitting
  // the form) claims the workspace. The gate-open window is intentionally
  // brief and unavoidable in this state.
  const isFirstTimeSetup = !config.accessToken
  const cookieStore = await cookies()

  // Cookie check only applies when a password is already set.
  if (!isFirstTimeSetup) {
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  let currentPassword: string | undefined
  let newPassword: string | undefined
  try {
    const body = await request.json()
    currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : undefined
    newPassword     = typeof body.newPassword     === "string" ? body.newPassword     : undefined
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }
  if (!newPassword) {
    return NextResponse.json({ error: "New password is required" }, { status: 400 })
  }
  if (!isFirstTimeSetup) {
    if (!currentPassword) {
      return NextResponse.json({ error: "Current password is required" }, { status: 400 })
    }
    if (currentPassword !== config.accessToken) {
      // Slow brute-force attempts on the current-password check.
      await new Promise(r => setTimeout(r, 400))
      return NextResponse.json({ error: "Current password is incorrect" }, { status: 401 })
    }
    if (newPassword === currentPassword) {
      return NextResponse.json(
        { error: "New password must be different from the current one" },
        { status: 400 },
      )
    }
  }
  if (newPassword.length < MIN_LENGTH) {
    return NextResponse.json(
      { error: `New password must be at least ${MIN_LENGTH} characters` },
      { status: 400 },
    )
  }

  // Persist — saveWorkspaceConfig handles the encryption.
  await saveWorkspaceConfig({ ...config, accessToken: newPassword })

  // Refresh the cookie so this session stays valid. Match the path the auth
  // route uses (/) so /api/dashboard/<id>/... requests carry it.
  cookieStore.set(`dashboard_auth_${workspaceId}`, newPassword, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === "production",
    sameSite: "lax",
    path:     "/",
    maxAge:   60 * 60 * 24 * 7,
  })

  return NextResponse.json({ ok: true })
}
