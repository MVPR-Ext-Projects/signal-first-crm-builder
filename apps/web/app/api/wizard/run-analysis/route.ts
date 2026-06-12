import { NextRequest, NextResponse } from "next/server"
import { getSession, SESSION_COOKIE } from "@/lib/session"

export async function POST(req: NextRequest) {
  const sessionId = req.cookies.get(SESSION_COOKIE)?.value
  if (!sessionId) return NextResponse.json({ error: "No session" }, { status: 401 })

  const session = await getSession(sessionId)
  if (!session) return NextResponse.json({ error: "Session expired" }, { status: 401 })

  console.log(`[run-analysis] Running analysis for session ${sessionId}`)
  if (!session.questionnaire) {
    return NextResponse.json({ error: "Questionnaire not completed" }, { status: 400 })
  }

  // Delegate to the AI agent route
  const analyzeRes = await fetch(new URL("/api/agent/analyze", req.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  })

  if (!analyzeRes.ok) {
    const body = await analyzeRes.json().catch(() => ({})) as { error?: string }
    return NextResponse.json(
      { error: body.error ?? "Analysis failed" },
      { status: analyzeRes.status },
    )
  }

  return NextResponse.json({ ok: true })
}
