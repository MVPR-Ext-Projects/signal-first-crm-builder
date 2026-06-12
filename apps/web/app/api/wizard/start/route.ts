import { NextRequest, NextResponse } from "next/server"
import { createSession, SESSION_COOKIE } from "@/lib/session"

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId")

  let finalSessionId = sessionId
  if (!finalSessionId) {
    const session = await createSession()
    finalSessionId = session.sessionId
  }

  const response = NextResponse.redirect(new URL("/wizard/upload", req.url))
  response.cookies.set(SESSION_COOKIE, finalSessionId, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24, // 24h
    path: "/",
  })
  return response
}
