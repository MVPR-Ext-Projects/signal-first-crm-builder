/**
 * Migration: introduce the Channels entity layer above Campaigns.
 *
 * Today: "channel" is a string enum on `campaigns.channel`
 * (linkedin_dm | email | newsletter | lead_magnet | other) and stats
 * queries take that name as a literal. After this migration,
 * `channels` is a real per-workspace entity with a delivery mechanism
 * + optional fingerprint flag, and campaigns nest under it via
 * `campaigns.channel_id` (FK to channels.id).
 *
 * Also wires `outreach_log.campaign_id` + `outreach_log.coverage_mvpr_id`
 * so per-campaign and per-coverage attribution becomes possible going
 * forward (no backfill of historical sends).
 *
 * Seed pass: for every workspace that has at least one campaign row
 * OR a config record in Redis (via the existing campaign-channel
 * enum values), insert default Channel rows:
 *
 *   PR coverage      delivery=none      has_fingerprint=false
 *   LinkedIn DM      delivery=unipile   has_fingerprint=true
 *   Direct Email     delivery=resend    has_fingerprint=true
 *   Newsletter       delivery=resend    has_fingerprint=false
 *   Product Updates  delivery=resend    has_fingerprint=false
 *   Outbound Calls   delivery=none      has_fingerprint=false
 *
 * Existing `campaigns` rows get their channel_id populated by mapping
 * the legacy enum value -> seeded channel name:
 *
 *   linkedin_dm -> LinkedIn DM
 *   email       -> Direct Email
 *   newsletter  -> Newsletter
 *   lead_magnet -> Direct Email     (closest existing-data fit)
 *   other       -> NULL             (user assigns later)
 *
 * Idempotent. Safe to run multiple times.
 *
 * Usage:
 *   node scripts/migrate-add-channels.mjs
 */

import { neon } from "@neondatabase/serverless"
import { config as loadEnv } from "dotenv"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { randomUUID } from "crypto"

const __dirname = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(__dirname, "../.env.production.local") })
loadEnv({ path: resolve(__dirname, "../.env.local") })
loadEnv({ path: resolve(__dirname, "../apps/web/.env.production.local") })
loadEnv({ path: resolve(__dirname, "../apps/web/.env.local") })

if (!process.env.DATABASE_URL) {
  console.error("✗ Missing DATABASE_URL")
  process.exit(1)
}

const sql = neon(process.env.DATABASE_URL)

// ─── 1. Schema ───────────────────────────────────────────────────────────────

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS channels (
    id                   TEXT         PRIMARY KEY,
    workspace_id         TEXT         NOT NULL,
    name                 TEXT         NOT NULL,
    delivery_mechanism   TEXT         NOT NULL,   -- 'none' | 'unipile' | 'resend' | future
    has_fingerprint      BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    archived_at          TIMESTAMPTZ
  )`,

  `CREATE INDEX IF NOT EXISTS channels_workspace_active_idx
    ON channels (workspace_id, archived_at)`,

  // One active channel per (workspace, name) so the seed pass is idempotent.
  `CREATE UNIQUE INDEX IF NOT EXISTS channels_workspace_name_active_uq
    ON channels (workspace_id, name)
    WHERE archived_at IS NULL`,

  `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS channel_id TEXT`,

  // FK is nullable; some legacy campaigns (channel='other') won't get a
  // mapping in the seed pass and a future user action assigns them.
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'campaigns_channel_id_fkey'
         AND conrelid = 'campaigns'::regclass
     ) THEN
       ALTER TABLE campaigns
         ADD CONSTRAINT campaigns_channel_id_fkey
         FOREIGN KEY (channel_id) REFERENCES channels(id);
     END IF;
   END$$`,

  `CREATE INDEX IF NOT EXISTS campaigns_channel_idx
    ON campaigns (workspace_id, channel_id)
    WHERE channel_id IS NOT NULL`,

  `ALTER TABLE outreach_log ADD COLUMN IF NOT EXISTS campaign_id      TEXT`,
  `ALTER TABLE outreach_log ADD COLUMN IF NOT EXISTS coverage_mvpr_id TEXT`,

  `CREATE INDEX IF NOT EXISTS outreach_log_campaign_idx
    ON outreach_log (workspace_id, campaign_id, occurred_at DESC)
    WHERE campaign_id IS NOT NULL`,

  `CREATE INDEX IF NOT EXISTS outreach_log_coverage_idx
    ON outreach_log (workspace_id, coverage_mvpr_id, occurred_at DESC)
    WHERE coverage_mvpr_id IS NOT NULL`,
]

for (const s of schemaStatements) {
  process.stdout.write(`→ ${s.slice(0, 80).replace(/\s+/g, " ")}${s.length > 80 ? "…" : ""} `)
  await sql.query(s)
  console.log("✓")
}

// ─── 2. Seed default channels per workspace ──────────────────────────────────

/**
 * Which workspaces should we seed? Every workspace that has either:
 *   - At least one campaign row, OR
 *   - At least one outreach_log row, OR
 *   - At least one mvpr_coverage row
 * Anything else is a workspace that's never used the Channels surface
 * and we leave it untouched until they create their first campaign.
 */
const workspaces = await sql`
  SELECT DISTINCT workspace_id FROM (
    SELECT workspace_id FROM campaigns
    UNION
    SELECT workspace_id FROM outreach_log
    UNION
    SELECT workspace_id FROM mvpr_coverage
  ) t
`

const DEFAULT_CHANNELS = [
  { name: "PR coverage",     delivery: "none",    fingerprint: false },
  { name: "LinkedIn DM",     delivery: "unipile", fingerprint: true  },
  { name: "Direct Email",    delivery: "resend",  fingerprint: true  },
  { name: "Newsletter",      delivery: "resend",  fingerprint: false },
  { name: "Product Updates", delivery: "resend",  fingerprint: false },
  { name: "Outbound Calls",  delivery: "none",    fingerprint: false },
]

console.log(`\nSeeding default channels for ${workspaces.length} workspace(s)...`)

let totalSeeded = 0
const workspaceChannelMap = new Map() // workspace_id -> { name -> channel_id }

for (const { workspace_id } of workspaces) {
  const map = {}
  for (const ch of DEFAULT_CHANNELS) {
    // Lookup any existing active row for this (workspace, name).
    const existing = await sql`
      SELECT id FROM channels
      WHERE workspace_id = ${workspace_id}
        AND name         = ${ch.name}
        AND archived_at  IS NULL
      LIMIT 1
    `
    if (existing.length > 0) {
      map[ch.name] = existing[0].id
      continue
    }
    const id = randomUUID()
    await sql`
      INSERT INTO channels (id, workspace_id, name, delivery_mechanism, has_fingerprint)
      VALUES (${id}, ${workspace_id}, ${ch.name}, ${ch.delivery}, ${ch.fingerprint})
    `
    map[ch.name] = id
    totalSeeded += 1
  }
  workspaceChannelMap.set(workspace_id, map)
}
console.log(`Seeded ${totalSeeded} new channel rows (existing rows left as-is).`)

// ─── 3. Map existing campaigns to their seeded channel ───────────────────────

const ENUM_TO_CHANNEL_NAME = {
  linkedin_dm: "LinkedIn DM",
  email:       "Direct Email",
  newsletter:  "Newsletter",
  lead_magnet: "Direct Email",
  // 'other' -> no mapping; channel_id stays NULL
}

console.log(`\nLinking existing campaigns to their seeded channels...`)
let updated = 0
for (const [workspaceId, channelMap] of workspaceChannelMap.entries()) {
  for (const [enumValue, channelName] of Object.entries(ENUM_TO_CHANNEL_NAME)) {
    const channelId = channelMap[channelName]
    if (!channelId) continue
    const res = await sql`
      UPDATE campaigns SET channel_id = ${channelId}
      WHERE workspace_id = ${workspaceId}
        AND channel      = ${enumValue}
        AND channel_id   IS NULL
    `
    updated += res.length ?? 0
  }
}
console.log(`Updated campaigns.channel_id on existing rows.`)

console.log("\nMigration complete.")
