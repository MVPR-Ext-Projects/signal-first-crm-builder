/**
 * GET /api/dashboard/[workspaceId]/contacts/[contactId]
 *
 * Returns a single contact's lead-row payload (same shape as getLeads) plus
 * the workspace's configured persona names — everything the right-hand
 * contact drawer on the Companies page needs to render summary + clickable
 * stage / persona pills.
 *
 * Auth: same dashboard cookie as the page.
 */

import { cookies } from "next/headers"
import { revalidatePath } from "next/cache"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { getContactById, isDbConfigured } from "@/lib/db/contact-store"
import { sql } from "@/lib/db"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; contactId: string }> },
) {
  const { workspaceId, contactId } = await params
  const id = Number.parseInt(contactId, 10)
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid contactId" }, { status: 400 })
  }

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

  const row = await getContactById(workspaceId, id)
  if (!row) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 })
  }

  const personaNames = (config.messaging?.personas ?? [])
    .map(p => p.name?.trim())
    .filter((n): n is string => !!n)

  const teamMembers = (config.teamMembers ?? []).map(m => ({ id: m.id, name: m.name }))

  return NextResponse.json({ contact: row, personaNames, teamMembers })
}

/**
 * PATCH /api/dashboard/[workspaceId]/contacts/[contactId]
 *
 * Manual edit of contact fields. Lets users fix data the enrichment
 * provider didn't return (or got wrong) — e.g. paste in an email Surfe
 * couldn't find, correct a job title, swap a stale LinkedIn URL.
 *
 * Body: any subset of { email, linkedinUrl, jobTitle, fullName,
 * companyName }. Pass null to clear a field; omit to leave unchanged.
 *
 * Only writes fields that were explicitly included in the body — partial
 * updates are the norm here.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; contactId: string }> },
) {
  const { workspaceId, contactId } = await params
  const id = Number.parseInt(contactId, 10)
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid contactId" }, { status: 400 })
  }

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

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }

  // Whitelist of fields a user can manually edit. NULL clears, omitted
  // leaves unchanged.
  const FIELDS: Record<string, string> = {
    email:         "email",
    linkedinUrl:   "linkedin_url",
    twitterUrl:    "twitter_url",
    jobTitle:      "job_title",
    fullName:      "full_name",
    companyName:   "company_name",
  }

  const sets: string[] = []
  const args: unknown[] = [workspaceId, id]
  let argIdx = 3
  for (const [bodyKey, column] of Object.entries(FIELDS)) {
    if (!(bodyKey in body)) continue
    const v = body[bodyKey]
    if (v !== null && typeof v !== "string") {
      return NextResponse.json({ error: `${bodyKey} must be a string or null` }, { status: 400 })
    }
    const trimmed = typeof v === "string" ? v.trim() : null
    sets.push(`${column} = $${argIdx}`)
    args.push(trimmed === "" ? null : trimmed)
    argIdx++
  }

  // Boolean field — null clears the override, true/false sets it.
  if ("linkedinConnected" in body) {
    const v = body.linkedinConnected
    if (v !== null && v !== true && v !== false) {
      return NextResponse.json({ error: "linkedinConnected must be true, false, or null" }, { status: 400 })
    }
    sets.push(`linkedin_connected = $${argIdx}`)
    args.push(v)
    argIdx++
  }

  if (sets.length === 0) {
    return NextResponse.json({ error: "No editable fields provided" }, { status: 400 })
  }

  // Re-derive full_name when first/last passed (not in this whitelist
  // currently — but if added later, keep this in mind).
  sets.push("updated_at = NOW()")

  const db = sql()
  const queryText = `
    UPDATE contacts
    SET ${sets.join(", ")}
    WHERE workspace_id = $1 AND id = $2
    RETURNING id
  `
  const rows = await db.query(queryText, args)
  if (!rows.length) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 })
  }

  // Auto-derive company from email domain when email changes and the caller
  // isn't explicitly setting companyName themselves. Finds the most common
  // company_name among other contacts in this workspace sharing the same
  // domain, then overrides the contact's company_name if it differs.
  const PERSONAL_DOMAINS = new Set([
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com",
    "protonmail.com", "me.com", "msn.com", "live.com", "googlemail.com",
  ])
  if (
    "email" in body &&
    !("companyName" in body) &&
    typeof body.email === "string" &&
    body.email.includes("@")
  ) {
    const domain = body.email.split("@")[1]?.toLowerCase().trim()
    if (domain && !PERSONAL_DOMAINS.has(domain)) {
      const taggedDb = sql()
      const matches = await taggedDb`
        SELECT company_name, COUNT(*) AS cnt
        FROM contacts
        WHERE workspace_id = ${workspaceId}
          AND id <> ${id}
          AND email ILIKE ${"%" + "@" + domain}
          AND company_name IS NOT NULL AND company_name <> ''
        GROUP BY company_name
        ORDER BY cnt DESC
        LIMIT 1
      ` as unknown as Array<{ company_name: string }>
      if (matches.length > 0) {
        await taggedDb`
          UPDATE contacts SET company_name = ${matches[0].company_name}, updated_at = NOW()
          WHERE workspace_id = ${workspaceId}
            AND id = ${id}
            AND company_name IS DISTINCT FROM ${matches[0].company_name}
        `
      }
    }
  }

  // Invalidate cached server-component data so router.refresh() picks up
  // the new values immediately.
  revalidatePath(`/dashboard/${workspaceId}/companies`)
  revalidatePath(`/dashboard/${workspaceId}/sdr`)

  return NextResponse.json({ ok: true })
}

/**
 * DELETE /api/dashboard/[workspaceId]/contacts/[contactId]
 *
 * Hard-removes the contact + cascade-delete their signals (FK ON DELETE
 * CASCADE on the signals table). Used by the "remove" button on Apify-
 * promoted Prospects in the Companies card. Distinct from
 * /exclude-contact, which ALSO adds the LinkedIn URL to internalLinkedinUrls
 * — that's heavier and wrong for the "I just don't want this person here"
 * case.
 *
 * Idempotent: a 404 on a missing id still returns ok so client retries
 * don't trip up.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; contactId: string }> },
) {
  const { workspaceId, contactId } = await params
  const id = Number.parseInt(contactId, 10)
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid contactId" }, { status: 400 })
  }

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

  const db = sql()
  await db`DELETE FROM contacts WHERE workspace_id = ${workspaceId} AND id = ${id}`

  // Invalidate cached server-component data for the routes this contact
  // appears on so router.refresh() on the client gets fresh data.
  revalidatePath(`/dashboard/${workspaceId}/companies`)
  revalidatePath(`/dashboard/${workspaceId}/sdr`)
  revalidatePath(`/dashboard/${workspaceId}/signals`)

  return NextResponse.json({ ok: true })
}
