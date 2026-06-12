/**
 * Channels store - the parent entity above campaigns.
 *
 * A channel carries a delivery mechanism ('unipile' / 'resend' / 'none' /
 * future) and whether it supports a per-campaign writing-style fingerprint.
 * Campaigns nest under a channel via `campaigns.channel_id`.
 *
 * The hardcoded /actions sections (PR coverage, LinkedIn DM, Direct Email,
 * Newsletter, Product Updates, Outbound Calls) seed as channels on
 * migration so existing campaign + stats data has a home. The migration
 * script handles the seed; this store is the runtime read/write surface.
 */

import { sql, isDbConfigured } from "./index"

export type DeliveryMechanism = "none" | "unipile" | "resend" | "twilio_voice"

export interface ChannelRow {
  id:                 string
  workspaceId:        string
  name:               string
  deliveryMechanism:  DeliveryMechanism
  hasFingerprint:     boolean
  createdAt:          string
  archivedAt:         string | null
}

interface DbRow {
  id:                  string
  workspace_id:        string
  name:                string
  delivery_mechanism:  string
  has_fingerprint:     boolean
  created_at:          Date
  archived_at:         Date | null
}

function mapRow(r: DbRow): ChannelRow {
  return {
    id:                r.id,
    workspaceId:       r.workspace_id,
    name:              r.name,
    deliveryMechanism: r.delivery_mechanism as DeliveryMechanism,
    hasFingerprint:    r.has_fingerprint,
    createdAt:         r.created_at.toISOString(),
    archivedAt:        r.archived_at?.toISOString() ?? null,
  }
}

export async function listChannels(
  workspaceId: string,
  includeArchived = false,
): Promise<ChannelRow[]> {
  if (!isDbConfigured()) return []
  const db = sql()
  const rows = includeArchived
    ? await db<DbRow>`
        SELECT id, workspace_id, name, delivery_mechanism, has_fingerprint, created_at, archived_at
        FROM channels
        WHERE workspace_id = ${workspaceId}
        ORDER BY created_at ASC
      `
    : await db<DbRow>`
        SELECT id, workspace_id, name, delivery_mechanism, has_fingerprint, created_at, archived_at
        FROM channels
        WHERE workspace_id = ${workspaceId}
          AND archived_at IS NULL
        ORDER BY created_at ASC
      `
  return rows.map(mapRow)
}

export async function getChannelById(
  workspaceId: string,
  id:          string,
): Promise<ChannelRow | null> {
  if (!isDbConfigured()) return null
  const db = sql()
  const rows = await db<DbRow>`
    SELECT id, workspace_id, name, delivery_mechanism, has_fingerprint, created_at, archived_at
    FROM channels
    WHERE workspace_id = ${workspaceId} AND id = ${id}
    LIMIT 1
  `
  return rows[0] ? mapRow(rows[0]) : null
}

export async function createChannel(args: {
  workspaceId:        string
  name:               string
  deliveryMechanism:  DeliveryMechanism
  hasFingerprint?:    boolean
}): Promise<string | null> {
  if (!isDbConfigured()) return null
  const id = crypto.randomUUID()
  const db = sql()
  await db`
    INSERT INTO channels (id, workspace_id, name, delivery_mechanism, has_fingerprint)
    VALUES (
      ${id}, ${args.workspaceId}, ${args.name},
      ${args.deliveryMechanism}, ${args.hasFingerprint ?? false}
    )
  `
  return id
}

export async function updateChannel(args: {
  workspaceId:         string
  id:                  string
  name?:               string
  deliveryMechanism?:  DeliveryMechanism
  hasFingerprint?:     boolean
}): Promise<boolean> {
  if (!isDbConfigured()) return false
  const db = sql()
  const res = await db`
    UPDATE channels SET
      name               = COALESCE(${args.name              ?? null}, name),
      delivery_mechanism = COALESCE(${args.deliveryMechanism ?? null}, delivery_mechanism),
      has_fingerprint    = COALESCE(${args.hasFingerprint    ?? null}, has_fingerprint)
    WHERE workspace_id = ${args.workspaceId} AND id = ${args.id}
  `
  return (res as unknown as { count: number }).count > 0
}

export async function archiveChannel(
  workspaceId: string,
  id:          string,
): Promise<boolean> {
  if (!isDbConfigured()) return false
  const db = sql()
  const res = await db`
    UPDATE channels SET archived_at = NOW()
    WHERE workspace_id = ${workspaceId}
      AND id           = ${id}
      AND archived_at  IS NULL
  `
  return (res as unknown as { count: number }).count > 0
}

/** Lookup a channel by its display name. Used during draft/attach flows
 *  where the legacy enum value is the only reference available. */
export async function findChannelByName(
  workspaceId: string,
  name:        string,
): Promise<ChannelRow | null> {
  if (!isDbConfigured()) return null
  const db = sql()
  const rows = await db<DbRow>`
    SELECT id, workspace_id, name, delivery_mechanism, has_fingerprint, created_at, archived_at
    FROM channels
    WHERE workspace_id = ${workspaceId}
      AND name         = ${name}
      AND archived_at  IS NULL
    LIMIT 1
  `
  return rows[0] ? mapRow(rows[0]) : null
}
