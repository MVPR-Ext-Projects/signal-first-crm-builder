/**
 * HubSpotAdapter — CrmAdapter implementation for HubSpot portals.
 *
 * Auth: Private App access token (simple) or OAuth access token (multi-tenant).
 *   Header: Authorization: Bearer ${accessToken}
 *   Base:   https://api.hubapi.com
 *
 * Notes on the model:
 *   - Contacts are identified by email or hs_object_id
 *   - There is no "signals" object — signal events are logged as Timeline Events
 *     on the contact record using a custom event type registered per HubSpot app
 *   - Property names use HubSpot internal names (e.g. "jobtitle", "hs_linkedin_url")
 *     rather than workspace-specific slugs
 *
 * Before using this adapter you need to:
 *   1. Create a Private App (or OAuth app) in HubSpot and store the access token
 *      in WorkspaceConfig.hubspot.accessToken
 *   2. Register a custom Timeline Event type via POST /crm/v3/timeline/event-templates
 *      and store the returned eventTemplateId in WorkspaceConfig.hubspot.timelineEventTemplateId
 *   3. Ensure any custom contact properties (e.g. signal_score) exist in the portal
 *      — create them via POST /crm/v3/properties/contacts if needed
 */

import type { CrmAdapter, EnrichedContact, SignalData } from "./adapter"
import type { ResolvedHubSpotProperties } from "./types"

const HS_BASE = "https://api.hubapi.com"

interface HubSpotContact {
  id: string
  properties: Record<string, string>
}

interface HubSpotSearchResponse {
  results: HubSpotContact[]
}

export class HubSpotAdapter implements CrmAdapter {
  constructor(
    private readonly accessToken: string,
    private readonly props: ResolvedHubSpotProperties,
    /** HubSpot app ID — required for logging timeline events */
    private readonly appId: string,
  ) {}

  // ─── HTTP helpers ────────────────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${HS_BASE}${path}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
      cache: "no-store",
    })
    if (!res.ok) throw new Error(`HubSpot GET ${path} → ${res.status}: ${await res.text()}`)
    return res.json() as Promise<T>
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${HS_BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`HubSpot POST ${path} → ${res.status}: ${await res.text()}`)
    return res.json() as Promise<T>
  }

  private async patch<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${HS_BASE}${path}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`HubSpot PATCH ${path} → ${res.status}: ${await res.text()}`)
    return res.json() as Promise<T>
  }

  // ─── CrmAdapter ──────────────────────────────────────────────────────────────

  async findContactByEmail(email: string): Promise<string | null> {
    // HubSpot search API: POST /crm/v3/objects/contacts/search
    const res = await this.post<HubSpotSearchResponse>("/crm/v3/objects/contacts/search", {
      filterGroups: [{
        filters: [{ propertyName: "email", operator: "EQ", value: email }],
      }],
      limit: 1,
      properties: ["email"],
    })
    return res.results[0]?.id ?? null
  }

  async findContactByLinkedin(linkedinUrl: string): Promise<string | null> {
    const res = await this.post<HubSpotSearchResponse>("/crm/v3/objects/contacts/search", {
      filterGroups: [{
        filters: [{ propertyName: this.props.linkedinUrl, operator: "EQ", value: linkedinUrl }],
      }],
      limit: 1,
      properties: [this.props.linkedinUrl],
    })
    return res.results[0]?.id ?? null
  }

  async createContact(contact: EnrichedContact): Promise<string> {
    const { props } = this
    const properties: Record<string, string> = {}

    if (contact.firstName)   properties["firstname"]       = contact.firstName
    if (contact.lastName)    properties["lastname"]        = contact.lastName
    if (contact.email)       properties["email"]           = contact.email
    if (contact.phone)       properties["phone"]           = contact.phone
    if (contact.jobTitle)    properties[props.jobTitle]    = contact.jobTitle
    if (contact.companyName) properties["company"]         = contact.companyName
    if (contact.linkedinUrl) properties[props.linkedinUrl] = contact.linkedinUrl
    if (contact.location)    properties["city"]            = contact.location

    const res = await this.post<HubSpotContact>("/crm/v3/objects/contacts", { properties })
    return res.id
  }

  async updateContact(contactId: string, contact: EnrichedContact): Promise<void> {
    const { props } = this
    const properties: Record<string, string> = {}

    if (contact.jobTitle)    properties[props.jobTitle]    = contact.jobTitle
    if (contact.linkedinUrl) properties[props.linkedinUrl] = contact.linkedinUrl
    if (contact.location)    properties["city"]            = contact.location

    if (Object.keys(properties).length === 0) return
    await this.patch(`/crm/v3/objects/contacts/${contactId}`, { properties })
  }

  /**
   * Logs a new signal as a custom timeline event on the HubSpot contact.
   * Returns null — HubSpot timeline events have no persistent record ID we need.
   *
   * Requires a Timeline Event Template registered for your app:
   *   POST https://api.hubapi.com/crm/v3/timeline/event-templates
   *   Store the returned eventTemplateId in WorkspaceConfig.hubspot.timelineEventTemplateId
   *
   * Docs: https://developers.hubspot.com/docs/api/crm/timeline
   */
  async createSignal(
    contactId: string,
    signal: SignalData,
    _contact: EnrichedContact,
  ): Promise<string | null> {
    const { props } = this

    await this.post(`/crm/v3/timeline/events`, {
      eventTemplateId: props.timelineEventTemplateId,
      objectId: contactId,
      tokens: {
        signalSource:  signal.sourceType   ?? "",
        engagementUrl: signal.engagementUrl ?? "",
        signalScore:   String(signal.score ?? 0),
        ...(signal.teamfluenceCrmId ? { teamfluenceId: signal.teamfluenceCrmId } : {}),
      },
    })

    // Increment cumulative signal score property on the contact
    if (signal.score !== undefined && props.signalScore) {
      const current = await this.get<HubSpotContact>(
        `/crm/v3/objects/contacts/${contactId}?properties=${props.signalScore}`,
      )
      const existing = Number(current.properties[props.signalScore] ?? 0)
      await this.patch(`/crm/v3/objects/contacts/${contactId}`, {
        properties: { [props.signalScore]: String(existing + signal.score) },
      })
    }

    return null
  }

  /**
   * Noop for HubSpot — contact is already updated via updateContact() in the
   * enrichment flow. There is no separate signal record to patch back.
   */
  async linkEnrichment(
    _signalId: string,
    _contactId: string,
    _contact: EnrichedContact,
  ): Promise<void> {
    // noop
  }

  // ─── Companies ─────────────────────────────────────────────────────────────
  // Stubs - HubSpot company sync is a future addition.
  // The throws keep the contract loud if anyone hits them by mistake.

  async findCompanyByDomain(_domain: string): Promise<string | null> {
    throw new Error("HubSpotAdapter.findCompanyByDomain: not implemented yet")
  }

  async createCompany(_company: import("./types").CompanyData): Promise<string> {
    throw new Error("HubSpotAdapter.createCompany: not implemented yet")
  }

  async updateCompany(_companyId: string, _company: import("./types").CompanyData): Promise<void> {
    throw new Error("HubSpotAdapter.updateCompany: not implemented yet")
  }

  // ─── Influencers ───────────────────────────────────────────────────────────
  // HubSpot has no native influencer object. Mirroring the influence graph to
  // HubSpot would need a custom object + association; out of scope for the
  // default adapter. Throws so a misconfiguration is loud rather than silent.
  // (Attio implements these for real — see attio-adapter.ts / ADR-015.)

  async findInfluencer(_influencer: import("./types").InfluencerRecord): Promise<string | null> {
    throw new Error("HubSpotAdapter.findInfluencer: not implemented (no influencer object in HubSpot)")
  }

  async createInfluencer(_influencer: import("./types").InfluencerRecord): Promise<string> {
    throw new Error("HubSpotAdapter.createInfluencer: not implemented (no influencer object in HubSpot)")
  }

  async updateInfluencer(_influencerId: string, _influencer: import("./types").InfluencerRecord): Promise<void> {
    throw new Error("HubSpotAdapter.updateInfluencer: not implemented (no influencer object in HubSpot)")
  }

  async linkInfluence(_influencerId: string, _contactId: string): Promise<void> {
    throw new Error("HubSpotAdapter.linkInfluence: not implemented (no influencer object in HubSpot)")
  }
}
