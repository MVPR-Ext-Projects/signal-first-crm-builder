/**
 * Migration: add the calendly_bookings table.
 *
 * Calendly's invitee.created and invitee.canceled webhooks land in
 * apps/web/app/api/webhooks/[workspaceId]/calendly/route.ts. Each booking
 * gets the rich event payload preserved here plus a booked_meeting signal
 * on the matching contact (existing verb in schema.sql).
 *
 * What this adds:
 *   - calendly_bookings table — one row per Calendly event
 *   - calendly_bookings_workspace_time_idx — list-by-time queries
 *   - calendly_bookings_contact_idx        — per-contact booking lookups
 *
 * Idempotent. Strictly additive. Safe to run multiple times.
 *
 * Usage:
 *   node scripts/migrate-add-calendly-bookings-table.mjs
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
  console.error("✗ Missing DATABASE_URL")
  process.exit(1)
}

const sql = neon(process.env.DATABASE_URL)

const statements = [
  `CREATE TABLE IF NOT EXISTS calendly_bookings (
    id                  BIGSERIAL    PRIMARY KEY,
    workspace_id        TEXT         NOT NULL,
    -- Stable Calendly event URI - prevents double-writes when Calendly retries
    -- the same webhook (and lets us match invitee.canceled back to the original).
    calendly_event_uri  TEXT         NOT NULL UNIQUE,
    -- Event type info: uri is the API ref, slug is the URL-tail (e.g.
    -- "mvpr-for-agency-teams"), name is the human label.
    event_type_uri      TEXT         NOT NULL,
    -- Slug derived from event_type_uri via a known-URI -> slug map at write
    -- time. Nullable because new event types won't be in the map until added.
    event_type_slug     TEXT,
    event_type_name     TEXT         NOT NULL,
    -- Invitee details copied from the webhook payload.
    invitee_email       TEXT         NOT NULL,
    invitee_name        TEXT,
    -- When the meeting itself is scheduled. Separate from created_at, which
    -- is when the booking was made.
    scheduled_for       TIMESTAMPTZ  NOT NULL,
    -- Populated on invitee.canceled; NULL while the meeting is live.
    cancelled_at        TIMESTAMPTZ,
    -- Form field answers Calendly collects per-event-type. Variable shape,
    -- preserved as-is for downstream review.
    custom_answers      JSONB,
    -- Raw webhook payload kept so we can reprocess if our parser changes.
    raw_payload         JSONB        NOT NULL,
    -- FK to the gtm-os contact created/upserted at webhook time. Nullable so
    -- we can still record the booking if contact upsert fails.
    contact_id          BIGINT       REFERENCES contacts(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS calendly_bookings_workspace_time_idx
    ON calendly_bookings (workspace_id, scheduled_for DESC)`,

  `CREATE INDEX IF NOT EXISTS calendly_bookings_contact_idx
    ON calendly_bookings (contact_id)
    WHERE contact_id IS NOT NULL`,
]

for (const s of statements) {
  process.stdout.write(`→ ${s.slice(0, 80).replace(/\s+/g, " ")}${s.length > 80 ? "…" : ""} `)
  await sql.query(s)
  console.log("✓")
}
console.log("\nMigration complete.")
