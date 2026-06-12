-- Signal-First CRM Builder — Postgres projection schema
-- Run once against your Neon database to create the tables.
--
-- contacts: one row per contact per workspace (keyed by CRM-native ID)
-- signals:  one row per signal event, linked to a contact

CREATE TABLE IF NOT EXISTS contacts (
  id              BIGSERIAL     PRIMARY KEY,
  workspace_id    TEXT          NOT NULL,
  crm_provider    TEXT          NOT NULL DEFAULT 'hubspot',
  crm_contact_id  TEXT          NOT NULL,   -- HubSpot hs_object_id, or other CRM's native record id
  crm_url         TEXT,                     -- Deep-link into the CRM
  email           TEXT,
  linkedin_url    TEXT,
  linkedin_member_id TEXT,                  -- LinkedIn URN (stable id). The /in/<slug> bit of linkedin_url is vanity and can change; member_id can't. Sourced from Unipile relations + enrichment webhooks.
  first_name      TEXT,
  last_name       TEXT,
  full_name       TEXT,
  job_title       TEXT,
  company_name    TEXT,
  company_linkedin_url TEXT,                   -- linkedin.com/company/<slug>, captured from TF webhooks
  twitter_url     TEXT,                        -- x.com/<handle>, populated from CRM record or enrichment
  avatar_url      TEXT,
  location        TEXT,
  signal_score    INTEGER       NOT NULL DEFAULT 0,
  signal_count    INTEGER       NOT NULL DEFAULT 0,
  -- Auto-derived stage based on signal_score. Five values:
  --   Prospect (default, < 5) → Signal Found (≥ 5) → Engaged (≥ 20)
  --   → High Signal (≥ 50) → Discovery Call (manual override only).
  -- recordSignal recomputes this on every score change.
  funnel_stage    TEXT          NOT NULL DEFAULT 'Prospect',
  -- Manual override that wins over auto-derivation when non-NULL.
  -- Today only "Discovery Call" gets written here (will be set by a future
  -- Calendly webhook). Column accepts any of the five stage names so a UI
  -- override can lock any stage.
  manual_stage    TEXT,
  last_signal_at  TIMESTAMPTZ,
  -- Company-level metadata that arrives in TF webhook payloads. Pre-enrichment
  -- — used to filter out clearly-non-ICP contacts before spending Surfe credits.
  company_industries      TEXT[],            -- e.g. ARRAY['Banking']
  company_employees_min   INTEGER,
  company_employees_max   INTEGER,
  company_country         TEXT,              -- ISO code (GB, US, etc.)
  company_type            TEXT,              -- "Privately Held", "Non-Profit", etc.
  -- Heuristic classification into a Fiat-defined ICP group (Issuer / Liquidity
  -- Provider / Exchange / Payment Provider). Computed at contact write time
  -- from companyName / industries against WorkspaceConfig.icpGroups.
  icp_group               TEXT,
  -- Matched persona name from WorkspaceConfig.messaging.personas, picked by
  -- pickPersona() against the contact's job_title. Populated on every
  -- contact upsert and re-run when the workspace edits its personas.
  -- NULL when no persona matches (or no personas are configured).
  persona                 TEXT,
  -- Manual override that wins over the auto-classified `persona` at read
  -- time via COALESCE(manual_persona, persona). Set by the clickable persona
  -- pill on the lead row. Survives reclassification runs so a human override
  -- isn't lost when the workspace edits persona match rules. Same pattern as
  -- manual_stage / funnel_stage.
  manual_persona          TEXT,
  -- Enrichment-provider metadata (currently Surfe). Useful for company-level
  -- enrichment joins (company_id) and re-enrichment scheduling (expires_at).
  company_id              TEXT,
  enrichment_expires_at   TIMESTAMPTZ,
  -- FK to the gtm-os-internal companies table. Populated by Phase 2 of the
  -- dedup waterfalls (Companies find-or-create). Distinct from `company_id`
  -- above (which holds the enrichment-provider record id / Surfe id).
  -- Nullable until Phase 10 backfill populates historical contacts.
  gtm_company_id          BIGINT,
  -- Captured from inbound webhook payloads — Teamfluence company.domain,
  -- Dripify companyWebsite. Used by the Companies waterfall to look up by
  -- domain when the company's LinkedIn URL isn't supplied.
  company_domain          TEXT,
  company_website         TEXT,
  -- Team Filters: optional explicit assignment to a team member id stored on
  -- WorkspaceConfig.teamMembers[].id. When set, the contact appears in that
  -- member's team filter regardless of whether their rules match. NULL =
  -- rules-only matching.
  assigned_team_member_id TEXT,
  linkedin_followers_count   INTEGER,
  linkedin_connections_count INTEGER,
  -- Per-contact influence graph — JSONB array of
  --   { kind: "person" | "company", crmId, name, linkedinUrl?, domain? }
  -- NULL = never imported; [] = imported but no influences.
  influenced_by              JSONB,
  -- ── Corporate-email lifecycle (Phase 0 — Task #6) ─────────────────────────
  -- `email` is "any email we have". `corporate_email` is specifically the
  -- validated corporate one. Status moves through confirmed → stale (cron)
  -- → re-confirmed | not_found.
  corporate_email                  TEXT,
  corporate_email_status           TEXT,
  corporate_email_confirmed_at     TIMESTAMPTZ,
  corporate_email_invalidated_at   TIMESTAMPTZ,
  -- ── LinkedIn-URL lifecycle (Phase 0 — Task #6) ────────────────────────────
  -- Inactive flagged when Unipile fails to resolve or DMs hard-fail twice
  -- in 48h (see linkedin_send_failures).
  linkedin_url_status              TEXT,
  linkedin_url_confirmed_at        TIMESTAMPTZ,
  linkedin_url_invalidated_at      TIMESTAMPTZ,
  -- ── Do-Not-Contact (Task #7) ──────────────────────────────────────────────
  -- Set on AI-classifier "not interested" detection, bounce/complain, or
  -- manual. Decays at do_not_contact_until. `do_not_contact_source` is
  -- free-text so new channels land here without a schema migration.
  do_not_contact                       BOOLEAN     NOT NULL DEFAULT FALSE,
  do_not_contact_until                 TIMESTAMPTZ,
  do_not_contact_reason_classification TEXT,
  do_not_contact_reason_snippet        TEXT,
  do_not_contact_source                TEXT,
  -- "departed" when call notes flag the contact as no longer at the company.
  -- NULL = current employee (default).
  company_status                       TEXT,
  -- Drives the Enrichment Candidates page. Set by LinkedIn-URL invalidation,
  -- email-freshness cron, or "no longer at company" detection.
  needs_enrichment                     BOOLEAN     NOT NULL DEFAULT FALSE,
  enrichment_reason                    TEXT,
  -- Per-row last-push-to-CRM time. Push jobs use this to push only rows
  -- where updated_at > synced_to_attio_at. NULL = never pushed yet.
  -- (Column name is legacy — kept to avoid a migration.)
  synced_to_attio_at                   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, crm_contact_id)
);

CREATE INDEX IF NOT EXISTS contacts_workspace_score_idx
  ON contacts (workspace_id, signal_score DESC);

-- Default sort on the SDR + Companies pages is `last_signal_at DESC NULLS LAST`.
-- Without this index Postgres falls back to seq scan + in-memory sort, which
-- gets expensive past a few thousand contacts per workspace.
CREATE INDEX IF NOT EXISTS contacts_workspace_recent_idx
  ON contacts (workspace_id, last_signal_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS contacts_email_idx
  ON contacts (workspace_id, email)
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS contacts_linkedin_idx
  ON contacts (workspace_id, linkedin_url)
  WHERE linkedin_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS contacts_workspace_persona_idx
  ON contacts (workspace_id, persona)
  WHERE persona IS NOT NULL;

-- Team Filters: explicit-assignment lookup. Rules-only matches don't hit
-- this index since assigned_team_member_id is NULL for them.
CREATE INDEX IF NOT EXISTS contacts_workspace_assigned_idx
  ON contacts (workspace_id, assigned_team_member_id)
  WHERE assigned_team_member_id IS NOT NULL;

-- Lookup index for dashboard joins from contacts to the new companies table.
CREATE INDEX IF NOT EXISTS contacts_workspace_gtm_company_idx
  ON contacts (workspace_id, gtm_company_id)
  WHERE gtm_company_id IS NOT NULL;

-- "Is this contact currently DNC'd?" — partial index on rows where
-- do_not_contact_until is set; the runtime query adds AND do_not_contact_until > now().
CREATE INDEX IF NOT EXISTS contacts_dnc_active_idx
  ON contacts (workspace_id, do_not_contact_until)
  WHERE do_not_contact_until IS NOT NULL;

-- Enrichment Candidates page query (small partial — only rows we care about).
CREATE INDEX IF NOT EXISTS contacts_needs_enrichment_idx
  ON contacts (workspace_id, updated_at DESC)
  WHERE needs_enrichment;

-- Email-freshness cron — confirmed corporate emails that haven't been re-validated.
CREATE INDEX IF NOT EXISTS contacts_corporate_email_stale_idx
  ON contacts (workspace_id, corporate_email_confirmed_at)
  WHERE corporate_email_status = 'confirmed';

-- Find rows that need pushing to the CRM (column name is legacy).
CREATE INDEX IF NOT EXISTS contacts_needs_attio_sync_idx
  ON contacts (workspace_id, updated_at)
  WHERE synced_to_attio_at IS NULL OR synced_to_attio_at < updated_at;

CREATE TABLE IF NOT EXISTS signals (
  id              BIGSERIAL     PRIMARY KEY,
  workspace_id    TEXT          NOT NULL,
  contact_id      BIGINT        NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  crm_signal_id    TEXT,
  source_type      TEXT,          -- legacy category label; being replaced by signal_verb
  engagement_url   TEXT,          -- legacy; see verb_description
  description      TEXT,          -- legacy; see signal_* fields
  signal_verb      TEXT,          -- liked_post | commented_post | viewed_profile | followed_our_team_member |
                                  -- followed_prospect | followed_our_company | accepted_our_connection |
                                  -- sent_connection_request | connected | sent_dm |
                                  -- replied_dm (legacy) | replied_dm_initial | replied_dm_subsequent |
                                  -- sent_email | replied_email | booked_meeting |
                                  -- email_sent | email_delivered | email_delivery_delayed |
                                  -- email_opened | email_clicked | email_bounced | email_complained |
                                  -- clicked_link |
                                  -- pr_pitch_sent | pr_journalist_replied | pr_coverage_published
                                  --   (MVPR PR signals, recorded against the journalist contact;
                                  --    see lib/mvpr.ts MvprSignalVerb + ADR-014)
  signal_actor     TEXT,          -- display name of who took the action
  signal_object    TEXT,          -- display name of what/who was acted on
  verb_description TEXT,          -- content payload: post URL, message text, invite date, etc.
  score_delta      INTEGER        NOT NULL DEFAULT 0,
  occurred_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS signals_contact_time_idx
  ON signals (contact_id, occurred_at DESC);

-- notes: general per-contact notes. Distinct from signals — notes are
-- non-engagement context (call outcomes, free-text observations) and do
-- NOT roll into signal_count / signal_score / funnel_stage.
-- Companion: scripts/retro-migrate-notes-to-notes-table.mjs moved the
-- historical 'Manual Note' rows out of `signals`.
CREATE TABLE IF NOT EXISTS notes (
  id            BIGSERIAL    PRIMARY KEY,
  workspace_id  TEXT         NOT NULL,
  contact_id    BIGINT       NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  body          TEXT         NOT NULL,
  -- Optional author display (team_member id / name / email — caller's choice).
  created_by    TEXT,
  -- When the note pertains to. Separate from created_at so a note can be
  -- back-dated to the conversation it captures.
  occurred_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notes_contact_time_idx
  ON notes (contact_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS notes_workspace_time_idx
  ON notes (workspace_id, occurred_at DESC);

-- linkedin_send_failures: individual Unipile DM send failures so the
-- "2 hard fails in 48h → mark URL inactive" policy is a single query.
-- One row per fail event; the runtime query windows to the last 48h.
CREATE TABLE IF NOT EXISTS linkedin_send_failures (
  id           BIGSERIAL    PRIMARY KEY,
  workspace_id TEXT         NOT NULL,
  contact_id   BIGINT       NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  linkedin_url TEXT         NOT NULL,
  reason       TEXT,
  occurred_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS linkedin_send_failures_contact_window_idx
  ON linkedin_send_failures (workspace_id, contact_id, occurred_at DESC);

-- channels: the parent entity above campaigns. A channel carries the
-- delivery mechanism (unipile / resend / none / future) and whether it
-- supports a writing-style fingerprint. Hardcoded /actions sections seed
-- as channels on migration so existing campaign + stats data has a home.
-- A channel.delivery_mechanism='none' channel (e.g. "PR coverage") is a
-- storage/source channel - no outbound sends, just a logical grouping.
CREATE TABLE IF NOT EXISTS channels (
  id                   TEXT         PRIMARY KEY,
  workspace_id         TEXT         NOT NULL,
  name                 TEXT         NOT NULL,
  delivery_mechanism   TEXT         NOT NULL,   -- 'none' | 'unipile' | 'resend' | future
  has_fingerprint      BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  archived_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS channels_workspace_active_idx
  ON channels (workspace_id, archived_at);

-- One active channel per (workspace, name).
CREATE UNIQUE INDEX IF NOT EXISTS channels_workspace_name_active_uq
  ON channels (workspace_id, name)
  WHERE archived_at IS NULL;

-- campaigns: nests under a channel via channel_id (added 2026-05-21).
-- The legacy `channel` enum stays as a back-compat read source; new
-- writes should always set channel_id. UTMs on campaign links carry
-- the campaign id (utm_medium) and the click tracker resolves the
-- clicked_link_score from this table.
CREATE TABLE IF NOT EXISTS campaigns (
  id                 TEXT         PRIMARY KEY,
  workspace_id       TEXT         NOT NULL,
  name               TEXT         NOT NULL,
  -- Legacy enum kept for back-compat with existing stats queries:
  -- 'linkedin_dm' | 'email' | 'newsletter' | 'lead_magnet' | 'other'
  channel            TEXT         NOT NULL,
  -- The parent Channel row (see channels table above). FK is nullable
  -- to accommodate legacy 'other' rows that have no seeded mapping.
  channel_id         TEXT         REFERENCES channels(id),
  clicked_link_score INT          NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  archived_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS campaigns_channel_idx
  ON campaigns (workspace_id, channel_id)
  WHERE channel_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS campaigns_workspace_active_idx
  ON campaigns (workspace_id, archived_at);

-- campaign_templates: editable per-campaign message templates. A campaign
-- can have one or more (e.g. A/B variants); is_default marks the one the
-- drafter uses unless the user overrides at draft time.
--
-- Shape per channel (channel inherited from the parent campaign row):
--   linkedin_dm     - { body } (plain text)
--   email           - { subject, html?, body } (HTML preferred, body as fallback)
--   newsletter      - same as email (PR 4)
--   lead_magnet|other - { body } default; subject/html optional
CREATE TABLE IF NOT EXISTS campaign_templates (
  id            TEXT         PRIMARY KEY,
  workspace_id  TEXT         NOT NULL,
  campaign_id   TEXT         NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name          TEXT         NOT NULL,
  subject       TEXT,
  html          TEXT,
  body          TEXT         NOT NULL,
  is_default    BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS campaign_templates_workspace_campaign_idx
  ON campaign_templates (workspace_id, campaign_id);

CREATE UNIQUE INDEX IF NOT EXISTS campaign_templates_default_uq
  ON campaign_templates (workspace_id, campaign_id)
  WHERE is_default = TRUE;

-- campaign_coverage: many-to-many between campaigns and PR coverage.
-- A row lands here when a coverage piece is used to spawn a new campaign
-- (via the coverage drawer action menu) or attached to an existing one.
-- /reports/pr reads this to attribute campaign activity back to coverage.
-- Composite FK to mvpr_coverage(workspace_id, mvpr_id) for workspace
-- isolation; CASCADE on the campaigns FK so archiving drops attachments.
-- (Table/column names retain the mvpr_ prefix as a historical integration
--  identifier and aren't renamed here to avoid a column migration.)
CREATE TABLE IF NOT EXISTS campaign_coverage (
  workspace_id      TEXT         NOT NULL,
  campaign_id       TEXT         NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  coverage_mvpr_id  TEXT         NOT NULL,
  attached_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, campaign_id, coverage_mvpr_id),
  FOREIGN KEY (workspace_id, coverage_mvpr_id)
    REFERENCES mvpr_coverage(workspace_id, mvpr_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS campaign_coverage_campaign_idx
  ON campaign_coverage (workspace_id, campaign_id);

CREATE INDEX IF NOT EXISTS campaign_coverage_coverage_idx
  ON campaign_coverage (workspace_id, coverage_mvpr_id);

-- mvpr_coverage / mvpr_announcements / mvpr_sync_state: projection of the
-- external PR platform's REST API. The /api/cron/mvpr-coverage-sync cron
-- pulls every 6h and upserts here so the dashboard's PR section reads
-- from Postgres. Each workspace's PR-platform credentials drive a
-- single-tenant pull (baseUrl embeds the platform's company id). PK is
-- (workspace_id, mvpr_id) so workspaces never collide on shared ids.
-- (Table/column names use the mvpr_ prefix as the historical integration
--  identifier; not renamed here to avoid a column migration.)
CREATE TABLE IF NOT EXISTS mvpr_coverage (
  workspace_id      TEXT         NOT NULL,
  mvpr_id           TEXT         NOT NULL,
  title             TEXT         NOT NULL,
  link              TEXT,
  summary           TEXT,
  published_at      TIMESTAMPTZ  NOT NULL,
  mvpr_created_at   TIMESTAMPTZ  NOT NULL,
  tier              TEXT         NOT NULL,
  topics            TEXT[]       NOT NULL DEFAULT '{}',
  is_organic        BOOLEAN      NOT NULL,
  image             TEXT,
  journalist_id     TEXT         NOT NULL,
  journalist_name   TEXT         NOT NULL,
  publication_id    TEXT         NOT NULL,
  publication_name  TEXT         NOT NULL,
  domain_authority  INTEGER,
  thread_id         TEXT,          -- outreach thread this coverage came from (mvpr_threads.mvpr_id); NULL for organic
  raw_payload       JSONB,
  synced_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, mvpr_id)
);

CREATE INDEX IF NOT EXISTS mvpr_coverage_workspace_time_idx
  ON mvpr_coverage (workspace_id, published_at DESC);

CREATE INDEX IF NOT EXISTS mvpr_coverage_publication_idx
  ON mvpr_coverage (workspace_id, publication_name);

CREATE TABLE IF NOT EXISTS mvpr_announcements (
  workspace_id        TEXT         NOT NULL,
  mvpr_id             TEXT         NOT NULL,
  title               TEXT         NOT NULL,
  announcement_type   TEXT         NOT NULL,
  start_time          TIMESTAMPTZ  NOT NULL,
  subject             TEXT         NOT NULL,
  complete            BOOLEAN      NOT NULL DEFAULT FALSE,
  share_token         TEXT,
  document            JSONB,
  coverages           JSONB,
  threads             JSONB,
  stats               JSONB,
  journalist_lists    JSONB,
  journalists         JSONB,
  objectives          JSONB,
  company_id          TEXT         NOT NULL,
  mvpr_updated_at     TIMESTAMPTZ  NOT NULL,
  raw_payload         JSONB,
  synced_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, mvpr_id)
);

CREATE INDEX IF NOT EXISTS mvpr_announcements_workspace_time_idx
  ON mvpr_announcements (workspace_id, start_time DESC);

-- mvpr_threads: the journalist outreach threads behind coverage. One row per
-- MVPR thread. `has_journalist_reply` is derived at sync time (any inbound
-- message) and `coverage_count` is filled by joining mvpr_coverage.thread_id.
-- Together with mvpr_coverage these drive PR-performance tracking: response
-- rate = threads with a reply / threads sent; coverage rate = threads that
-- produced coverage / threads sent; "which messages land" = grouped by intent.
CREATE TABLE IF NOT EXISTS mvpr_threads (
  workspace_id         TEXT         NOT NULL,
  mvpr_id              TEXT         NOT NULL,
  subject              TEXT         NOT NULL,
  intent               TEXT         NOT NULL,
  status               TEXT         NOT NULL,
  is_archived          BOOLEAN      NOT NULL DEFAULT FALSE,
  message_count        INTEGER      NOT NULL DEFAULT 0,
  has_journalist_reply BOOLEAN      NOT NULL DEFAULT FALSE,
  journalist_id        TEXT         NOT NULL,
  journalist_name      TEXT         NOT NULL,
  publication_id       TEXT,
  publication_name     TEXT,
  mvpr_created_at      TIMESTAMPTZ  NOT NULL,
  last_action_at       TIMESTAMPTZ  NOT NULL,
  raw_payload          JSONB,
  synced_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, mvpr_id)
);

CREATE INDEX IF NOT EXISTS mvpr_threads_workspace_time_idx
  ON mvpr_threads (workspace_id, last_action_at DESC);

CREATE INDEX IF NOT EXISTS mvpr_threads_workspace_intent_idx
  ON mvpr_threads (workspace_id, intent);

CREATE INDEX IF NOT EXISTS mvpr_threads_journalist_idx
  ON mvpr_threads (workspace_id, journalist_id);

CREATE TABLE IF NOT EXISTS mvpr_sync_state (
  workspace_id              TEXT         PRIMARY KEY,
  last_coverage_sync_at     TIMESTAMPTZ,
  last_announcement_sync_at TIMESTAMPTZ,
  last_thread_sync_at       TIMESTAMPTZ,
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- enrichment_log: one row per Surfe (or future provider) call. Lets the
-- dashboard show credit usage filterable by period.
CREATE TABLE IF NOT EXISTS enrichment_log (
  id              BIGSERIAL    PRIMARY KEY,
  workspace_id    TEXT         NOT NULL,
  contact_id      BIGINT       REFERENCES contacts(id) ON DELETE SET NULL,
  linkedin_url    TEXT,
  enrichment_id   TEXT,
  provider        TEXT         NOT NULL DEFAULT 'surfe',
  status          TEXT         NOT NULL,    -- 'enriched' | 'no_match' | 'internal_purged' | 'failed'
  email_credits   INTEGER      NOT NULL DEFAULT 0,
  mobile_credits  INTEGER      NOT NULL DEFAULT 0,
  occurred_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS enrichment_log_workspace_time_idx
  ON enrichment_log (workspace_id, occurred_at DESC);

-- companies: the gtm-os-internal company entity. Used by the Companies dedup
-- waterfall (LinkedIn URL > domain > normalized name with guard). Contacts FK
-- into this via contacts.gtm_company_id, populated by Phase 2 of the dedup
-- work and backfilled retroactively by scripts/retro-companies-table-backfill.mjs.
--
-- Identity ranking, strongest → weakest:
--   1. linkedin_url   normalized to linkedin.com/company/<slug>
--   2. domain         normalized (lowercase, no www, no protocol)
--   3. canonical_name lowercase + trimmed + legal-suffixes stripped
--
-- Race protection: the unique partial indexes on (workspace_id, linkedin_url)
-- and (workspace_id, domain) — where the column is non-NULL — let the DB
-- resolve concurrent inserts via INSERT ... ON CONFLICT DO NOTHING + re-SELECT.
CREATE TABLE IF NOT EXISTS companies (
  id                  BIGSERIAL    PRIMARY KEY,
  workspace_id        TEXT         NOT NULL,
  linkedin_url        TEXT,
  domain              TEXT,
  canonical_name      TEXT         NOT NULL,
  raw_name            TEXT         NOT NULL,
  -- Parent/child relationship for regional offices (e.g. Acme APAC →
  -- Acme). Set by a separate heuristic / human review, not by the dedup
  -- waterfall. Always nullable, always overridable.
  parent_company_id   BIGINT,
  -- Caches the CRM-native company record id so future syncs both directions
  -- can map between gtm-os and the configured CRM without falling back to
  -- fuzzy domain/name matching.
  crm_company_id      TEXT,
  -- Last successful push to the configured CRM. NULL = never pushed.
  -- Push jobs pick up rows where updated_at > synced_to_attio_at.
  -- (Column name is legacy — kept to avoid a migration.)
  synced_to_attio_at  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS companies_workspace_linkedin_idx
  ON companies (workspace_id, linkedin_url)
  WHERE linkedin_url IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS companies_workspace_domain_idx
  ON companies (workspace_id, domain)
  WHERE domain IS NOT NULL;

CREATE INDEX IF NOT EXISTS companies_workspace_name_idx
  ON companies (workspace_id, canonical_name);

CREATE INDEX IF NOT EXISTS companies_parent_idx
  ON companies (parent_company_id)
  WHERE parent_company_id IS NOT NULL;

-- A given CRM company record can't be linked to two different gtm-os companies.
CREATE UNIQUE INDEX IF NOT EXISTS companies_workspace_crm_id_idx
  ON companies (workspace_id, crm_company_id)
  WHERE crm_company_id IS NOT NULL;

-- Find companies that need pushing to the CRM (column name is legacy).
CREATE INDEX IF NOT EXISTS companies_needs_attio_sync_idx
  ON companies (workspace_id, updated_at)
  WHERE synced_to_attio_at IS NULL OR synced_to_attio_at < updated_at;

-- influencers: first-class influence-graph entity, SEPARATE storage from
-- contacts (a prospect and an influencer are different things, even when the
-- same human is both). An influencer is anyone/anything with influence over
-- prospects:
--   kind = 'person'        -> journalist, or an individual a prospect follows
--   kind = 'organization'  -> a publisher: publication, news site, podcast
-- `type` is the specific label (journalist | publication | news_site | podcast
-- | individual | other). Many-to-many with contacts via influencer_influences.
-- Dedup waterfall per workspace: linkedin_url > domain > mvpr id > name.
-- MVPR writes each coverage's journalist (person/journalist) and publication
-- (organization/publication) in here. See ADR-015.
CREATE TABLE IF NOT EXISTS influencers (
  id                  BIGSERIAL    PRIMARY KEY,
  workspace_id        TEXT         NOT NULL,
  kind                TEXT         NOT NULL,   -- person | organization
  type                TEXT         NOT NULL,   -- journalist | publication | news_site | podcast | individual | other
  name                TEXT         NOT NULL,
  -- Identity / dedup keys (any may be NULL; the waterfall uses the strongest present).
  linkedin_url        TEXT,                    -- person influencers
  domain              TEXT,                    -- organization influencers
  twitter_url         TEXT,
  website             TEXT,
  -- External source ids so MVPR (and future sources) map without fuzzy matching.
  mvpr_journalist_id  TEXT,
  mvpr_publication_id TEXT,
  -- Caches the CRM-native influencer record id (e.g. Attio "influencers" object).
  crm_influencer_id   TEXT,
  metadata            JSONB,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Dedup waterfall — race-safe upsert targets.
CREATE UNIQUE INDEX IF NOT EXISTS influencers_workspace_linkedin_idx
  ON influencers (workspace_id, linkedin_url) WHERE linkedin_url IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS influencers_workspace_domain_idx
  ON influencers (workspace_id, domain) WHERE domain IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS influencers_workspace_mvpr_journalist_idx
  ON influencers (workspace_id, mvpr_journalist_id) WHERE mvpr_journalist_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS influencers_workspace_mvpr_publication_idx
  ON influencers (workspace_id, mvpr_publication_id) WHERE mvpr_publication_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS influencers_workspace_type_idx
  ON influencers (workspace_id, type);
CREATE INDEX IF NOT EXISTS influencers_workspace_name_idx
  ON influencers (workspace_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS influencers_workspace_crm_id_idx
  ON influencers (workspace_id, crm_influencer_id) WHERE crm_influencer_id IS NOT NULL;

-- influencer_influences: the many-to-many edge between an influencer and a
-- prospect (contact). Read in two named directions:
--   influencer.influences   -> contacts an influencer influences  (by influencer_id)
--   contact.influenced_by    -> influencers influencing a prospect (by contact_id)
-- contacts.influenced_by JSONB is a denormalized read-cache of this same
-- relationship (legacy; still drives the SDR "Influenced by" panel). This
-- table is the relational source of truth.
CREATE TABLE IF NOT EXISTS influencer_influences (
  workspace_id   TEXT        NOT NULL,
  influencer_id  BIGINT      NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  contact_id     BIGINT      NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- How we learned of this edge: 'mvpr' | 'engagement' | 'manual' | 'import'.
  source         TEXT,
  -- Optional strength for future weighting of influence.
  weight         INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, influencer_id, contact_id)
);

-- "Influenced by" direction: every influencer for a given prospect.
CREATE INDEX IF NOT EXISTS influencer_influences_contact_idx
  ON influencer_influences (workspace_id, contact_id);
-- "Influences" direction: every prospect a given influencer touches.
CREATE INDEX IF NOT EXISTS influencer_influences_influencer_idx
  ON influencer_influences (workspace_id, influencer_id);

-- company_enrichments: latest Apify employee-scrape result per (workspace, company).
-- Re-fetch overwrites; we don't keep history for now since Apify credits are
-- non-trivial and the user can just trigger again if they want a refresh.
CREATE TABLE IF NOT EXISTS company_enrichments (
  id                    BIGSERIAL    PRIMARY KEY,
  workspace_id          TEXT         NOT NULL,
  company_linkedin_url  TEXT         NOT NULL,
  company_name          TEXT,
  fetched_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  raw_count             INTEGER      NOT NULL DEFAULT 0,
  match_count           INTEGER      NOT NULL DEFAULT 0,  -- how many passed the title regex
  employees             JSONB        NOT NULL,            -- array of normalized profile objects
  UNIQUE (workspace_id, company_linkedin_url)
);

CREATE INDEX IF NOT EXISTS company_enrichments_workspace_idx
  ON company_enrichments (workspace_id, fetched_at DESC);

-- company_tags: per-workspace Prospect-Type tagging on companies, keyed by
-- the same (workspace_id, company_name) pair the Companies dashboard already
-- groups by. Multi-value: a company can hold ["Software","Partner"] etc.
-- The available tag values + which are default-excluded from the Companies
-- chip filter live on WorkspaceConfig.prospectTypes / .defaultExcludedProspectTypes.
-- The proper companies table now exists (see CREATE TABLE companies above).
-- A follow-up migration will move prospect_types onto companies as a column
-- and drop this bridge table — sequenced after Phase 10 backfills
-- contacts.gtm_company_id and the dashboard switches to grouping on company_id.
CREATE TABLE IF NOT EXISTS company_tags (
  workspace_id              TEXT         NOT NULL,
  company_name              TEXT         NOT NULL,
  prospect_types            TEXT[]       NOT NULL DEFAULT '{}',
  -- Manual SDR / team-member assignment, keyed by the id from
  -- WorkspaceConfig.teamMembers. NULL = unassigned. The Companies page
  -- exposes this as an inline picker per row; the SDR / Companies pages
  -- filter on it via ?team=<id>.
  assigned_team_member_id   TEXT,
  -- Manual funnel-stage override at the company level. NULL = let the
  -- auto-derived stage win (which is a function of signal_score for the
  -- company, and signal_score for each contact). When set, this stage
  -- rolls down to every contact at the company — accounts buy, people
  -- engage, so a "Discovery Call" booking is an account-level fact and
  -- the per-person stages should reflect it. Replaces the old per-contact
  -- contacts.manual_stage path.
  manual_stage              TEXT,
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, company_name)
);

-- For workspaces created before these columns existed.
ALTER TABLE company_tags
  ADD COLUMN IF NOT EXISTS assigned_team_member_id TEXT;
ALTER TABLE company_tags
  ADD COLUMN IF NOT EXISTS manual_stage TEXT;
ALTER TABLE company_tags
  ADD COLUMN IF NOT EXISTS website_domain TEXT;
-- Monthly recurring revenue on the deal at this company, in the
-- workspace's working currency. ARR is derivable as deal_mrr * 12 at
-- read time. See scripts/migrate-add-company-deal-mrr.mjs.
ALTER TABLE company_tags
  ADD COLUMN IF NOT EXISTS deal_mrr NUMERIC(10, 2);

CREATE INDEX IF NOT EXISTS company_tags_workspace_idx
  ON company_tags (workspace_id);

-- linkedin_interests: latest Apify LinkedIn-Interests scrape per (workspace, contact).
-- Mirrors the company_enrichments pattern. The interests JSONB holds four
-- arrays - topVoices, companies, groups, newsletters - each item shaped as
-- { name, linkedinUrl, tagline?, followerCount? }. Categories the actor
-- doesn't return arrive as empty arrays.
--
-- Naming: the platform prefix (linkedin_) leaves room for sibling tables when
-- we add cross-platform interest sources (twitter_following, instagram_following,
-- etc.). All such tables FK to contacts(id) so a contact's interests across
-- platforms can be assembled with a join.
CREATE TABLE IF NOT EXISTS linkedin_interests (
  id            BIGSERIAL    PRIMARY KEY,
  workspace_id  TEXT         NOT NULL,
  contact_id    BIGINT       NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  fetched_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  total_count   INTEGER      NOT NULL DEFAULT 0,
  interests     JSONB        NOT NULL,
  UNIQUE (workspace_id, contact_id)
);

CREATE INDEX IF NOT EXISTS linkedin_interests_workspace_idx
  ON linkedin_interests (workspace_id, fetched_at DESC);

-- x_interests: latest Apify X (Twitter) following scrape per (workspace, contact).
-- Sibling of linkedin_interests. JSONB shape mirrors linkedin_interests but
-- with a single flat bucket since X doesn't categorise follows like LinkedIn:
--   { accounts: [{ name, handle, profileUrl, bio?, followerCount?, verified? }, …] }
-- Used by the unified "Interests" panel on the lead row + the cross-funnel
-- influence-trends aggregation that ranks accounts followed by N+ contacts.
CREATE TABLE IF NOT EXISTS x_interests (
  id            BIGSERIAL    PRIMARY KEY,
  workspace_id  TEXT         NOT NULL,
  contact_id    BIGINT       NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  fetched_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  total_count   INTEGER      NOT NULL DEFAULT 0,
  interests     JSONB        NOT NULL,
  UNIQUE (workspace_id, contact_id)
);

CREATE INDEX IF NOT EXISTS x_interests_workspace_idx
  ON x_interests (workspace_id, fetched_at DESC);

-- usage_log: one row per cost-incurring event, per workspace. Powers the
-- "current spend" pills in the dashboard header and the per-workspace cost
-- breakdown page. Real-cost providers (Surfe credits, Apify runs, AI tokens,
-- Unipile sends) write directly here; shared-infra providers (Vercel, Neon)
-- get a daily cron that allocates team-level usage by share-of-events.
--
-- units            -- credits / tokens / runs / messages / GB-hours
-- unit_cost_cents  -- USD cents per unit at the time of the call (frozen
--                     even if pricing changes later, so historical totals
--                     stay accurate)
-- total_cost_cents -- pre-computed units * unit_cost_cents for fast SUMs
-- metadata         -- per-provider extra context (e.g. {model, contactId,
--                     enrichmentStatus}). Use sparingly; analytics live in
--                     dedicated columns where it matters.
CREATE TABLE IF NOT EXISTS usage_log (
  id                BIGSERIAL    PRIMARY KEY,
  workspace_id      TEXT         NOT NULL,
  occurred_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  category          TEXT         NOT NULL,    -- 'enrichment' | 'ai' | 'messaging' | 'platform'
  provider          TEXT         NOT NULL,    -- 'surfe' | 'apify' | 'anthropic' | 'unipile' | 'vercel' | 'neon' | …
  units             NUMERIC      NOT NULL DEFAULT 0,
  unit_cost_cents   NUMERIC      NOT NULL DEFAULT 0,
  total_cost_cents  NUMERIC      NOT NULL DEFAULT 0,
  metadata          JSONB        NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS usage_log_workspace_time_idx
  ON usage_log (workspace_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS usage_log_workspace_provider_time_idx
  ON usage_log (workspace_id, provider, occurred_at DESC);

-- company_moz_data: Moz domain metrics fetched on demand from the Companies tab.
-- Keyed by (workspace_id, domain) — refetch overwrites, no history kept.
CREATE TABLE IF NOT EXISTS company_moz_data (
  workspace_id      TEXT         NOT NULL,
  domain            TEXT         NOT NULL,
  domain_authority  INTEGER,
  page_authority    INTEGER,
  backlinks         BIGINT,
  root_domains      INTEGER,
  spam_score        INTEGER,
  fetched_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, domain)
);

CREATE INDEX IF NOT EXISTS company_moz_data_workspace_idx
  ON company_moz_data (workspace_id);

-- company_moz_history: append-only record of every Moz fetch.
-- company_moz_data keeps only the latest snapshot; this table lets us
-- track DA trends over time and compute per-segment averages.
CREATE TABLE IF NOT EXISTS company_moz_history (
  id               BIGSERIAL    PRIMARY KEY,
  workspace_id     TEXT         NOT NULL,
  domain           TEXT         NOT NULL,
  domain_authority INTEGER,
  page_authority   INTEGER,
  backlinks        BIGINT,
  root_domains     INTEGER,
  spam_score       INTEGER,
  fetched_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS company_moz_history_workspace_domain_time_idx
  ON company_moz_history (workspace_id, domain, fetched_at DESC);

-- Tracks when a company moves between funnel stages (auto or manual).
-- Populated by recordSignal() and setCompanyStage() in contact-store.ts.
CREATE TABLE IF NOT EXISTS company_stage_transitions (
  id              BIGSERIAL    PRIMARY KEY,
  workspace_id    TEXT         NOT NULL,
  company_name    TEXT         NOT NULL,
  from_stage      TEXT,                          -- null = first observed entry
  to_stage        TEXT         NOT NULL,
  transitioned_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  trigger         TEXT         NOT NULL DEFAULT 'auto'   -- 'auto' | 'manual'
);

CREATE INDEX IF NOT EXISTS company_stage_transitions_ws_time_idx
  ON company_stage_transitions (workspace_id, transitioned_at DESC);

CREATE INDEX IF NOT EXISTS company_stage_transitions_ws_company_idx
  ON company_stage_transitions (workspace_id, company_name, transitioned_at DESC);

-- Outreach log: one row per sent DM or email.
-- responded_at is set lazily (when draft-dm detects a reply in the Unipile thread).
-- booking_at is set when a booked_meeting signal arrives for the same contact.
CREATE TABLE IF NOT EXISTS outreach_log (
  id                BIGSERIAL    PRIMARY KEY,
  workspace_id      TEXT         NOT NULL,
  contact_id        BIGINT       NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel           TEXT         NOT NULL DEFAULT 'dm',   -- 'dm' | 'email'
  message_preview   TEXT,
  persona           TEXT,
  stage             TEXT,
  template_ids      TEXT[],
  -- Absolute attribution: which campaign drove this send, and which
  -- piece of coverage was attached to that campaign at send time
  -- (added 2026-05-21). Nullable; backfill of historical sends not
  -- attempted. Per-coverage outcome rollups join through these.
  campaign_id       TEXT,
  coverage_mvpr_id  TEXT,
  occurred_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  responded_at      TIMESTAMPTZ,
  booking_at        TIMESTAMPTZ,
  chat_id           TEXT,
  message_id        TEXT
);

CREATE INDEX IF NOT EXISTS outreach_log_campaign_idx
  ON outreach_log (workspace_id, campaign_id, occurred_at DESC)
  WHERE campaign_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS outreach_log_coverage_idx
  ON outreach_log (workspace_id, coverage_mvpr_id, occurred_at DESC)
  WHERE coverage_mvpr_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS outreach_log_workspace_time_idx
  ON outreach_log (workspace_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS outreach_log_contact_idx
  ON outreach_log (contact_id, occurred_at DESC);

-- Aggregate stats per broadcast send (newsletter / product update email)
CREATE TABLE IF NOT EXISTS broadcast_sends (
  id             BIGSERIAL    PRIMARY KEY,
  workspace_id   TEXT         NOT NULL,
  type           TEXT         NOT NULL,   -- 'newsletter' | 'product_update'
  name           TEXT,
  sent_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  emails_sent    INT          NOT NULL DEFAULT 0,
  opened         INT          NOT NULL DEFAULT 0,
  clicked        INT          NOT NULL DEFAULT 0,
  booked         INT          NOT NULL DEFAULT 0,
  won_or_upsold  INT          NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS broadcast_sends_workspace_type_idx
  ON broadcast_sends (workspace_id, type, sent_at DESC);

-- LinkedIn URN (stable id). See scripts/migrate-add-linkedin-member-id.mjs.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS linkedin_member_id TEXT;
CREATE INDEX IF NOT EXISTS contacts_workspace_member_id_idx
  ON contacts (workspace_id, linkedin_member_id) WHERE linkedin_member_id IS NOT NULL;

-- ── Legacy one-off CSV import fields ─────────────────────────────────────────
-- Carried over from a one-off CSV import of pre-existing prospect data.
-- No current code path reads or writes these — left in for that historical
-- workspace + so a re-import / re-hydration of that CSV still has homes for
-- each column. Safe to drop once the legacy import is fully migrated into the
-- live shape (signals + outreach_log + meetings).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS prospect_phone                  TEXT;
-- phone: clean top-level phone field (added via migrate-add-contacts-phone.mjs).
-- Populated by Surfe mobile-phone enrichment; eventually consumed by Twilio dialer.
-- Distinct from the legacy prospect_phone above (one-off CSV import only).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone                           TEXT;
-- linkedin_connected: TRUE once we have confirmed 1st-degree connection with
-- this contact (set near-realtime by the TF webhook on accepted_our_connection,
-- and by the daily sweep / Unipile relations import). NULL = unknown; FALSE =
-- explicitly not connected.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS linkedin_connected              BOOLEAN;
-- contact_industry: self-reported industry from LinkedIn (Dripify payload).
-- Distinct from company_industries (company-level, from TF).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS contact_industry                TEXT;
-- linkedin_premium: whether the contact has a LinkedIn Premium subscription.
-- Sourced from Dripify payload; weak but useful signal (Premium skews toward
-- sales/BD/senior-buyer profiles).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS linkedin_premium                BOOLEAN;
-- company_followers_count: LinkedIn company page follower count.
-- Sourced from TF company.followers and Dripify numberOfCompanyFollowers.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_followers_count         INTEGER;
-- company_specialties: LinkedIn company specialty tags (e.g. ["Broadcasting","radio",...]).
-- Sourced from TF company.specialties. Complements company_industries for AI ICP scoring.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_specialties             TEXT[];
-- company_headquarters: city / location string of the company HQ (e.g. "London").
-- Sourced from TF company.headquarters or company.location.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_headquarters            TEXT;
-- company_founded_year: year the company was founded (e.g. 1922).
-- Sourced from TF company.founded_year.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_founded_year            INTEGER;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS prospect_notes                  TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS prospect_location               TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS prospect_first_meeting_at       TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS prospect_last_meeting_at        TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS calendly_attribution            TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS prospect_years_comms_experience NUMERIC;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS prospect_years_at_company       NUMERIC;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS prospect_past_experience        TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS prospect_marketing_opt_in       BOOLEAN;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS prospect_user_status            TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lead_first_found_at             DATE;

-- style_fingerprints: per-(workspace, scope, channel?, persona_id?) writing-
-- style profiles (cozy-tiger plan). Three scopes:
--   'corporate'        - workspace-level umbrella voice. channel + persona_id NULL.
--   'channel'          - Action-Set-level voice for a channel, independent of
--                        persona. channel set, persona_id NULL. Applied when
--                        no persona matched, or as the channel-wide default.
--   'channel_persona'  - one per (channel, persona) pair. channel in
--                        {'linkedin_dm', 'email'} for v1. persona_id matches
--                        the UUID on WorkspaceConfig.messaging.personas[].id.
--
-- Resolution at draft time (see lib/style/fetch-fingerprints.ts) stacks the
-- three layers least-to-most specific: corporate < channel < channel_persona.
-- Most-specific available wins.
--
-- One row per version. is_active = TRUE marks the canonical version for that
-- cell. Refits create a new row and flip is_active. Old versions retained
-- for rollback + history.
CREATE TABLE IF NOT EXISTS style_fingerprints (
  id                 BIGSERIAL    PRIMARY KEY,
  workspace_id       TEXT         NOT NULL,
  scope              TEXT         NOT NULL,        -- 'corporate' | 'channel' | 'channel_persona' | 'campaign'
  channel            TEXT,                         -- NULL only for corporate
  persona_id         TEXT,                         -- NULL for corporate and channel; required for channel_persona
  campaign_id        TEXT,                         -- NULL for non-campaign scopes; required for campaign
  version            INT          NOT NULL DEFAULT 1,
  is_active          BOOLEAN      NOT NULL DEFAULT TRUE,
  fingerprint        JSONB        NOT NULL,        -- StyleProfile JSON (63-dim)
  sample_count_pos   INT          NOT NULL DEFAULT 0,
  sample_count_neg   INT          NOT NULL DEFAULT 0,
  source             TEXT         NOT NULL,        -- 'manual_upload' | 'mined_from_outreach_log' | 'auto_refit' | 'seed'
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Only one active fingerprint per cell. NULL-safe via COALESCE so the
-- corporate scope (channel + persona_id both NULL) is treated as a single
-- cell, and campaign-scoped rows (campaign_id set, persona_id NULL) don't
-- conflict with channel-scope rows.
CREATE UNIQUE INDEX IF NOT EXISTS style_fingerprints_active_uq
  ON style_fingerprints (
    workspace_id, scope,
    COALESCE(channel,     ''),
    COALESCE(persona_id,  ''),
    COALESCE(campaign_id, '')
  )
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS style_fingerprints_cell_idx
  ON style_fingerprints (workspace_id, scope, channel, persona_id, created_at DESC);

CREATE INDEX IF NOT EXISTS style_fingerprints_campaign_idx
  ON style_fingerprints (workspace_id, campaign_id)
  WHERE campaign_id IS NOT NULL;

-- style_samples: outcome-tagged content pieces that feed refinement.
-- source describes provenance:
--   'auto_send'              - written by the compose-and-send path (Phase 3)
--   'manual_upload'          - user pasted labelled samples in Company Messaging
--   'mined_from_outreach_log' - bootstrapped from historical sends
--
-- recipient_context is frozen at capture so schema changes upstream don't
-- retroactively warp old samples. Shape:
--   { job_title, company_size, country, prior_signals: [{verb, source, occurred_at}, ...] }
-- outreach_log_id is the back-pointer to the send row so the outcome scorer
-- can join against signals for the same contact since send time.
CREATE TABLE IF NOT EXISTS style_samples (
  id                        BIGSERIAL    PRIMARY KEY,
  workspace_id              TEXT         NOT NULL,
  channel                   TEXT         NOT NULL, -- 'linkedin_dm' | 'email'
  persona_id                TEXT,                  -- NULL when no persona matched
  contact_id                BIGINT       REFERENCES contacts(id) ON DELETE SET NULL,
  source                    TEXT         NOT NULL,
  content                   TEXT         NOT NULL,
  outcome_score             NUMERIC(4,2),
  outcome_resolved_at       TIMESTAMPTZ,
  recipient_context         JSONB,
  contributed_to_fp_version INT,                   -- style_fingerprints.version that consumed this; NULL until refit
  outreach_log_id           BIGINT       REFERENCES outreach_log(id) ON DELETE SET NULL,
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS style_samples_cell_idx
  ON style_samples (workspace_id, channel, persona_id, outcome_resolved_at DESC);

-- Partial index for the refit cron: find resolved-but-not-yet-consumed samples.
CREATE INDEX IF NOT EXISTS style_samples_pending_idx
  ON style_samples (workspace_id, channel, persona_id)
  WHERE contributed_to_fp_version IS NULL AND outcome_resolved_at IS NOT NULL;

-- Back-pointer from each AI-drafted send to the fingerprint version that
-- produced it. NULL for sends that weren't AI-drafted (template-only,
-- manual, or pre-feature). Drives the audit trail + rollback story.
ALTER TABLE outreach_log
  ADD COLUMN IF NOT EXISTS fingerprint_version_id BIGINT REFERENCES style_fingerprints(id) ON DELETE SET NULL;

-- linkedin_invite_queue: one row per LinkedIn connection invitation, queued
-- and then sent via Unipile. The queue is workspace-scoped; the worker reads
-- WorkspaceConfig.messaging.unipile.{accountId, dsn, apiKey} as the sender,
-- and WorkspaceConfig.messaging.unipile.dailyInviteCap as the rolling-24h cap.
--
-- Status lifecycle:
--   queued    - waiting for scheduled_at AND a daily-cap slot
--   sending   - worker has claimed the row; Unipile call in flight
--   sent      - Unipile accepted; awaiting LinkedIn recipient response
--   accepted  - recipient accepted (Unipile webhook or detection cron)
--   declined  - recipient declined or invite expired (LinkedIn ~3 weeks)
--   failed    - terminal error; see last_error + attempts
--   cancelled - aborted pre-send (DNC trip, linkedin_url invalidated, manual)
--
-- DNC and linkedin_url_status are NOT denormalized here. The worker rechecks
-- contacts.do_not_contact, contacts.do_not_contact_until, and
-- contacts.linkedin_url_status at claim time; a trip flips the row to
-- 'cancelled' with the reason in last_error.
CREATE TABLE IF NOT EXISTS linkedin_invite_queue (
  id                           BIGSERIAL    PRIMARY KEY,
  workspace_id                 TEXT         NOT NULL,
  contact_id                   BIGINT       NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

  -- Worker filters: status='queued' AND scheduled_at <= now().
  scheduled_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- 'queued' | 'sending' | 'sent' | 'accepted' | 'declined' | 'failed' | 'cancelled'
  status                       TEXT         NOT NULL DEFAULT 'queued',

  -- Optional invitation note (<=300 chars). Free LinkedIn accounts are
  -- capped at ~5 notes/month, so most rows leave this NULL. Premium accounts
  -- get a higher cap; usage tracking lives in usage_log, not here.
  note                         TEXT,

  -- Provenance.
  --   'manual'                - enqueued from a lead row
  --   'auto_signal_threshold' - signal_score crossed an invite threshold
  --   'campaign'              - tied to a campaigns row
  --   'bulk_import'           - admin CSV / script
  source                       TEXT         NOT NULL DEFAULT 'manual',

  -- Optional back-pointers. NULL when not applicable.
  triggered_by_signal_id       BIGINT       REFERENCES signals(id) ON DELETE SET NULL,
  requested_by_team_member_id  TEXT,        -- WorkspaceConfig.teamMembers[].id

  -- Unipile send-half. NULL until status reaches 'sent'.
  unipile_invitation_id        TEXT,
  provider_id                  TEXT,        -- LinkedIn member URN resolved at send
  sent_at                      TIMESTAMPTZ, -- drives the rolling-24h cap window
  accepted_at                  TIMESTAMPTZ,
  declined_at                  TIMESTAMPTZ,

  -- Retry / failure. Bumped on every 'sending' attempt that doesn't reach 'sent'.
  attempts                     INT          NOT NULL DEFAULT 0,
  last_attempt_at              TIMESTAMPTZ,
  last_error                   TEXT,

  created_at                   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Worker pull: "next batch of due invites in this workspace".
CREATE INDEX IF NOT EXISTS linkedin_invite_queue_due_idx
  ON linkedin_invite_queue (workspace_id, scheduled_at)
  WHERE status = 'queued';

-- Rolling-24h cap counter:
--   SELECT COUNT(*) FROM linkedin_invite_queue
--   WHERE workspace_id = $1 AND sent_at > now() - interval '24 hours';
CREATE INDEX IF NOT EXISTS linkedin_invite_queue_sent_window_idx
  ON linkedin_invite_queue (workspace_id, sent_at DESC)
  WHERE sent_at IS NOT NULL;

-- Idempotency: never two simultaneous open invites for the same contact.
-- 'sent' is included so a re-enqueue while a prior invite is still pending
-- is rejected at the DB layer. After accept/decline/fail/cancel the row
-- exits the partial index and a re-enqueue is allowed.
CREATE UNIQUE INDEX IF NOT EXISTS linkedin_invite_queue_one_open_per_contact_idx
  ON linkedin_invite_queue (workspace_id, contact_id)
  WHERE status IN ('queued', 'sending', 'sent');

-- Contact lookup for the lead-row "Invite status" pill + history view.
CREATE INDEX IF NOT EXISTS linkedin_invite_queue_contact_idx
  ON linkedin_invite_queue (contact_id, created_at DESC);

-- ── Stripe revenue ingestion (Phase A) ───────────────────────────────────────
-- Per-workspace Stripe connections feed three tables that together let us
-- compute LTV, MRR, NDR and ACV per gtm-os company:
--   stripe_customers       - bridge between Stripe Customer and gtm-os company.
--   stripe_subscriptions   - one row per Stripe Subscription. The ordinal
--                            column tracks first vs subsequent subscriptions
--                            for the customer.
--   stripe_revenue_events  - append-only event stream covering both MRR-
--                            affecting events (subscription start, expansion,
--                            contraction, churn) and invoice payments.
--
-- Funnel side effects (driven from the webhook handler, not the schema):
--   - First payment_succeeded -> company_tags.manual_stage = 'Customer Won'.
--   - Last subscription churns -> manual_stage cleared, previous_customer_since
--     set, company drops back to its score-derived stage. See
--     apps/web/app/api/webhooks/[workspaceId]/stripe/route.ts.

CREATE TABLE IF NOT EXISTS stripe_customers (
  id                 BIGSERIAL    PRIMARY KEY,
  workspace_id       TEXT         NOT NULL,
  stripe_customer_id TEXT         NOT NULL,
  -- gtm-os company match. NULL when the Stripe customer hasn't been linked
  -- yet (Settings -> Stripe Matches surfaces these for manual linking).
  gtm_company_id     BIGINT       REFERENCES companies(id) ON DELETE SET NULL,
  -- Canonical Stripe customer email (lowercased) - drives the auto-domain match.
  email              TEXT,
  -- Canonical Stripe customer name - drives the name-fuzzy fallback.
  name               TEXT,
  -- 'auto_domain' | 'auto_name_fuzzy' | 'manual' | 'unmatched'
  match_method       TEXT         NOT NULL DEFAULT 'unmatched',
  matched_at         TIMESTAMPTZ,
  -- Workspace-curated classification of what this Stripe customer represents.
  -- Values (free-form, conventionally):
  --   'untracked'             - test / internal / excluded from funnel + reporting.
  --                             Reclassifier and dashboards skip these entirely.
  --   'recurring_subscriber'  - standard recurring-revenue customer.
  --   'announcement_only'     - the 100%-discount + £500 fee pattern (see BILLING.md).
  --   'free_tier'             - educator / experimental free access; no revenue expected.
  --   NULL                    - not yet classified; treated as a regular customer.
  customer_type      TEXT,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, stripe_customer_id)
);

-- For workspaces whose stripe_customers table predates the customer_type column.
ALTER TABLE stripe_customers
  ADD COLUMN IF NOT EXISTS customer_type TEXT;

-- "What companies have Stripe revenue?" lookup for the Companies page join.
CREATE INDEX IF NOT EXISTS stripe_customers_workspace_company_idx
  ON stripe_customers (workspace_id, gtm_company_id)
  WHERE gtm_company_id IS NOT NULL;

-- Drives the Settings -> Stripe Matches page (unmatched queue).
CREATE INDEX IF NOT EXISTS stripe_customers_workspace_unmatched_idx
  ON stripe_customers (workspace_id, updated_at DESC)
  WHERE gtm_company_id IS NULL;

-- Fast filter for "all the customers we should exclude from classification +
-- reporting" - used by the reclassifier and future dashboard queries.
CREATE INDEX IF NOT EXISTS stripe_customers_workspace_type_idx
  ON stripe_customers (workspace_id, customer_type)
  WHERE customer_type IS NOT NULL;

CREATE TABLE IF NOT EXISTS stripe_subscriptions (
  id                       BIGSERIAL    PRIMARY KEY,
  workspace_id             TEXT         NOT NULL,
  stripe_customer_id       BIGINT       NOT NULL REFERENCES stripe_customers(id) ON DELETE CASCADE,
  stripe_subscription_id   TEXT         NOT NULL,
  -- 1, 2, 3, ... within the customer. Computed at insert time as the count of
  -- pre-existing rows for the same stripe_customer_id, plus one. Drives the
  -- Track B vs Track C decision in the commission engine.
  ordinal                  INT          NOT NULL,
  -- Optional human-readable plan name ('Single' | 'Regional' | 'Multi-Regional'
  -- | 'Global'). Populated from Stripe price.nickname when present.
  plan_nickname            TEXT,
  unit_amount_cents        INT          NOT NULL,
  currency                 TEXT         NOT NULL,
  -- 'month' | 'year'
  interval                 TEXT         NOT NULL,
  -- Stripe subscription status: active | past_due | canceled | trialing |
  -- incomplete | incomplete_expired | unpaid | paused.
  status                   TEXT         NOT NULL,
  started_at               TIMESTAMPTZ  NOT NULL,
  -- Hard 12-month attribution cap per subscription. Computed at insert
  -- as started_at + 12 months. Used by reporting to bound the window
  -- over which a subscription is attributed to the originating campaign.
  initial_term_ends_at     TIMESTAMPTZ  NOT NULL,
  -- Current billing-period bounds. Used by the cadence-aware Customer Won
  -- classifier in the funnel pass + webhook handler: when
  -- current_period_end > now() AND status NOT IN ('canceled',
  -- 'incomplete_expired'), the matched company is currently active
  -- regardless of last paid_at. Handles quarterly / upfront enterprise
  -- billing correctly. See BILLING.md.
  current_period_start     TIMESTAMPTZ,
  current_period_end       TIMESTAMPTZ,
  canceled_at              TIMESTAMPTZ,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, stripe_subscription_id)
);

-- For workspaces whose stripe_subscriptions table predates the period
-- columns (Phase A originals).
ALTER TABLE stripe_subscriptions
  ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMPTZ;
ALTER TABLE stripe_subscriptions
  ADD COLUMN IF NOT EXISTS current_period_end   TIMESTAMPTZ;

-- Drives the cadence-aware "any active subscription?" check in the
-- funnel pass; partial so only active rows with future period_end are
-- indexed.
CREATE INDEX IF NOT EXISTS stripe_subscriptions_active_period_idx
  ON stripe_subscriptions (workspace_id, stripe_customer_id, current_period_end)
  WHERE status NOT IN ('canceled', 'incomplete_expired')
    AND current_period_end IS NOT NULL;

CREATE INDEX IF NOT EXISTS stripe_subscriptions_customer_idx
  ON stripe_subscriptions (stripe_customer_id, ordinal);

-- Helper for the "is this subscription the last active one?" check the churn
-- side-effect runs on every customer.subscription.deleted webhook.
CREATE INDEX IF NOT EXISTS stripe_subscriptions_customer_active_idx
  ON stripe_subscriptions (stripe_customer_id)
  WHERE status NOT IN ('canceled', 'incomplete_expired');

CREATE TABLE IF NOT EXISTS stripe_revenue_events (
  id                       BIGSERIAL    PRIMARY KEY,
  workspace_id             TEXT         NOT NULL,
  stripe_customer_id       BIGINT       NOT NULL REFERENCES stripe_customers(id) ON DELETE CASCADE,
  stripe_subscription_id   BIGINT       REFERENCES stripe_subscriptions(id) ON DELETE SET NULL,
  -- MRR-affecting:
  --   'subscription_started' | 'expansion' | 'contraction' | 'churn'
  -- Payment-affecting:
  --   'payment_succeeded' | 'payment_refunded' | 'payment_failed'
  kind                     TEXT         NOT NULL,
  -- MRR rows: signed cents. NULL for payment rows.
  mrr_delta_cents          INT,
  -- Payment rows: total billed amount in cents. NULL for MRR rows.
  gross_amount_cents       INT,
  -- Payment rows: post-tax, post-discount, post-Stripe-fee amount in cents.
  -- Sourced from the linked BalanceTransaction. NULL for MRR rows.
  net_amount_cents         INT,
  currency                 TEXT,
  -- Stripe webhook event id. Unique per workspace so re-delivered events
  -- don't double-write.
  stripe_event_id          TEXT,
  occurred_at              TIMESTAMPTZ  NOT NULL,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, stripe_event_id)
);

-- Per-customer timeline (LTV computations, "show me this company's revenue
-- history").
CREATE INDEX IF NOT EXISTS stripe_revenue_events_customer_time_idx
  ON stripe_revenue_events (stripe_customer_id, occurred_at DESC);

-- Per-workspace per-kind timeline (NDR/MRR cohort queries).
CREATE INDEX IF NOT EXISTS stripe_revenue_events_workspace_kind_time_idx
  ON stripe_revenue_events (workspace_id, kind, occurred_at DESC);

-- Fast "has this customer ever had a successful payment?" check for the first-
-- payment -> Customer Won side-effect.
CREATE INDEX IF NOT EXISTS stripe_revenue_events_customer_first_payment_idx
  ON stripe_revenue_events (stripe_customer_id, occurred_at)
  WHERE kind = 'payment_succeeded';

-- "Has this company ever been a customer?" marker. Set when the customer
-- churns (all subscriptions cancelled). Stays set on re-purchase - this is
-- historical, not a current-state flag. NULL = never been a customer.
ALTER TABLE company_tags
  ADD COLUMN IF NOT EXISTS previous_customer_since TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS company_tags_previous_customer_idx
  ON company_tags (workspace_id, previous_customer_since)
  WHERE previous_customer_since IS NOT NULL;

-- stripe_products: one row per Stripe Product. The stripe_product_id is the
-- stable handle (never changes); name is editable and may rotate during the
-- product's lifetime. name_history captures every rename observed via the
-- product.updated webhook so renames don't lose attribution.
--
-- Note: Stripe does NOT retain pre-existing names server-side, so the history
-- only starts from when we first see the product. Historical renames before
-- that point must be entered manually (or via stripe_product_aliases).
CREATE TABLE IF NOT EXISTS stripe_products (
  id                BIGSERIAL    PRIMARY KEY,
  workspace_id      TEXT         NOT NULL,
  stripe_product_id TEXT         NOT NULL,
  name              TEXT,
  description       TEXT,
  active            BOOLEAN      NOT NULL DEFAULT TRUE,
  -- Append-only array of {name, observed_at, stripe_event_id?}. Older first;
  -- the most recent rename is the last element. Capped at 50 entries by the
  -- webhook handler to keep the row from growing unbounded.
  name_history      JSONB        NOT NULL DEFAULT '[]'::jsonb,
  -- Mirror of Stripe's metadata object so workspaces can tag canonical names,
  -- internal sku codes, etc. Read-only from gtm-os; written by Stripe-side
  -- edits and picked up via webhook.
  metadata          JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, stripe_product_id)
);

CREATE INDEX IF NOT EXISTS stripe_products_workspace_active_idx
  ON stripe_products (workspace_id, active);

-- stripe_prices: one row per Stripe Price. Each price points at exactly one
-- product. Subscription items and invoice lines reference prices, so
-- "MRR by product" is the join chain price -> product.
CREATE TABLE IF NOT EXISTS stripe_prices (
  id                  BIGSERIAL    PRIMARY KEY,
  workspace_id        TEXT         NOT NULL,
  stripe_price_id     TEXT         NOT NULL,
  stripe_product_row  BIGINT       NOT NULL REFERENCES stripe_products(id) ON DELETE CASCADE,
  -- Cached so we don't have to join on every read.
  stripe_product_id   TEXT         NOT NULL,
  nickname            TEXT,
  currency            TEXT         NOT NULL,
  -- NULL for tiered / per-unit pricing where there isn't a single unit price.
  unit_amount_cents   INT,
  -- 'month' | 'year' | 'week' | 'day' | NULL for one-off prices.
  interval            TEXT,
  active              BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, stripe_price_id)
);

CREATE INDEX IF NOT EXISTS stripe_prices_workspace_product_idx
  ON stripe_prices (workspace_id, stripe_product_row);

-- stripe_product_aliases: workspace-curated grouping for products that span
-- multiple Stripe ids (e.g. a relaunch where the old product was archived
-- and a new one was created). Each row maps one Stripe product to a canonical
-- key the workspace defines; reports group by canonical_key when set,
-- otherwise fall back to the Stripe product id.
--
-- One Stripe product can only belong to one canonical group (UNIQUE on
-- stripe_product_row). Multiple Stripe products can share a canonical_key.
CREATE TABLE IF NOT EXISTS stripe_product_aliases (
  id                  BIGSERIAL    PRIMARY KEY,
  workspace_id        TEXT         NOT NULL,
  -- Workspace-defined slug (e.g. "pro-plan", "enterprise-2024"). Free text;
  -- not validated against any taxonomy.
  canonical_key       TEXT         NOT NULL,
  stripe_product_row  BIGINT       NOT NULL REFERENCES stripe_products(id) ON DELETE CASCADE,
  -- Optional human-readable note explaining the grouping ("renamed from Pro
  -- Plan to Business in Q3 2024, then merged with Standard").
  notes               TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, stripe_product_row)
);

CREATE INDEX IF NOT EXISTS stripe_product_aliases_canonical_idx
  ON stripe_product_aliases (workspace_id, canonical_key);

-- stripe_invoices: one row per Stripe Invoice. Captures the customer-facing
-- bill including tax, discount, payment status. Use for ACV computations,
-- per-period revenue breakdowns, and the customer-detail invoice timeline.
CREATE TABLE IF NOT EXISTS stripe_invoices (
  id                       BIGSERIAL    PRIMARY KEY,
  workspace_id             TEXT         NOT NULL,
  stripe_invoice_id        TEXT         NOT NULL,
  stripe_customer_id       BIGINT       NOT NULL REFERENCES stripe_customers(id) ON DELETE CASCADE,
  -- Subscription that triggered this invoice (subscription billing) or NULL
  -- for ad-hoc / one-off invoices.
  stripe_subscription_id   BIGINT       REFERENCES stripe_subscriptions(id) ON DELETE SET NULL,
  -- 'draft' | 'open' | 'paid' | 'void' | 'uncollectible'
  status                   TEXT         NOT NULL,
  currency                 TEXT         NOT NULL,
  -- Pre-tax, pre-discount sum of line items.
  subtotal_cents           INT          NOT NULL DEFAULT 0,
  -- Tax across all lines.
  tax_cents                INT          NOT NULL DEFAULT 0,
  -- Total discount (sum of all discount lines).
  discount_cents           INT          NOT NULL DEFAULT 0,
  -- Customer-facing total (subtotal + tax - discount).
  total_cents              INT          NOT NULL DEFAULT 0,
  amount_paid_cents        INT          NOT NULL DEFAULT 0,
  amount_remaining_cents   INT          NOT NULL DEFAULT 0,
  -- Stripe-hosted invoice URL for the customer-facing page.
  hosted_invoice_url       TEXT,
  -- Stripe's creation timestamp (not our row creation).
  stripe_created_at        TIMESTAMPTZ  NOT NULL,
  finalized_at             TIMESTAMPTZ,
  paid_at                  TIMESTAMPTZ,
  voided_at                TIMESTAMPTZ,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, stripe_invoice_id)
);

CREATE INDEX IF NOT EXISTS stripe_invoices_customer_time_idx
  ON stripe_invoices (stripe_customer_id, stripe_created_at DESC);

CREATE INDEX IF NOT EXISTS stripe_invoices_workspace_status_idx
  ON stripe_invoices (workspace_id, status, stripe_created_at DESC);

-- stripe_invoice_lines: one row per line item on an invoice. The price_row
-- FK is where "per-product revenue" comes from - joining lines -> prices ->
-- products (and optionally aliases). The period_start / period_end columns
-- support cohort-style queries ("what did this customer pay for in Q3?").
CREATE TABLE IF NOT EXISTS stripe_invoice_lines (
  id                       BIGSERIAL    PRIMARY KEY,
  workspace_id             TEXT         NOT NULL,
  stripe_invoice_row       BIGINT       NOT NULL REFERENCES stripe_invoices(id) ON DELETE CASCADE,
  stripe_line_id           TEXT         NOT NULL,
  -- Optional: line items without an associated price (e.g. manual invoice
  -- adjustments) leave this NULL.
  stripe_price_row         BIGINT       REFERENCES stripe_prices(id) ON DELETE SET NULL,
  stripe_subscription_row  BIGINT       REFERENCES stripe_subscriptions(id) ON DELETE SET NULL,
  description              TEXT,
  quantity                 INT          NOT NULL DEFAULT 1,
  -- Line subtotal in cents (quantity * unit_amount, pre-tax pre-discount).
  amount_cents             INT          NOT NULL DEFAULT 0,
  currency                 TEXT         NOT NULL,
  -- Billing period covered by this line. For subscription items this matches
  -- the subscription's current period; for ad-hoc lines both may be NULL.
  period_start             TIMESTAMPTZ,
  period_end               TIMESTAMPTZ,
  proration                BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, stripe_line_id)
);

CREATE INDEX IF NOT EXISTS stripe_invoice_lines_invoice_idx
  ON stripe_invoice_lines (stripe_invoice_row);

CREATE INDEX IF NOT EXISTS stripe_invoice_lines_price_idx
  ON stripe_invoice_lines (stripe_price_row)
  WHERE stripe_price_row IS NOT NULL;

-- calendly_bookings: one row per Calendly invitee.created webhook, with the
-- raw payload preserved. The webhook handler also writes a `booked_meeting`
-- signal on the matching contact (existing verb in this file).
--
-- Companion: scripts/migrate-add-calendly-bookings-table.mjs
CREATE TABLE IF NOT EXISTS calendly_bookings (
  id                  BIGSERIAL    PRIMARY KEY,
  workspace_id        TEXT         NOT NULL,
  -- Stable Calendly event URI. Unique so retries / canceled-then-rebooked
  -- flows don't double-write.
  calendly_event_uri  TEXT         NOT NULL UNIQUE,
  event_type_uri      TEXT         NOT NULL,
  -- Slug derived from event_type_uri via a known-URI -> slug map at write
  -- time. Nullable because new event types won't be in the map until added.
  event_type_slug     TEXT,
  event_type_name     TEXT         NOT NULL,
  invitee_email       TEXT         NOT NULL,
  invitee_name        TEXT,
  -- When the meeting itself is scheduled (separate from created_at).
  scheduled_for       TIMESTAMPTZ  NOT NULL,
  cancelled_at        TIMESTAMPTZ,
  -- Calendly's per-event-type form answers. Variable shape so kept as JSONB.
  custom_answers      JSONB,
  -- Full webhook payload preserved so we can reprocess if our parser changes.
  raw_payload         JSONB        NOT NULL,
  -- FK to the gtm-os contact this booking was attached to. Nullable so the
  -- booking row still lands if contact upsert fails.
  contact_id          BIGINT       REFERENCES contacts(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS calendly_bookings_workspace_time_idx
  ON calendly_bookings (workspace_id, scheduled_for DESC);

CREATE INDEX IF NOT EXISTS calendly_bookings_contact_idx
  ON calendly_bookings (contact_id)
  WHERE contact_id IS NOT NULL;
