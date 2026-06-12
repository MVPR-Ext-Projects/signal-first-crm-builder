# CRM adapters — choosing between HubSpot and Attio

Postgres is the system of record (see [ADR-010](./adr/010-crm-as-secondary-projection.md)). The CRM is a **secondary projection** — a mirror the system writes to best-effort so your team can work signals inside a tool they already live in. The whole funnel runs with `crmProvider: "none"` and no CRM at all.

Two adapters ship out of the box. You pick one **per workspace** via `WorkspaceConfig.crmProvider`. This doc covers how they differ and how to wire each.

| | `"hubspot"` | `"attio"` | `"none"` |
|---|---|---|---|
| Signal storage | Timeline event on the contact | Real record in a `signals` object | Postgres only |
| `createSignal()` returns | `null` (no record id) | the new `record_id` | — |
| Companies | Stubbed (throws if called) | First-class records | Postgres only |
| Enrichment write-back (`linkEnrichment`) | Noop (contact already patched) | Patches the signal record | — |
| Attribute addressing | Fixed HubSpot internal names + `propertyMap` overrides | `api_slug`s resolved via `resolveSlug(config)` | — |
| Auth | Private-app / OAuth access token | Workspace access token | — |

Both implement the same `CrmAdapter` interface (`packages/crm-adapters/src/adapter.ts`), so every call site (`createCrmAdapter(config)` in the Teamfluence webhook and the enrichment poller) is provider-agnostic. Switching providers is a config change, not a code change.

## Why they're shaped differently

HubSpot has no first-class "signal" object, so signals are logged as **timeline events** and the cumulative `signal_score` is patched onto a contact property. There's nothing to hand back, so `createSignal()` returns `null` and `linkEnrichment()` is a noop.

Attio is a **record database**. A signal is a real record in a custom `signals` object, linked to the person via a record-reference attribute. That record has an id, so `createSignal()` returns it and `linkEnrichment()` patches enrichment results back onto the same record once Surfe completes. Companies are first-class records too (the HubSpot adapter stubs them).

This is why the enrichment poller (`apps/web/lib/enrichment.ts`) branches: for HubSpot it patches the existing contact in place; for any record-based CRM it does find-or-create then `linkEnrichment()`.

## Configure: HubSpot

```jsonc
{
  "crmProvider": "hubspot",
  "hubspot": {
    "accessToken": "enc:<private-app-or-oauth-token>",
    "appId": "<app-id>",            // required to log timeline events
    "clientSecret": "enc:<secret>", // verifies X-HubSpot-Signature-v3 on inbound webhooks
    "propertyMap": {                // optional — only if the portal renamed properties
      "linkedinUrl": "hs_linkedin_url",
      "signalScore": "gtm_signal_score"
    }
  }
}
```

One-time HubSpot setup: register a custom Timeline Event template (`POST /crm/v3/timeline/event-templates`) and store the returned id in `propertyMap.timelineEventTemplateId`; create any custom contact properties (e.g. `gtm_signal_score`) the map references. Property defaults are in `resolveHubSpotProperties()`.

## Configure: Attio

```jsonc
{
  "crmProvider": "attio",
  "attio": {
    "accessToken": "enc:<attio-access-token>",
    "objects": {            // optional — only if you renamed the standard objects
      "people": "people",
      "companies": "companies",
      "signals": "signals"
    }
  },
  "slugs": { /* optional api_slug overrides — see below */ }
}
```

One-time Attio setup: provision a custom **`signals`** object whose attributes match the `api_slug`s in `resolveSlug()` (`apps/web/lib/workspace-config.ts`), and make sure the people/companies objects carry the custom attributes the sync writes (`signal_score`, `persona`, `funnel_stage`, engagement aggregates). If your workspace uses non-default slug names, override them under `slugs` — the defaults are applied by `resolveSlug()` and listed there.

The `enc:` prefix in the seed marks a value the seed script encrypts at rest (see [SCAFFOLD.md](../SCAFFOLD.md) step 9). `accessToken` round-trips through `encryptIfNeeded` / `decrypt` like every other tenant secret.

## Switching an existing workspace

`crmProvider` is read at adapter-construction time, so changing it takes effect on the next signal/enrichment write — no migration. Postgres already holds the full history, so the new CRM simply starts receiving mirrored writes from that point. Backfilling the new CRM with historical signals is a separate, manual job (none ships in the template).

If the factory returns `null` (provider set but credentials missing), writes silently skip the mirror and Postgres still records everything — exactly the `"none"` behaviour. Check `Settings → Integrations` if you expected mirroring and don't see it.

## Adding a third CRM (e.g. Salesforce)

1. Implement `CrmAdapter` in `packages/crm-adapters/src/salesforce-adapter.ts`.
2. Export it from `packages/crm-adapters/src/index.ts`.
3. Add `"salesforce"` to `WorkspaceConfig.crmProvider` and a config block + encrypt/decrypt round-trip in `apps/web/lib/workspace-config.ts`.
4. Add a branch to `createCrmAdapter()` (`apps/web/lib/crm/index.ts`).

The interface is the only contract the rest of the system knows about. If a CRM lacks a concept (HubSpot's missing signal object, say), return `null` / noop rather than throwing — keep the mirror best-effort so a CRM outage never blocks the Postgres write.
