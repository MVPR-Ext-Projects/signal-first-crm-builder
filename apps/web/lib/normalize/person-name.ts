/**
 * Person name normalization + fuzzy match.
 *
 * Used as the weakest identity signal in the People dedup waterfall (steps
 * 3 and 4: name + company website / name + company name fallback). Tom
 * accepted some false-merge risk in exchange for catching real duplicates
 * — the fuzzy matcher handles common variations:
 *
 *   - case + whitespace differences
 *   - middle names / initials present or absent
 *   - leading/trailing initials (T. Lawrence vs Tom Lawrence)
 *   - common diminutives (Tom ↔ Thomas, Bob ↔ Robert, …)
 *
 * Tightening: requires both first and last name tokens to agree. Refuses
 * to match on first-name-only or last-name-only.
 */

// Diminutive ↔ formal name dictionary. Bidirectional comparison treats both
// forms as the same canonical "key". Starter list — extend as we find dupes
// the matcher misses in production.
const DIMINUTIVES: Record<string, string> = {
  // Boys
  tom: "thomas", thomas: "thomas",
  bob: "robert", rob: "robert", bobby: "robert", robby: "robert", robert: "robert",
  bill: "william", billy: "william", will: "william", willy: "william", liam: "william", william: "william",
  dick: "richard", rick: "richard", ricky: "richard", richie: "richard", richard: "richard",
  jim: "james", jimmy: "james", jamie: "james", james: "james",
  joe: "joseph", joey: "joseph", joseph: "joseph",
  mike: "michael", mick: "michael", mickey: "michael", michael: "michael",
  matt: "matthew", matty: "matthew", matthew: "matthew",
  dan: "daniel", danny: "daniel", daniel: "daniel",
  dave: "david", davey: "david", david: "david",
  chris: "christopher", topher: "christopher", christopher: "christopher",
  alex: "alexander", al: "alexander", alexander: "alexander",
  nick: "nicholas", nicky: "nicholas", nicholas: "nicholas",
  steve: "stephen", stephen: "stephen", steven: "stephen",
  ben: "benjamin", benji: "benjamin", benjamin: "benjamin",
  ed: "edward", eddie: "edward", ted: "edward", teddy: "edward", edward: "edward",
  tony: "anthony", anthony: "anthony",
  charlie: "charles", chuck: "charles", charles: "charles",
  greg: "gregory", gregory: "gregory",
  jeff: "jeffrey", jeffrey: "jeffrey", geoff: "geoffrey", geoffrey: "geoffrey",
  ken: "kenneth", kenny: "kenneth", kenneth: "kenneth",
  ron: "ronald", ronnie: "ronald", ronald: "ronald",
  sam: "samuel", sammy: "samuel", samuel: "samuel",
  pat: "patrick", paddy: "patrick", patrick: "patrick",
  // Girls
  liz: "elizabeth", beth: "elizabeth", betty: "elizabeth", lizzie: "elizabeth", elizabeth: "elizabeth",
  kate: "katherine", katie: "katherine", kathy: "katherine", kat: "katherine", katherine: "katherine", catherine: "katherine",
  meg: "margaret", maggie: "margaret", peggy: "margaret", margaret: "margaret",
  sue: "susan", susie: "susan", susan: "susan",
  jen: "jennifer", jenny: "jennifer", jennifer: "jennifer",
  becky: "rebecca", rebecca: "rebecca",
  mandy: "amanda", amanda: "amanda",
  vicky: "victoria", victoria: "victoria",
  sandy: "sandra", sandra: "sandra",
  nat: "natalie", nattie: "natalie", natalie: "natalie",
  mel: "melissa", missy: "melissa", melissa: "melissa",
}

function canonicalGiven(token: string): string {
  return DIMINUTIVES[token] ?? token
}

function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")  // strip combining diacritics
    .replace(/[.]/g, "")              // drop periods (initials: "T." → "t")
    .replace(/[^a-z\s'-]/g, " ")      // keep letters, apostrophes, hyphens
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Lowercase, collapse whitespace, normalize accents. Stable form for storage
 * + display comparison. Use `fuzzyNameMatch` for actual identity checks.
 */
export function normalizePersonName(name: string | null | undefined): string | null {
  if (!name || typeof name !== "string") return null
  const tokens = tokenize(name)
  if (tokens.length === 0) return null
  return tokens.join(" ")
}

/**
 * Fuzzy match between two person names. True when the names are plausibly
 * the same individual (after diminutive expansion, initial handling, and
 * middle-name allowance). Requires both a first-name and last-name agreement
 * — refuses to match on a single token.
 *
 * Examples (all true):
 *   fuzzyNameMatch("Tom Lawrence",  "Thomas Lawrence")   → true
 *   fuzzyNameMatch("T. Lawrence",   "Tom Lawrence")      → true
 *   fuzzyNameMatch("Tom Lawrence",  "Tom J Lawrence")    → true
 *   fuzzyNameMatch("tom lawrence",  "TOM LAWRENCE")      → true
 *
 * Examples (all false):
 *   fuzzyNameMatch("Tom Lawrence",  "Tom Smith")         → false (different surname)
 *   fuzzyNameMatch("Tom Lawrence",  "Tim Lawrence")      → false (Tim ≠ Tom)
 *   fuzzyNameMatch("Lawrence",      "Tom Lawrence")      → false (single token)
 *   fuzzyNameMatch("Tom L.",        "Tom Lawrence")      → false (last-name initial too weak)
 */
export function fuzzyNameMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false
  const ta = tokenize(a)
  const tb = tokenize(b)
  if (ta.length < 2 || tb.length < 2) return false

  const firstA = ta[0]
  const firstB = tb[0]
  const lastA  = ta[ta.length - 1]
  const lastB  = tb[tb.length - 1]

  // Last names must be a strong match: full token equality (no initials).
  if (lastA.length < 2 || lastB.length < 2) return false
  if (lastA !== lastB) return false

  // First names: try exact, then diminutive-canonical, then initial expansion.
  if (firstA === firstB) return true
  if (canonicalGiven(firstA) === canonicalGiven(firstB)) return true

  // Initial expansion: "t" matches any first name starting with "t".
  if (firstA.length === 1 && firstB.startsWith(firstA)) return true
  if (firstB.length === 1 && firstA.startsWith(firstB)) return true

  return false
}
