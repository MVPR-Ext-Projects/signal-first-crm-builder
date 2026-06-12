/**
 * POST /api/dashboard/[workspaceId]/draft-dm
 *
 * Body: { linkedinUrl: string }
 * Returns: { draft: string }
 *
 * Drafts a short, low-pressure LinkedIn DM for the given lead by feeding the
 * workspace's outreach context, the lead's profile, and their recent
 * engagement signals to Claude. Returns the draft text — the SDR edits before
 * sending via /send-dm.
 *
 * Auth: same dashboard cookie as the page.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { generateText } from "ai"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { sql, isDbConfigured } from "@/lib/db"
import { fetchLinkedInThread, type ThreadMessage } from "@/lib/unipile"
import { pickPersona } from "@/lib/persona-match"
import { logAiTokens } from "@/lib/usage-log"
import {
  getLatestUnrespondedOutreach,
  markOutreachResponded,
  getOutreachTemplateStats,
} from "@/lib/db/contact-store"
import { getActiveFingerprint } from "@/lib/db/style-store"
import { renderStackedFingerprints } from "@/lib/style/prompt-render"

const MODEL = "anthropic/claude-sonnet-4.6"

const SYSTEM_PROMPT = `You are an SDR drafting a short LinkedIn DM to a lead who has recently engaged with our content.

Hard rules:
- 60–110 words. Shorter is better.
- Reference ONE specific thing they engaged with — be concrete.
- DO NOT pitch. The goal is to start a conversation, not close.
- Sound like a human typed it, not a template. No "I hope this finds you well." No emojis.
- End with ONE soft, open question.
- Match the tone the workspace describes in their context.
- Do not include greeting brackets like "[Name]" — write the actual name.
- Output ONLY the message body. No subject line, no signature, no preamble.

If a "Prior conversation" section is provided:
- Treat it as the existing thread between you and the lead, oldest first. "Us:" is your prior outbound; "Them:" is the lead's reply.
- Write the next message in the thread — don't re-introduce yourself, don't repeat openers you've already used.
- If they asked something or pushed back, respond to that directly.
- If they replied positively, push the conversation one step forward (a small ask — a 15-min call, a link, a relevant question). Still soft, still under 110 words.`

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
  id:                      number
  full_name:               string | null
  job_title:               string | null
  company_name:            string | null
  company_employees_min:   number | null
  company_employees_max:   number | null
  company_industries:      string[] | null
  icp_group:               string | null
  effective_stage:         string | null
  effective_persona:       string | null
  prospect_types:          string[] | null
}

// ── Signal helpers ─────────────────────────────────────────────────────────

function renderSignal(s: SignalRow): string {
  const verb = s.signal_verb
  const obj  = s.signal_object ?? null
  const actor = s.signal_actor ?? null

  if (verb) {
    switch (verb) {
      case "liked_post":                return obj ? `Liked ${obj}'s post`                       : "Liked a post"
      case "commented_post":            return obj ? `Commented on ${obj}'s post`                 : "Commented on a post"
      case "viewed_profile":            return obj ? `Viewed ${obj}'s LinkedIn profile`           : "Viewed a profile"
      case "followed_our_team_member":  return obj ? `Followed ${obj} on LinkedIn`                : "Followed a team member"
      case "followed_our_company":      return "Followed our company on LinkedIn"
      case "followed_prospect":         return actor ? `${actor} followed them on LinkedIn`       : "Team followed this contact"
      case "sent_connection_request":   return actor ? `${actor} sent a connection request`       : "Connection request sent"
      case "accepted_our_connection":   return obj   ? `Accepted ${obj}'s connection request`    : "Accepted a connection request"
      case "connected":                 return obj   ? `Connected with ${obj}`                   : "Connected"
      case "sent_dm":                   return actor ? `${actor} sent a DM`                      : "DM sent"
      case "replied_dm":                return "Replied to a DM"
      case "booked_meeting":            return "Booked a meeting"
      case "ai_search":                 return "Appeared in AI search"
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

  // Auth — same cookie as the dashboard
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

  let linkedinUrl: string | undefined
  try {
    const body = await request.json()
    linkedinUrl = typeof body.linkedinUrl === "string" ? body.linkedinUrl : undefined
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }
  if (!linkedinUrl) return NextResponse.json({ error: "linkedinUrl is required" }, { status: 400 })

  // ── Look up the contact + recent signals ───────────────────────────────
  const db   = sql()
  const norm = linkedinUrl.toLowerCase().replace(/\/$/, "")

  const contactRows = await db`
    SELECT
      c.id,
      c.full_name,
      c.job_title,
      c.company_name,
      c.company_employees_min,
      c.company_employees_max,
      c.company_industries,
      c.icp_group,
      COALESCE(c.manual_stage, c.funnel_stage)     AS effective_stage,
      COALESCE(c.manual_persona, c.persona)        AS effective_persona,
      COALESCE(t.prospect_types, '{}'::text[])     AS prospect_types
    FROM contacts c
    LEFT JOIN company_tags t
      ON t.workspace_id = c.workspace_id
     AND t.company_name = c.company_name
    WHERE c.workspace_id = ${workspaceId}
      AND LOWER(REGEXP_REPLACE(c.linkedin_url, '/$', '')) = ${norm}
    LIMIT 1
  `
  const contact = contactRows[0] as ContactRow | undefined
  if (!contact) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 })
  }

  const signalRows = await db`
    SELECT
      s.source_type, s.description, s.engagement_url, s.occurred_at,
      s.signal_verb, s.signal_actor, s.signal_object, s.verb_description
    FROM signals s
    JOIN contacts c ON c.id = s.contact_id
    WHERE c.workspace_id = ${workspaceId}
      AND LOWER(REGEXP_REPLACE(c.linkedin_url, '/$', '')) = ${norm}
    ORDER BY s.occurred_at DESC
    LIMIT 8
  `
  const signals = signalRows as SignalRow[]

  // ── Build the user prompt ──────────────────────────────────────────────
  const lines: string[] = []

  // Workspace-wide pacing rules (Outreach Principles tab) — applied to
  // every draft regardless of persona match.
  const principles = config.messaging?.outreachPrinciples?.trim()
  if (principles) {
    lines.push("## Outreach principles")
    lines.push(principles)
    lines.push("")
  }

  // Try to match a persona first; fall back to the generic outreachContext.
  const persona = pickPersona(contact.job_title, contact.icp_group, config.messaging?.personas)
  const ctx = config.messaging?.outreachContext?.trim()

  // ── Voice fingerprints (cozy-tiger plan) ───────────────────────────────
  // Three layers stack least-to-most specific: corporate < channel <
  // channel_persona. Corporate is mirrored on
  // WorkspaceConfig.messaging.companyFingerprint for fast reads; channel and
  // channel-persona rows live in style_fingerprints. Any layer may be
  // absent - the prompt builder just skips a missing block. See
  // CLAUDE.md "Writing-style fingerprints stack three layers".
  const corporateFp = config.messaging?.companyFingerprint ?? null
  const [channelFpRow, cellFpRow] = isDbConfigured()
    ? await Promise.all([
        getActiveFingerprint({
          workspaceId,
          scope:       "channel",
          channel:     "linkedin_dm",
          personaId:   null,
        }),
        persona?.id
          ? getActiveFingerprint({
              workspaceId,
              scope:       "channel_persona",
              channel:     "linkedin_dm",
              personaId:   persona.id,
            })
          : Promise.resolve(null),
      ])
    : [null, null]
  const fingerprintBlock = renderStackedFingerprints({
    corporate:      corporateFp,
    channelOnly:    channelFpRow?.fingerprint ?? null,
    channelPersona: cellFpRow?.fingerprint    ?? null,
    channelLabel:   "LinkedIn DM",
    personaLabel:   persona?.name,
  })
  if (fingerprintBlock) {
    lines.push(fingerprintBlock)
    lines.push("")
  }
  // Most-specific fingerprint version stamped on the send when the user
  // sends this draft - powers per-version performance attribution + lets
  // the refit cron find samples by version.
  const fingerprintVersionId = cellFpRow?.id ?? channelFpRow?.id ?? null

  if (persona) {
    const headline = persona.name || "(unnamed)"
    const productSuffix = persona.product?.trim() ? ` — interested in ${persona.product.trim()}` : ""
    lines.push(`## Persona: ${headline}${productSuffix}`)
    if (persona.whoTheyAre?.trim()) {
      lines.push("### Who they are")
      lines.push(persona.whoTheyAre.trim())
    }
    if (persona.primaryJob?.trim()) {
      lines.push("### Primary job to be done")
      lines.push(persona.primaryJob.trim())
    }
    if (persona.jobsToBeDone?.length) {
      lines.push("### Also needs to")
      for (const b of persona.jobsToBeDone) lines.push(`- ${b}`)
    }
    if (persona.emotionalJob?.trim()) {
      lines.push("### Emotional job")
      lines.push(persona.emotionalJob.trim())
    }
    // Prefer bullet valueProps; fall back to legacy single-string valueProp.
    const valueProps = persona.valueProps?.length
      ? persona.valueProps
      : (persona.valueProp?.trim() ? [persona.valueProp.trim()] : [])
    if (valueProps.length) {
      lines.push("### Value propositions")
      for (const b of valueProps) lines.push(`- ${b}`)
    }
    if (persona.painPoints?.length) {
      lines.push("### Pain points")
      for (const b of persona.painPoints) lines.push(`- ${b}`)
    }
    if (persona.desiredOutcomes?.length) {
      lines.push("### Desired outcomes")
      for (const b of persona.desiredOutcomes) lines.push(`- ${b}`)
    }
    if (persona.proofPoints?.length) {
      lines.push("### Proof points (use sparingly, only when relevant)")
      for (const b of persona.proofPoints) lines.push(`- ${b}`)
    }
    if (persona.commonObjections?.length) {
      lines.push("### Objections we've heard (avoid triggering these)")
      for (const b of persona.commonObjections) lines.push(`- ${b}`)
    }
    if (persona.ctas?.length) {
      lines.push("### CTAs that work for this persona")
      for (const b of persona.ctas) lines.push(`- ${b}`)
    }
    if (persona.valueLanguage?.length) {
      lines.push("### Phrases this persona uses (mirror their language)")
      for (const b of persona.valueLanguage) lines.push(`- ${b}`)
    }
    if (persona.language.trim()) {
      lines.push("### Language and tone")
      lines.push(persona.language.trim())
    }
    if (persona.dmPrinciples.trim()) {
      lines.push("### Message principles")
      lines.push(persona.dmPrinciples.trim())
    }
  } else if (ctx) {
    lines.push("## About us")
    lines.push(ctx)
  } else {
    lines.push("## About us")
    lines.push(`Workspace: ${config.name ?? "Unnamed"}`)
    if (config.icpGroups?.length) {
      lines.push(`We sell to: ${config.icpGroups.map(g => g.name).join(", ")}`)
    }
    lines.push("(No outreach context configured — keep the message generic and curious.)")
  }
  lines.push("")

  lines.push("## The lead")
  if (contact.full_name) lines.push(`- Name: ${contact.full_name}`)
  if (contact.job_title) lines.push(`- Job: ${contact.job_title}`)
  if (contact.company_name) {
    let companyLine = contact.company_name
    const eMin = contact.company_employees_min
    const eMax = contact.company_employees_max
    if (eMin || eMax) {
      companyLine += ` (${eMin && eMax ? `${eMin}–${eMax}` : eMin ? `${eMin}+` : `up to ${eMax}`} employees)`
    }
    const industries = contact.company_industries?.filter(Boolean).slice(0, 2) ?? []
    if (industries.length) companyLine += ` · ${industries.join(", ")}`
    lines.push(`- Company: ${companyLine}`)
  }
  if (contact.icp_group) lines.push(`- ICP group: ${contact.icp_group}`)
  lines.push("")

  if (signals.length > 0) {
    // Build one-liners then deduplicate repeated action types
    const entries = signals.map(s => ({ label: renderSignal(s), when: s.occurred_at }))
    const grouped = new Map<string, { count: number; mostRecent: Date | string | null }>()
    for (const { label, when } of entries) {
      const ex = grouped.get(label)
      if (ex) {
        ex.count++
        if (when && (!ex.mostRecent || new Date(when as string) > new Date(ex.mostRecent as string))) {
          ex.mostRecent = when
        }
      } else {
        grouped.set(label, { count: 1, mostRecent: when })
      }
    }
    lines.push("## Recent engagement (most recent first)")
    for (const [label, { count, mostRecent }] of grouped) {
      const when = fmtRecency(mostRecent)
      lines.push(count > 1 ? `- ${label} (×${count}, most recently ${when})` : `- ${when}: ${label}`)
    }
    lines.push("")
  }

  // ── Reference templates (Outreach Settings) ────────────────────────────
  // Score each template by tag overlap with the lead's effective persona /
  // stage / prospect types. A populated tag list is treated as a filter — if
  // the lead matches any value in the list, the template is in scope. Empty
  // tag lists are treated as wildcards (template applies to anyone). Score
  // = number of tag dimensions that explicitly matched, so templates tagged
  // for ALL three (persona + stage + prospectType) outrank single-tag ones.
  // Capped to top 3 by score so the prompt doesn't bloat with everything.
  const allTemplates = config.messaging?.templates ?? []
  let selectedTemplateIds: string[] = []

  if (allTemplates.length > 0) {
    const leadPersona      = contact.effective_persona ?? null
    const leadStage        = contact.effective_stage ?? null
    const leadProspectTags = contact.prospect_types ?? []

    // Load performance stats for templates that have been used before
    const perfStats = isDbConfigured() ? await getOutreachTemplateStats(workspaceId) : []
    const statsMap  = new Map(perfStats.map(s => [s.templateId, s]))

    type Scored = { tpl: NonNullable<typeof allTemplates>[number]; score: number }
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
      // Boost templates with proven conversion — only when >= 3 sends (enough data)
      if (inScope && tpl.id) {
        const perf = statsMap.get(tpl.id)
        if (perf && perf.sent >= 3) {
          score += (perf.responded / perf.sent) * 2
          score += (perf.booked   / perf.sent) * 5
        }
      }
      if (inScope) scored.push({ tpl, score })
    }
    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, 3)
    if (top.length > 0) {
      selectedTemplateIds = top.map(({ tpl }) => tpl.id).filter(Boolean) as string[]
      lines.push("## Reference templates")
      lines.push("These templates have worked for similar leads — draw from their structure, voice, and patterns. Don't copy them verbatim; the lead deserves something specific to their engagement.")
      for (const { tpl } of top) {
        lines.push(`### ${tpl.title || "(untitled)"}`)
        lines.push(tpl.body.trim())
      }
      lines.push("")
    }
  }

  // ── Prior DM history (if Unipile is wired) ─────────────────────────────
  // Best-effort: fetch never throws, returns [] when unconfigured / no chat.
  let thread: ThreadMessage[] = []
  const unipile = config.messaging?.unipile
  if (unipile?.apiKey && unipile.dsn && unipile.accountId) {
    thread = await fetchLinkedInThread({ creds: unipile, linkedinUrl })
  }
  // Only use the thread if the lead has actually replied — outbound-only threads
  // are either unanswered or (as we've seen) the wrong chat from Unipile.
  const hasReply = thread.some(m => m.from === "them")
  if (thread.length > 0 && hasReply) {
    // Lazy response detection — mark any open outreach_log entry as responded
    if (isDbConfigured()) {
      try {
        const openOutreach = await getLatestUnrespondedOutreach(workspaceId, contact.id)
        if (openOutreach) {
          const reply = thread.find(
            m => m.from === "them" && m.timestamp
              && new Date(m.timestamp) > new Date(openOutreach.occurred_at),
          )
          if (reply?.timestamp) {
            await markOutreachResponded(openOutreach.id, new Date(reply.timestamp))
          }
        }
      } catch {
        // best-effort — never block the draft
      }
    }

    const oldestFirst = [...thread].reverse()
    // Staleness warning when the last exchange was a long time ago
    const newestMsg  = thread[0]
    const staleDays  = newestMsg?.timestamp
      ? Math.floor((Date.now() - new Date(newestMsg.timestamp).getTime()) / 86_400_000)
      : null
    const staleNote  = staleDays !== null && staleDays > 60
      ? ` — note: last exchange was ${staleDays > 90 ? `${Math.round(staleDays / 30)} months` : `${staleDays} days`} ago`
      : ""
    lines.push(`## Prior conversation (oldest first${staleNote})`)
    for (const m of oldestFirst) {
      const who  = m.from === "us" ? "Us" : "Them"
      const text = m.text.length > 600 ? `${m.text.slice(0, 600)}…` : m.text
      const when = m.timestamp
        ? new Date(m.timestamp).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
        : null
      lines.push(`- ${who}${when ? ` (${when})` : ""}: ${text}`)
    }
    lines.push("")
    lines.push("Draft the next message in this thread. Output the message text only.")
  } else {
    lines.push("Draft a single LinkedIn DM body to send them. Output the message text only.")
  }

  // ── Call Claude via Vercel AI Gateway ──────────────────────────────────
  try {
    const result = await generateText({
      model:    MODEL,
      system:   SYSTEM_PROMPT,
      prompt:   lines.join("\n"),
      // Keep the draft tight — gives the LLM headroom but caps stray rambling.
      maxOutputTokens: 400,
      temperature: 0.7,
    })
    // Cost tracking — fire-and-forget, never block the response.
    void logAiTokens({
      workspaceId,
      model:        MODEL,
      inputTokens:  result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      metadata:     { route: "draft-dm" },
    })
    const draft = result.text.trim()
    if (!draft) {
      return NextResponse.json({ error: "Model returned an empty draft" }, { status: 502 })
    }
    return NextResponse.json({ draft, selectedTemplateIds, fingerprintVersionId })
  } catch (err) {
    console.error(`[draft-dm] generateText failed:`, err)
    return NextResponse.json(
      { error: `Draft failed: ${(err as Error).message}` },
      { status: 502 },
    )
  }
}
