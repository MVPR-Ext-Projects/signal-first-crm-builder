/**
 * POST /api/workspace/:workspaceId/import-contacts
 *
 * Two modes:
 *
 * mode = "parse"  — body: { text: string }
 *   Uses Claude to extract contacts from free-form text (pasted LinkedIn
 *   profiles, email signatures, CSV text, etc.). Returns a parsed preview
 *   array for the user to review before committing.
 *
 * mode = "dedup"  — body: { contacts: ParsedContact[] }
 *   Checks the workspace for duplicates. Returns each contact with a
 *   `duplicate` field pointing to any existing match.
 *
 * mode = "import" — body: { contacts: ParsedContact[] }
 *   Upserts confirmed contacts. New contacts start at Prospect stage with
 *   no signal score. Existing contacts (matched by email or linkedin_url)
 *   are updated with any new fields. Returns imported count.
 */

import { NextRequest, NextResponse } from "next/server"
import { generateObject } from "ai"
import { z } from "zod"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { upsertContact } from "@/lib/db/contact-store"
import { isDbConfigured, sql } from "@/lib/db/index"

const ParsedContactSchema = z.object({
  firstName:         z.string().optional(),
  lastName:          z.string().optional(),
  fullName:          z.string().optional(),
  jobTitle:          z.string().optional(),
  companyName:       z.string().optional(),
  email:             z.string().email().optional(),
  linkedinUrl:       z.string().url().optional(),
  twitterUrl:        z.string().url().optional(),
  location:          z.string().optional(),
  companyLinkedinUrl: z.string().url().optional(),
})

type ParsedContact = z.infer<typeof ParsedContactSchema> & {
  _id?: string
  duplicate?: { contactId: number; fullName: string | null; email: string | null }
}

const ContactArraySchema = z.object({
  contacts: z.array(ParsedContactSchema),
})

// ─── Parse (AI extraction) ───────────────────────────────────────────────────

async function parseContacts(text: string): Promise<ParsedContact[]> {
  const { object } = await generateObject({
    model:  "anthropic/claude-haiku-4-5-20251001",
    schema: ContactArraySchema,
    prompt: [
      "Extract all people/contacts from the following text.",
      "Return each person as a structured object with the fields below.",
      "Normalise LinkedIn URLs to https://www.linkedin.com/in/<slug>/",
      "Normalise Twitter/X URLs to https://x.com/<handle>",
      "If a field is not present, omit it entirely.",
      "Do not invent data that isn't in the text.",
      "",
      "Text:",
      text,
    ].join("\n"),
  })
  return (object.contacts as ParsedContact[]).map((c, i) => ({
    ...c,
    _id: `imported-${Date.now()}-${i}`,
  }))
}

// ─── De-duplicate check ──────────────────────────────────────────────────────

async function checkDuplicates(
  workspaceId: string,
  contacts:    ParsedContact[],
): Promise<ParsedContact[]> {
  const db = sql()
  return Promise.all(contacts.map(async c => {
    // Email match (most reliable)
    if (c.email) {
      const [row] = await db<{ id: number; full_name: string | null; email: string | null }>`
        SELECT id, full_name, email FROM contacts
        WHERE  workspace_id = ${workspaceId}
          AND  LOWER(email) = LOWER(${c.email})
        LIMIT 1
      `
      if (row) return { ...c, duplicate: { contactId: row.id, fullName: row.full_name, email: row.email } }
    }

    // LinkedIn URL match
    if (c.linkedinUrl) {
      const normUrl = c.linkedinUrl.replace(/\/$/, "").toLowerCase()
      const [row] = await db<{ id: number; full_name: string | null; email: string | null }>`
        SELECT id, full_name, email FROM contacts
        WHERE  workspace_id = ${workspaceId}
          AND  LOWER(RTRIM(linkedin_url, '/')) = ${normUrl}
        LIMIT 1
      `
      if (row) return { ...c, duplicate: { contactId: row.id, fullName: row.full_name, email: row.email } }
    }

    // Fuzzy: full name + company
    if (c.fullName && c.companyName) {
      const [row] = await db<{ id: number; full_name: string | null; email: string | null }>`
        SELECT id, full_name, email FROM contacts
        WHERE  workspace_id  = ${workspaceId}
          AND  LOWER(full_name)    = LOWER(${c.fullName})
          AND  LOWER(company_name) = LOWER(${c.companyName})
        LIMIT 1
      `
      if (row) return { ...c, duplicate: { contactId: row.id, fullName: row.full_name, email: row.email } }
    }

    return c
  }))
}

// ─── Import (upsert) ─────────────────────────────────────────────────────────

async function importContacts(
  workspaceId: string,
  contacts:    ParsedContact[],
): Promise<number> {
  let imported = 0
  for (const c of contacts) {
    const fullName = c.fullName ?? ([c.firstName, c.lastName].filter(Boolean).join(" ") || null)
    // Use email or linkedinUrl as a stable key, falling back to a generated ID.
    // This ensures the same person imported twice merges rather than duplicates.
    const crmContactId = c.email
      ? `import:email:${c.email.toLowerCase()}`
      : c.linkedinUrl
        ? `import:li:${c.linkedinUrl.replace(/\/$/, "").toLowerCase()}`
        : `import:manual:${Date.now()}:${Math.random().toString(36).slice(2)}`

    await upsertContact(workspaceId, "manual", crmContactId, {
      email:             c.email,
      linkedinUrl:       c.linkedinUrl,
      twitterUrl:        c.twitterUrl,
      firstName:         c.firstName,
      lastName:          c.lastName,
      fullName:          fullName ?? undefined,
      jobTitle:          c.jobTitle,
      companyName:       c.companyName,
      companyLinkedinUrl: c.companyLinkedinUrl,
      location:          c.location,
    })
    imported++
  }
  return imported
}

// ─── Route handler ───────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params
  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Workspace not found" }, { status: 404 })

  const body = await req.json() as { mode?: string; text?: string; contacts?: ParsedContact[] }
  const mode = body.mode ?? "import"

  if (mode === "parse") {
    if (!body.text?.trim()) {
      return NextResponse.json({ error: "text is required for parse mode" }, { status: 400 })
    }
    const contacts = await parseContacts(body.text)
    return NextResponse.json({ contacts })
  }

  if (mode === "dedup") {
    if (!isDbConfigured()) return NextResponse.json({ contacts: body.contacts ?? [] })
    const contacts = await checkDuplicates(workspaceId, body.contacts ?? [])
    return NextResponse.json({ contacts })
  }

  if (mode === "import") {
    if (!isDbConfigured()) return NextResponse.json({ error: "Database not configured" }, { status: 503 })
    const count = await importContacts(workspaceId, body.contacts ?? [])
    return NextResponse.json({ imported: count })
  }

  return NextResponse.json({ error: "Unknown mode" }, { status: 400 })
}
