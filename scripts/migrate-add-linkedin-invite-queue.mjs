/**
 * Migration: linkedin_invite_queue table.
 *
 * Queues outbound LinkedIn connection invitations. UniPile exposes a send
 * endpoint but no scheduler, queue, or daily-cap throttle - we own all of
 * that. The worker pulls rows where status='queued' AND scheduled_at <= now(),
 * respects WorkspaceConfig.messaging.unipile.dailyInviteCap (rolling 24h
 * window over sent_at), calls Unipile, and walks the row through the status
 * lifecycle on its own.
 *
 * Strictly additive. Idempotent (CREATE TABLE / INDEX IF NOT EXISTS).
 *
 * Usage:
 *   node scripts/migrate-add-linkedin-invite-queue.mjs
 */

import { neon } from "@neondatabase/serverless"
import { config as loadEnv } from "dotenv"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(__dirname, "../.env.production.local") })
loadEnv({ path: resolve(__dirname, "../.env.local") })
loadEnv({ path: resolve(__dirname, "../apps/web/.env.production.local") })
loadEnv({ path: resolve(__dirname, "../apps/web/.env.local") })

if (!process.env.DATABASE_URL) {
  console.error("Missing DATABASE_URL")
  process.exit(1)
}

const sql = neon(process.env.DATABASE_URL)

const statements = [
  `CREATE TABLE IF NOT EXISTS linkedin_invite_queue (
    id                           BIGSERIAL    PRIMARY KEY,
    workspace_id                 TEXT         NOT NULL,
    contact_id                   BIGINT       NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    scheduled_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    status                       TEXT         NOT NULL DEFAULT 'queued',
    note                         TEXT,
    source                       TEXT         NOT NULL DEFAULT 'manual',
    triggered_by_signal_id       BIGINT       REFERENCES signals(id) ON DELETE SET NULL,
    requested_by_team_member_id  TEXT,
    unipile_invitation_id        TEXT,
    provider_id                  TEXT,
    sent_at                      TIMESTAMPTZ,
    accepted_at                  TIMESTAMPTZ,
    declined_at                  TIMESTAMPTZ,
    attempts                     INT          NOT NULL DEFAULT 0,
    last_attempt_at              TIMESTAMPTZ,
    last_error                   TEXT,
    created_at                   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at                   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS linkedin_invite_queue_due_idx
     ON linkedin_invite_queue (workspace_id, scheduled_at)
     WHERE status = 'queued'`,

  `CREATE INDEX IF NOT EXISTS linkedin_invite_queue_sent_window_idx
     ON linkedin_invite_queue (workspace_id, sent_at DESC)
     WHERE sent_at IS NOT NULL`,

  `CREATE UNIQUE INDEX IF NOT EXISTS linkedin_invite_queue_one_open_per_contact_idx
     ON linkedin_invite_queue (workspace_id, contact_id)
     WHERE status IN ('queued', 'sending', 'sent')`,

  `CREATE INDEX IF NOT EXISTS linkedin_invite_queue_contact_idx
     ON linkedin_invite_queue (contact_id, created_at DESC)`,
]

for (const s of statements) {
  process.stdout.write(`-> ${s.slice(0, 70).replace(/\s+/g, " ")}${s.length > 70 ? "..." : ""} `)
  await sql.query(s)
  console.log("OK")
}
console.log("\nMigration complete.")
