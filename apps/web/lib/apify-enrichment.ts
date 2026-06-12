/**
 * Apify-based company employee enrichment.
 *
 * Calls a LinkedIn employee scraper actor on Apify and returns normalized
 * profiles. Pure data layer — does not write to any CRM.
 *
 * The default actor is apimaestro/linkedin-company-employees-scraper-no-cookies,
 * which takes a company LinkedIn URL and returns up to N employee profiles
 * with name, headline, and profile URL. Workspaces can override the actor ID
 * via `enrichment.apify.actorId` if they prefer a different scraper.
 */

export const DEFAULT_APIFY_ACTOR = "apimaestro~linkedin-company-employees-scraper-no-cookies"
// No default for the LinkedIn interests actor — the previous default
// (apimaestro~linkedin-profile-scraper-no-cookies) returns 404 on Apify, so
// we now require the workspace owner to pick one in Settings → Apify advanced.
// Kept exported as null for any caller that wants to feature-detect.
export const DEFAULT_INTERESTS_ACTOR: string | null = null
export const DEFAULT_MAX_EMPLOYEES = 30

// Founder / CEO / etc., with negative lookbehinds to suppress common false
// positives ("Vice President", "Ex-CEO", "former CEO", "Product Owner",
// "Data Owner", "Process Owner", "Project Owner", "Business Owner-and-X").
export const FOUNDER_TITLE_RE =
  /(?<!vice\s)(?<!ex[\s-])(?<!former\s)(?<!product\s)(?<!data\s)(?<!process\s)(?<!project\s)(?<!business\s)\b(ceo|chief\s+executive|founder|co[-\s]?founder|owner|president|managing\s+director)\b/i

// ─── Slug canonicalization ──────────────────────────────────────────────────

/**
 * Canonical form of a LinkedIn /in/<slug> URL: lowercased slug, no host,
 * no query, no hash, no trailing slash. Used to dedupe people across stored
 * URL variants like https://www.linkedin.com/in/foo/, https://linkedin.com/in/Foo,
 * linkedin.com/in/foo?utm=...
 */
export function linkedinSlug(url: string | null | undefined): string | null {
  if (!url) return null
  const m = String(url).match(/linkedin\.com\/in\/([^/?#]+)/i)
  if (!m) return null
  return decodeURIComponent(m[1]).toLowerCase().replace(/\/+$/, "")
}

/**
 * A real LinkedIn company URL has a slug: lowercase, digits, hyphens — no
 * spaces, no uppercase, no dots in the slug. Older imports sometimes
 * templated the company name into the URL, which won't resolve.
 */
export function looksLikeValidCompanyLinkedin(url: string | null | undefined): boolean {
  if (!url) return false
  const m = String(url).match(/linkedin\.com\/company\/([^/?#]+)/i)
  if (!m) return false
  const slug = decodeURIComponent(m[1])
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)
}

// ─── Apify actor call ───────────────────────────────────────────────────────

interface ApifyRawProfile {
  fullname?: string
  first_name?: string
  last_name?: string
  headline?: string
  profile_url?: string
  public_identifier?: string
}

export interface NormalizedProfile {
  fullName: string | null
  firstName: string | null
  lastName: string | null
  title: string
  linkedinUrl: string | null
  /** LinkedIn slug as Apify returns it (the /in/<slug> portion). Captured separately from linkedinUrl so callers don't have to re-parse the URL when matching against other systems that store the slug verbatim. */
  publicIdentifier: string | null
  /** True when the profile's title matched any configured persona pattern (or the founder regex when personas are empty). */
  titleMatch: boolean
  /** Name of the first persona whose matchPatterns matched the title; null when no persona matched (or when matching used the founder regex). */
  matchedPersona: string | null
}

export interface ApifyError {
  status: number
  message: string
}

export interface ApifyRunResult {
  profiles: NormalizedProfile[]
  rawCount: number
  matchCount: number
  error?: ApifyError
}

function normalizeProfile(item: ApifyRawProfile): Omit<NormalizedProfile, "titleMatch" | "matchedPersona"> {
  const linkedinUrl = item.profile_url ?? null
  const firstName = item.first_name ?? null
  const lastName = item.last_name ?? null
  const builtName = [firstName, lastName].filter(Boolean).join(" ").trim()
  const fullName = item.fullname ?? (builtName || null)
  const title = item.headline ?? ""
  const publicIdentifier = item.public_identifier?.trim() || null
  return { linkedinUrl, title, firstName, lastName, fullName, publicIdentifier }
}

/**
 * Run the configured Apify employee scraper for a company.
 *
 * Returns the raw + title-matched profile counts, plus the normalized profile
 * list. Tags each profile with `titleMatch` so callers can act on the regex
 * result without re-running it.
 *
 * On HTTP error, returns an empty profile list plus an `error` payload — the
 * caller decides whether to surface or retry.
 */
/**
 * Persona match input shape for the employees fetch — narrow shape that
 * mirrors WorkspaceConfig.messaging.personas without forcing this lib to
 * import the full WorkspaceConfig type. matchPatterns is the only field
 * we use for Apify-result matching; size / country narrowing doesn't
 * apply because per-profile size and country aren't returned by the
 * actor.
 */
export interface ApifyPersonaMatcher {
  name:           string
  matchPatterns?: string[]
}

export async function fetchCompanyEmployees(
  companyLinkedinUrl: string,
  config: {
    apiToken:     string
    actorId?:     string
    maxEmployees?: number
    /**
     * When provided, the title-match check uses these personas' matchPatterns
     * (any pattern hitting any persona = match) and tags each profile with
     * the first persona that matched. When empty / undefined, falls back to
     * the legacy FOUNDER_TITLE_RE.
     */
    personas?:    ApifyPersonaMatcher[]
  },
): Promise<ApifyRunResult> {
  const actorId = config.actorId ?? DEFAULT_APIFY_ACTOR
  const maxEmployees = config.maxEmployees ?? DEFAULT_MAX_EMPLOYEES
  // Apify enforces a "Maximum charged results" cap on Pay-Per-Result actors
  // via the URL `maxItems` query param, NOT a body field. Without it the
  // run is rejected with "max-items-must-be-greater-than-zero". The
  // actor's own `max_employees` input field still drives how many profiles
  // it scrapes; `maxItems` purely caps billing at the platform level.
  const cap = Math.max(1, maxEmployees)
  const url = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(config.apiToken)}&maxItems=${cap}`
  const input = {
    identifier:    companyLinkedinUrl,
    max_employees: cap,
    job_title:     "",
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText)
    return {
      profiles: [],
      rawCount: 0,
      matchCount: 0,
      error: { status: res.status, message: body.slice(0, 500) },
    }
  }
  const items = await res.json().catch(() => [])
  const arr: ApifyRawProfile[] = Array.isArray(items) ? items : []
  // Build a per-persona pattern matcher once. When the workspace has any
  // configured personas with patterns we use those; otherwise we fall back
  // to the legacy founder/exec regex so the feature still does something
  // sensible on first-run workspaces.
  const personaMatchers = (config.personas ?? [])
    .filter(p => (p.matchPatterns ?? []).some(s => s && s.trim()))
    .map(p => ({
      name:     p.name,
      patterns: p.matchPatterns!.map(s => s.toLowerCase()).filter(Boolean),
    }))

  function matchTitle(title: string): { matched: boolean; persona: string | null } {
    if (!title) return { matched: false, persona: null }
    if (personaMatchers.length > 0) {
      const lc = title.toLowerCase()
      for (const m of personaMatchers) {
        if (m.patterns.some(pat => lc.includes(pat))) {
          return { matched: true, persona: m.name }
        }
      }
      return { matched: false, persona: null }
    }
    // Legacy fallback when the workspace has no personas configured.
    return { matched: FOUNDER_TITLE_RE.test(title), persona: null }
  }

  const profiles: NormalizedProfile[] = arr.map(normalizeProfile).map((p) => {
    const { matched, persona } = matchTitle(p.title)
    return {
      ...p,
      titleMatch:     !!p.linkedinUrl && matched,
      matchedPersona: matched ? persona : null,
    }
  })
  return {
    profiles,
    rawCount: profiles.length,
    matchCount: profiles.filter((p) => p.titleMatch).length,
  }
}

// ─── Personal profile - Interests scrape ────────────────────────────────────

export type InterestCategory = "topVoices" | "companies" | "groups" | "newsletters"

export interface FollowedAccount {
  name: string
  linkedinUrl: string | null
  /** Tagline (Companies, Newsletters) or headline (Top Voices). */
  tagline: string | null
  /** Where applicable (Companies, Newsletters, Top Voices). */
  followerCount: number | null
}

export interface ProfileInterests {
  topVoices:   FollowedAccount[]
  companies:   FollowedAccount[]
  groups:      FollowedAccount[]
  newsletters: FollowedAccount[]
}

export interface InterestsRunResult {
  interests: ProfileInterests
  totalCount: number
  /** Raw payload kept for debugging when an actor's response shape isn't what we expect. */
  rawSample: unknown
  error?: ApifyError
}

const EMPTY_INTERESTS: ProfileInterests = {
  topVoices:   [],
  companies:   [],
  groups:      [],
  newsletters: [],
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") {
    const n = parseInt(v.replace(/[^0-9]/g, ""), 10)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function toStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null
}

/**
 * Try to coerce a single item from the actor's response into our normalized
 * shape. Apify actors are inconsistent across the field names they use, so we
 * sniff the common variants. Anything we can't extract becomes null.
 */
function normalizeFollowed(item: unknown): FollowedAccount | null {
  if (!item || typeof item !== "object") return null
  const o = item as Record<string, unknown>
  const name = toStr(o.name) ?? toStr(o.title) ?? toStr(o.fullName) ?? toStr(o.companyName)
  if (!name) return null
  const linkedinUrl = toStr(o.url) ?? toStr(o.profileUrl) ?? toStr(o.profile_url) ?? toStr(o.linkedinUrl)
  const tagline = toStr(o.tagline) ?? toStr(o.headline) ?? toStr(o.description) ?? toStr(o.subtitle)
  const followerCount = toNumber(o.followerCount) ?? toNumber(o.followers) ?? toNumber(o.followers_count)
  return { name, linkedinUrl, tagline, followerCount }
}

function pickArray(...candidates: unknown[]): unknown[] {
  for (const c of candidates) {
    if (Array.isArray(c)) return c
  }
  return []
}

/**
 * Extract Interests from an actor response. Different actors nest the data
 * differently - some use { interests: { topVoices: [...] } }, some
 * { topVoices: [...] } at root, some { followedCompanies: [...] }. Sniff each
 * shape independently. Anything missing becomes an empty array.
 */
function extractInterests(item: Record<string, unknown>): ProfileInterests {
  const interestsBlock = (item.interests && typeof item.interests === "object")
    ? (item.interests as Record<string, unknown>)
    : item

  const topVoicesRaw = pickArray(
    interestsBlock.topVoices,
    interestsBlock.influencers,
    interestsBlock.followedInfluencers,
  )
  const companiesRaw = pickArray(
    interestsBlock.companies,
    interestsBlock.followedCompanies,
  )
  const groupsRaw = pickArray(
    interestsBlock.groups,
    interestsBlock.linkedinGroups,
  )
  const newslettersRaw = pickArray(
    interestsBlock.newsletters,
    interestsBlock.followedNewsletters,
  )

  return {
    topVoices:   topVoicesRaw.map(normalizeFollowed).filter((x): x is FollowedAccount => x !== null),
    companies:   companiesRaw.map(normalizeFollowed).filter((x): x is FollowedAccount => x !== null),
    groups:      groupsRaw.map(normalizeFollowed).filter((x): x is FollowedAccount => x !== null),
    newsletters: newslettersRaw.map(normalizeFollowed).filter((x): x is FollowedAccount => x !== null),
  }
}

/**
 * Run the configured profile-interests actor for a single LinkedIn URL and
 * return the followed accounts grouped by category. Returns an `error` payload
 * on HTTP failure; returns empty arrays for any category the actor doesn't
 * surface (so the caller can render a "no data" state rather than crashing).
 */
export async function fetchContactInterests(
  profileLinkedinUrl: string,
  config: { apiToken: string; actorId: string },
): Promise<InterestsRunResult> {
  const actorId = config.actorId
  if (!actorId) {
    return {
      interests:  EMPTY_INTERESTS,
      totalCount: 0,
      rawSample:  null,
      error:      { status: 400, message: "LinkedIn interests actor not configured" },
    }
  }
  const url = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${encodeURIComponent(config.apiToken)}`
  const input = {
    profileUrls: [profileLinkedinUrl],
    profileUrl:  profileLinkedinUrl,
    url:         profileLinkedinUrl,
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText)
    return {
      interests: EMPTY_INTERESTS,
      totalCount: 0,
      rawSample: null,
      error: { status: res.status, message: body.slice(0, 500) },
    }
  }
  const items = await res.json().catch(() => [])
  const arr = Array.isArray(items) ? items : []
  const first = (arr[0] && typeof arr[0] === "object")
    ? (arr[0] as Record<string, unknown>)
    : {}
  const interests = extractInterests(first)
  const totalCount =
    interests.topVoices.length +
    interests.companies.length +
    interests.groups.length +
    interests.newsletters.length
  return { interests, totalCount, rawSample: first }
}

// ─── Personal profile - X (Twitter) interests scrape ───────────────────────

/**
 * Hardcoded actor for X scraping. apidojo's lite Twitter scraper is the
 * single supported choice — picking actors was confusing for users so we
 * make the call once for everyone. If apidojo deprecates / renames this,
 * update the constant; nothing else needs to change.
 */
export const X_INTERESTS_ACTOR = "apidojo~twitter-scraper-lite"

export interface XInterestAccount {
  name:          string
  handle:        string
  profileUrl:    string | null
  bio:           string | null
  followerCount: number | null
  verified:      boolean
}

export interface XInterestsRunResult {
  accounts:   XInterestAccount[]
  totalCount: number
  rawSample:  unknown
  error?:     ApifyError
}

/**
 * Pull `<handle>` out of x.com/<handle> or twitter.com/<handle> (or just
 * accept a bare handle, with or without leading `@`).
 */
function normaliseTwitterHandle(input: string): string | null {
  const trimmed = input.trim().replace(/^@/, "")
  if (!trimmed) return null
  // Bare handle — no slashes, no protocol.
  if (!trimmed.includes("/") && !trimmed.includes(" ")) return trimmed
  const m = trimmed.match(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,15})/i)
  return m ? m[1] : null
}

/**
 * Field-tolerant: different actor versions expose the following list under
 * different names. We sniff the common shapes so the same parser keeps
 * working when apidojo iterates on output schemas.
 */
function extractXAccounts(item: Record<string, unknown>): XInterestAccount[] {
  const candidates: unknown[] = [
    item.following,
    item.followings,
    item.userFollowing,
    item.user_following,
    item.followingList,
    // Some actors return one user per item rather than a wrapper object.
    Array.isArray(item) ? item : null,
  ].filter(v => v !== null && v !== undefined)

  const arr = (candidates.find(v => Array.isArray(v)) as unknown[]) ?? []

  return arr.map((raw): XInterestAccount | null => {
    if (!raw || typeof raw !== "object") return null
    const r = raw as Record<string, unknown>
    const handle = toStr(r.handle) ?? toStr(r.screen_name) ?? toStr(r.screenName) ?? toStr(r.username) ?? toStr(r.userName)
    if (!handle) return null
    const name = toStr(r.name) ?? toStr(r.displayName) ?? toStr(r.full_name) ?? handle
    const profileUrl =
      toStr(r.profileUrl) ??
      toStr(r.url) ??
      `https://x.com/${handle}`
    const bio = toStr(r.bio) ?? toStr(r.description) ?? toStr(r.tagline)
    const followerCount =
      toNumber(r.followers) ??
      toNumber(r.followersCount) ??
      toNumber(r.followers_count) ??
      toNumber(r.followerCount)
    const verified = !!(r.verified ?? r.isVerified ?? r.isBlueVerified)
    return { name, handle, profileUrl, bio, followerCount, verified }
  }).filter((x): x is XInterestAccount => x !== null)
}

/**
 * Run the X-interests actor for a single Twitter handle/URL and return the
 * accounts that user follows. Returns an `error` payload on HTTP failure;
 * empty array when the actor returns nothing recognisable (caller renders a
 * "no data" state).
 */
export async function fetchContactXInterests(
  twitterUrlOrHandle: string,
  config: { apiToken: string; maxResults?: number },
): Promise<XInterestsRunResult> {
  const handle = normaliseTwitterHandle(twitterUrlOrHandle)
  if (!handle) {
    return {
      accounts:   [],
      totalCount: 0,
      rawSample:  null,
      error:      { status: 400, message: "Couldn't parse a Twitter handle from the input" },
    }
  }

  const url = `https://api.apify.com/v2/acts/${X_INTERESTS_ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(config.apiToken)}`
  // Send several common input shapes so the same call works across actor versions.
  const input = {
    handles:    [handle],
    handle,
    usernames:  [handle],
    username:   handle,
    profileUrls:[`https://x.com/${handle}`],
    profileUrl: `https://x.com/${handle}`,
    url:        `https://x.com/${handle}`,
    maxItems:   config.maxResults ?? 1000,
    limit:      config.maxResults ?? 1000,
  }
  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(input),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText)
    return {
      accounts:   [],
      totalCount: 0,
      rawSample:  null,
      error:      { status: res.status, message: body.slice(0, 500) },
    }
  }

  const items = await res.json().catch(() => [])
  const arr   = Array.isArray(items) ? items : []
  // Two actor shapes we accommodate:
  //   - One wrapper item that contains a following array, or
  //   - A flat dataset where each item IS a followed account.
  const wrapper = extractXAccounts((arr[0] && typeof arr[0] === "object") ? arr[0] as Record<string, unknown> : {})
  const flat    = wrapper.length > 0 ? wrapper : extractXAccounts({ following: arr })
  return {
    accounts:   flat,
    totalCount: flat.length,
    rawSample:  arr[0] ?? null,
  }
}
