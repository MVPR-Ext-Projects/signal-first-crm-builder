import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { safeUpsertContact } from "@/lib/db/contact-store"
import { sql, isDbConfigured } from "@/lib/db"

// Search contacts within a workspace, for the merge UI.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params
  const q = req.nextUrl.searchParams.get("q")?.trim() ?? ""
  const excludeRaw = req.nextUrl.searchParams.get("exclude") ?? ""
  const excludeIds = excludeRaw.split(",").map(s => Number(s)).filter(n => Number.isFinite(n) && n > 0)
  if (q.length < 2) return NextResponse.json({ contacts: [] })
  if (!isDbConfigured()) return NextResponse.json({ contacts: [] })

  const db = sql()
  const like = `%${q}%`
  const rows = excludeIds.length === 0
    ? await db<{
        id: number; full_name: string | null; email: string | null;
        linkedin_url: string | null; company_name: string | null;
        signal_score: number; signal_count: number
      }>`
        SELECT id, full_name, email, linkedin_url, company_name, signal_score, signal_count
        FROM   contacts
        WHERE  workspace_id = ${workspaceId}
          AND  (full_name ILIKE ${like} OR email ILIKE ${like}
                OR linkedin_url ILIKE ${like} OR company_name ILIKE ${like})
        ORDER  BY signal_score DESC, id ASC
        LIMIT  20
      `
    : await db<{
        id: number; full_name: string | null; email: string | null;
        linkedin_url: string | null; company_name: string | null;
        signal_score: number; signal_count: number
      }>`
        SELECT id, full_name, email, linkedin_url, company_name, signal_score, signal_count
        FROM   contacts
        WHERE  workspace_id = ${workspaceId}
          AND  (full_name ILIKE ${like} OR email ILIKE ${like}
                OR linkedin_url ILIKE ${like} OR company_name ILIKE ${like})
          AND  NOT (id = ANY(${excludeIds}::bigint[]))
        ORDER  BY signal_score DESC, id ASC
        LIMIT  20
      `
  return NextResponse.json({
    contacts: rows.map(r => ({
      id:           r.id,
      fullName:     r.full_name,
      email:        r.email,
      linkedinUrl:  r.linkedin_url,
      companyName:  r.company_name,
      signalScore:  r.signal_score,
      signalCount:  r.signal_count,
    })),
  })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params
  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Workspace not found" }, { status: 404 })

  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })

  const { fullName, linkedinUrl, email, companyName, companyWebsite } = body as {
    fullName: string
    linkedinUrl?: string
    email?: string
    companyName?: string
    companyWebsite?: string
  }

  if (!fullName?.trim()) {
    return NextResponse.json({ error: "Full name is required" }, { status: 400 })
  }

  const nameParts  = fullName.trim().split(/\s+/)
  const firstName  = nameParts[0]
  const lastName   = nameParts.slice(1).join(" ") || undefined

  const id = await safeUpsertContact(
    workspaceId,
    "manual",
    `manual:${randomUUID()}`,
    {
      fullName:   fullName.trim(),
      firstName,
      lastName,
      email:      email?.trim() || undefined,
      linkedinUrl: linkedinUrl?.trim() || undefined,
      companyName: companyName?.trim() || undefined,
      // Store website as crmUrl since there's no dedicated company_website column
      crmUrl:     companyWebsite?.trim() || undefined,
    },
  )

  if (!id) return NextResponse.json({ error: "Failed to create contact" }, { status: 500 })
  return NextResponse.json({ ok: true, id })
}
