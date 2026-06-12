import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig, DEFAULT_VERB_WEIGHTS, resolveThresholds } from "@/lib/workspace-config"
import { sql, isDbConfigured } from "@/lib/db/index"

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params
  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Workspace not found" }, { status: 404 })
  if (!isDbConfigured()) return NextResponse.json({ error: "Database not configured" }, { status: 503 })

  const weights = { ...DEFAULT_VERB_WEIGHTS, ...(config.scoring?.verbWeights ?? {}) }
  const { signalFound, engaged, highSignal } = resolveThresholds(config)
  const db = sql()

  // Step 1: update score_delta on all verb-tagged signals in this workspace.
  // Unknown verbs keep their existing delta; manual notes/calls (no verb) are untouched.
  await db`
    UPDATE signals
    SET score_delta = CASE signal_verb
      WHEN 'liked_post'                THEN ${weights.liked_post                ?? 0}
      WHEN 'commented_post'            THEN ${weights.commented_post            ?? 0}
      WHEN 'viewed_profile'            THEN ${weights.viewed_profile            ?? 0}
      WHEN 'followed_our_team_member'  THEN ${weights.followed_our_team_member  ?? 0}
      WHEN 'followed_prospect'         THEN ${weights.followed_prospect         ?? 0}
      WHEN 'followed_our_company'      THEN ${weights.followed_our_company      ?? 0}
      WHEN 'sent_connection_request'   THEN ${weights.sent_connection_request   ?? 0}
      WHEN 'accepted_our_connection'   THEN ${weights.accepted_our_connection   ?? 0}
      WHEN 'connected'                 THEN ${weights.connected                 ?? 0}
      WHEN 'sent_dm'                   THEN ${weights.sent_dm                   ?? 0}
      WHEN 'replied_dm'                THEN ${weights.replied_dm                ?? 0}
      WHEN 'sent_email'                THEN ${weights.sent_email                ?? 0}
      WHEN 'replied_email'             THEN ${weights.replied_email             ?? 0}
      WHEN 'booked_meeting'            THEN ${weights.booked_meeting            ?? 0}
      WHEN 'ai_search'                 THEN ${weights.ai_search                 ?? 0}
      ELSE score_delta
    END
    WHERE workspace_id = ${workspaceId}
      AND signal_verb IS NOT NULL
  `

  // Step 2: recompute each contact's signal_score, signal_count, and funnel_stage.
  // Use a CTE join instead of correlated subqueries — one scan of both tables
  // instead of 3-4 subquery executions per contact row.
  //
  // Note: sql() returns result.rows, so we use RETURNING id to count affected rows
  // (reading the .count property from the array would always be undefined).
  const updated = await db`
    WITH score_data AS (
      SELECT
        c.id                                    AS contact_id,
        COALESCE(SUM(s.score_delta), 0)::int    AS total_score,
        COUNT(s.id)::int                        AS total_count
      FROM contacts c
      LEFT JOIN signals s ON s.contact_id = c.id
      WHERE c.workspace_id = ${workspaceId}
      GROUP BY c.id
    )
    UPDATE contacts c
    SET
      signal_score = GREATEST(0, sd.total_score),
      signal_count = sd.total_count,
      funnel_stage = CASE
        WHEN sd.total_score >= ${highSignal}  THEN 'High Signal'
        WHEN sd.total_score >= ${engaged}     THEN 'Engaged'
        WHEN sd.total_score >= ${signalFound} THEN 'Signal Found'
        ELSE 'Prospect'
      END,
      updated_at = NOW()
    FROM score_data sd
    WHERE c.id = sd.contact_id
    RETURNING c.id
  `

  return NextResponse.json({ ok: true, contactsUpdated: updated.length })
}
