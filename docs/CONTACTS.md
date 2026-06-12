# Adding people

How contacts get into the system. The short answer: **mostly automatically, via signal-emitting webhooks.** The longer answer covers all five paths, plus the deliberate design choice that there is no "Add new contact" button in the dashboard.

---

## The default path: signals create contacts

The signal-first design (ADR-001, PHILOSOPHY.md) means the unit of truth is an event a real human performed. When an event arrives via a webhook, the handler does `findOrCreateContact(workspaceId, payload)` — if the contact already exists, it's matched on `crm_contact_id`, email, or LinkedIn URL; if not, a new row is appended.

This means the typical lifecycle of a contact is:

1. Someone follows your company on LinkedIn → Teamfluence webhook fires → contact is created with a `followed_our_company` signal.
2. Subsequent likes / comments / profile views land as further signals on the same contact (deduped via the identity match).
3. The contact's `signal_score` accumulates; their funnel stage progresses.
4. Eventually they cross your engagement threshold and appear at the top of the SDR view.

You don't manually add this person. They added themselves by engaging.

This is deliberate: a contact that exists in the system without a signal trail is, by definition, someone you're targeting blindly. The signal-first design discourages it.

## All five paths people can enter

### 1. Webhook ingest (the primary path)

Every webhook in `docs/WEBHOOKS.md` either creates a contact or matches against an existing one. The relevant verbs:

- **Teamfluence** → likes, comments, follows, profile views.
- **Dripify** → outbound automation events (sent connection request, accepted, sent DM).
- **Unipile** → inbound LinkedIn DM replies.
- **Calendly** → meeting bookings (the contact is the invitee).
- **Stripe** → payment events (the contact is the customer's billing contact, when resolvable).
- **HubSpot** → updates to existing contacts in HubSpot (rarely creates; mostly keeps the local projection fresh).
- **Resend** → email lifecycle events (the contact is the recipient).

The webhook handler is responsible for normalising whatever identifier the provider gave us (LinkedIn URL, email, CRM contact ID) into the local `contacts` row.

### 2. Wizard CSV upload (one-time, during onboarding)

The wizard's `/wizard/upload` step accepts a CRM-export CSV. The flow:

1. User uploads `crm_export.csv` via the Vercel Blob upload endpoint (`/api/wizard/upload`).
2. The next wizard step (analyzing → blueprint) parses the CSV and previews how it'd map to contacts.
3. On provision (`/wizard/provision`), each row is run through the dedup waterfall (ADR-002): the contact's company is resolved by `linkedin_url > domain > canonical_name`; the contact is upserted by `(workspace_id, crm_contact_id || email || linkedin_url)`.

This path exists for one purpose: getting an existing customer base into the new workspace. After onboarding, the wizard isn't the right tool to add more people — use signal ingestion instead.

### 3. Manual inline editing (correcting existing contacts)

`apps/web/app/dashboard/[workspaceId]/components/manual-contact-edit.tsx` provides an inline controlled form for fixing a contact's identity fields. Used from the SDR's pre-enrichment tab (when enrichment didn't return an email) and from the main SDR table (when a job title is stale or a LinkedIn URL has changed).

Crucially: this edits an EXISTING contact. It doesn't create a new one. Only fields the user changed are sent to the server; omitted fields stay as they are; empty string clears.

### 4. HubSpot inbound (CRM → us)

When a contact is updated in HubSpot (email changed, lifecycle stage updated), HubSpot's outbound webhook fires our HubSpot inbound handler. The handler updates the matching local contact's fields.

In rare cases — a contact who was created directly in HubSpot rather than via our outbound flow — the HubSpot webhook may receive an update for a contact we don't yet know about. The handler treats this as a create-on-first-update: it inserts a new local contact row keyed by the HubSpot `vid` (stored as `crm_contact_id`).

### 5. There is no "Add new contact" button in the dashboard

This is a design choice, not an oversight. A signal-first CRM where the seller adds contacts they "feel" should be in the pipeline re-introduces the bet the system was designed against (per ADR-001). The dashboard is for working contacts that arrived via signals, not for typing in names.

If you genuinely need to add a contact who hasn't yet emitted a signal — e.g. a referral from another customer — the right action is to add them to your outbound automation (Dripify) and let the connection request / first DM be the signal that creates them. Or manually trigger a `viewed_profile` or similar low-strength signal via a Teamfluence-style ingest if you want to track them without messaging yet.

This boundary will feel arbitrary to a seller coming from Salesforce. The justification is: every contact in the system has a verifiable engagement trail. That property is what makes the funnel auditable, the score honest, and the priority queue meaningful.

## Dedup behaviour on ingest

Contacts dedup on the identifier waterfall:

1. `crm_contact_id` — when the source provides one, it's authoritative.
2. `email` — case-insensitive, normalised.
3. `linkedin_url` — normalised to `linkedin.com/in/<slug>`.

If two of those identifiers collide (e.g. same email, different `crm_contact_id`), the system keeps the existing row and merges the new identifier in. The merge logic lives in `apps/web/lib/db/contact-store.ts` under `findOrCreateContact` and the dedicated merge endpoint at `/api/dashboard/[workspaceId]/contacts/[contactId]/merge/route.ts` (for manual merges when the automated dedup didn't catch a duplicate).

## What happens to the company when a contact is created

Per ADR-002, every contact gets `gtm_company_id` populated from day one. The webhook payload's company fields (LinkedIn URL, domain, name) feed the dedup waterfall on the `companies` table. The contact is then linked.

If two contacts at the same company arrive seconds apart, the unique partial indexes on `(workspace_id, linkedin_url)` and `(workspace_id, domain)` resolve the race: only one company row exists; both contacts FK into it.

## Footguns

- **Don't bulk-insert contacts without running them through the dedup waterfall.** Bypassing the waterfall produces duplicate companies, which cascades to wrong groupings in reports.
- **Don't write a backfill script that creates contacts without signals.** It looks innocent but it pollutes the audit trail — a contact with zero signals is invisible to the SDR's "what should I do today" query, and that's correct behaviour, but means your backfill produced contacts no one will work.
- **Don't conflate the wizard `/upload` flow with ongoing imports.** The wizard is one-time. Repeated imports from a CRM export will keep creating duplicate companies if the export uses inconsistent name normalisation (e.g. "Acme, Inc." one week, "Acme Inc" the next). The dedup waterfall catches most of this via LinkedIn URL and domain, but only if those columns are populated in the export.

## Common operations

### Bulk-add a CSV after the wizard

Not natively supported. Two options:
1. Write a one-off script under `scripts/` that reads the CSV and calls `findOrCreateContact` per row. Pattern is similar to the wizard's provision step (`apps/web/app/wizard/provision/page.tsx`).
2. If the CSV represents an existing CRM, import it into HubSpot first; HubSpot's webhook will sync it into the local projection over time.

### Trace a contact's origin

The `signals` table for that contact, sorted by `occurred_at ASC`. The first row tells you which webhook created them. If there are no signals, they were created by the wizard or by a HubSpot inbound update.

### Manually mark a contact as "do not contact"

Use the DNC affordance in the SDR view (the controls in `lead-table-row.tsx`). Setting DNC manually is distinct from the automatic DNC on bounce / "not interested" reply — both end up in the same columns (`do_not_contact`, `do_not_contact_source = 'manual'`).

### Permanently exclude a contact

Use the Exclude action (different from DNC — see GLOSSARY's DNC and Exclude entries). Exclude is permanent; DNC is time-bounded.
