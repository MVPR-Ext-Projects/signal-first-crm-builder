/**
 * LinkedIn URL normalization.
 *
 * Two URL shapes show up: personal profile URLs (linkedin.com/in/<slug>) and
 * company page URLs (linkedin.com/company/<slug>). Both are stored full-form
 * with `www.` (some enrichment providers need it), but compared in normalized
 * form during dedup lookups.
 *
 * Normalize-both-sides-at-match-time per the dedup plan:
 *   stored value:  www.linkedin.com/in/foo
 *   match form:    linkedin.com/in/foo
 *
 * Normalization:
 *   - lowercase
 *   - strip protocol (http://, https://)
 *   - strip leading www.
 *   - strip trailing slash
 *   - strip trailing path segments that are LinkedIn navigation tabs
 *     (/about, /posts, /jobs, /people, /detail/contact-info, etc.)
 *
 * Returns null when the input is missing or doesn't look like a LinkedIn URL.
 */

const PROFILE_TABS = ["about", "posts", "activity", "experience", "education",
                      "skills", "recommendations", "interests", "courses",
                      "honors", "patents", "publications", "certifications",
                      "volunteering-experiences", "detail"]

const COMPANY_TABS = ["about", "posts", "jobs", "people", "life", "events",
                      "videos", "insights", "stories", "ads"]

function stripCommonPrefix(url: string): string {
  let s = url.trim().toLowerCase()
  s = s.replace(/^https?:\/\//, "")
  s = s.replace(/^www\./, "")
  return s
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "")
}

function stripTrailingTabs(url: string, tabs: string[]): string {
  // Strip a trailing /<tab> or /<tab>/anything segment (LinkedIn nav).
  // Handles e.g. linkedin.com/in/foo/about, linkedin.com/in/foo/detail/contact-info
  const tabPattern = new RegExp(`/(${tabs.join("|")})(/.*)?$`)
  return url.replace(tabPattern, "")
}

/**
 * Normalize a personal LinkedIn profile URL for dedup comparison.
 * Returns the canonical form `linkedin.com/in/<slug>` or null on garbage input.
 */
export function normalizeLinkedinProfileUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== "string") return null
  let s = stripCommonPrefix(url)
  if (!s.startsWith("linkedin.com/in/")) return null
  s = stripTrailingSlashes(s)
  s = stripTrailingTabs(s, PROFILE_TABS)
  s = stripTrailingSlashes(s)
  // Sanity: must still have a slug after `/in/`
  if (!/^linkedin\.com\/in\/[^/]+$/.test(s)) return null
  return s
}

/**
 * Normalize a LinkedIn company page URL for dedup comparison.
 * Returns the canonical form `linkedin.com/company/<slug>` or null on garbage input.
 */
export function normalizeLinkedinCompanyUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== "string") return null
  let s = stripCommonPrefix(url)
  if (!s.startsWith("linkedin.com/company/")) return null
  s = stripTrailingSlashes(s)
  s = stripTrailingTabs(s, COMPANY_TABS)
  s = stripTrailingSlashes(s)
  if (!/^linkedin\.com\/company\/[^/]+$/.test(s)) return null
  return s
}
