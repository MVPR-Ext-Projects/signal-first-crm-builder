/**
 * POST /api/dashboard/[workspaceId]/sign-out
 *
 * Clears the dashboard auth cookie for this workspace. Cookie is path-scoped
 * to /dashboard/[workspaceId], so signing out of one workspace leaves any
 * other workspace logins intact.
 */

import { cookies } from "next/headers"
import { NextResponse } from "next/server"

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params
  const cookieStore = await cookies()
  cookieStore.set(`dashboard_auth_${workspaceId}`, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: `/dashboard/${workspaceId}`,
    maxAge: 0,
  })
  return NextResponse.json({ ok: true })
}
