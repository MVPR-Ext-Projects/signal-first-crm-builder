/**
 * Surfe people-enrichment response shape + parsing helpers.
 *
 * Used by both enrichment paths:
 *   - lib/enrichment.ts                — the polling cron path
 *   - api/dashboard/<id>/enrich-contact — the per-row manual trigger
 *
 * Both paths used to keep their own copy of the type + the v2-aware
 * credit estimator. This module is the single source of truth.
 */

export interface SurfeEnrichmentResponse {
  id?:           string
  firstName?:    string
  lastName?:     string
  /** Combined name field — present on some Surfe responses, falls back to firstName + lastName. */
  name?:         string
  /** Surfe's internal company id. */
  companyID?:    string
  companyName?:  string
  linkedinUrl?:  string
  /** LinkedIn URN ("ACoAAA..."). Surfe surfaces this as entityUrn (per their CSV export). */
  entityUrn?:       string
  /** Country name (Surfe returns "United Kingdom", not an ISO code). */
  country?:      string
  /** Job title at the matched company. Often more current than what came
   *  in via Teamfluence webhook because Surfe re-resolves from the
   *  LinkedIn profile at enrichment time. */
  jobTitle?:     string
  /** Lifecycle status string ("PENDING" | "ENRICHED" | etc.). */
  status?:       string
  emails?:       Array<{ email: string; validationStatus?: string }>
  mobilePhones?: Array<{ mobilePhone?: string; phone?: string }>
  landlines?:    Array<{ phone?: string }>
  expiresAt?:    string
  /**
   * Surfe v1 returned credits used directly on the response. v2 doesn't —
   * remaining balance is only available via GET /v1/credits. We still parse
   * this field as a fallback in case Surfe ever starts populating it again.
   */
  creditsUsed?:  { emailCreditsUsed?: number; mobileCreditsUsed?: number }
}

/** Pull the most usable email out of a Surfe response (verified first, otherwise the first one). */
export function extractValidEmail(r: SurfeEnrichmentResponse): string | undefined {
  return r.emails?.find(e => e.validationStatus === "VALID")?.email ?? r.emails?.[0]?.email
}

/** Pull the LinkedIn URN ("ACoAAA...") out of a Surfe response. */
export function extractLinkedinMemberId(r: SurfeEnrichmentResponse): string | undefined {
  return r.entityUrn?.trim() || undefined
}

/** Pull the most usable phone out of a Surfe response. */
export function extractPhone(r: SurfeEnrichmentResponse): string | undefined {
  return (
    r.mobilePhones?.[0]?.mobilePhone
    ?? r.mobilePhones?.[0]?.phone
    ?? r.landlines?.[0]?.phone
  )
}

/**
 * v2-aware credit estimator. Surfe's v2 response doesn't include credits
 * used; estimate from outcome: a successful reveal consumes one credit for
 * that channel; an empty response costs nothing. The reported fields stay
 * as a fallback in case the API starts populating them.
 *
 * Pass `hasPhone=false` for endpoints that only requested email-type
 * enrichment — the mobile bucket then stays at 0.
 */
export function parseSurfeCredits(
  r: SurfeEnrichmentResponse,
  flags: { hasAnyData: boolean; hasPhone: boolean },
): { emailCredits: number; mobileCredits: number } {
  const reportedEmail  = r.creditsUsed?.emailCreditsUsed  ?? 0
  const reportedMobile = r.creditsUsed?.mobileCreditsUsed ?? 0
  return {
    emailCredits:  reportedEmail  || (flags.hasAnyData ? 1 : 0),
    mobileCredits: reportedMobile || (flags.hasPhone   ? 1 : 0),
  }
}
