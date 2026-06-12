/**
 * POST /api/dashboard/[workspaceId]/companies/promote-contacts
 *
 * Body: { companyLinkedinUrl: string, companyName?: string, profiles: ApifyEmployee[] }
 *
 * Promotes the supplied profiles into the contacts table at Prospect stage.
 * Reuses promoteApifyMatchesToContacts. Caller passes only the profiles
 * the user has selected in the Reveal-employees drawer — we set
 * titleMatch=true on each so the helper inserts them regardless of
 * whether they originally hit a persona pattern.
 *
 * Existing contacts with the same linkedin_url are skipped (dedupe).
 *
 * Auth: same dashboard cookie as the page.
 */

import { cookies } from "next/headers"
import { revalidatePath } from "next/cache"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { promoteApifyMatchesToContacts, isDbConfigured } from "@/lib/db/contact-store"

interface IncomingProfile {
  fullName?:       string | null
  firstName?:      string | null
  lastName?:       string | null
  title?:          string
  linkedinUrl?:    string | null
  matchedPersona?: string | null
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
    companyLinkedinUrl?: string
    companyName?:        string | null
    profiles?:           IncomingProfile[]
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }
  const companyLinkedinUrl = body.companyLinkedinUrl?.trim()
  const profiles           = Array.isArray(body.profiles) ? body.profiles : []
  if (!companyLinkedinUrl) {
    return NextResponse.json({ error: "companyLinkedinUrl is required" }, { status: 400 })
  }
  if (profiles.length === 0) {
    return NextResponse.json({ error: "profiles must be a non-empty array" }, { status: 400 })
  }

  // Force titleMatch=true for the user-selected list so promoteApifyMatchesToContacts
  // doesn't filter them out. Persona is preserved when the client sent it
  // (matched profiles still pre-flag with their persona) so the contact
  // lands in the funnel correctly classified.
  const promoted = profiles.map(p => ({
    fullName:       p.fullName ?? null,
    firstName:      p.firstName ?? null,
    lastName:       p.lastName ?? null,
    title:          p.title ?? "",
    linkedinUrl:    p.linkedinUrl ?? null,
    titleMatch:     true,
    matchedPersona: p.matchedPersona ?? null,
  }))

  const result = await promoteApifyMatchesToContacts(
    workspaceId,
    {
      companyName:        body.companyName ?? null,
      companyLinkedinUrl,
    },
    promoted,
  )

  // Invalidate the Companies + SDR pages for this workspace so the next
  // navigation / router.refresh() reads the new contacts. Belt-and-braces
  // alongside the client-side router.refresh() — covers both data-cache
  // and router-cache layers.
  revalidatePath(`/dashboard/${workspaceId}/companies`)
  revalidatePath(`/dashboard/${workspaceId}/sdr`)

  return NextResponse.json({ ok: true, ...result })
}
