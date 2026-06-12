import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { getSession, patchSession, SESSION_COOKIE } from "@/lib/session"

const Schema = z.object({
  pitchDeckUrl: z.string().url().optional(),
  crmExportUrl: z.string().url().optional(),
})

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

  const parsed = Schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 })

  console.log(`[save-uploads] Saving uploads for session ${sessionId}`)
  type SessionPatch = {
    pitchDeckUrl?: string
    crmExportUrl?: string
    pitchDeckText?: string
    crmExportHeaders?: string[]
    crmExportRows?: Record<string, string>[]
  }
  const patch: SessionPatch = {}
  if (parsed.data.pitchDeckUrl) patch.pitchDeckUrl = parsed.data.pitchDeckUrl
  if (parsed.data.crmExportUrl) patch.crmExportUrl = parsed.data.crmExportUrl

  // If files were uploaded, parse them now so they're ready for the AI agent
  if (parsed.data.pitchDeckUrl) {
    try {
      const res = await fetch(new URL("/api/files/parse-pdf", req.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: parsed.data.pitchDeckUrl }),
      })
      if (res.ok) {
        const { text } = await res.json() as { text: string }
        patch.pitchDeckText = text
      }
    } catch {
      // Non-fatal — PDF parsing failure shouldn't block the wizard
    }
  }

  if (parsed.data.crmExportUrl) {
    try {
      const res = await fetch(new URL("/api/files/parse-csv", req.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: parsed.data.crmExportUrl }),
      })
      if (res.ok) {
        const data = await res.json() as {
          headers: string[]
          sampleRows: Record<string, string>[]
        }
        patch.crmExportHeaders = data.headers
        patch.crmExportRows = data.sampleRows
      }
    } catch {
      // Non-fatal
    }
  }

  await patchSession(sessionId, patch)
  return NextResponse.json({ ok: true })
}
