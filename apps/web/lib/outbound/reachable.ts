/**
 * isContactReachable - shared "should we send to this contact?" gate.
 *
 * Aggregates the four reasons a contact may be off-limits for outbound
 * (per Principle 3 of the dedup master plan):
 *
 *   1. Do-Not-Contact marker is active (do_not_contact_until > now()).
 *   2. Their LinkedIn URL has been marked inactive (linkedin_url_status =
 *      'inactive'). Only blocks LinkedIn-channel sends; email is fine.
 *   3. Their corporate email is not confirmed (corporate_email_status !=
 *      'confirmed'). Only blocks email-channel sends; LinkedIn is fine.
 *   4. Their email is a personal-provider address (gmail, outlook, etc.).
 *      We sell to corporate inboxes, not personal ones. Only blocks email.
 *
 * Returns a structured result so callers can present "why" to the user.
 * Today the function takes the contact row's relevant columns rather than
 * an id - so it can be used from server components (which already have
 * the row) and from API routes that fetch their own data. A by-id
 * convenience overload can be added if callers ask for it.
 *
 * Channel-aware: pass channel='linkedin_dm' / 'email' / 'any' to scope
 * the check. 'any' is the strictest form ("not reachable on anything").
 */

import { isPersonalEmail } from "../email/personal-providers"

export type Channel = "linkedin_dm" | "email" | "any"

export interface ReachabilityInputs {
  doNotContactUntil:        Date | string | null
  linkedinUrlStatus:        string | null
  corporateEmailStatus:     string | null
  email:                    string | null
}

export type Reason =
  | "dnc_active"
  | "linkedin_url_inactive"
  | "corporate_email_unconfirmed"
  | "personal_email_only"

export interface ReachabilityResult {
  ok:      boolean
  reasons: Reason[]
}

export function isContactReachable(
  inputs:  ReachabilityInputs,
  channel: Channel = "any",
): ReachabilityResult {
  const reasons: Reason[] = []

  if (inputs.doNotContactUntil) {
    const until = inputs.doNotContactUntil instanceof Date
      ? inputs.doNotContactUntil
      : new Date(inputs.doNotContactUntil)
    if (until.getTime() > Date.now()) {
      reasons.push("dnc_active")
    }
  }

  if (channel === "linkedin_dm" || channel === "any") {
    if (inputs.linkedinUrlStatus === "inactive") {
      reasons.push("linkedin_url_inactive")
    }
  }

  if (channel === "email" || channel === "any") {
    if (inputs.corporateEmailStatus !== "confirmed") {
      reasons.push("corporate_email_unconfirmed")
    }
    if (inputs.email && isPersonalEmail(inputs.email)) {
      reasons.push("personal_email_only")
    }
  }

  return { ok: reasons.length === 0, reasons }
}

export function explainReason(reason: Reason): string {
  switch (reason) {
    case "dnc_active":                   return "Contact is marked Do-Not-Contact."
    case "linkedin_url_inactive":        return "LinkedIn URL is marked inactive."
    case "corporate_email_unconfirmed":  return "Corporate email is not confirmed."
    case "personal_email_only":          return "Only a personal email is on file."
  }
}
