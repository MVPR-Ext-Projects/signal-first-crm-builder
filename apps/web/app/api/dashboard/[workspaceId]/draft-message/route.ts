/**
 * POST /api/dashboard/[workspaceId]/draft-message
 *
 * The unified draft endpoint for the cozy-tiger plan. Replaces /draft-dm
 * (which stays as-is for legacy callers; remove in a follow-up). Supports
 * both channels (LinkedIn DM, Email) and two modes:
 *
 *   - mode: 'draft'    write a new message from scratch
 *   - mode: 'improve'  rewrite the provided seed_text in the workspace
 *                      voice, preserving intent + concrete facts
 *
 * Body:
 *   {
 *     channel:     'linkedin_dm' | 'email'
 *     linkedinUrl?:  string         // required when channel='linkedin_dm'
 *     email?:        string         // required when channel='email'
 *     mode?:       'draft' | 'improve'   default 'draft'
 *     seed_text?:    string         // required when mode='improve'
 *     template_id?:  string         // optional; biases draft mode toward this template
 *   }
 *
 * Returns: { draft, fingerprintVersionId, selectedTemplateIds }
 *
 * Auth: dashboard cookie.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { generateText } from "ai"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { sql, isDbConfigured } from "@/lib/db"
import { fetchLinkedInThread, type ThreadMessage } from "@/lib/unipile"
import { pickPersona } from "@/lib/persona-match"
import { logAiTokens } from "@/lib/usage-log"
import { fetchFingerprintsForDraft } from "@/lib/style/fetch-fingerprints"
import type { StyleChannel } from "@/lib/db/style-store"

const MODEL = "anthropic/claude-sonnet-4.6"

const DM_SYSTEM_PROMPT = `You are an SDR drafting a short LinkedIn DM to a lead who has recently engaged with our content.

Hard rules:
- 60-110 words. Shorter is better.
- Reference ONE specific thing they engaged with - be concrete.
- DO NOT pitch. The goal is to start a conversation, not close.
- Sound like a human typed it, not a template. No "I hope this finds you well." No emojis.
- End with ONE soft, open question.
- Match the tone the workspace describes in their context.
- Do not include greeting brackets like "[Name]" - write the actual name.
- Output ONLY the message body. No subject line, no signature, no preamble.

If a "Prior conversation" section is provided:
- Treat it as the existing thread between you and the lead, oldest first.
- Write the next message in the thread - don't re-introduce yourself.
- If they asked something or pushed back, respond to that directly.
- If they replied positively, push the conversation one step forward.`

const EMAIL_SYSTEM_PROMPT = `You are an SDR drafting a short outbound email to a lead who has recently engaged with our content.

Hard rules:
- 80-180 words for the body. Shorter beats longer.
- Reference ONE specific thing they did or signal they sent - be concrete.
- DO NOT pitch. The goal is to start a conversation, not close.
- Sound like a person wrote it. No "I hope this finds you well." No emojis.
- Open with a one-sentence hook tied to the specific engagement. No "I noticed you" intros.
- End with ONE soft, open question or a small ask (15-min call / one link / a relevant question).
- Match the tone the workspace describes in their context.
- Do not include greeting brackets like "[Name]" - write the actual name.
- Output ONLY the email body text. No subject line, no signature, no preamble.`

const IMPROVE_SYSTEM_PROMPT = `You are rewriting a draft message in the workspace's voice fingerprint.

Hard rules:
- Preserve the original draft's intent, key facts, and any concrete references.
- Apply the voice fingerprint transformation rules (provided in the prompt) - tone, structure, vocabulary.
- Keep length within ~10% of the original unless the voice rules explicitly favour longer or shorter.
- Do not invent facts. If the original is missing context, leave it missing.
- Sound like a human wrote it. No emojis. No "[Name]" placeholders.
- Output ONLY the rewritten message body. No preamble, no explanation.`

interface SignalRow {
  source_type:      string | null
  description:      string | null
  engagement_url:   string | null
  occurred_at:      Date | string | null
  signal_verb:      string | null
  signal_actor:     string | null
  signal_object:    string | null
  verb_description: string | null
}

interface ContactRow {
  id:                    number
  full_name:             string | null
  job_title:             string | null
  company_name:          string | null
  company_employees_min: number | null
  company_employees_max: number | null
  company_industries:    string[] | null
  icp_group:             string | null
  effective_stage:       string | null
  effective_persona:     string | null
  prospect_types:        string[] | null
}

function renderSignal(s: SignalRow): string {
  const v = s.signal_verb
  const o = s.signal_object ?? null
  const a = s.signal_actor ?? null
  if (v) {
    switch (v) {
      case "liked_post":              return o ? `Liked ${o}'s post` : "Liked a post"
      case "commented_post":          return o ? `Commented on ${o}'s post` : "Commented on a post"
      case "viewed_profile":          return o ? `Viewed ${o}'s LinkedIn profile` : "Viewed a profile"
      case "followed_our_team_member": return o ? `Followed ${o} on LinkedIn` : "Followed a team member"
      case "followed_our_company":    return "Followed our company on LinkedIn"
      case "followed_prospect":       return a ? `${a} followed them on LinkedIn` : "Team followed this contact"
      case "accepted_our_connection": return o ? `Accepted ${o}'s connection request` : "Accepted a connection request"
      case "connected":               return o ? `Connected with ${o}` : "Connected"
      case "sent_dm":                 return "DM sent"
      case "replied_dm":              return "Replied to a DM"
      case "replied_email":           return "Replied to an email"
      case "email_opened":            return "Opened an email"
      case "email_clicked":           return "Clicked a link in an email"
      case "clicked_link":            return "Clicked a tracked link"
      case "booked_meeting":          return "Booked a meeting"
      default: break
    }
  }
  if (s.description?.trim()) return s.description.trim().slice(0, 100)
  return s.source_type ?? "Engaged with content"
}

function fmtRecency(val: Date | string | null): string {
  if (!val) return "recently"
  const d = new Date(val as string)
  if (Number.isNaN(d.getTime())) return "recently"
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000)
  if (days === 0)  return "today"
  if (days === 1)  return "yesterday"
  if (days < 14)   return `${days} days ago`
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
}

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
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Postgres not configured" }, { status: 500 })
  }

  let body: {
    channel?:     unknown
    linkedinUrl?: unknown
    email?:       unknown
    mode?:        unknown
    seed_text?:   unknown
    template_id?: unknown
  }
  try { body = await request.json() } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }

  const channel = body.channel as StyleChannel
  if (channel !== "linkedin_dm" && channel !== "email") {
    return NextResponse.json({ error: "channel must be 'linkedin_dm' or 'email'" }, { status: 400 })
  }
  const mode: "draft" | "improve" = body.mode === "improve" ? "improve" : "draft"
  const linkedinUrl = typeof body.linkedinUrl === "string" ? body.linkedinUrl : undefined
  const email       = typeof body.email       === "string" ? body.email       : undefined
  const seedText    = typeof body.seed_text   === "string" ? body.seed_text   : undefined

  if (channel === "linkedin_dm" && !linkedinUrl) {
    return NextResponse.json({ error: "linkedinUrl is required for linkedin_dm" }, { status: 400 })
  }
  if (channel === "email" && !email && !linkedinUrl) {
    return NextResponse.json({ error: "email or linkedinUrl is required for email" }, { status: 400 })
  }
  if (mode === "improve" && !seedText?.trim()) {
    return NextResponse.json({ error: "seed_text required when mode='improve'" }, { status: 400 })
  }

  // ── Contact lookup. Prefer linkedin URL when present; fall back to email
  //    for email-channel sends that only have the address.
  const db = sql()
  let contact: ContactRow | undefined
  if (linkedinUrl) {
    const norm = linkedinUrl.toLowerCase().replace(/\/$/, "")
    const rows = await db<ContactRow>`
      SELECT
        c.id, c.full_name, c.job_title, c.company_name,
        c.company_employees_min, c.company_employees_max, c.company_industries,
        c.icp_group,
        COALESCE(c.manual_stage, c.funnel_stage)     AS effective_stage,
        COALESCE(c.manual_persona, c.persona)        AS effective_persona,
        COALESCE(t.prospect_types, '{}'::text[])     AS prospect_types
      FROM contacts c
      LEFT JOIN company_tags t
        ON t.workspace_id = c.workspace_id AND t.company_name = c.company_name
      WHERE c.workspace_id = ${workspaceId}
        AND LOWER(REGEXP_REPLACE(c.linkedin_url, '/$', '')) = ${norm}
      LIMIT 1
    `
    contact = rows[0]
  } else if (email) {
    const rows = await db<ContactRow>`
      SELECT
        c.id, c.full_name, c.job_title, c.company_name,
        c.company_employees_min, c.company_employees_max, c.company_industries,
        c.icp_group,
        COALESCE(c.manual_stage, c.funnel_stage)     AS effective_stage,
        COALESCE(c.manual_persona, c.persona)        AS effective_persona,
        COALESCE(t.prospect_types, '{}'::text[])     AS prospect_types
      FROM contacts c
      LEFT JOIN company_tags t
        ON t.workspace_id = c.workspace_id AND t.company_name = c.company_name
      WHERE c.workspace_id = ${workspaceId}
        AND LOWER(c.email) = ${email.toLowerCase()}
      LIMIT 1
    `
    contact = rows[0]
  }
  if (!contact) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 })
  }

  // ── Persona + fingerprints ─────────────────────────────────────────────
  const persona = pickPersona(contact.job_title, contact.icp_group, config.messaging?.personas)
  const fp = await fetchFingerprintsForDraft({
    workspaceId,
    config,
    channel,
    personaName: persona?.name,
    personaId:   persona?.id,
  })

  // ── Build the user prompt ──────────────────────────────────────────────
  const lines: string[] = []

  // Voice fingerprint goes near the top so the LLM weights it.
  if (fp.promptBlock) {
    lines.push(fp.promptBlock)
    lines.push("")
  }

  // IMPROVE mode is shorter - the rules + voice are the heavy lift; the seed
  // text is the input.
  if (mode === "improve") {
    lines.push("## Rewrite this draft in the voice above")
    lines.push(seedText!.trim())

    const result = await generateText({
      model:           MODEL,
      system:          IMPROVE_SYSTEM_PROMPT,
      prompt:          lines.join("\n"),
      maxOutputTokens: 500,
      temperature:     0.6,
    })
    void logAiTokens({
      workspaceId, model: MODEL,
      inputTokens:  result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      metadata:     { route: "draft-message", channel, mode },
    })
    const draft = result.text.trim()
    if (!draft) {
      return NextResponse.json({ error: "Model returned an empty draft" }, { status: 502 })
    }
    return NextResponse.json({
      draft,
      fingerprintVersionId: fp.fingerprintVersionId,
      selectedTemplateIds:  [],
    })
  }

  // DRAFT mode - full context.
  const principles = config.messaging?.outreachPrinciples?.trim()
  if (principles) {
    lines.push("## Outreach principles")
    lines.push(principles)
    lines.push("")
  }

  if (persona) {
    const headline      = persona.name || "(unnamed)"
    const productSuffix = persona.product?.trim() ? ` - interested in ${persona.product.trim()}` : ""
    lines.push(`## Persona: ${headline}${productSuffix}`)
    if (persona.whoTheyAre?.trim())   { lines.push("### Who they are"); lines.push(persona.whoTheyAre.trim()) }
    if (persona.primaryJob?.trim())   { lines.push("### Primary job"); lines.push(persona.primaryJob.trim()) }
    if (persona.painPoints?.length)   { lines.push("### Pain points");  for (const b of persona.painPoints) lines.push(`- ${b}`) }
    if (persona.desiredOutcomes?.length) { lines.push("### Desired outcomes"); for (const b of persona.desiredOutcomes) lines.push(`- ${b}`) }
    if (persona.ctas?.length)         { lines.push("### CTAs that work"); for (const b of persona.ctas) lines.push(`- ${b}`) }
    if (persona.valueLanguage?.length){ lines.push("### Phrases this persona uses"); for (const b of persona.valueLanguage) lines.push(`- ${b}`) }
    if (persona.language?.trim())     { lines.push("### Language and tone"); lines.push(persona.language.trim()) }
    if (persona.dmPrinciples?.trim()) { lines.push("### Message principles"); lines.push(persona.dmPrinciples.trim()) }
    lines.push("")
  } else {
    const ctx = config.messaging?.outreachContext?.trim()
    lines.push("## About us")
    lines.push(ctx || `Workspace: ${config.name ?? "Unnamed"}. Keep the message generic and curious.`)
    lines.push("")
  }

  lines.push("## The lead")
  if (contact.full_name) lines.push(`- Name: ${contact.full_name}`)
  if (contact.job_title) lines.push(`- Job: ${contact.job_title}`)
  if (contact.company_name) {
    let cl = contact.company_name
    if (contact.company_employees_min || contact.company_employees_max) {
      const lo = contact.company_employees_min
      const hi = contact.company_employees_max
      cl += ` (${lo && hi ? `${lo}-${hi}` : lo ? `${lo}+` : `up to ${hi}`} employees)`
    }
    const inds = contact.company_industries?.filter(Boolean).slice(0, 2) ?? []
    if (inds.length) cl += ` - ${inds.join(", ")}`
    lines.push(`- Company: ${cl}`)
  }
  if (contact.icp_group) lines.push(`- ICP group: ${contact.icp_group}`)
  lines.push("")

  // Recent signals
  const signals = await db<SignalRow>`
    SELECT s.source_type, s.description, s.engagement_url, s.occurred_at,
           s.signal_verb, s.signal_actor, s.signal_object, s.verb_description
    FROM   signals s
    WHERE  s.contact_id = ${contact.id}
    ORDER BY s.occurred_at DESC
    LIMIT  8
  `
  if (signals.length > 0) {
    const grouped = new Map<string, { count: number; mostRecent: Date | string | null }>()
    for (const s of signals) {
      const label = renderSignal(s)
      const ex = grouped.get(label)
      if (ex) {
        ex.count++
        if (s.occurred_at && (!ex.mostRecent || new Date(s.occurred_at as string) > new Date(ex.mostRecent as string))) {
          ex.mostRecent = s.occurred_at
        }
      } else {
        grouped.set(label, { count: 1, mostRecent: s.occurred_at })
      }
    }
    lines.push("## Recent engagement (most recent first)")
    for (const [label, { count, mostRecent }] of grouped) {
      const when = fmtRecency(mostRecent)
      lines.push(count > 1 ? `- ${label} (x${count}, most recently ${when})` : `- ${when}: ${label}`)
    }
    lines.push("")
  }

  // Templates - load workspace templates that match the lead's persona / stage / prospectType.
  const allTemplates = config.messaging?.templates ?? []
  const selectedTemplateIds: string[] = []
  if (allTemplates.length > 0) {
    const leadPersona      = contact.effective_persona ?? null
    const leadStage        = contact.effective_stage ?? null
    const leadProspectTags = contact.prospect_types ?? []
    type Scored = { tpl: typeof allTemplates[number]; score: number }
    const scored: Scored[] = []
    for (const tpl of allTemplates) {
      if (!tpl.body?.trim()) continue
      let score = 0
      let inScope = true
      if (tpl.personas?.length) {
        if (leadPersona && tpl.personas.includes(leadPersona)) score++
        else inScope = false
      }
      if (inScope && tpl.stages?.length) {
        if (leadStage && tpl.stages.includes(leadStage)) score++
        else inScope = false
      }
      if (inScope && tpl.prospectTypes?.length) {
        if (leadProspectTags.some(p => tpl.prospectTypes!.includes(p))) score++
        else inScope = false
      }
      if (inScope) scored.push({ tpl, score })
    }
    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, 3)
    if (top.length > 0) {
      for (const { tpl } of top) selectedTemplateIds.push(tpl.id)
      lines.push("## Reference templates")
      lines.push("These templates have worked for similar leads. Draw from their structure, voice, and patterns. Don't copy verbatim.")
      for (const { tpl } of top) {
        lines.push(`### ${tpl.title || "(untitled)"}`)
        lines.push(tpl.body.trim())
      }
      lines.push("")
    }
  }

  // Prior LinkedIn thread (DM channel only).
  if (channel === "linkedin_dm" && linkedinUrl) {
    let thread: ThreadMessage[] = []
    const unipile = config.messaging?.unipile
    if (unipile?.apiKey && unipile.dsn && unipile.accountId) {
      thread = await fetchLinkedInThread({ creds: unipile, linkedinUrl })
    }
    const hasReply = thread.some(m => m.from === "them")
    if (thread.length > 0 && hasReply) {
      const oldestFirst = [...thread].reverse()
      lines.push("## Prior conversation (oldest first)")
      for (const m of oldestFirst) {
        const who = m.from === "us" ? "Us" : "Them"
        const text = m.text.length > 600 ? `${m.text.slice(0, 600)}...` : m.text
        lines.push(`- ${who}: ${text}`)
      }
      lines.push("")
      lines.push("Draft the next message in this thread. Output the message text only.")
    } else {
      lines.push(`Draft a single ${channel === "linkedin_dm" ? "LinkedIn DM" : "email"} body to send them. Output the message text only.`)
    }
  } else {
    lines.push(`Draft a single ${channel === "linkedin_dm" ? "LinkedIn DM" : "email"} body to send them. Output the message text only.`)
  }

  const result = await generateText({
    model:           MODEL,
    system:          channel === "linkedin_dm" ? DM_SYSTEM_PROMPT : EMAIL_SYSTEM_PROMPT,
    prompt:          lines.join("\n"),
    maxOutputTokens: channel === "email" ? 600 : 400,
    temperature:     0.7,
  })
  void logAiTokens({
    workspaceId, model: MODEL,
    inputTokens:  result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
    metadata:     { route: "draft-message", channel, mode },
  })
  const draft = result.text.trim()
  if (!draft) {
    return NextResponse.json({ error: "Model returned an empty draft" }, { status: 502 })
  }
  return NextResponse.json({
    draft,
    fingerprintVersionId: fp.fingerprintVersionId,
    selectedTemplateIds,
  })
}
