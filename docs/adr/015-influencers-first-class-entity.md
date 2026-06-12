# 015 — Influencers are a first-class entity, many-to-many with prospects

**Status:** Accepted (intent); prospect-edge population + CRM provisioning incomplete

## Context

The funnel models prospects (`contacts`) and the companies they work at (`companies`). It did not model the people and organizations that hold *influence* over those prospects - the journalists they read, the publications and podcasts they trust, the founders they follow. That influence is exactly what the trust-nested PR loop trades on (see ADR-014, `docs/PR-LinkedIn-Measurement.md`): a prospect engages because a source they already trust vouched for you.

Until now "influence" existed only as a denormalized `contacts.influenced_by` JSONB array (entries `{ kind, name, … }`), populated by import scripts and rendered in the SDR "Influenced by" panel. That has two problems:

1. **No entity.** An influencer had no identity of its own - it was a blob embedded on each contact. You couldn't ask "who does this journalist influence?" or dedupe a publication across the prospects who follow it.
2. **One direction only.** You could read a prospect's influencers; you couldn't read an influencer's prospects.

An influencer is also heterogeneous: it can be a **person** (a journalist, or an individual a prospect follows) or an **organization** (a publication, news site, or podcast). And the relationship is many-to-many: a prospect is influenced by many influencers; an influencer influences many prospects.

## Decision

Promote influencers to a first-class entity with its own storage, separate from `contacts`.

- **`influencers` table.** `kind` is the structural class (`person` | `organization`, mapping cleanly onto a CRM Person/Company); `type` is the specific label (`journalist` | `publication` | `news_site` | `podcast` | `individual` | `other`). Dedup waterfall per workspace: `mvpr id > linkedin_url > domain > (type, name)`, mirroring the companies waterfall (ADR-002).
- **`influencer_influences` M2M join.** The edge between an influencer and a prospect, read in two named directions that match the field names used across the product and the CRM:
  - `influencer.influences`  -> the contacts an influencer influences
  - `contact.influenced_by`  -> the influencers influencing a prospect
- **`contacts.influenced_by` JSONB stays** as a denormalized read-cache for the existing SDR panel; the join table is the relational source of truth.
- **MVPR populates influencers.** On coverage sync, each coverage's journalist is upserted as `{kind: person, type: journalist}` and its publication as `{kind: organization, type: publication}` (domain derived from the article host). MVPR is the first writer; manual + import + engagement-derived are others.
- **The CRM mirrors it.** The `CrmAdapter` interface gains `findInfluencer` / `createInfluencer` / `updateInfluencer` / `linkInfluence`. Attio implements them against its `influencers` object, maintaining both `influences` (on the influencer) and `influenced_by` (on the person) multi-reference attributes. HubSpot has no influencer object, so its adapter throws loud stubs (consistent with its company-method stubs).

## Implementation status

What ships:
- `influencers` + `influencer_influences` in `schema.sql` and `scripts/migrate-add-influencers.mjs`.
- `lib/db/influencers.ts`: `upsertInfluencer` (waterfall), `linkInfluence`, `getInfluencedBy(contactId)`, `getInfluences(influencerId)`.
- MVPR sync upserts journalists + publications as influencers (`influencersUpserted` in the sync result + UI message).
- `AttioAdapter` influencer methods (real, with read-modify-write to keep both reference sides) and `HubSpotAdapter` stubs.

**Edge population (`lib/influence/edge-population.ts`).** Edges between an influencer and a prospect are drawn from several sources, each tagged with a `source`:

1. **Coverage engagement (trust-nested).** A prospect engages with coverage that's *wrapped* inside a marketing channel - a LinkedIn post/ad or a Resend email - typically delivered via a campaign. `linkCoverageInfluencers` / `linkCampaignCoverageInfluencers` draw the edge to that coverage's journalist + publication. **Wired** into `enrollContact` (campaign enrollment = exposure, `source: "campaign"`); a confirmed-engagement caller (reply/click) can re-link with `source: "engagement"` for a stronger edge.
2. **Social follows.** Scraping a prospect's profiles for who they follow. **Wired** into the LinkedIn-interests route (`source: "social_follow_linkedin"`) and the X/Twitter-interests route (`source: "social_follow_x"`) via `linkFollowedInfluencers` + the `linkedinInterests`/`xAccounts` mappers.
3. **Publication audience.** Scraping a publication/media page's followers and matching them to our contacts. `linkPublicationAudience` is **ready** (batch link); the follower-scrape that supplies the contact list is the external input.

Remaining gaps (consistent with how ADR-012/014 ship):
- **Instagram / Facebook follow scrapers aren't built.** Only LinkedIn + X interest routes exist today; `linkFollowedInfluencers` is source-agnostic, so an IG/FB route just maps its accounts and calls it.
- **Direct LinkedIn-post → coverage mapping.** Coverage-engagement edges currently route through *campaign* attribution (clean and wired). Mapping a raw Teamfluence `post_url` straight to a coverage piece still needs the post↔coverage table ADR-014 flags.
- **Publication-follower scrape source.** `linkPublicationAudience` is ready, but no scraper feeds it the follower list yet.
- **`influenced_by` JSONB ↔ join backfill.** A one-time script to project existing `contacts.influenced_by` blobs into `influencer_influences` (and regenerate the JSONB from the join) is not written.
- **CRM object provisioning.** The Attio `influencers` object + the `influences`/`influenced_by` attributes must exist in the workspace; the adapter assumes the default slugs. No provisioning/verify script ships (same gap as the Attio `signals` object).

## Consequences

**Upsides:**
- Influence is queryable in both directions; influencers dedupe across prospects.
- The same entity covers journalists, publications, podcasts, and individuals via `kind` + `type`.
- MVPR coverage now lands not just as a report but as influence-graph nodes, reinforcing the trust-nested model.
- The CRM mirror keeps the influence graph visible to teams working inside Attio.

**Downsides / watch-outs:**
- A human who is both a prospect and an influencer exists as a row in *both* `contacts` and `influencers`. That's intended (different roles), but downstream code must not assume one identity.
- `linkInfluence` on Attio is read-modify-write on a multi-reference attribute; concurrent writes to the same record could race. Acceptable at sync volumes; revisit if edges are written hot.
- The denormalized JSONB and the relational join can drift until the backfill/regeneration script exists. Treat the join as source of truth.

## Live-system note

This ADR and the code live in the generic export. Wiring the same entity into the live gtm-os deployment + provisioning the Attio `influencers` object/attributes in the real workspace is a separate step outside this repo.

## What would invalidate this decision

- Modelling influence as a property of companies only (e.g. only publications matter, never individuals) - then the entity collapses into `companies` with a flag. Rejected here because journalists and followed individuals are first-class influencers and aren't companies.
- A CRM-native influence object the platform owns end-to-end, making the Postgres projection redundant - then Postgres mirrors it rather than leads (as with the CRM generally, ADR-010).
