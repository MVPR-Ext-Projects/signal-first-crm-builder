/**
 * Domain normalization.
 *
 * Accepts either a bare domain (`Acme.com`) or a website URL
 * (`https://www.acme.com/about`) and returns the registrable domain
 * lowercased without `www.` for use as a dedup key.
 *
 * Returns null when the input doesn't contain a recognisable hostname.
 *
 * Examples:
 *   normalizeDomain("https://www.acme.com/")   → "acme.com"
 *   normalizeDomain("Acme.com")                → "acme.com"
 *   normalizeDomain("ACME.COM/about/?utm=x")      → "acme.com"
 *   normalizeDomain("not a url")                  → null
 *   normalizeDomain(null)                         → null
 */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input || typeof input !== "string") return null
  let s = input.trim().toLowerCase()
  if (!s) return null

  // Strip protocol if present so we can also handle bare hostnames.
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "")

  // Strip everything after the first slash (path), question mark, or hash.
  s = s.split(/[/?#]/)[0]

  // Strip leading www.
  s = s.replace(/^www\./, "")

  // Strip a port if present.
  s = s.replace(/:\d+$/, "")

  // Sanity check — must contain at least one dot and look like a hostname.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return null

  return s
}

/**
 * Derive a domain from an email address. Returns the lowercased domain
 * portion or null if the email is malformed.
 *
 *   emailDomain("Tom@Acme.com") → "acme.com"
 *   emailDomain("not-an-email")    → null
 */
export function emailDomain(email: string | null | undefined): string | null {
  if (!email || typeof email !== "string") return null
  const at = email.lastIndexOf("@")
  if (at <= 0 || at === email.length - 1) return null
  return normalizeDomain(email.slice(at + 1))
}
