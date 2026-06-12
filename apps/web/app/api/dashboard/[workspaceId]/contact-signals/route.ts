/**
 * GET /api/dashboard/[workspaceId]/contact-signals?linkedinUrl=<url>
 *
 * Returns the recent engagement signals for a contact, looked up by their
 * LinkedIn URL (normalized both sides at match time so trailing-slash /
 * `www.` / protocol differences don't matter).
 *
 * Built for the DM drafter (Task #9): the send-dm modal needs to show the
 * contact's engagement history so users have context when writing manually
 * or refining an AI draft. Returns at most 20 most-recent signals, ordered
 * newest first.
 *
 * Auth: same dashboard cookie as the page.
 */

import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { sql, isDbConfigured } from "@/lib/db"

interface Signal {
  id:              number
  occurredAt:      string
  sourceType:      string | null
  description:     string | null
  signalVerb:      string | null
  signalActor:     string | null
  signalObject:    string | null
  verbDescription: string | null
  engagementUrl:   string | null
  scoreDelta:      number
}

const LIMIT = 20

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params

  const config = await getWorkspaceConfig(workspaceId)
  if (!config) {
    return NextResponse.json({ error: "Unknown workspace" }, { status: 404 })
  }

  // Auth — same cookie check as the dashboard page.
  if (config.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  if (!isDbConfigured()) {
    return NextResponse.json({ signals: [] })
  }

  const linkedinUrl = req.nextUrl.searchParams.get("linkedinUrl")?.trim()
  if (!linkedinUrl) {
    return NextResponse.json({ error: "linkedinUrl is required" }, { status: 400 })
  }

  // Normalize the inbound URL the same way we normalize the stored one
  // in the SQL — strip protocol, www, trailing slash; lowercase.
  const normalized = linkedinUrl
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/\/+$/, "")

  const db = sql()

  // UNION ALL signals + notes (Task #12 — notes live in a separate table
  // but the DM drafter wants them merged into one timeline by date). Both
  // sides map to the Signal shape; notes get isNote=true so the modal can
  // route edit/delete appropriately if it ever surfaces those affordances.
  const signals = await db<Signal & { isNote: boolean }>`
    WITH s AS (
      SELECT
        s.id,
        s.occurred_at      AS "occurredAt",
        s.source_type      AS "sourceType",
        s.description,
        s.signal_verb      AS "signalVerb",
        s.signal_actor     AS "signalActor",
        s.signal_object    AS "signalObject",
        s.verb_description AS "verbDescription",
        s.engagement_url   AS "engagementUrl",
        s.score_delta      AS "scoreDelta",
        false              AS "isNote"
      FROM signals s
      INNER JOIN contacts c
        ON c.id = s.contact_id
       AND c.workspace_id = s.workspace_id
      WHERE c.workspace_id = ${workspaceId}
        AND c.linkedin_url IS NOT NULL
        AND lower(
              regexp_replace(
                regexp_replace(c.linkedin_url, '^https?://(www\\.)?', ''),
                '/+$', ''
              )
            ) = ${normalized}
    ),
    n AS (
      SELECT
        n.id,
        n.occurred_at AS "occurredAt",
        'Manual Note'::text AS "sourceType",
        n.body        AS "description",
        NULL::text    AS "signalVerb",
        NULL::text    AS "signalActor",
        NULL::text    AS "signalObject",
        NULL::text    AS "verbDescription",
        NULL::text    AS "engagementUrl",
        0             AS "scoreDelta",
        true          AS "isNote"
      FROM notes n
      INNER JOIN contacts c
        ON c.id = n.contact_id
       AND c.workspace_id = n.workspace_id
      WHERE c.workspace_id = ${workspaceId}
        AND c.linkedin_url IS NOT NULL
        AND lower(
              regexp_replace(
                regexp_replace(c.linkedin_url, '^https?://(www\\.)?', ''),
                '/+$', ''
              )
            ) = ${normalized}
    )
    SELECT * FROM (
      SELECT * FROM s
      UNION ALL
      SELECT * FROM n
    ) merged
    ORDER BY "occurredAt" DESC
    LIMIT ${LIMIT}
  `

  return NextResponse.json({ signals })
}
