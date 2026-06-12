import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { getSession, patchSession } from "@/lib/session"

/**
 * TODO(template): this route used to call the LLM with the opinionated
 * methodology template to produce a full WorkspaceBlueprint. The original
 * branded template was removed when this codebase was forked into a
 * template. Rebuild the methodology + AI prompt before re-enabling the
 * wizard, then restore the real generateText/Output.object call.
 *
 * The stub below returns a minimal empty blueprint so the wizard's session
 * shape stays valid for downstream steps that read session.blueprint.
 */

const RequestSchema = z.object({
  sessionId: z.string(),
})

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const parsed = RequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 })
  }

  const { sessionId } = parsed.data
  const session = await getSession(sessionId)
  if (!session) {
    return NextResponse.json({ error: "Session not found or expired" }, { status: 404 })
  }

  if (!session.questionnaire) {
    return NextResponse.json({ error: "Questionnaire not completed" }, { status: 400 })
  }

  const q = session.questionnaire

  // Minimal empty blueprint shape — populate properly once the methodology
  // template is rebuilt for this template's target CRM.
  const blueprint = {
    metadata: {
      companyName: "",
      businessModel: q.businessModel,
      salesMotion: q.salesMotion,
      icpSummary: q.icpDescription,
      primaryIndustry: "",
      dealType: "mixed" as const,
      hasMediaPRComponent: false,
      hasFundraisingComponent: false,
      hasPartnerMotion: false,
    },
    customObjects: [],
    companyAttributes: [],
    peopleAttributes: [],
    lists: [],
    seedInstructions: [],
    rationale: "Stub blueprint — the wizard's AI analysis step has not yet been rebuilt for this template.",
  }

  await patchSession(sessionId, { blueprint })

  return NextResponse.json({ blueprint })
}
