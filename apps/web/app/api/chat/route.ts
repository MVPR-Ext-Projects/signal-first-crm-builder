import { streamText, tool, generateText, Output, stepCountIs, convertToModelMessages, type UIMessage } from "ai"
import { QuestionnaireSchema, WorkspaceBlueprintSchema } from "@signal-first/blueprint-schema"
import { ANALYSIS_MODEL, METHODOLOGY_SYSTEM_PROMPT } from "@/lib/ai"
import type { Questionnaire } from "@signal-first/blueprint-schema"

const CHAT_SYSTEM_PROMPT = `You are a friendly CRM consultant helping companies set up a HubSpot workspace using the signal-first methodology.

Your job is to have a natural conversation to understand the business, then generate their workspace blueprint. Keep it conversational — this should feel like a chat with an expert, not filling in a form.

## Questions to cover (in any order that feels natural)

**About the business:**
1. What the company does and who they sell to — their ICP (ideal customer profile)
2. Business model — B2B, B2C, marketplace, B2B2C
3. Sales motion — inbound, outbound, PLG, hybrid, or partner-led
4. Who the key personas/job titles are that they sell to, and who's involved in buying decisions
5. Roughly how many contacts or companies are in their universe (helps size the workspace)

**Their current setup:**
6. What CRM (if any) they're currently using — HubSpot, Salesforce, Pipedrive, spreadsheets, nothing
7. What sales and marketing tools they use (LinkedIn Sales Navigator, Apollo, Clay, HubSpot, etc.)

**LinkedIn & signal collection — these are critical for blueprint design:**
8. Are they targeting B2B professionals on LinkedIn? (This determines whether LinkedIn is the primary signal source)
9. Are they building a personal or company brand on LinkedIn? (→ affects whether we include content/messaging tracking)
10. Do they use or plan to use LinkedIn automation tools like Dripify or Teamfluence to follow people at scale?
11. Do they have enrichment tools — Surfe, Clay, Apollo, Clearbit? (→ affects enrichment workflow design)

**Channels & integrations:**
12. Which marketing channels are they actively using or plan to use? (LinkedIn personal posts, LinkedIn company page, LinkedIn ads, email, PR/press, events, podcast, newsletter, partnerships)
13. Do they use Fireflies (or similar) for call transcripts? (→ determines whether to include call_transcript object for pain point capture)

## How to conduct the conversation

- Start with one open question about what the company does
- Follow up naturally — don't read off a list, pick the most important gaps
- Group related questions naturally (e.g. ask about LinkedIn tools together)
- Clarify anything vague ("outbound to who exactly?", "what does that automation do?")
- Once you have a clear picture, call generateBlueprint
- You don't need perfect answers to everything — use good judgment on defaults

## When to generate

Call generateBlueprint once you have:
- A clear ICP and business model
- Their sales motion
- Whether LinkedIn signals are their primary source
- Which tools they use (especially enrichment + automation)
- Whether they have Fireflies for transcripts

Don't over-interrogate. 6-8 messages is usually enough for a complete picture.`

function buildUserPrompt(questionnaire: Questionnaire): string {
  const lines: string[] = [
    "## Company Profile",
    "",
    `ICP: ${questionnaire.icpDescription}`,
    `Business Model: ${questionnaire.businessModel}`,
    `Sales Motion: ${questionnaire.salesMotion}`,
    `Personas / job titles: ${questionnaire.personaTypes.join(", ") || "Not specified"}`,
    `Buyer committee: ${questionnaire.buyerPersonas.join(", ") || "Not specified"}`,
    `Entity scale: ${questionnaire.entityScale ?? "Not specified"}`,
  ]

  if (questionnaire.existingCrm) lines.push(`Existing CRM: ${questionnaire.existingCrm}`)
  if (questionnaire.toolsUsed.length) lines.push(`Tools used: ${questionnaire.toolsUsed.join(", ")}`)

  lines.push("", "## LinkedIn & signal collection")
  lines.push(`Targeting B2B professionals on LinkedIn: ${questionnaire.targetingB2BProfessionals ? "Yes" : "No/not primary"}`)
  lines.push(`Building LinkedIn brand (personal or company): ${questionnaire.linkedinBrandBuilding ? "Yes" : "No"}`)
  if (questionnaire.signalTools?.length) lines.push(`Signal collection tools: ${questionnaire.signalTools.join(", ")}`)
  if (questionnaire.enrichmentTools?.length) lines.push(`Enrichment tools: ${questionnaire.enrichmentTools.join(", ")}`)

  lines.push("", "## Channels & integrations")
  if (questionnaire.marketingChannels?.length) lines.push(`Active marketing channels: ${questionnaire.marketingChannels.join(", ")}`)
  lines.push(`Uses Fireflies / call transcripts: ${questionnaire.hasFirefliesTranscripts ? "Yes — include call_transcript object" : "No"}`)

  if (questionnaire.additionalContext) lines.push("", `Additional context: ${questionnaire.additionalContext}`)

  lines.push(
    "",
    "## Your task",
    "",
    "Produce a WorkspaceBlueprint for this company's CRM workspace.",
    "- Always include signals, sales_pipeline, client_data_match",
    "- Include messaging/content object if linkedinBrandBuilding is true or content channels are listed",
    "- Include call_transcript object if hasFirefliesTranscripts is true",
    "- Include influencers object if there is a PR, media, or partnership motion",
    "- Customise select options to match this company's industry and context",
    "- Every included component needs a specific reason referencing this company's situation",
    "- If enrichment tools are named, reference them in the enrichment workflow notes",
  )

  return lines.join("\n")
}

export async function POST(req: Request) {
  const { messages: uiMessages } = await req.json() as { messages: UIMessage[] }
  const messages = await convertToModelMessages(uiMessages ?? [])

  const result = streamText({
    model: ANALYSIS_MODEL,
    system: CHAT_SYSTEM_PROMPT,
    messages,
    tools: {
      generateBlueprint: tool({
        description: "Generate a workspace blueprint once you have enough information about the company. Call this when you have a clear picture of their ICP, business model, and sales motion.",
        inputSchema: QuestionnaireSchema,
        execute: async (questionnaire) => {
          console.log("[chat/generateBlueprint] Generating blueprint for:", questionnaire.icpDescription.slice(0, 80))
          const analysisResult = await generateText({
            model: ANALYSIS_MODEL,
            system: METHODOLOGY_SYSTEM_PROMPT,
            prompt: buildUserPrompt(questionnaire),
            experimental_output: Output.object({ schema: WorkspaceBlueprintSchema }),
          })

          if (!analysisResult.experimental_output) {
            throw new Error("Blueprint generation failed — no structured output returned")
          }

          console.log(`[chat/generateBlueprint] Blueprint generated: ${analysisResult.experimental_output.lists.filter(l => l.include).length} lists, ${analysisResult.experimental_output.customObjects.filter(o => o.include).length} objects`)
          return { blueprint: analysisResult.experimental_output }
        },
      }),
    },
    stopWhen: stepCountIs(5),
  })

  return result.toUIMessageStreamResponse()
}
