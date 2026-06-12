/**
 * Shared types for the CRM adapter layer.
 *
 * EnrichedContact: normalised contact data returned by any enrichment provider
 *   (Surfe, Clay, Apollo). Adapters consume this to write to their CRM.
 *
 * SignalData: normalised signal event, passed to recordSignal() so the adapter
 *   can decide how to persist it (e.g. HubSpot logs a timeline event on the
 *   contact). Per-CRM persistence shape is the adapter's concern.
 */

export interface EnrichedContact {
  firstName?: string
  lastName?: string
  fullName?: string
  email?: string
  phone?: string
  jobTitle?: string
  companyName?: string
  linkedinUrl?: string
  /** LinkedIn URN ("ACoAAA..."). Stable id, populated by enrichment providers that surface it (Surfe, Unipile relations). */
  linkedinMemberId?: string
  avatarUrl?: string
  location?: string
  /**
   * Effective persona name (manual override or auto-classified). Used by
   * the gtm-os -> CRM sync to populate the persona attribute on the
   * person record.
   */
  persona?: string
  /** Effective funnel stage (manual override or derived). */
  funnelStage?: string
  /** Total signal score on the contact (cumulative engagement). */
  signalScore?: number
  /** Total signal count on the contact. */
  signalCount?: number
}

/**
 * Normalised company shape consumed by the adapter's company methods.
 * Mirrors the gtm-os companies table plus per-company aggregates the
 * sync-to-CRM path computes from joined contact rows.
 */
export interface CompanyData {
  /** Display name. Canonical company name in the CRM. */
  name:           string
  /** Registrable domain (lowercase, no www). */
  domain?:        string
  /** Optional - bucket name from the workspace's CRM select options. */
  employeeRange?: string
  /** Highest funnel stage across associated contacts. */
  funnelStage?:   string
  /** Prospect type label (e.g. "Software", "Investor"). */
  prospectType?:  string
  /** Sum of associated contacts' signal_score. */
  engagementScore?: number
  /** Sum of associated contacts' signal_count. */
  signalsCount?:    number
}

export interface SignalData {
  /** CRM-native ID of the signal record (e.g. HubSpot timeline event ID). */
  signalId: string
  sourceType?: string
  engagementUrl?: string
  score?: number
  teamfluenceCrmId?: string
}

/**
 * Normalised influencer shape. An influencer is a person (journalist, an
 * individual a prospect follows) or an organization (publication, news site,
 * podcast) with influence over prospects. Mirrors the gtm-os influencers table.
 * The adapter maps `kind` onto the CRM's person/company-style record.
 */
export interface InfluencerRecord {
  kind:        "person" | "organization"
  /** journalist | publication | news_site | podcast | individual | other */
  type:        string
  name:        string
  linkedinUrl?: string
  domain?:     string
  twitterUrl?: string
  website?:    string
}

/** Legacy slug mapping (Attio-style object/attribute api_slug values). Kept for
 *  workspaces still carrying customised slugs in their config. All defaults applied. */
export interface ResolvedSlugs {
  signalPersonRef: string
  signalLinkedinUrl: string
  signalEmail: string
  signalFirstName: string
  signalLastName: string
  signalJobTitle: string
  signalSourceType: string
  signalScore: string
  signalTeamfluenceCrmId: string
  signalEngagementUrl: string
  signalSourceContent: string
  personAllSignals: string
  personSignalCount: string
  personEngagementScore: string
  personCompanyRef: string
  personLinkedin: string
  personEmail: string
  personJobTitle: string
  personAvatarUrl: string
  personLocation: string
  /**
   * Person attribute slug for the workspace's persona classification.
   * Defaults to "persona". Used by sync-to-CRM to write the effective
   * persona onto the person record.
   */
  personPersona: string
  funnelStage: string
  // Company slugs (manual gtm-os -> CRM sync).
  companyName:            string
  companyDomains:         string
  companyEmployeeRange:   string
  companyFunnelStage:     string
  companyProspectType:    string
  companyEngagementScore: string
  companySignalsCount:    string
}

/** HubSpot property name mapping — all defaults applied */
export interface ResolvedHubSpotProperties {
  linkedinUrl: string
  jobTitle: string
  signalScore: string
  funnelStage: string
  timelineEventTemplateId: string
}
