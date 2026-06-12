/**
 * Wizard session — stores state across the 6 wizard steps.
 * Uses Upstash Redis keyed by a session cookie. Falls back to in-memory
 * during local dev when UPSTASH_REDIS_REST_URL is not set.
 */

import type { WorkspaceBlueprint, Questionnaire } from "@signal-first/blueprint-schema"

export interface WizardSession {
  sessionId: string
  // Step 1: uploaded file references (Vercel Blob URLs)
  pitchDeckUrl?: string
  onePageUrl?: string
  crmExportUrl?: string
  // Parsed file content (stored after parsing)
  pitchDeckText?: string
  crmExportRows?: Record<string, string>[]
  crmExportHeaders?: string[]
  // Step 2: questionnaire answers
  questionnaire?: Questionnaire
  // Step 3+: generated blueprint
  blueprint?: WorkspaceBlueprint
  // Step 5: CRM OAuth token (encrypted reference stored in KV, not the raw token)
  crmTokenKey?: string
  // Step 6: provisioning workflow ID
  provisioningWorkflowId?: string
  createdAt: number
  updatedAt: number
}

const SESSION_TTL_SECONDS = 60 * 60 * 24 // 24 hours

// ─── Storage backend ──────────────────────────────────────────────────────────

type StorageBackend = {
  get: (key: string) => Promise<WizardSession | null>
  set: (key: string, value: WizardSession, ttl: number) => Promise<void>
}

function getStorage(): StorageBackend {
  if (process.env.UPSTASH_REDIS_REST_URL) {
    // Lazy import so the module doesn't error when Redis isn't configured
    return {
      async get(key) {
        const { Redis } = await import("@upstash/redis")
        const redis = Redis.fromEnv()
        return redis.get<WizardSession>(key)
      },
      async set(key, value, ttl) {
        const { Redis } = await import("@upstash/redis")
        const redis = Redis.fromEnv()
        await redis.set(key, value, { ex: ttl })
      },
    }
  }

  // In-memory fallback for local dev without Redis
  const store = new Map<string, { value: WizardSession; expiresAt: number }>()
  return {
    async get(key) {
      const entry = store.get(key)
      if (!entry || Date.now() > entry.expiresAt) return null
      return entry.value
    },
    async set(key, value, ttl) {
      store.set(key, { value, expiresAt: Date.now() + ttl * 1000 })
    },
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getSession(sessionId: string): Promise<WizardSession | null> {
  const storage = getStorage()
  return storage.get(`wizard:${sessionId}`)
}

export async function saveSession(session: WizardSession): Promise<void> {
  const storage = getStorage()
  const updated = { ...session, updatedAt: Date.now() }
  await storage.set(`wizard:${session.sessionId}`, updated, SESSION_TTL_SECONDS)
}

export async function createSession(): Promise<WizardSession> {
  const sessionId = crypto.randomUUID()
  const session: WizardSession = {
    sessionId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await saveSession(session)
  return session
}

export async function patchSession(
  sessionId: string,
  patch: Partial<Omit<WizardSession, "sessionId" | "createdAt">>,
): Promise<WizardSession> {
  const existing = await getSession(sessionId)
  const session: WizardSession = {
    ...(existing ?? { sessionId, createdAt: Date.now(), updatedAt: Date.now() }),
    ...patch,
    sessionId,
    updatedAt: Date.now(),
  }
  await saveSession(session)
  return session
}

export const SESSION_COOKIE = "sfcrm_session"
