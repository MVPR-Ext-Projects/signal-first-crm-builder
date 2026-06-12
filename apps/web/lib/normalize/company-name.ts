/**
 * Company name normalization.
 *
 * Used as the weakest identity signal in the Companies dedup waterfall —
 * only matched against rows where `linkedin_url IS NULL AND domain IS NULL`
 * so a name-only inbound doesn't get over-merged into a richly-known parent
 * company (the Acme ↔ Acme APAC failure mode).
 *
 * Normalization:
 *   - lowercase
 *   - collapse internal whitespace runs to single spaces
 *   - strip trailing punctuation (commas, periods, parens)
 *   - strip a trailing legal suffix (Inc, Ltd, LLC, GmbH, …)
 *   - trim
 *
 * Examples:
 *   normalizeCompanyName("Acme, Inc.")          → "acme"
 *   normalizeCompanyName("ACME Holdings Limited")  → "acme holdings"
 *   normalizeCompanyName("MVPR (UK)")              → "mvpr (uk)"   ← parens kept inside
 *   normalizeCompanyName("Acme APAC")           → "acme apac" ← regional kept (intentional)
 */

// Trailing legal suffixes to strip. Order matters: more specific first.
// Each entry is matched at the very end (with optional trailing comma/period/space).
const TRAILING_SUFFIXES = [
  "incorporated", "limited", "corporation", "company",
  "inc", "ltd", "llc", "lp", "llp", "plc", "corp", "co",
  "gmbh", "ag", "kg", "se",
  "sa", "s\\.a", "sas", "s\\.a\\.s", "sarl", "s\\.a\\.r\\.l",
  "spa", "s\\.p\\.a", "srl", "s\\.r\\.l",
  "bv", "b\\.v", "nv", "n\\.v",
  "pty", "pty ltd", "pte", "pte ltd",
  "oy", "ab", "as", "aps",
]

const SUFFIX_PATTERN = new RegExp(
  `[ ,.]+(${TRAILING_SUFFIXES.join("|")})\\s*\\.?\\s*$`,
  "i",
)

export function normalizeCompanyName(name: string | null | undefined): string | null {
  if (!name || typeof name !== "string") return null
  let s = name.toLowerCase().trim()
  if (!s) return null

  // Collapse whitespace runs.
  s = s.replace(/\s+/g, " ")

  // Strip trailing punctuation that isn't structural (closing parens kept).
  s = s.replace(/[,.\s]+$/, "")

  // Strip one trailing legal suffix. (Run twice for "Apple Inc." → "apple"
  // where the period was already stripped in the previous step. The first
  // pass strips "inc"; second pass is a no-op.)
  s = s.replace(SUFFIX_PATTERN, "").trim()

  // Strip trailing punctuation again in case the suffix removal left a comma.
  s = s.replace(/[,.\s]+$/, "")

  return s || null
}
