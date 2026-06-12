/**
 * Shared types for the SDR view (lead-table-row, pre-enrichment-tab,
 * and the page that constructs the leads array). Previously each file
 * had its own near-duplicate Lead / SignalDetail / FunnelStage /
 * ActionType definitions; adding a field meant touching all three, and
 * a couple of bugs slipped through where a field was added on one view
 * but forgotten on another. Centralising the shape here.
 */

export type FunnelStage =
  | "Prospect"
  | "Signal Found"
  | "Engaged"
  | "High Signal"
  | "Discovery Call"
  | "Requested Information"
  | "Follow Up Call"
  | "Sent Information"
  | "Diligence"
  | "Contract Negotiation"
  | "Customer Won"

export type ActionType = "linkedin" | "email" | "call"

export interface SignalDetail {
  /** signals.id or notes.id depending on isNote. NULL for legacy records not present in Postgres. */
  id: number | null
  source: string | null
  url: string | null
  description: string | null
  date: string | null
  signalVerb: string | null
  signalActor: string | null
  signalObject: string | null
  verbDescription: string | null
  scoreDelta: number
  /**
   * Task #12: notes live in the `notes` table, not `signals`. They're
   * merged into the same timeline array for the unified UI; the
   * lead-table-row dispatches edit/delete to /api/.../notes/[id] when
   * this is true, otherwise to /api/.../signals/[id].
   */
  isNote?: boolean
}

export interface Lead {
  recordId: string
  contactId: number | null
  crmUrl: string | null
  fullName: string | null
  linkedin: string | null
  /** x.com/<handle> if known. Drives the X-following panel visibility. */
  twitterUrl: string | null
  email: string | null
  jobTitle: string | null
  company: string | null
  icpGroup: string | null
  /** Effective persona - manual override if set, otherwise the auto-classified value. */
  persona: string | null
  /** True when persona came from a human override (manual_persona). */
  personaIsManual: boolean
  score: number
  signalCount: number
  stage: FunnelStage
  stageIsManual: boolean
  actionType: ActionType
  guidance: string
  signals: SignalDetail[]
  /** "enriched" / "no_match" / "internal_purged" / null when never tried. */
  lastEnrichmentStatus: string | null
  lastEnrichmentAt:     string | null
  /**
   * Do-Not-Contact decay timestamp (Task #17). ISO string when set,
   * null when the contact isn't flagged. UI treats `until > now()` as
   * "DNC active"; expired markers display as inactive.
   */
  doNotContactUntil:    string | null
  /**
   * TRUE = confirmed connected on LinkedIn (signal sweep or manual).
   * FALSE = explicitly not connected (manual override).
   * NULL = infer from recent signal window.
   */
  linkedinConnected:    boolean | null
}
