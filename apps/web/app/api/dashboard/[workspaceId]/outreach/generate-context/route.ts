/**
 * POST /api/dashboard/[workspaceId]/outreach/generate-context
 *
 * Body: { personaName: string }
 * Returns: { context: string }
 *
 * Drafts a fallback DM context from a configured persona's analysis. The
 * Outreach Settings UI uses this to seed / regenerate the messaging.outreachContext
 * field — the user can then edit and save.
 *
 * Auth: same dashboard cookie as the page.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { generateText } from "ai"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { logAiTokens } from "@/lib/usage-log"

const MODEL = "anthropic/claude-sonnet-4.6"

const SYSTEM_PROMPT = `You write concise, plainspoken positioning copy for B2B sales teams.

You'll be given a buyer-persona analysis (who they are, what they care about, what we sell, the language they use). Your job: write a fallback DM context — a tight, ~150-word block that an SDR can use as the LLM's positioning input when no specific persona matches a lead.

Hard rules:
- 100–180 words. No more.
- Plain text, no markdown, no headings, no bullet points. Read like a single confident paragraph.
- Cover: what we sell, who we sell to, what makes us different, the tone we want. Skip anything the persona doesn't justify.
- Mirror the persona's voice-of-customer language where it appears — don't invent industry jargon.
- Sound like a human wrote it, not a brochure. No "industry-leading," no "synergize," no "best-in-class."
- Output ONLY the paragraph. No preamble, no sign-off, no "Here's the context:".`

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params

  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Unknown workspace" }, { status: 404 })

  if (config.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  let personaName: string | undefined
  try {
    const body = await request.json()
    personaName = typeof body.personaName === "string" ? body.personaName : undefined
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }
  if (!personaName) {
    return NextResponse.json({ error: "personaName is required" }, { status: 400 })
  }

  const persona = (config.messaging?.personas ?? []).find(p => p.name === personaName)
  if (!persona) {
    return NextResponse.json({ error: "Persona not found in workspace config" }, { status: 404 })
  }

  // Build a structured prompt from whichever persona blocks are populated.
  const lines: string[] = []
  lines.push(`## Persona: ${persona.name}`)
  if (persona.product?.trim())       lines.push(`Product they're interested in: ${persona.product.trim()}`)
  if (persona.headlineQuote?.trim()) lines.push(`Their voice: ${persona.headlineQuote.trim()}`)
  if (persona.whoTheyAre?.trim())    { lines.push("### Who they are");        lines.push(persona.whoTheyAre.trim()) }
  if (persona.primaryJob?.trim())    { lines.push("### Primary job");          lines.push(persona.primaryJob.trim()) }
  if (persona.jobsToBeDone?.length)  { lines.push("### Jobs to be done");      for (const b of persona.jobsToBeDone) lines.push(`- ${b}`) }
  if (persona.emotionalJob?.trim())  { lines.push("### Emotional job");        lines.push(persona.emotionalJob.trim()) }
  const valueProps = persona.valueProps?.length ? persona.valueProps : (persona.valueProp?.trim() ? [persona.valueProp.trim()] : [])
  if (valueProps.length)             { lines.push("### Value propositions");   for (const b of valueProps) lines.push(`- ${b}`) }
  if (persona.painPoints?.length)    { lines.push("### Pain points");          for (const b of persona.painPoints) lines.push(`- ${b}`) }
  if (persona.desiredOutcomes?.length) { lines.push("### Desired outcomes");   for (const b of persona.desiredOutcomes) lines.push(`- ${b}`) }
  if (persona.proofPoints?.length)   { lines.push("### Proof points");         for (const b of persona.proofPoints) lines.push(`- ${b}`) }
  if (persona.voiceOfCustomer?.length) { lines.push("### Voice of customer (mirror this language)"); for (const b of persona.voiceOfCustomer) lines.push(`- ${b}`) }
  if (persona.valueLanguage?.length) { lines.push("### Phrases this persona uses"); for (const b of persona.valueLanguage) lines.push(`- ${b}`) }
  if (persona.positioning?.trim())   { lines.push("### Positioning");          lines.push(persona.positioning.trim()) }
  if (persona.language?.trim())      { lines.push("### Language and tone");    lines.push(persona.language.trim()) }
  if (config.icpGroups?.length) {
    lines.push("### Workspace ICP groups (for orientation)")
    for (const g of config.icpGroups) lines.push(`- ${g.name}`)
  }
  lines.push("")
  lines.push("Write the fallback DM context now.")

  try {
    const result = await generateText({
      model: MODEL,
      system: SYSTEM_PROMPT,
      prompt: lines.join("\n"),
      maxOutputTokens: 350,
      temperature: 0.7,
    })
    void logAiTokens({
      workspaceId,
      model:        MODEL,
      inputTokens:  result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      metadata:     { route: "outreach/generate-context", personaName },
    })
    const context = result.text.trim()
    if (!context) {
      return NextResponse.json({ error: "Model returned an empty draft" }, { status: 502 })
    }
    return NextResponse.json({ context })
  } catch (err) {
    console.error("[outreach/generate-context] generateText failed:", err)
    return NextResponse.json(
      { error: `Generation failed: ${(err as Error).message}` },
      { status: 502 },
    )
  }
}
