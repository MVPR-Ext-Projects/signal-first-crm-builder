/**
 * Per-workspace config — stored in Upstash Redis, keyed by workspaceId.
 *
 * Each provisioned workspace gets a config entry that holds:
 *   - Their CRM access token (HubSpot in this template; set during OAuth/provisioning)
 *   - Enrichment API keys (Surfe, Clay, Apollo) — added by the client
 *   - Webhook secrets per tool — for HMAC verification
 *   - HubSpot property name overrides — if their portal uses non-standard names
 *   - Custom scoring thresholds
 *
 * Canonical slug names (signal projection columns):
 *   signals.person_with_signal    — record-reference to Person
 *   signals.source_type           — what the person did (Teamfluence event label)
 *   signals.signal_score          — score contribution of this single event
 *   signals.teamfluence_crm_id    — Teamfluence lead ID for writeback
 *   signals.teamfluence_engagement_url — URL of the LinkedIn post/page engaged with
 *   people.all_signals            — multi-ref to all Signal records for this person
 *   people.signal_count           — number of signals recorded
 *   people.people_engagement_score — cumulative engagement score
 */

import { Redis } from "@upstash/redis"
import { encryptIfNeeded, decrypt } from "./encrypt"
import type { ResolvedSlugs, ResolvedHubSpotProperties } from "@gtm/crm-adapters"

export type { ResolvedSlugs, ResolvedHubSpotProperties }

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * HubSpot property name overrides.
 * Defaults cover the standard HubSpot internal names + common custom properties.
 * Only set overrides when the portal uses non-standard property names.
 */
export interface HubSpotPropertyMap {
  linkedinUrl?: string
  jobTitle?: string
  signalScore?: string
  funnelStage?: string
  timelineEventTemplateId?: string
}

export function resolveHubSpotProperties(config: WorkspaceConfig): ResolvedHubSpotProperties {
  const p = config.hubspot?.propertyMap ?? {}
  return {
    linkedinUrl:             p.linkedinUrl             ?? "hs_linkedin_url",
    jobTitle:                p.jobTitle                ?? "jobtitle",
    signalScore:             p.signalScore             ?? "gtm_signal_score",
    funnelStage:             p.funnelStage             ?? "gtm_funnel_stage",
    timelineEventTemplateId: p.timelineEventTemplateId ?? "",
  }
}

export interface WorkspaceConfig {

  workspaceId: string
  name?: string

  /** Contact email for this workspace (used for admin notifications). */
  adminEmail?: string

  /**
   * Which CRM this workspace mirrors to. Postgres is always the system of
   * record; the CRM is a secondary projection (see ADR-010). Two adapters ship
   * out of the box — "hubspot" and "attio" — plus "none" to run CRM-free.
   * Defaults to "hubspot". See docs/CRM-ADAPTERS.md for how to choose.
   */
  crmProvider?: "hubspot" | "attio" | "none"

  /** Teamfluence Feed API credentials (personal JWT key + profile ID) */
  teamfluenceApiKey?: string
  teamfluenceProfileId?: string

  /** MCP HTTP endpoint scoped to this client's workspace */
  mcpUrl?: string

  /**
   * MVPR PR platform REST API credentials. Used to pull press coverage +
   * announcements into the CRM's PR section. Optional — workspaces without
   * an MVPR account just skip the integration.
   *
   * Each workspace's baseUrl embeds their own MVPR company id (e.g.
   * `https://prd-message-opportunity-domain-service-.../api/v1/companies/<id>/`),
   * so users paste the full URL from MVPR's API docs. apiKey is encrypted
   * at rest via the standard `enc:` prefix roundtrip.
   *
   * Adapter:   apps/web/lib/mvpr.ts
   * Sync cron: /api/cron/mvpr-coverage-sync (every 6h)
   */
  mvpr?: {
    apiKey:  string
    baseUrl: string
  }

  /**
   * LinkedIn profile URLs of the workspace's own employees. Webhook events
   * where the engager matches one of these are dropped — without this filter,
   * cross-engagement between teammates clutters the SDR queue.
   * Stored as plain strings (these are public LinkedIn URLs, not secrets).
   */
  internalLinkedinUrls?: string[]

  /**
   * Email domains owned by the workspace. Applied after Surfe enrichment —
   * anyone whose verified email is in one of these domains is treated as
   * internal and purged. Catches employees the URL-based filter doesn't know
   * about.
   */
  internalEmailDomains?: string[]

  /**
   * Company names owned by the workspace. Applied post-enrichment alongside
   * internalEmailDomains. Case-insensitive substring.
   */
  internalCompanyNames?: string[]

  /**
   * Email addresses of agency / non-customer team members whose Teamfluence
   * profiles are tracked under the same TF account but should NOT contribute
   * signals to this workspace. Matched against `team_member_email` on the
   * Teamfluence webhook payload (case-insensitive). Common case: an agency
   * operator's profile is tracked alongside a customer's profile under the
   * customer's TF account; events for the operator's profile leak into the
   * customer workspace unless filtered here.
   */
  agencyTeamMemberEmails?: string[]

  /**
   * Team members for the Team Filters UX. No login/auth — these are saved
   * names that map to manual SDR-to-company assignments. The Companies
   * page exposes an inline picker per row (writes to
   * company_tags.assigned_team_member_id); the SDR / Companies pages then
   * filter by ?team=<id> against that same column.
   *
   * Each member has a stable id (used in URLs + on
   * company_tags.assigned_team_member_id) and a display name.
   */
  teamMembers?: Array<{
    id:    string
    name:  string
  }>

  /**
   * Editable list of Prospect Type tag values shown on the Companies dashboard.
   * Each company can carry zero or more of these values (multi-value). Values
   * are stored on the `company_tags` Postgres table.
   *
   * Default values: ["Investor","Software","Services","Partner","Excluded"].
   * Edited by users in Settings → Prospect types.
   */
  prospectTypes?: string[]

  /**
   * Tag values that are pre-unchecked on the Companies page chip filter.
   * Companies tagged exclusively with one of these values do not appear on
   * first load; the user must tick the chip to see them. Multi-tagged
   * companies still appear under any other ticked chip.
   *
   * Default: ["Excluded"]. The lighter default (only Excluded) lets users
   * discover the filter system by tagging their first companies as Excluded
   * and watching them disappear.
   */
  defaultExcludedProspectTypes?: string[]

  /**
   * ICP group definitions. Each contact gets classified into one of these
   * (or null if no match) at write time, based on company name + industries.
   * Used as a visible pill in the SDR dashboard so SDRs can quickly tell what
   * playbook to apply.
   */
  icpGroups?: {
    name: string
    keywords: string[]   // case-insensitive substrings of company_name
    industries?: string[] // exact-match on TF industry tags
    color?: "amber" | "violet" | "rose" | "emerald" | "blue" | "sky" | "teal"
  }[]

  /**
   * Whitelist of source_type values that show in the Signals page filter
   * dropdown. When unset, every source_type present in the workspace's
   * signals appears. Useful for noisy workspaces where the workspace
   * accumulates many auto-tagged source values that aren't meaningful
   * to filter on. Filtering still operates over ALL signals — this is
   * just a UI-side narrowing of the dropdown options.
   */
  signalSourceWhitelist?: string[]

  /**
   * Pre-enrichment exclusion rules. When auto-enrichment is active, contacts
   * matching any of these are skipped (stay in queue, no Surfe credits spent).
   * Manual enrichment via the dashboard always overrides — this is a default
   * gate, not a hard wall.
   */
  exclusionRules?: {
    /** Exclude if company.employees_num_max < this */
    minEmployees?: number
    /** ISO country codes that are *allowed*. If set, anyone outside this list is excluded. */
    targetCountries?: string[]
    /** TF industry tags that disqualify (case-insensitive) */
    excludeIndustries?: string[]
    /** company.company_type values that disqualify */
    excludeCompanyTypes?: string[]
  }

  // ── HubSpot ──────────────────────────────────────────────────────────────────
  /** Required when crmProvider is "hubspot". */
  hubspot?: {
    /** Private App token or OAuth access token */
    accessToken: string
    /** OAuth refresh token — only needed for multi-tenant OAuth installs */
    refreshToken?: string
    /** HubSpot portal/account ID */
    portalId?: string
    /** HubSpot app ID — required for logging timeline events */
    appId?: string
    /**
     * App client secret — used to verify X-HubSpot-Signature-v3 on inbound webhooks.
     * Found in HubSpot → App → Auth → Client secret.
     */
    clientSecret?: string
    /** Override default property names */
    propertyMap?: HubSpotPropertyMap
  }

  // ── Attio ──────────────────────────────────────────────────────────────────
  /**
   * Required when crmProvider is "attio". Attio is a record database, so unlike
   * HubSpot it stores each signal as a real record (createSignal returns a
   * record_id) and treats companies as first-class records. Attribute names are
   * api_slugs resolved through `slugs` / resolveSlug() — only override `objects`
   * if the workspace renamed the standard people/companies objects or uses a
   * non-default slug for the custom signals object. See docs/CRM-ADAPTERS.md.
   */
  attio?: {
    /** Attio access token (workspace-scoped), encrypted at rest. */
    accessToken: string
    /** Object api_slug overrides. Defaults: people / companies / signals. */
    objects?: {
      people?:    string
      companies?: string
      signals?:   string
    }
  }

  // ── Stripe (revenue ingestion) ───────────────────────────────────────────────
  /**
   * Per-workspace Stripe connection for pulling revenue data (customers,
   * subscriptions, payments) into gtm-os. Drives the LTV / NDR / ACV
   * dashboards and the auto-Customer-Won funnel transition on first payment.
   *
   * apiKey is a restricted Stripe API key (read access to customers /
   * subscriptions / invoices / balance_transactions is sufficient).
   * webhookSecret verifies the Stripe-Signature header on inbound webhooks.
   * Both are encrypted at rest via encryptIfNeeded / decrypt.
   *
   * Inbound webhook: /api/webhooks/[workspaceId]/stripe.
   * Daily reconcile cron: /api/cron/stripe-reconcile.
   */
  stripe?: {
    /** Restricted API key, encrypted at rest. */
    apiKey: string
    /** Which Stripe environment this key targets. */
    mode: "test" | "live"
    /**
     * Stripe webhook signing secret (starts with whsec_). Required for
     * production deployments so the webhook handler can verify the
     * Stripe-Signature header. Encrypted at rest.
     */
    webhookSecret?: string
  }

  enrichment?: {
    surfe?: { apiKey: string }
    clay?: { apiKey: string }
    apollo?: { apiKey: string }
    /**
     * Moz API credentials. Used by the Companies tab to fetch domain
     * authority, backlinks, and referring-domain counts on prospects.
     * apiKey is encrypted at rest.
     */
    moz?: {
      apiKey: string
    }
    /**
     * Apify token used by the Companies tab to fetch employees of a company
     * via a LinkedIn employee scraper. Optional — only required to use the
     * "Fetch employees" action.
     */
    apify?: {
      apiToken: string
      /** Defaults to apimaestro~linkedin-company-employees-scraper-no-cookies */
      actorId?: string
      /** Defaults to 30. Cap to keep per-call cost predictable. */
      maxEmployees?: number
      /**
       * Apify actor used by the per-contact "Fetch interests" (LinkedIn) action.
       * No default — apimaestro doesn't publish a profile-following scraper as
       * of 2026-05. Configure with whichever actor you trust. The parser is
       * field-name tolerant (topVoices / influencers / followedInfluencers /
       * companies / followedCompanies / groups / newsletters all sniffed).
       */
      interestsActorId?: string
      /**
       * Cap on items returned per X-interests fetch. Defaults to 1000.
       * The X actor itself is hardcoded (apidojo/twitter-scraper-lite) — no
       * per-workspace override since picking actors was confusing for users.
       */
      xInterestsMaxResults?: number
    }
  }

  /**
   * Outbound messaging providers. Used by the "Send LinkedIn DM" action on
   * each lead. Workspace owners connect their own LinkedIn through the
   * provider's hosted-auth flow and paste the resulting credentials here.
   */
  messaging?: {
    /**
     * Unipile — unified messaging API. Required for sending LinkedIn DMs from
     * the dashboard. The DSN is the per-tenant base URL Unipile assigns
     * (e.g. https://api6.unipile.com:13670), accountId is the connected
     * LinkedIn account inside Unipile.
     */
    unipile?: {
      apiKey: string
      dsn: string
      accountId: string
      /**
       * Max LinkedIn connection invitations the worker may send from this
       * account in a rolling 24h window. Enforced by the queue worker:
       *   COUNT(*) FROM linkedin_invite_queue
       *   WHERE workspace_id = $1 AND sent_at > now() - interval '24 hours'
       *   < dailyInviteCap
       * before claiming the next 'queued' row.
       *
       * LinkedIn caps are unpublished and account-quality dependent; observed
       * soft ceilings are ~100/week (standard) to ~200/week (long-standing or
       * Premium). A sustained 15-25/day spread across business hours is the
       * safe zone; >50/day approaches the daily ceiling and risks a temporary
       * restriction. Omitted/undefined falls back to a conservative built-in
       * default (20/day) so a fresh workspace doesn't torch its account.
       */
      dailyInviteCap?: number
    }
    /**
     * Free-text positioning the LLM uses when drafting DMs. Used as the
     * fallback when no persona matches the contact. Should describe what the
     * workspace sells, who they sell to, and the tone they want.
     */
    outreachContext?: string
    /**
     * Email-freshness threshold in days (Task #22). The daily cron at
     * /api/cron/email-freshness flips corporate_email_status from
     * 'confirmed' to 'stale' once a contact's
     * corporate_email_confirmed_at is older than this. Stale contacts
     * surface on the Enrichment Candidates page for a re-enrichment
     * pass. Defaults to 365 when unset.
     */
    emailFreshnessDays?: number
    /**
     * Free-text rules about outreach pacing — how quickly to escalate from
     * informational/relationship-building messages to messages with a clear
     * CTA (e.g. "stay informational for the first 2 messages, then ask for
     * a 15-min call once they've engaged twice"). Fed into the draft-DM
     * (and future draft-email) prompt so the LLM matches the workspace's
     * outbound rhythm.
     */
    outreachPrinciples?: string
    /**
     * Workspace-level "corporate voice" fingerprint - the 63-dim StyleProfile
     * generated from positive samples the user pastes into the Company
     * Messaging settings page. Combined with the (channel, persona)
     * fingerprint at draft time to produce the unified voice for an
     * outbound message. Stored unencrypted - it's not sensitive. Generated
     * via apps/web/lib/style/generator.ts. See the cozy-tiger plan.
     */
    companyFingerprint?: import("./style/types").StyleProfile
    /**
     * Reusable message templates the LLM draws from when drafting a DM.
     * Each template has an optional set of tags — when the lead's persona /
     * stage / prospect type overlaps any non-empty tag list, the template
     * is "in scope" and gets fed into the prompt as reference material.
     * Templates with all-empty tags act as general-purpose fallbacks.
     *
     * Saved on WorkspaceConfig so the drafting pipeline reads them without
     * a separate DB round-trip.
     */
    templates?: Array<{
      id:             string
      title:          string
      body:           string
      personas?:      string[]
      stages?:        string[]
      prospectTypes?: string[]
    }>
    /**
     * Per-persona DM context. The /draft-dm endpoint picks the best-fit
     * persona for a contact at draft time (by matching the contact's
     * job_title against `matchPatterns` and optionally narrowing by
     * `matchIcpGroups`), then feeds that persona's blocks into the LLM
     * instead of the generic outreachContext. First match wins; declare
     * the most-specific personas first.
     */
    personas?: Array<{
      // ── Identity ──────────────────────────────────────────────────────
      /**
       * Stable UUID assigned on creation. Optional in the persisted shape
       * for back-compat with personas saved before stable IDs landed -
       * scripts/migrate-persona-stable-ids.mjs backfills missing ones, and
       * the Company Messaging page hydrates on load so every in-memory
       * persona has an id. Required by anything keyed on
       * (workspace_id, persona_id), notably style_fingerprints +
       * style_samples (cozy-tiger plan).
       */
      id?:                string
      /** Display label (e.g. "The Stretched Startup Comms Lead"). */
      name:               string
      /** Which product/service this persona is interested in buying (e.g. "PR Services", "PR Operating System"). */
      product?:           string
      /** Canonical "this is what they sound like" customer quote. */
      headlineQuote?:     string

      // ── Match rules ───────────────────────────────────────────────────
      /** Case-insensitive substrings of the contact's job_title — also "Job titles" in the UI. Empty = match anything. */
      matchPatterns:      string[]
      /**
       * Optional company-size band. When set, the contact's company-size
       * range (Teamfluence employees_min / employees_max) must fall inside
       * this band — strict, so a contact missing size data won't match a
       * persona that requires it. A 5–50-person startup persona uses
       * minEmployees=undefined, maxEmployees=50.
       */
      minEmployees?:      number
      maxEmployees?:      number
      /**
       * Optional ISO-2 country code allow-list. When set, the contact's
       * company_country must be one of these. Empty array = no filter.
       */
      matchCountries?:    string[]
      /**
       * @deprecated — persona match-by-ICP-group was removed because the
       * Teamfluence-classified icp_group surfaced confusing filters. Field
       * stays as optional so old persona records still parse, but it is
       * intentionally unused at match time and hidden from the UI.
       */
      matchIcpGroups?:    string[]

      // ── Description ───────────────────────────────────────────────────
      /** Long-form paragraph — who this persona is. */
      whoTheyAre?:        string
      /** 4–6 short trait bullets. */
      characteristics?:   string[]

      // ── Jobs to be done ───────────────────────────────────────────────
      /** Single statement of the core job. */
      primaryJob?:        string
      /** Secondary jobs / "also needs to" bullets. */
      jobsToBeDone?:      string[]
      /** Paragraph — the emotional / identity outcome they want. */
      emotionalJob?:      string

      // ── Value ─────────────────────────────────────────────────────────
      /** Bullet-list value props — supersedes the legacy single-string valueProp. */
      valueProps?:        string[]
      /** Concrete pains this persona has. */
      painPoints?:        string[]
      /** What they actually want — what success looks like for them. */
      desiredOutcomes?:   string[]
      /** Customer logos / case studies / quotes that resonate with this persona. */
      proofPoints?:       string[]
      /** Optional bullet list — explicit goals/objectives (overlaps with desiredOutcomes; both are fine). */
      objectives?:        string[]
      /** Optional bullet list — adjacent opportunities or upsell angles. */
      opportunities?:     string[]

      // ── Buying signals ────────────────────────────────────────────────
      /** Pushback we typically hear from this persona. */
      commonObjections?:  string[]
      /** Asks that work — calls to action that have landed before. */
      ctas?:              string[]
      /** Disqualifiers that say "this contact is NOT this persona" — useful for matching guard rails. */
      redFlags?:          string[]

      // ── Voice ─────────────────────────────────────────────────────────
      /** Themes / quotes from real customer calls that capture how the persona talks. */
      voiceOfCustomer?:   string[]
      /** Phrases this persona uses when describing value (5-ish). */
      valueLanguage?:     string[]

      // ── Selling principles ────────────────────────────────────────────
      /** Paragraph — how to position the product to this persona. */
      positioning?:       string
      /** Tone hints — how the message should sound. */
      language:           string
      /** Do/don't bullets on what makes a good DM (or email) to this persona. */
      dmPrinciples:       string
      /** Paragraph — what causes this persona to churn after they've bought. */
      churnRisk?:         string

      // ── Legacy ────────────────────────────────────────────────────────
      /** @deprecated — replaced by valueProps (string[]). Read fallback only. */
      valueProp?:         string
    }>
  }

  webhookSecrets?: {
    teamfluence?: string
    dripify?: string
    /** Shared secret echoed back in the `Unipile-Auth` header on incoming
     *  Unipile webhooks. Configure both ends with the same value: this
     *  field in WorkspaceConfig, and the `headers` block when registering
     *  the webhook URL via Unipile's API. */
    unipile?: string
    /** Calendly webhook signing key returned when registering a
     *  webhook_subscription via the Calendly API. Used to HMAC-verify
     *  incoming webhooks at apps/web/app/api/webhooks/[workspaceId]/calendly. */
    calendly?: string
  }

  dripifyWebhooks?: Array<{
    id:               string
    actorId:          string
    campaignName:     string
    includeInReports: boolean
    createdAt:        string
  }>

  /**
   * Attribute slug overrides.
   * Only needed when a client's workspace uses different slug names than the
   * canonical template defaults. Set during provisioning or manually via seed.
   */
  slugs?: {
    // ── Signals object ────────────────────────────────────────────────────
    signalPersonRef?: string          // default: "person_with_signal"
    signalLinkedinUrl?: string        // default: "linkedin_profile_url_3"
    signalEmail?: string              // default: "email_address"
    signalFirstName?: string          // default: "first_name"
    signalLastName?: string           // default: "last_name"
    signalJobTitle?: string           // default: "job_title"
    signalSourceType?: string         // default: "source_type"
    signalScore?: string              // default: "signal_score"
    signalTeamfluenceCrmId?: string   // default: "teamfluence_crm_id"
    signalEngagementUrl?: string      // default: "teamfluence_engagement_url"
      signalSourceContent?: string      // default: "source_content" — set to "" to disable linking
    // ── People object ────────────────────────────────────────────────────
    personAllSignals?: string         // default: "all_signals"
    personSignalCount?: string        // default: "signal_count"
    personEngagementScore?: string    // default: "people_engagement_score"
    personCompanyRef?: string         // default: "company"
    personLinkedin?: string           // default: "linkedin"
    personEmail?: string              // default: "email_addresses"
    personJobTitle?: string           // default: "job_title"
    personAvatarUrl?: string          // default: "avatar_url"
    personLocation?: string           // default: "primary_location"
    personPersona?: string            // default: "persona"
    funnelStage?: string              // default: "funnel_stage"
    // ── Companies object (Task #5 Phase C) ────────────────────────────────
    companyName?: string              // default: "name"
    companyDomains?: string           // default: "domains"
    companyEmployeeRange?: string     // default: "employee_range"
    companyFunnelStage?: string       // default: "funnel_stage"
    companyProspectType?: string      // default: "prospect_type"
    companyEngagementScore?: string   // default: "engagement_score"
    companySignalsCount?: string      // default: "signals_count"
  }

  scoring?: {
    /**
     * People-level funnel thresholds. Tighter than companyThresholds because
     * a single person rarely accumulates many signals.
     *   Prospect      0-2
     *   Signal Found  3-5
     *   Engaged       6-25
     *   High Signal   26+
     */
    thresholds?: {
      signalFound?: number            // default: 3
      engaged?: number                // default: 6
      highSignal?: number             // default: 26
    }
    /**
     * Company-level funnel thresholds. Looser than people thresholds because
     * a company's score is the sum across its contacts.
     *   Prospect      0-4
     *   Signal Found  5-19
     *   Engaged       20-49
     *   High Signal   50+
     */
    companyThresholds?: {
      signalFound?: number            // default: 5
      engaged?: number                // default: 20
      highSignal?: number             // default: 50
    }
    /** Per-verb point values. Falls back to DEFAULT_VERB_WEIGHTS when not set. */
    verbWeights?: Record<string, number>
  }

  /**
   * Per-workspace overrides for Teamfluence event_type → CRM select option title mapping.
   * Only needed when a workspace uses non-standard option names.
   * Keys are Teamfluence event_type strings; values are the option title to use.
   * Example: { "LINKEDIN_PROFILE_FOLLOWER": "Profile Follower" }
   */
  eventTypeMap?: Record<string, string>

  /**
   * Dashboard access token — a random hex string shared with the client.
   * If set, the SDR dashboard requires a matching cookie to be viewed.
   * If unset, the dashboard is publicly accessible (no password required).
   */
  accessToken?: string

  /**
   * Resend email delivery config. One API key, multiple verified senders.
   * The `role` field controls which address is used per email type — the
   * send function picks by role, falls back to 'default', then to env vars.
   */
  resend?: {
    apiKey: string
    senders: Array<{
      email: string
      name?:  string
      role:   'default'
    }>
  }

  createdAt?: string
  updatedAt?: string
}

// ─── Slug resolver (applies template defaults) ──────────────────────────

export function resolveSlug(config: WorkspaceConfig): ResolvedSlugs {
  const s = config.slugs ?? {}
  return {
    // Signals
    signalPersonRef:        s.signalPersonRef        ?? "person_with_signal",
    signalLinkedinUrl:      s.signalLinkedinUrl      ?? "linkedin_profile_url_3",
    signalEmail:            s.signalEmail            ?? "email_address",
    signalFirstName:        s.signalFirstName        ?? "first_name",
    signalLastName:         s.signalLastName         ?? "last_name",
    signalJobTitle:         s.signalJobTitle         ?? "job_title",
    signalSourceType:       s.signalSourceType       ?? "source_type",
    signalScore:            s.signalScore            ?? "signal_score",
    signalTeamfluenceCrmId: s.signalTeamfluenceCrmId ?? "teamfluence_crm_id",
    signalEngagementUrl:    s.signalEngagementUrl    ?? "teamfluence_engagement_url",
    signalSourceContent:    s.signalSourceContent    ?? "source_content",
    // People
    personAllSignals:       s.personAllSignals       ?? "all_signals",
    personSignalCount:      s.personSignalCount      ?? "signal_count",
    personEngagementScore:  s.personEngagementScore  ?? "people_engagement_score",
    personCompanyRef:       s.personCompanyRef       ?? "company",
    personLinkedin:         s.personLinkedin         ?? "linkedin",
    personEmail:            s.personEmail            ?? "email_addresses",
    personJobTitle:         s.personJobTitle         ?? "job_title",
    personAvatarUrl:        s.personAvatarUrl        ?? "avatar_url",
    personLocation:         s.personLocation         ?? "primary_location",
    personPersona:          s.personPersona          ?? "persona",
    funnelStage:            s.funnelStage            ?? "funnel_stage",
    // Companies
    companyName:            s.companyName            ?? "name",
    companyDomains:         s.companyDomains         ?? "domains",
    companyEmployeeRange:   s.companyEmployeeRange   ?? "employee_range",
    companyFunnelStage:     s.companyFunnelStage     ?? "funnel_stage",
    companyProspectType:    s.companyProspectType    ?? "prospect_type",
    companyEngagementScore: s.companyEngagementScore ?? "engagement_score",
    companySignalsCount:    s.companySignalsCount    ?? "signals_count",
  }
}

export function resolveThresholds(config: WorkspaceConfig) {
  return {
    signalFound: config.scoring?.thresholds?.signalFound ?? 3,
    engaged:     config.scoring?.thresholds?.engaged     ?? 6,
    highSignal:  config.scoring?.thresholds?.highSignal  ?? 26,
  }
}

export function resolveCompanyThresholds(config: WorkspaceConfig) {
  return {
    signalFound: config.scoring?.companyThresholds?.signalFound ?? 5,
    engaged:     config.scoring?.companyThresholds?.engaged     ?? 20,
    highSignal:  config.scoring?.companyThresholds?.highSignal  ?? 50,
  }
}

/** Default points per engagement verb — matches the historic hardcoded EVENT_MAP values. */
export const DEFAULT_VERB_WEIGHTS: Record<string, number> = {
  liked_post:                3,
  commented_post:            5,
  viewed_profile:            3,
  followed_our_team_member:  10,
  followed_prospect:         0,
  followed_our_company:      3,
  sent_connection_request:   2,
  accepted_our_connection:   10,
  connected:                 5,
  sent_dm:                   0,
  // Task #10 (DM verb split). replied_dm is retained for back-compat with
  // historical rows; new inbound replies are emitted by the Unipile webhook
  // as either _initial (first reply in a thread, scored lower because the
  // first reply is ambiguous — could be "not interested") or _subsequent
  // (sustained engagement, scored higher).
  replied_dm:                5,
  replied_dm_initial:        3,
  replied_dm_subsequent:     5,
  sent_email:                0,
  replied_email:             3,
  booked_meeting:            15,
  ai_search:                 1,
  // Email events from the Resend webhook (apps/attribution/api/resend-webhook.ts).
  // All default to 0 in the wiring pass; tune via the Engagement Scoring UI.
  email_sent:                0,
  email_delivered:           0,
  email_delivery_delayed:    0,
  email_opened:              0,
  email_clicked:             0,
  email_bounced:             0,
  email_complained:          0,
  // Universal UTM click tracker (apps/attribution/api/track.ts). Per-campaign
  // click scoring (Phase 9-full) will read from a campaigns table later;
  // for now everything uses this workspace-wide default.
  clicked_link:              0,
  // Call notes (Task #16). The AI classifier in recordCallNote labels each
  // note into one of these three buckets; the score follows the workspace
  // configuration with these defaults. Voicemails / no-answers don't earn
  // points; an answered call earns a small amount (number worked, contact
  // was correct); a problem-fit call earns the most.
  call_not_answered:           0,
  call_answered:               1,
  call_answered_problem_fit:  10,
  // MVPR PR signals (lib/mvpr.ts, ADR-014). pr_pitch_sent is outbound (0, like
  // sent_dm); a journalist reply is a real response; published coverage is the
  // PR "win" and scores like a booked meeting. Recorded against the journalist
  // contact. Tune via the Engagement Scoring UI.
  pr_pitch_sent:               0,
  pr_journalist_replied:       5,
  pr_coverage_published:      15,
}

export function resolveVerbWeight(config: WorkspaceConfig, verb: string): number {
  return config.scoring?.verbWeights?.[verb] ?? DEFAULT_VERB_WEIGHTS[verb] ?? 0
}

export type TeamMember = NonNullable<WorkspaceConfig["teamMembers"]>[number]

export function resolveTeamMembers(config: WorkspaceConfig): TeamMember[] {
  return config.teamMembers ?? []
}

/**
 * Find a team member by id. Returns undefined when the id isn't in the
 * workspace's list — used by the page to fall back to "no team filter"
 * gracefully when a stale URL points at a removed member.
 */
export function findTeamMember(config: WorkspaceConfig, id: string | null | undefined): TeamMember | null {
  if (!id) return null
  return resolveTeamMembers(config).find(m => m.id === id) ?? null
}

export const DEFAULT_PROSPECT_TYPES = ["Investor", "Software", "Services", "Partner", "Excluded"]
export const DEFAULT_PROSPECT_TYPES_EXCLUDED = ["Excluded"]

export function resolveProspectTypes(config: WorkspaceConfig): string[] {
  const list = config.prospectTypes
  return list && list.length > 0 ? list : DEFAULT_PROSPECT_TYPES
}

export function resolveDefaultExcludedProspectTypes(config: WorkspaceConfig): string[] {
  return config.defaultExcludedProspectTypes ?? DEFAULT_PROSPECT_TYPES_EXCLUDED
}

// ─── Storage ──────────────────────────────────────────────────────────────────

function kv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null
  return new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  })
}

function configKey(workspaceId: string) {
  return `workspace:${workspaceId}:config`
}

/** Encrypt all sensitive fields before writing to Redis. */
function encryptConfig(config: WorkspaceConfig): WorkspaceConfig {
  return {
    ...config,
    ...(config.teamfluenceApiKey
      ? { teamfluenceApiKey: encryptIfNeeded(config.teamfluenceApiKey) }
      : {}),
    ...(config.accessToken
      ? { accessToken: encryptIfNeeded(config.accessToken) }
      : {}),
    ...(config.hubspot ? {
      hubspot: {
        ...config.hubspot,
        accessToken: encryptIfNeeded(config.hubspot.accessToken),
        ...(config.hubspot.refreshToken
          ? { refreshToken: encryptIfNeeded(config.hubspot.refreshToken) }
          : {}),
      },
    } : {}),
    ...(config.attio ? {
      attio: {
        ...config.attio,
        accessToken: encryptIfNeeded(config.attio.accessToken),
      },
    } : {}),
    ...(config.enrichment ? {
      enrichment: {
        ...(config.enrichment.surfe ? { surfe: { apiKey: encryptIfNeeded(config.enrichment.surfe.apiKey) } } : {}),
        ...(config.enrichment.clay  ? { clay:  { apiKey: encryptIfNeeded(config.enrichment.clay.apiKey)  } } : {}),
        ...(config.enrichment.apollo? { apollo:{ apiKey: encryptIfNeeded(config.enrichment.apollo.apiKey)} } : {}),
        ...(config.enrichment.moz ? {
          moz: {
            ...config.enrichment.moz,
            ...(config.enrichment.moz.apiKey ? { apiKey: encryptIfNeeded(config.enrichment.moz.apiKey) } : {}),
          },
        } : {}),
        ...(config.enrichment.apify ? {
          apify: {
            ...config.enrichment.apify,
            apiToken: encryptIfNeeded(config.enrichment.apify.apiToken),
          },
        } : {}),
      },
    } : {}),
    ...(config.webhookSecrets ? {
      webhookSecrets: {
        ...(config.webhookSecrets.teamfluence ? { teamfluence: encryptIfNeeded(config.webhookSecrets.teamfluence) } : {}),
        ...(config.webhookSecrets.dripify     ? { dripify:     encryptIfNeeded(config.webhookSecrets.dripify)     } : {}),
        ...(config.webhookSecrets.unipile     ? { unipile:     encryptIfNeeded(config.webhookSecrets.unipile)     } : {}),
        ...(config.webhookSecrets.calendly    ? { calendly:    encryptIfNeeded(config.webhookSecrets.calendly)    } : {}),
      },
    } : {}),
    ...(config.resend ? {
      resend: { ...config.resend, apiKey: encryptIfNeeded(config.resend.apiKey) },
    } : {}),
    ...(config.stripe ? {
      stripe: {
        ...config.stripe,
        apiKey: encryptIfNeeded(config.stripe.apiKey),
        ...(config.stripe.webhookSecret
          ? { webhookSecret: encryptIfNeeded(config.stripe.webhookSecret) }
          : {}),
      },
    } : {}),
    ...(config.mvpr ? {
      mvpr: { ...config.mvpr, apiKey: encryptIfNeeded(config.mvpr.apiKey) },
    } : {}),
  }
}

/** Decrypt all sensitive fields after reading from Redis. */
function decryptConfig(config: WorkspaceConfig): WorkspaceConfig {
  return {
    ...config,
    ...(config.teamfluenceApiKey
      ? { teamfluenceApiKey: decrypt(config.teamfluenceApiKey) }
      : {}),
    ...(config.accessToken
      ? { accessToken: decrypt(config.accessToken) }
      : {}),
    ...(config.hubspot ? {
      hubspot: {
        ...config.hubspot,
        accessToken: decrypt(config.hubspot.accessToken),
        ...(config.hubspot.refreshToken
          ? { refreshToken: decrypt(config.hubspot.refreshToken) }
          : {}),
      },
    } : {}),
    ...(config.attio ? {
      attio: {
        ...config.attio,
        accessToken: decrypt(config.attio.accessToken),
      },
    } : {}),
    ...(config.enrichment ? {
      enrichment: {
        ...(config.enrichment.surfe ? { surfe: { apiKey: decrypt(config.enrichment.surfe.apiKey) } } : {}),
        ...(config.enrichment.clay  ? { clay:  { apiKey: decrypt(config.enrichment.clay.apiKey)  } } : {}),
        ...(config.enrichment.apollo? { apollo:{ apiKey: decrypt(config.enrichment.apollo.apiKey)} } : {}),
        ...(config.enrichment.moz ? {
          moz: {
            ...config.enrichment.moz,
            ...(config.enrichment.moz.apiKey ? { apiKey: decrypt(config.enrichment.moz.apiKey) } : {}),
          },
        } : {}),
        ...(config.enrichment.apify ? {
          apify: {
            ...config.enrichment.apify,
            apiToken: decrypt(config.enrichment.apify.apiToken),
          },
        } : {}),
      },
    } : {}),
    ...(config.webhookSecrets ? {
      webhookSecrets: {
        ...(config.webhookSecrets.teamfluence ? { teamfluence: decrypt(config.webhookSecrets.teamfluence) } : {}),
        ...(config.webhookSecrets.dripify     ? { dripify:     decrypt(config.webhookSecrets.dripify)     } : {}),
        ...(config.webhookSecrets.unipile     ? { unipile:     decrypt(config.webhookSecrets.unipile)     } : {}),
        ...(config.webhookSecrets.calendly    ? { calendly:    decrypt(config.webhookSecrets.calendly)    } : {}),
      },
    } : {}),
    ...(config.resend ? {
      resend: { ...config.resend, apiKey: decrypt(config.resend.apiKey) },
    } : {}),
    ...(config.stripe ? {
      stripe: {
        ...config.stripe,
        apiKey: decrypt(config.stripe.apiKey),
        ...(config.stripe.webhookSecret
          ? { webhookSecret: decrypt(config.stripe.webhookSecret) }
          : {}),
      },
    } : {}),
    ...(config.mvpr ? {
      mvpr: { ...config.mvpr, apiKey: decrypt(config.mvpr.apiKey) },
    } : {}),
  }
}

export async function getWorkspaceConfig(workspaceId: string): Promise<WorkspaceConfig | null> {
  const redis = kv()
  if (!redis) return null
  const config = await redis.get<WorkspaceConfig>(configKey(workspaceId))
  if (!config) return null
  return decryptConfig(config)
}

export async function saveWorkspaceConfig(config: WorkspaceConfig): Promise<void> {
  const redis = kv()
  if (!redis) throw new Error("KV not configured")
  const now = new Date().toISOString()
  await redis.set(configKey(config.workspaceId), encryptConfig({
    ...config,
    updatedAt: now,
    createdAt: config.createdAt ?? now,
  }))
}

export async function patchWorkspaceConfig(
  workspaceId: string,
  patch: Partial<WorkspaceConfig>,
): Promise<WorkspaceConfig> {
  const existing = await getWorkspaceConfig(workspaceId)
  // Deep-merge `enrichment` so a partial update (e.g. setting just the Apify
  // token) doesn't wipe the other configured providers. Other nested fields
  // are left as shallow merges since they're either short arrays or simple
  // objects callers always send in full.
  const mergedEnrichment = patch.enrichment !== undefined
    ? {
        ...(existing?.enrichment ?? {}),
        ...patch.enrichment,
        ...(patch.enrichment.moz !== undefined
          ? { moz: { ...(existing?.enrichment?.moz ?? {}), ...patch.enrichment.moz } }
          : {}),
        // Same for apify — the form omits the token when only actorId/maxEmployees change.
        ...(patch.enrichment.apify !== undefined
          ? { apify: { ...(existing?.enrichment?.apify ?? {}), ...patch.enrichment.apify } }
          : {}),
      }
    : existing?.enrichment
  // Same shape for messaging — partial updates (e.g. just rotating the
  // Unipile API key) shouldn't wipe DSN / accountId or other providers.
  const mergedMessaging: WorkspaceConfig["messaging"] | undefined =
    patch.messaging !== undefined
      ? {
          ...(existing?.messaging ?? {}),
          ...patch.messaging,
          ...(patch.messaging.unipile !== undefined
            ? {
                unipile: {
                  ...(existing?.messaging?.unipile ?? {}),
                  ...patch.messaging.unipile,
                } as NonNullable<NonNullable<WorkspaceConfig["messaging"]>["unipile"]>,
              }
            : {}),
        }
      : existing?.messaging
  // Resend — keep existing apiKey when caller only wants to update senders.
  const mergedResend: WorkspaceConfig["resend"] | undefined =
    patch.resend !== undefined
      ? { ...(existing?.resend ?? {}), ...patch.resend } as WorkspaceConfig["resend"]
      : existing?.resend
  // Stripe - rotating the API key alone shouldn't wipe webhookSecret / mode,
  // and vice versa.
  const mergedStripe: WorkspaceConfig["stripe"] | undefined =
    patch.stripe !== undefined
      ? { ...(existing?.stripe ?? {}), ...patch.stripe } as WorkspaceConfig["stripe"]
      : existing?.stripe

  const updated: WorkspaceConfig = {
    ...(existing ?? { workspaceId }),
    ...patch,
    ...(mergedEnrichment ? { enrichment: mergedEnrichment } : {}),
    ...(mergedMessaging  ? { messaging:  mergedMessaging  } : {}),
    ...(mergedResend     ? { resend:     mergedResend     } : {}),
    ...(mergedStripe     ? { stripe:     mergedStripe     } : {}),
    workspaceId,
    updatedAt: new Date().toISOString(),
  }
  await saveWorkspaceConfig(updated)
  return updated
}

// ─── ICP group helper ────────────────────────────────────────────────────────

/**
 * Best-guess ICP group label for a contact, derived from company name +
 * industries against the workspace's icpGroups list. Returns null if no match.
 */
export interface IcpGroupMatch {
  name: string
  color: string
}
export function classifyIcpGroup(
  companyName: string | null | undefined,
  industries: string[] | null | undefined,
  config: { icpGroups?: WorkspaceConfig["icpGroups"] },
): IcpGroupMatch | null {
  const groups = config.icpGroups ?? []
  if (!groups.length) return null
  const lcName = (companyName ?? "").toLowerCase()
  const lcIndustries = (industries ?? []).map(i => i.toLowerCase())
  for (const g of groups) {
    // Industry tag exact-match wins (more reliable)
    if (g.industries && g.industries.some(i => lcIndustries.includes(i.toLowerCase()))) {
      return { name: g.name, color: g.color ?? "blue" }
    }
    // Fall back to company name keyword substring match
    if (lcName && g.keywords.some(k => k && lcName.includes(k.toLowerCase()))) {
      return { name: g.name, color: g.color ?? "blue" }
    }
  }
  return null
}

/**
 * Pre-enrichment exclusion check. Returns the rule name that triggered, or
 * null if the contact passes. Soft gate — manual override always allowed.
 */
export function checkExclusion(
  contact: {
    companyEmployeesMax?: number | null
    companyCountry?: string | null
    companyIndustries?: string[] | null
    companyType?: string | null
  },
  rules: WorkspaceConfig["exclusionRules"],
): string | null {
  if (!rules) return null
  if (rules.minEmployees != null && contact.companyEmployeesMax != null && contact.companyEmployeesMax < rules.minEmployees) {
    return `headcount<${rules.minEmployees}`
  }
  if (rules.targetCountries && rules.targetCountries.length > 0 && contact.companyCountry) {
    if (!rules.targetCountries.includes(contact.companyCountry)) {
      return `country:${contact.companyCountry}`
    }
  }
  if (rules.excludeIndustries && rules.excludeIndustries.length && contact.companyIndustries?.length) {
    const lcExclude = rules.excludeIndustries.map(s => s.toLowerCase())
    const lcContact = contact.companyIndustries.map(s => s.toLowerCase())
    const match = lcContact.find(i => lcExclude.includes(i))
    if (match) return `industry:${match}`
  }
  if (rules.excludeCompanyTypes && contact.companyType) {
    if (rules.excludeCompanyTypes.some(t => t.toLowerCase() === contact.companyType!.toLowerCase())) {
      return `companyType:${contact.companyType}`
    }
  }
  return null
}
