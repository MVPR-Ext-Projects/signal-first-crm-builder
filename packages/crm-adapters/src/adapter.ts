/**
 * CrmAdapter — the interface every CRM integration must implement.
 *
 * Each adapter is instantiated with its credentials + field mapping baked in,
 * so call-sites only work with the normalised shape below.
 *
 * Current implementations:
 *   HubSpotAdapter → hubspot-adapter.ts (timeline-event model; companies stubbed)
 *   AttioAdapter   → attio-adapter.ts   (record model; signals + companies are real records)
 *   Pick per workspace via WorkspaceConfig.crmProvider ("hubspot" | "attio" | "none").
 *   See docs/CRM-ADAPTERS.md for the trade-offs and how to choose.
 *
 * Adding a new CRM (e.g. Salesforce):
 *   1. Create salesforce-adapter.ts implementing this interface
 *   2. Add "salesforce" to WorkspaceConfig.crmProvider
 *   3. Register it in the factory (apps/web/lib/crm/index.ts)
 */

import type { EnrichedContact, SignalData, CompanyData, InfluencerRecord } from "./types"

export type { EnrichedContact, SignalData, CompanyData, InfluencerRecord }

export interface CrmAdapter {
  findContactByEmail(email: string): Promise<string | null>
  findContactByLinkedin(linkedinUrl: string): Promise<string | null>
  createContact(contact: EnrichedContact): Promise<string>
  updateContact(contactId: string, contact: EnrichedContact): Promise<void>

  /**
   * Create a new signal event linked to a contact. Called when a signal
   * arrives from an inbound source (Teamfluence, Dripify, etc.)
   *
   * HubSpot writes a timeline event and returns null (no signal record concept).
   * Attio creates a real record in the signals object and returns its record_id.
   */
  createSignal(
    contactId: string,
    signal: SignalData,
    contact: EnrichedContact,
  ): Promise<string | null>

  /**
   * Write enrichment results back after Surfe completes. For HubSpot this
   * is a noop: the contact is already updated via updateContact() in the
   * enrichment flow.
   */
  linkEnrichment(
    signalId: string,
    contactId: string,
    contact: EnrichedContact,
  ): Promise<void>

  findCompanyByDomain(domain: string): Promise<string | null>
  createCompany(company: CompanyData): Promise<string>
  updateCompany(companyId: string, company: CompanyData): Promise<void>

  // ── Influencers (the influence graph) ──────────────────────────────────────
  // An influencer (journalist, publication, podcast, individual) influences
  // prospects. The CRM mirrors the gtm-os influencers entity + the M2M edge,
  // surfaced as two reference attributes: influencer.influences (-> people) and
  // person.influenced_by (-> influencers). See ADR-015. CRMs without an
  // influencer object (e.g. HubSpot by default) may no-op / throw.

  findInfluencer(influencer: InfluencerRecord): Promise<string | null>
  createInfluencer(influencer: InfluencerRecord): Promise<string>
  updateInfluencer(influencerId: string, influencer: InfluencerRecord): Promise<void>

  /**
   * Link an influencer to a contact: adds the contact to the influencer's
   * `influences` and the influencer to the contact's `influenced_by`.
   */
  linkInfluence(influencerId: string, contactId: string): Promise<void>
}
