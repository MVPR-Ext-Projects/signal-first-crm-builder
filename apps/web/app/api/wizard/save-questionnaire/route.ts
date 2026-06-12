import { NextRequest, NextResponse } from "next/server"
import { QuestionnaireSchema } from "@signal-first/blueprint-schema"
import { getSession, patchSession, SESSION_COOKIE } from "@/lib/session"

export async function POST(req: NextRequest) {
  const sessionId = req.cookies.get(SESSION_COOKIE)?.value
  if (!sessionId) return NextResponse.json({ error: "No session" }, { status: 401 })

  const session = await getSession(sessionId)
  if (!session) return NextResponse.json({ error: "Session expired" }, { status: 401 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  console.log(`[save-questionnaire] Saving questionnaire for session ${sessionId}`)
  const parsed = QuestionnaireSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid questionnaire data", issues: parsed.error.issues }, { status: 400 })
  }

  await patchSession(sessionId, { questionnaire: parsed.data })
  return NextResponse.json({ ok: true })
}
