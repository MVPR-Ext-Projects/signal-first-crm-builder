---
description: Scaffold a new inbound webhook handler that ingests signals from a third-party source.
---

You are helping the user wire up a new inbound webhook. The end result is a new route under `apps/web/app/api/webhooks/[workspaceId]/<source>/route.ts` that verifies signatures, normalises the payload, resolves a contact, appends a signal, and (conditionally) pushes to the configured CRM.

## What you need from the user

Ask one at a time, plain text:

1. **The source name** — short slug, e.g. `intercom`, `pendo`, `segment`, `customerio`. Used in the URL path and config key.
2. **The auth model** — HMAC signature in header (most common), bearer token, query-param secret, or workspace-id-in-path (no shared secret, like Teamfluence). If unsure, link them to the provider's docs.
3. **The signal verbs this source will emit** — list them. If verbs aren't in the existing enum, suggest running `/add-signal-verb` first for each new one.
4. **Whether signals from this source push to the CRM** — yes (like Teamfluence) or no (like Dripify). See `docs/adr/003-dripify-teamfluence-asymmetry.md` for the framework. Default to no for outbound-automation sources; yes for prospect-behaviour sources.

## Scaffold the route

Create `apps/web/app/api/webhooks/[workspaceId]/<source>/route.ts` following this skeleton (adapt to the auth model):

```ts
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { decrypt } from "@/lib/workspace-config"
import { findOrCreateContact, appendSignal } from "@/lib/db/contact-store"
import { createCrmAdapter } from "@/lib/crm"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params
  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Workspace not found" }, { status: 404 })

  // 1. Verify signature (or auth model of choice)
  // const sig = req.headers.get("x-<source>-signature")
  // ...

  // 2. Parse payload
  const payload = await req.json()

  // 3. Resolve contact
  const contact = await findOrCreateContact(workspaceId, {
    crmContactId: payload.contactId,
    email: payload.email,
    linkedinUrl: payload.linkedinUrl,
    // ... map source-specific fields
  })

  // 4. Append signal
  await appendSignal(workspaceId, {
    contactId: contact.id,
    signalVerb: "<verb-from-mapping>",
    signalActor: payload.actorName,
    signalObject: payload.objectName,
    verbDescription: payload.url ?? payload.text,
    occurredAt: new Date(payload.timestamp),
  })

  // 5. (If pushing to CRM) Forward to HubSpot
  // const adapter = createCrmAdapter(config)
  // if (adapter) await adapter.createSignal(contact.crmContactId, ...)

  return NextResponse.json({ ok: true })
}
```

## Add the webhook secret

If the auth uses HMAC: add `<source>` to `WorkspaceConfig.webhookSecrets` (encrypted at rest). Update:
- The type definition in `apps/web/lib/workspace-config.ts`
- The encryption round-trip helpers (add the new key to the `enc:`-prefixed paths)
- The dashboard settings UI at `/settings/webhooks` so the user can paste the secret
- `scripts/seed-workspaces.mjs` if the secret should be seedable

## CRM push decision

If signals from this source SHOULD push to HubSpot, include the `adapter.createSignal(...)` call. Don't hardcode HubSpot — use `createCrmAdapter(config)` which routes to whatever CRM is configured.

If signals from this source should NOT push, leave the comment in place explaining why. (Reference `docs/adr/003-dripify-teamfluence-asymmetry.md`.)

## Pre-commit eval (for this change)

- Multi-tenancy: every query in the route scopes by `workspaceId`? ✓
- Webhook secret round-trips through encryption? ✓
- Verb is in the schema comment + verb model + label map? ✓
- CRM push decision is intentional + documented in the route's header comment? ✓
- Provider's docs URL is referenced in the route's header for future maintainers? ✓
