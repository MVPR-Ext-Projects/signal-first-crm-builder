/**
 * POST /api/dashboard/[workspaceId]/personas/parse-doc
 *
 * Body: multipart form-data with a single `file` field — PDF or Markdown.
 * Returns: structured persona JSON (richer schema) the client can drop into
 * the persona form for the user to review and save.
 *
 * Parse-on-upload — we don't store the original file. PDF text is extracted
 * via pdf-parse, Markdown is read as plain text. Then Claude (via the Vercel
 * AI Gateway) runs a structured-output generation against a Zod schema and
 * returns the populated persona fields.
 *
 * Auth: same dashboard cookie as the page.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { generateObject } from "ai"
import { z } from "zod"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { logAiTokens } from "@/lib/usage-log"

const MODEL = "anthropic/claude-sonnet-4.6"
const MAX_FILE_BYTES = 5 * 1024 * 1024  // 5MB
const MAX_TEXT_CHARS = 60_000           // ~15k tokens worth — protects the prompt

const PersonaSchema = z.object({
  // Identity
  name: z.string().describe(
    "Short evocative label for this persona — e.g. 'The Stretched Startup Comms Lead', 'The Enterprise Comms Champion'. If the document has a title, use it.",
  ),
  product: z.string().describe(
    "Which product or service this persona is interested in buying (e.g. 'PR Services', 'PR Operating System'). Infer from the document context. Empty string if it's not stated or implied.",
  ),
  headlineQuote: z.string().describe(
    "Single canonical customer quote that captures how the persona sounds. Verbatim from the document if a quote is highlighted at the top; otherwise the most representative voice-of-customer quote.",
  ),

  // Match rules
  matchPatterns: z.array(z.string()).describe(
    "Case-insensitive substrings of job titles that identify this persona — also called 'Job titles' in the UI. Keep them short, lowercase, 1–3 words. e.g. ['comms lead', 'head of pr', 'pr manager'].",
  ),
  minEmployees: z.string().describe(
    "Optional minimum employee count for this persona's company. Strict — when set, leads at smaller companies won't match. Empty string when the doc doesn't imply a size constraint. Use a single integer (e.g. '1000' for an enterprise persona). Infer from doc context when explicit (e.g. 'large enterprise' → '1000', 'mid-market' → '200').",
  ),
  maxEmployees: z.string().describe(
    "Optional maximum employee count. Strict — leads at larger companies won't match. Empty string when not implied. Examples: 'startup or scaleup' → '200', 'small startup' → '50'.",
  ),
  matchCountries: z.array(z.string()).describe(
    "Optional ISO-2 country allow-list (e.g. ['GB', 'US']). Set only when the doc clearly says the persona is region-specific. Empty array when the persona is global/no constraint.",
  ),

  // Description
  whoTheyAre: z.string().describe(
    "Long-form paragraph describing who this persona is — their role, context, constraints. Pulled from the 'Who they are' section if the document has one.",
  ),
  characteristics: z.array(z.string()).describe(
    "4–6 short trait bullets — single-sentence statements that capture the essence of this persona's situation.",
  ),

  // Jobs to be done
  primaryJob: z.string().describe(
    "Single statement of the persona's primary job to be done. From 'Primary job' in the doc if present.",
  ),
  jobsToBeDone: z.array(z.string()).describe(
    "Secondary jobs / 'Also needs to' bullets. Each item is one short job statement.",
  ),
  emotionalJob: z.string().describe(
    "Paragraph capturing the emotional / identity outcome the persona wants. From 'Emotional job' in the doc.",
  ),

  // Value
  valueProps: z.array(z.string()).describe(
    "Bullet list — what we sell to this persona and why they care. Each item is one short value-prop bullet.",
  ),
  painPoints: z.array(z.string()).describe(
    "Concrete problems this persona has. Each item is one short pain bullet. From the 'Pain points' section.",
  ),
  desiredOutcomes: z.array(z.string()).describe(
    "What success looks like for this persona. Each item is one short outcome bullet. From the 'Desired outcomes' section.",
  ),
  proofPoints: z.array(z.string()).describe(
    "Customer logos, case studies, quotes or stats that resonate. Each item is one short proof bullet.",
  ),
  objectives: z.array(z.string()).describe(
    "Optional — explicit goals/objectives the persona has (overlaps with desiredOutcomes; only fill if the document distinguishes them).",
  ),
  opportunities: z.array(z.string()).describe(
    "Optional — adjacent opportunities or upsell angles for this persona. Empty array when not present in the doc.",
  ),

  // Buying signals
  commonObjections: z.array(z.string()).describe(
    "Pushback this persona typically gives. Each item is one short objection bullet.",
  ),
  ctas: z.array(z.string()).describe(
    "Asks that work — calls to action that have landed before (e.g. '15-min intro call', 'invite to roundtable', 'share teardown deck'). Each item is one short CTA bullet.",
  ),
  redFlags: z.array(z.string()).describe(
    "Disqualifiers — signals that a contact is NOT this persona. From the 'Red flags' section.",
  ),

  // Voice
  voiceOfCustomer: z.array(z.string()).describe(
    "Themes / quotes capturing how the persona talks about their world. From the 'Voice of customer' section. Each item is one short theme bullet.",
  ),
  valueLanguage: z.array(z.string()).describe(
    "Phrases this persona uses when describing value. From the 'Value language' section. Each item is a short phrase.",
  ),

  // Selling principles
  positioning: z.string().describe(
    "Paragraph — how to position the product to this persona. From the 'How to sell' / 'Positioning' section.",
  ),
  language: z.string().describe(
    "Tone hints — how the message should sound to this persona. One short paragraph.",
  ),
  dmPrinciples: z.string().describe(
    "Do's and don'ts for outbound messages to this persona. A few short lines.",
  ),
  churnRisk: z.string().describe(
    "Paragraph — what causes this persona to churn after they've bought. From the 'Churn risk' section.",
  ),
})

const SYSTEM_PROMPT = `You are an expert SDR coach. The user uploads a document describing one or more buyer personas — typically a call-intelligence persona report, a sales playbook excerpt, or a positioning one-pager. Your job is to extract the most useful single persona from the document and structure it for outbound messaging.

The documents we see often follow a structure like:
  - Title + one canonical customer quote
  - Who they are (paragraph + 4–6 bullets)
  - Jobs to be done (Primary, Also needs to, Emotional)
  - Pain points (with severity tags + customer quotes)
  - Desired outcomes (with customer quotes)
  - Voice of customer (themes + quotes)
  - Value language (phrases)
  - How to sell / Positioning (paragraph)
  - Red flags & Churn risk

Map the document's sections directly into the schema fields. The schema field descriptions tell you which section maps where.

Rules:
- If the document covers multiple personas, pick the one that's most clearly described. Don't try to merge multiple personas into one output.
- Be concrete. Specific pain bullets ("Manual reconciliation across 4 banks costs us 8 hours a week") beat vague ones ("Hard to manage").
- Strip the severity tags (HIGH/MEDIUM) from pain-point text — keep the text only.
- Customer quotes that appear in the source document are valuable — keep the most useful ones in voiceOfCustomer or as the headlineQuote, but don't put inline quotes inside other fields' bullets.
- Stay grounded in the document. Don't invent customer names, stats, or proof points that aren't there. If a field has no information, return an empty array or empty string.
- Keep bullets short and scannable — single sentences, no paragraphs.
- For 'product', infer which offering the persona is interested in buying (e.g. 'PR Services', 'PR Operating System', or whatever product names appear in the doc). Empty string if it can't be inferred.
- For 'minEmployees' / 'maxEmployees', infer company-size constraints from doc language: 'startup or scaleup' implies a max around 200; 'enterprise' implies a min around 1000; 'mid-market' is roughly 200-1000. Stay conservative — leave empty when the doc doesn't clearly imply a size.
- For 'matchCountries', only fill when the doc is clearly region-specific. Use ISO-2 codes ('GB', 'US', 'DE'). Most personas are global — empty array is the right default.`

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params

  // Auth — same cookie as the dashboard
  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Unknown workspace" }, { status: 404 })
  if (config.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data body" }, { status: 400 })
  }

  const file = formData.get("file")
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' field" }, { status: 400 })
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "File is empty" }, { status: 400 })
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: `File too large (max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB)` }, { status: 413 })
  }

  // ── Extract text ─────────────────────────────────────────────────────────
  const lower = (file.name || "").toLowerCase()
  const isMarkdown = file.type === "text/markdown" || lower.endsWith(".md") || lower.endsWith(".markdown")
  const isPdf      = file.type === "application/pdf" || lower.endsWith(".pdf")
  const isText     = file.type === "text/plain" || lower.endsWith(".txt")
  if (!isMarkdown && !isPdf && !isText) {
    return NextResponse.json({ error: "Only PDF, Markdown, or plain-text files are supported" }, { status: 415 })
  }

  let text = ""
  try {
    if (isPdf) {
      // Dynamic import — pdf-parse pulls in fs deps that the bundler shouldn't
      // hoist into client code paths.
      const pdfParse = (await import("pdf-parse")).default
      const buf = Buffer.from(await file.arrayBuffer())
      const out = await pdfParse(buf)
      text = (out.text ?? "").trim()
    } else {
      text = (await file.text()).trim()
    }
  } catch (err) {
    return NextResponse.json(
      { error: `Couldn't extract text from the file: ${(err as Error).message}` },
      { status: 422 },
    )
  }

  if (!text) {
    return NextResponse.json({ error: "The file didn't contain any extractable text" }, { status: 422 })
  }

  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS)
  }

  // ── Run the structured-output generation ────────────────────────────────
  try {
    const result = await generateObject({
      model:    MODEL,
      schema:   PersonaSchema,
      system:   SYSTEM_PROMPT,
      prompt:   `Extract the buyer persona from this document.\n\n---\n\n${text}`,
      // Lower temperature than draft-dm — we want fidelity to the doc, not creativity.
      temperature: 0.2,
    })

    void logAiTokens({
      workspaceId,
      model:        MODEL,
      inputTokens:  result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      metadata:     { route: "personas/parse-doc", filename: file.name, bytes: file.size },
    })

    return NextResponse.json({ persona: result.object })
  } catch (err) {
    console.error(`[personas/parse-doc] generateObject failed:`, err)
    return NextResponse.json(
      { error: `Parse failed: ${(err as Error).message}` },
      { status: 502 },
    )
  }
}
