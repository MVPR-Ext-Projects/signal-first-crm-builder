/**
 * Outcome scoring for writing-style samples (cozy-tiger plan).
 *
 * Given a sent message (contact + send time), score the engagement that
 * followed against the locked scoring table:
 *
 *   booked_meeting         +5
 *   replied_dm_initial     +3
 *   replied_email          +3
 *   replied_dm_subsequent  +1
 *   email_clicked          +1
 *   clicked_link           +1
 *   email_opened           +0.5
 *   do_not_contact set     -2
 *   email_complained       -2
 *   email_bounced          excluded (deliverability, not voice)
 *   company_status=departed after send  excluded (not about voice)
 *
 * A sample's outcome is "resolved" once either a booking/reply lands OR
 * the 14-day window closes. Phase 4 wires inline + cron resolution; here
 * we expose a single-send scorer that the Phase 2 mining flow uses to
 * bootstrap fingerprints from existing outreach_log history.
 */

import { sql, isDbConfigured } from "@/lib/db"

export interface ScoreSendInput {
  workspaceId: string
  contactId:   number
  /** When the message was sent. Signals after this time count. */
  sentAt:      Date
  /** How long to wait for engagement signals. Default 14 days. */
  windowDays?: number
}

export interface ScoreSendResult {
  score:        number
  /** True once at least one engagement signal landed OR the window closed. */
  resolved:     boolean
  /** When the outcome was determined (first signal, or window close). */
  resolvedAt:   Date | null
}

const VERB_SCORES: Record<string, number> = {
  booked_meeting:        +5,
  replied_dm_initial:    +3,
  replied_email:         +3,
  replied_dm_subsequent: +1,
  email_clicked:         +1,
  clicked_link:          +1,
  email_opened:          +0.5,
  email_complained:      -2,
}

const STRONG_VERBS = new Set([
  "booked_meeting",
  "replied_dm_initial",
  "replied_email",
])

export async function scoreSendOutcome(input: ScoreSendInput): Promise<ScoreSendResult> {
  const windowDays = input.windowDays ?? 14
  const windowEnd  = new Date(input.sentAt.getTime() + windowDays * 86400_000)

  if (!isDbConfigured()) {
    return { score: 0, resolved: false, resolvedAt: null }
  }
  const db = sql()

  const signals = await db<{ signal_verb: string | null; occurred_at: Date }>`
    SELECT signal_verb, occurred_at
    FROM signals
    WHERE contact_id  = ${input.contactId}
      AND occurred_at >= ${input.sentAt}
      AND occurred_at <= ${windowEnd}
    ORDER BY occurred_at ASC
  `

  let score          = 0
  let firstStrongAt: Date | null = null

  for (const s of signals) {
    if (s.signal_verb && s.signal_verb in VERB_SCORES) {
      score += VERB_SCORES[s.signal_verb]
      if (!firstStrongAt && STRONG_VERBS.has(s.signal_verb)) {
        firstStrongAt = s.occurred_at
      }
    }
  }

  // DNC set after the send is a strong negative signal (the AI classifier
  // flagged the reply as "not interested" or the user manually DNC'd).
  const [contact] = await db<{ do_not_contact_at: Date | null }>`
    SELECT do_not_contact_at FROM contacts WHERE id = ${input.contactId}
  `
  if (contact?.do_not_contact_at && contact.do_not_contact_at >= input.sentAt) {
    score -= 2
  }

  // Resolution: strong signal lands -> resolved at that signal's time.
  // Otherwise, window must close before we consider the no-reply case resolved.
  const now = new Date()
  if (firstStrongAt) {
    return { score, resolved: true, resolvedAt: firstStrongAt }
  }
  if (now >= windowEnd) {
    return { score, resolved: true, resolvedAt: windowEnd }
  }
  return { score, resolved: false, resolvedAt: null }
}
