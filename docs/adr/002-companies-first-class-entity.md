# 002 — Companies as a first-class entity (with deterministic dedup waterfall)

**Status:** Accepted

## Context

Early in gtm-os's life, companies were modelled as a grouping over the `contacts` table: `SELECT company_name, COUNT(*) FROM contacts GROUP BY workspace_id, company_name`. There was no `companies` table; company-level metadata lived in side tables (`company_tags`, `company_enrichments`) keyed on `(workspace_id, company_name)`.

That approach had real costs: "Acme APAC" and "Acme" became two separate companies in the dashboard. Filters, scoring, and cross-contact aggregation all suffered.

The decision below promoted companies to a first-class entity. This template ships with that decision already implemented — fresh installs get the new model from day one, with `contacts.gtm_company_id` populated by every webhook on first contact.

## Decision

Companies are a first-class entity (`companies` table). Identity is resolved by a deterministic dedup waterfall, evaluated in order:

1. `linkedin_url` (normalised to `linkedin.com/company/<slug>`)
2. `domain` (lowercase, no `www`, no protocol)
3. `canonical_name` (lowercase, trimmed, legal-suffixes stripped)

Race protection: unique partial indexes on `(workspace_id, linkedin_url)` and `(workspace_id, domain)` (where the column is non-NULL) let the DB resolve concurrent inserts via `INSERT ... ON CONFLICT DO NOTHING` + re-SELECT.

`contacts.gtm_company_id` is the FK. Parent/child relationships supported via `parent_company_id` (e.g. "Acme APAC" → "Acme"), set by a separate heuristic or human review, not by the waterfall.

`crm_company_id` caches the CRM-native company record ID so future syncs don't fall back to fuzzy matching.

## Note on the parent gtm-os repo

The gtm-os repo from which this template was forked is mid-migration: the `companies` table exists and is populated, but some dashboard views and side tables (`company_tags`, `company_enrichments`) still key on `(workspace_id, company_name)` for legacy contacts that pre-date the dedup waterfall.

**This is not a concern for fresh installs.** Every new contact gets `gtm_company_id` populated from day one. You won't have legacy `company_name`-only rows unless you import data from a previous CRM, in which case run the dedup waterfall against the import as part of the seeding.

The remaining `company_tags` / `company_enrichments` bridge tables (keyed on `company_name`) are technical debt being phased out upstream. The template inherits them, but in a fresh install they'll be populated alongside `gtm_company_id` correctly. New code should always use `gtm_company_id` as the canonical key.

## Consequences

**Upsides:**
- Race-safe dedup at write time prevents most "Acme" vs "Acme APAC" duplication.
- Parent/child relationships finally have a place to live.
- Cross-contact aggregation (company-level scoring, account-based motions) works because there's a real entity to aggregate on.

**Downsides:**
- The dedup waterfall depends on data quality. A contact arriving with no LinkedIn URL or domain falls to the canonical-name step, which can still produce duplicates if names differ slightly.
- Side tables still key on `company_name` in some places. New code should not bake `(workspace_id, company_name)` deeper into the system. If you must use `company_name` (joining to a side table that still keys on it), leave a `// TODO(companies-table-migration)` comment so the eventual cleanup can find every site.

## Guidance for new code

- New code that needs a canonical company key: use `contacts.gtm_company_id`.
- When ingesting a new signal source, populate the company's `linkedin_url` or `domain` if at all available — that's what makes the waterfall converge to a single canonical row.
- Don't assume `company_name` is unique. It isn't.

## What would invalidate this decision

- An entity-resolution service or library that handles "Acme APAC" vs "Acme" reliably enough to make the waterfall unnecessary.
- A switch in CRM provider where company is no longer secondary to contact in the source-of-truth model.
