/**
 * AttioAdapter — CrmAdapter implementation for Attio workspaces.
 *
 * Auth: Attio access token (workspace-scoped).
 *   Header: Authorization: Bearer ${accessToken}
 *   Base:   https://api.attio.com
 *   Docs:   https://developers.attio.com/reference
 *
 * Notes on the model (why this adapter is shaped differently to HubSpot):
 *   - Attio is a record database. Unlike HubSpot's timeline events, a signal
 *     is a real record in a custom "signals" object — so createSignal() returns
 *     a record_id (HubSpot returns null), and linkEnrichment() can patch that
 *     record back after Surfe completes.
 *   - Attio addresses attributes by api_slug, not fixed internal names. The
 *     workspace's slugs (with template defaults applied) arrive as ResolvedSlugs
 *     from resolveSlug(config) — see apps/web/lib/workspace-config.ts. That is
 *     why the slug machinery (ResolvedSlugs, resolveSlug) lives in the config
 *     layer rather than here.
 *   - Object slugs (people / companies / signals) are configurable but default
 *     to Attio's standard "people" and "companies" plus a custom "signals"
 *     object the workspace provisions.
 *
 * Before using this adapter you need to:
 *   1. Create an Attio access token and store it in WorkspaceConfig.attio.accessToken
 *   2. Provision a custom "signals" object in the Attio workspace with the
 *      attributes named by ResolvedSlugs (or override the slugs in config.slugs)
 *   3. Ensure the people/companies objects carry the custom attributes the sync
 *      writes (signal_score, persona, funnel_stage, etc.)
 */

import type { CrmAdapter, EnrichedContact, SignalData, CompanyData, InfluencerRecord } from "./adapter"
import type { ResolvedSlugs } from "./types"

const ATTIO_BASE = "https://api.attio.com"

/** Object api_slugs. Defaults match a standard Attio workspace + custom signals/influencers objects. */
export interface AttioObjectSlugs {
  people:      string
  companies:   string
  signals:     string
  influencers: string
}

const DEFAULT_OBJECTS: AttioObjectSlugs = {
  people:      "people",
  companies:   "companies",
  signals:     "signals",
  influencers: "influencers",
}

/**
 * Attribute slugs for the influence graph. The influencers object carries
 * `influences` (multi-reference to people); the people object carries
 * `influenced_by` (multi-reference to influencers). Override only if the
 * workspace renamed them.
 */
const INFLUENCER_ATTRS = {
  name:          "name",
  type:          "type",
  linkedinUrl:   "linkedin_url",
  domain:        "domain",
  twitterUrl:    "twitter_url",
  website:       "website",
  influences:    "influences",     // on the influencers object -> people
  influencedBy:  "influenced_by",  // on the people object       -> influencers
} as const

interface AttioRecord {
  id: { record_id: string }
  values: Record<string, unknown>
}

interface AttioQueryResponse {
  data: AttioRecord[]
}

interface AttioRecordResponse {
  data: AttioRecord
}

/** A single Attio attribute value, wrapped in the array shape the API expects. */
type AttioValues = Record<string, unknown[]>

export class AttioAdapter implements CrmAdapter {
  private readonly objects: AttioObjectSlugs

  constructor(
    private readonly accessToken: string,
    private readonly slugs: ResolvedSlugs,
    objects?: Partial<AttioObjectSlugs>,
  ) {
    this.objects = { ...DEFAULT_OBJECTS, ...objects }
  }

  // ─── HTTP helpers ────────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      "Content-Type": "application/json",
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${ATTIO_BASE}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      cache: "no-store",
    })
    if (!res.ok) throw new Error(`Attio POST ${path} → ${res.status}: ${await res.text()}`)
    return res.json() as Promise<T>
  }

  private async patch<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${ATTIO_BASE}${path}`, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify(body),
      cache: "no-store",
    })
    if (!res.ok) throw new Error(`Attio PATCH ${path} → ${res.status}: ${await res.text()}`)
    return res.json() as Promise<T>
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${ATTIO_BASE}${path}`, {
      headers: this.headers(),
      cache: "no-store",
    })
    if (!res.ok) throw new Error(`Attio GET ${path} → ${res.status}: ${await res.text()}`)
    return res.json() as Promise<T>
  }

  /** Query the first record on an object matching a single attribute. */
  private async queryOne(object: string, slug: string, value: string): Promise<string | null> {
    const res = await this.post<AttioQueryResponse>(
      `/v2/objects/${object}/records/query`,
      { filter: { [slug]: value }, limit: 1 },
    )
    return res.data[0]?.id.record_id ?? null
  }

  // ─── Value builders ──────────────────────────────────────────────────────────
  // Attio wraps every attribute write as an array of value objects.

  private text(value: string): unknown[] {
    return [{ value }]
  }

  private ref(object: string, recordId: string): unknown[] {
    return [{ target_object: object, target_record_id: recordId }]
  }

  // ─── CrmAdapter: contacts ──────────────────────────────────────────────────────

  async findContactByEmail(email: string): Promise<string | null> {
    return this.queryOne(this.objects.people, this.slugs.personEmail, email)
  }

  async findContactByLinkedin(linkedinUrl: string): Promise<string | null> {
    return this.queryOne(this.objects.people, this.slugs.personLinkedin, linkedinUrl)
  }

  async createContact(contact: EnrichedContact): Promise<string> {
    const res = await this.post<AttioRecordResponse>(
      `/v2/objects/${this.objects.people}/records`,
      { data: { values: this.personValues(contact) } },
    )
    return res.data.id.record_id
  }

  async updateContact(contactId: string, contact: EnrichedContact): Promise<void> {
    const values = this.personValues(contact)
    if (Object.keys(values).length === 0) return
    await this.patch(
      `/v2/objects/${this.objects.people}/records/${contactId}`,
      { data: { values } },
    )
  }

  /** Map an EnrichedContact onto people-object attribute slugs (only set fields). */
  private personValues(contact: EnrichedContact): AttioValues {
    const s = this.slugs
    const v: AttioValues = {}

    if (contact.email)            v[s.personEmail]          = [{ email_address: contact.email }]
    if (contact.linkedinUrl)      v[s.personLinkedin]       = this.text(contact.linkedinUrl)
    if (contact.jobTitle)         v[s.personJobTitle]       = this.text(contact.jobTitle)
    if (contact.avatarUrl)        v[s.personAvatarUrl]      = this.text(contact.avatarUrl)
    if (contact.location)         v[s.personLocation]       = this.text(contact.location)
    if (contact.persona)          v[s.personPersona]        = this.text(contact.persona)
    if (contact.funnelStage)      v[s.funnelStage]          = this.text(contact.funnelStage)
    if (contact.signalScore !== undefined) v[s.personEngagementScore] = [{ value: contact.signalScore }]
    if (contact.signalCount !== undefined) v[s.personSignalCount]     = [{ value: contact.signalCount }]

    // Attio's people.name is a structured personal-name attribute.
    if (contact.firstName || contact.lastName || contact.fullName) {
      v["name"] = [{
        first_name: contact.firstName ?? "",
        last_name:  contact.lastName ?? "",
        full_name:  contact.fullName ?? [contact.firstName, contact.lastName].filter(Boolean).join(" "),
      }]
    }
    return v
  }

  // ─── CrmAdapter: signals ───────────────────────────────────────────────────────

  /**
   * Create a real record in the custom "signals" object and link it to the
   * person. Returns the new record_id so callers can reference the CRM-side
   * signal (and so linkEnrichment() can patch it back after enrichment).
   */
  async createSignal(
    contactId: string,
    signal: SignalData,
    contact: EnrichedContact,
  ): Promise<string | null> {
    const s = this.slugs
    const values: AttioValues = {
      [s.signalPersonRef]: this.ref(this.objects.people, contactId),
    }

    if (contact.linkedinUrl) values[s.signalLinkedinUrl] = this.text(contact.linkedinUrl)
    if (contact.email)       values[s.signalEmail]       = [{ email_address: contact.email }]
    if (contact.firstName)   values[s.signalFirstName]   = this.text(contact.firstName)
    if (contact.lastName)    values[s.signalLastName]    = this.text(contact.lastName)
    if (contact.jobTitle)    values[s.signalJobTitle]    = this.text(contact.jobTitle)
    if (signal.sourceType)   values[s.signalSourceType]  = this.text(signal.sourceType)
    if (signal.score !== undefined) values[s.signalScore] = [{ value: signal.score }]
    if (signal.teamfluenceCrmId)    values[s.signalTeamfluenceCrmId] = this.text(signal.teamfluenceCrmId)
    if (signal.engagementUrl)       values[s.signalEngagementUrl]    = this.text(signal.engagementUrl)

    const res = await this.post<AttioRecordResponse>(
      `/v2/objects/${this.objects.signals}/records`,
      { data: { values } },
    )
    return res.data.id.record_id
  }

  /**
   * Patch the signal record back with enrichment results after Surfe completes.
   * Attio keeps a real signal record (unlike HubSpot), so this is a real write,
   * not a noop. signalId is the record_id returned by createSignal().
   */
  async linkEnrichment(
    signalId: string,
    _contactId: string,
    contact: EnrichedContact,
  ): Promise<void> {
    if (!signalId) return
    const s = this.slugs
    const values: AttioValues = {}
    if (contact.email)       values[s.signalEmail]    = [{ email_address: contact.email }]
    if (contact.firstName)   values[s.signalFirstName] = this.text(contact.firstName)
    if (contact.lastName)    values[s.signalLastName]  = this.text(contact.lastName)
    if (contact.jobTitle)    values[s.signalJobTitle]  = this.text(contact.jobTitle)

    if (Object.keys(values).length === 0) return
    await this.patch(
      `/v2/objects/${this.objects.signals}/records/${signalId}`,
      { data: { values } },
    )
  }

  // ─── CrmAdapter: companies ─────────────────────────────────────────────────────
  // Attio companies are first-class records (unlike the HubSpot adapter's stubs).

  async findCompanyByDomain(domain: string): Promise<string | null> {
    return this.queryOne(this.objects.companies, this.slugs.companyDomains, domain)
  }

  async createCompany(company: CompanyData): Promise<string> {
    const res = await this.post<AttioRecordResponse>(
      `/v2/objects/${this.objects.companies}/records`,
      { data: { values: this.companyValues(company) } },
    )
    return res.data.id.record_id
  }

  async updateCompany(companyId: string, company: CompanyData): Promise<void> {
    const values = this.companyValues(company)
    if (Object.keys(values).length === 0) return
    await this.patch(
      `/v2/objects/${this.objects.companies}/records/${companyId}`,
      { data: { values } },
    )
  }

  private companyValues(company: CompanyData): AttioValues {
    const s = this.slugs
    const v: AttioValues = {}

    if (company.name)         v[s.companyName]    = this.text(company.name)
    if (company.domain)       v[s.companyDomains] = [{ domain: company.domain }]
    if (company.employeeRange)v[s.companyEmployeeRange] = this.text(company.employeeRange)
    if (company.funnelStage)  v[s.companyFunnelStage]   = this.text(company.funnelStage)
    if (company.prospectType) v[s.companyProspectType]  = this.text(company.prospectType)
    if (company.engagementScore !== undefined) v[s.companyEngagementScore] = [{ value: company.engagementScore }]
    if (company.signalsCount !== undefined)    v[s.companySignalsCount]    = [{ value: company.signalsCount }]
    return v
  }

  // ─── Influencers (the influence graph) ─────────────────────────────────────
  // Influencers are their own Attio object. `influences` (on the influencer)
  // and `influenced_by` (on the person) are multi-reference attributes; we
  // maintain both sides explicitly via read-modify-write so the link shows up
  // regardless of whether the workspace configured them as Attio inverses.

  async findInfluencer(influencer: InfluencerRecord): Promise<string | null> {
    const a = INFLUENCER_ATTRS
    const obj = this.objects.influencers
    if (influencer.linkedinUrl) {
      const hit = await this.queryOne(obj, a.linkedinUrl, influencer.linkedinUrl)
      if (hit) return hit
    }
    if (influencer.domain) {
      const hit = await this.queryOne(obj, a.domain, influencer.domain)
      if (hit) return hit
    }
    return this.queryOne(obj, a.name, influencer.name)
  }

  async createInfluencer(influencer: InfluencerRecord): Promise<string> {
    const res = await this.post<AttioRecordResponse>(
      `/v2/objects/${this.objects.influencers}/records`,
      { data: { values: this.influencerValues(influencer) } },
    )
    return res.data.id.record_id
  }

  async updateInfluencer(influencerId: string, influencer: InfluencerRecord): Promise<void> {
    const values = this.influencerValues(influencer)
    if (Object.keys(values).length === 0) return
    await this.patch(
      `/v2/objects/${this.objects.influencers}/records/${influencerId}`,
      { data: { values } },
    )
  }

  /**
   * Append the contact to influencer.influences and the influencer to
   * person.influenced_by. Read-modify-write each side so we don't clobber
   * existing references (Attio replaces a multi-reference attribute wholesale
   * on write).
   */
  async linkInfluence(influencerId: string, contactId: string): Promise<void> {
    const a = INFLUENCER_ATTRS
    await this.appendReference(this.objects.influencers, influencerId, a.influences, this.objects.people, contactId)
    await this.appendReference(this.objects.people, contactId, a.influencedBy, this.objects.influencers, influencerId)
  }

  /** Add a record reference to a multi-reference attribute without dropping the existing ones. */
  private async appendReference(
    object: string,
    recordId: string,
    attrSlug: string,
    targetObject: string,
    targetRecordId: string,
  ): Promise<void> {
    const current = await this.get<AttioRecordResponse>(`/v2/objects/${object}/records/${recordId}`)
    const raw = (current.data.values?.[attrSlug] as Array<{ target_record_id?: string }> | undefined) ?? []
    const existing = raw
      .map(r => r.target_record_id)
      .filter((id): id is string => Boolean(id))
    if (existing.includes(targetRecordId)) return
    const refs = [...existing, targetRecordId].map(id => ({ target_object: targetObject, target_record_id: id }))
    await this.patch(`/v2/objects/${object}/records/${recordId}`, { data: { values: { [attrSlug]: refs } } })
  }

  private influencerValues(influencer: InfluencerRecord): AttioValues {
    const a = INFLUENCER_ATTRS
    const v: AttioValues = {}
    if (influencer.name)        v[a.name]        = this.text(influencer.name)
    if (influencer.type)        v[a.type]        = this.text(influencer.type)
    if (influencer.linkedinUrl) v[a.linkedinUrl] = this.text(influencer.linkedinUrl)
    if (influencer.domain)      v[a.domain]      = this.text(influencer.domain)
    if (influencer.twitterUrl)  v[a.twitterUrl]  = this.text(influencer.twitterUrl)
    if (influencer.website)     v[a.website]     = this.text(influencer.website)
    return v
  }
}
