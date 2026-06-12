/**
 * UTM parsing helpers — used by api/resend-webhook.ts and api/track.ts
 */

export interface UtmParams {
  utmSource?: string   // utm_source → channelId
  utmMedium?: string   // utm_medium → campaignId (CRM record ID)
  utmContent?: string  // utm_content → contentId
  utmTerm?: string     // utm_term   → personId (CRM person record ID)
}

/** Parse UTMs from a full URL string (used by resend-webhook for click.link) */
export function parseUtmsFromUrl(url: string): UtmParams {
  try {
    const parsed = new URL(url)
    return {
      utmSource:  parsed.searchParams.get("utm_source")  ?? undefined,
      utmMedium:  parsed.searchParams.get("utm_medium")  ?? undefined,
      utmContent: parsed.searchParams.get("utm_content") ?? undefined,
      utmTerm:    parsed.searchParams.get("utm_term")    ?? undefined,
    }
  } catch {
    return {}
  }
}

/** Parse UTMs from a query params object (used by track.ts from req.query) */
export function parseUtmsFromParams(
  params: Record<string, string | string[] | undefined>
): UtmParams {
  const get = (key: string): string | undefined => {
    const v = params[key]
    return Array.isArray(v) ? v[0] : v
  }
  return {
    utmSource:  get("utm_source"),
    utmMedium:  get("utm_medium"),
    utmContent: get("utm_content"),
    utmTerm:    get("utm_term"),
  }
}
