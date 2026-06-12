// Adapter interface and types
export type { CrmAdapter } from "./adapter"
export type { EnrichedContact, SignalData, CompanyData, InfluencerRecord, ResolvedSlugs, ResolvedHubSpotProperties } from "./types"

// Adapter implementations
export { HubSpotAdapter } from "./hubspot-adapter"
export { AttioAdapter, type AttioObjectSlugs } from "./attio-adapter"
