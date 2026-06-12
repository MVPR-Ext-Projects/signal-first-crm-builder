/**
 * createCrmAdapter — factory that returns the right CrmAdapter for a workspace.
 *
 * Usage:
 *   const adapter = createCrmAdapter(config)
 *   if (!adapter) throw new Error("CRM not configured")
 *
 *   const contactId = await adapter.findContactByEmail(email)
 *     ?? await adapter.createContact(enrichedContact)
 *   await adapter.recordSignal(signal, contactId, enrichedContact)
 */

import type { WorkspaceConfig } from "../workspace-config"
import { resolveHubSpotProperties, resolveSlug } from "../workspace-config"
import type { CrmAdapter } from "@gtm/crm-adapters"
import { HubSpotAdapter, AttioAdapter } from "@gtm/crm-adapters"

export type { CrmAdapter }
export type { EnrichedContact, SignalData } from "@gtm/crm-adapters"

export function createCrmAdapter(config: WorkspaceConfig): CrmAdapter | null {
  const provider = config.crmProvider ?? "hubspot"

  if (provider === "hubspot") {
    if (!config.hubspot?.accessToken) return null
    return new HubSpotAdapter(
      config.hubspot.accessToken,
      resolveHubSpotProperties(config),
      config.hubspot.appId ?? "",
    )
  }

  if (provider === "attio") {
    if (!config.attio?.accessToken) return null
    return new AttioAdapter(
      config.attio.accessToken,
      resolveSlug(config),
      config.attio.objects,
    )
  }

  return null
}
