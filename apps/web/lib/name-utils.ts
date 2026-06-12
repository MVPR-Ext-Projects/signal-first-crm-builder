/**
 * Helpers for detecting + cleaning up junk values in contact name/title
 * fields. Real-world TF / Zapier data sometimes leaves a LinkedIn URN
 * identifier (e.g. "ACoAAAFU75UBrEyKsG7p9yY8…") in the `first_name` field
 * when it can't resolve a real name, and produces "Unknown Title" /
 * "Unknown Company" placeholders for missing data.
 */

/**
 * Returns true if the string looks like an identifier rather than a real
 * human-readable value:
 *   - LinkedIn URN-style id (starts with ACo / AEB / similar prefix)
 *   - Long, no-spaces, base64-ish character set
 *   - "Unknown <something>" placeholder
 */
export function isJunkName(s: string | null | undefined): boolean {
  if (!s) return false
  const t = s.trim()
  if (!t) return false
  // "Unknown <foo>" placeholders (Unknown Title, Unknown Company, …)
  if (/^unknown(\s|$)/i.test(t)) return true
  // If any whitespace-separated token looks like an identifier, treat the whole
  // string as junk. Catches cases like "ACoAAFU75… ACoBABCDEF…" where Surfe /
  // Teamfluence returned URN-style ids in both first_name and last_name.
  const tokens = t.split(/\s+/)
  const looksLikeId = (tok: string) =>
    /^A[A-Z][a-zA-Z0-9_-]{10,}$/.test(tok) ||
    (tok.length >= 20 && /^[A-Za-z0-9_-]+$/.test(tok))
  if (tokens.some(looksLikeId)) return true
  return false
}

export interface DerivedName {
  firstName: string
  lastName: string | null
  fullName: string
}

/**
 * Best-effort name derivation from the local-part of an email address.
 *   tom.lawrence@mvpr.io   → { firstName: "Tom", lastName: "Lawrence", fullName: "Tom Lawrence" }
 *   jane.doe@mvpr.io       → "Jane Doe"
 *   support@mvpr.io        → "Support" (no separator, treat as one word)
 *   tom@mvpr.io            → "Tom"
 */
export function nameFromEmail(email: string | null | undefined): DerivedName | null {
  if (!email || typeof email !== "string") return null
  const local = email.split("@")[0]
  if (!local) return null
  const parts = local.split(/[._\-+]+/).filter(p => p && /[a-z]/i.test(p))
  if (parts.length === 0) return null
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
  if (parts.length === 1) {
    const only = cap(parts[0])
    return { firstName: only, lastName: null, fullName: only }
  }
  const firstName = cap(parts[0])
  const lastName  = parts.slice(1).map(cap).join(" ")
  return { firstName, lastName, fullName: `${firstName} ${lastName}` }
}

/**
 * Resolve the best available {first, last, full} name given:
 *   - the existing values on the contact row (may be junk)
 *   - any new values from the enrichment provider (may also be junk or empty)
 *   - the contact's email (used as fallback derivation)
 *
 * Returns the values that should be written back. Caller decides whether to
 * UPDATE — if the output equals the existing values, it's a no-op.
 */
export function resolveBestName(input: {
  existing: { firstName?: string | null; lastName?: string | null; fullName?: string | null }
  fromProvider: { firstName?: string | null; lastName?: string | null; fullName?: string | null }
  email?: string | null
}): { firstName: string | null; lastName: string | null; fullName: string | null } {
  const { existing, fromProvider, email } = input

  // Strip any junk values from the provider's response so we don't trust them.
  const provFirst = isJunkName(fromProvider.firstName) ? null : (fromProvider.firstName ?? null)
  const provLast  = isJunkName(fromProvider.lastName)  ? null : (fromProvider.lastName  ?? null)
  const provFull  = isJunkName(fromProvider.fullName)  ? null
                    : (fromProvider.fullName ?? (provFirst && provLast ? `${provFirst} ${provLast}` : provFirst))

  // 1. Provider gave us a clean name → that wins.
  if (provFull) {
    return {
      firstName: provFirst ?? null,
      lastName:  provLast  ?? null,
      fullName:  provFull,
    }
  }

  // 2. Existing name is clean → keep it.
  if (!isJunkName(existing.fullName) && existing.fullName) {
    return {
      firstName: existing.firstName ?? null,
      lastName:  existing.lastName  ?? null,
      fullName:  existing.fullName,
    }
  }

  // 3. Existing is junk (or missing) → derive from email if we can.
  if (email) {
    const derived = nameFromEmail(email)
    if (derived) {
      return {
        firstName: derived.firstName,
        lastName:  derived.lastName,
        fullName:  derived.fullName,
      }
    }
  }

  // 4. Nothing better than what we had — preserve.
  return {
    firstName: existing.firstName ?? null,
    lastName:  existing.lastName  ?? null,
    fullName:  existing.fullName  ?? null,
  }
}
