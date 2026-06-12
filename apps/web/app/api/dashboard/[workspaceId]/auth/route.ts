/**
 * POST /api/dashboard/[workspaceId]/auth
 *
 * Validates the submitted password against the workspace's accessToken in Redis.
 * On success, sets a secure httpOnly cookie valid for 7 days.
 * If no accessToken is configured for the workspace, access is granted freely.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params

  let password: string | undefined
  try {
    const body = await request.json()
    password = typeof body.password === "string" ? body.password : undefined
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }

  if (!password) {
    return NextResponse.json({ error: "Password is required" }, { status: 400 })
  }

  const config = await getWorkspaceConfig(workspaceId)

  // If workspace has no accessToken configured, allow through (no auth required)
  if (!config?.accessToken) {
    return NextResponse.json({ ok: true })
  }

  if (password !== config.accessToken) {
    // Small delay to slow brute-force attempts
    await new Promise((r) => setTimeout(r, 400))
    return NextResponse.json({ error: "Invalid password" }, { status: 401 })
  }

  // Set the auth cookie
  // Path scoped to "/" so the cookie is also sent on /api/dashboard/<id>/...
  // requests (the dashboard page lives at /dashboard/<id>/... but its API
  // calls live under /api/dashboard/<id>/... — different prefix).
  // Workspace isolation is preserved by namespacing the cookie name with
  // workspaceId, so different workspaces don't share the cookie.
  const cookieStore = await cookies()
  cookieStore.set(`dashboard_auth_${workspaceId}`, config.accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  })

  return NextResponse.json({ ok: true })
}
