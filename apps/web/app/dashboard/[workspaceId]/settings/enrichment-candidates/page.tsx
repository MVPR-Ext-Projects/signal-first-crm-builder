/**
 * Enrichment Candidates - contacts where something upstream decided we
 * should re-enrich.
 *
 * Today's triggers (all set `needs_enrichment = true` with a short
 * `enrichment_reason` on the contact):
 *
 *   - LinkedIn URL marked inactive (2 hard fails inside 48h on Unipile).
 *   - Corporate email staleness cron (`status = confirmed` + older than the
 *     workspace's freshness threshold).
 *   - Call note classifier flags "no longer at this company".
 *
 * None of those triggers ship yet - the column landed in Phase 0 of the
 * dedup master plan and this page is the consumer that will surface
 * candidates once the triggers come online. The empty state explains that
 * up-front so the page doesn't look broken.
 *
 * "Enrich now" reuses the existing /enrich-contact endpoint, which goes
 * through Surfe synchronously. On a successful enrichment the row is
 * cleared by setting `needs_enrichment = false` in the same write so the
 * candidate disappears.
 */

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { sql, isDbConfigured } from "@/lib/db"
import { SettingsShell } from "../settings-shell"
import { CandidatesList, type Candidate } from "./candidates-list"

export const dynamic = "force-dynamic"

export default async function EnrichmentCandidatesPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}) {
  const { workspaceId } = await params
  const config = await getWorkspaceConfig(workspaceId)

  if (!config) {
    return (
      <div className="flex items-center justify-center py-32">
        <p className="text-[14px] text-zinc-400">Workspace not found.</p>
      </div>
    )
  }

  if (config.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) {
      redirect(`/dashboard/${workspaceId}/login`)
    }
  }

  let candidates: Candidate[] = []
  if (isDbConfigured()) {
    const db = sql()
    const rows = await db<{
      id:           number
      full_name:    string | null
      first_name:   string | null
      last_name:    string | null
      job_title:    string | null
      company_name: string | null
      linkedin_url: string | null
      reason:       string | null
      updated_at:   Date
    }>`
      SELECT
        id,
        full_name,
        first_name,
        last_name,
        job_title,
        company_name,
        linkedin_url,
        enrichment_reason AS reason,
        updated_at
      FROM contacts
      WHERE workspace_id = ${workspaceId}
        AND needs_enrichment = TRUE
      ORDER BY updated_at DESC
      LIMIT 200
    `

    candidates = rows.map(r => {
      const fullName =
        r.full_name?.trim()
        || [r.first_name, r.last_name].filter(Boolean).join(" ").trim()
        || null
      return {
        id:           r.id,
        name:         fullName,
        jobTitle:     r.job_title,
        companyName:  r.company_name,
        linkedinUrl:  r.linkedin_url,
        reason:       r.reason,
        updatedAt:    r.updated_at.toISOString(),
      }
    })
  }

  const surfeConfigured = Boolean(config.enrichment?.surfe?.apiKey)

  return (
    <SettingsShell
      workspaceId={workspaceId}
      active="enrichmentCandidates"
      eyebrow={`${config.name ?? workspaceId} · Enrichment candidates`}
      title="Enrichment candidates"
      description="Contacts that something flagged for re-enrichment. Triggers land here over time: LinkedIn URL marked inactive, corporate email going stale, call notes detecting the person has left the company. Run an enrichment to refresh what we know about them."
    >
      <CandidatesList
        workspaceId={workspaceId}
        candidates={candidates}
        surfeConfigured={surfeConfigured}
      />
    </SettingsShell>
  )
}
