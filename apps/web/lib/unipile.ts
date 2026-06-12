/**
 * Unipile — unified messaging API.
 *
 * Used to send LinkedIn DMs (and eventually receive replies) from each lead
 * in the SDR dashboard. Unipile handles the LinkedIn session and rate-limits;
 * we only care about its REST surface.
 *
 * Per-tenant: every workspace brings their own Unipile API key + DSN +
 * connected-account ID. See WorkspaceConfig.messaging.unipile.
 *
 * To send a DM to a contact we have a LinkedIn URL for, we have to:
 *   1. Extract the public_identifier from the URL (.../in/<slug>)
 *   2. GET /api/v1/users/<slug>?account_id=... — Unipile resolves it to a
 *      provider_id (the LinkedIn URN we send a chat to)
 *   3. POST /api/v1/chats with attendees_ids=[provider_id], text=message
 */

interface UnipileCreds {
  apiKey:    string
  dsn:       string  // e.g. https://api6.unipile.com:13670
  accountId: string  // the connected LinkedIn account inside Unipile
}

const headers = (apiKey: string) => ({
  "X-API-KEY":    apiKey,
  Accept:         "application/json",
  "Content-Type": "application/json",
})

/**
 * Pull the public_identifier (slug) out of a LinkedIn URL.
 *   https://www.linkedin.com/in/jane-doe/  → "jane-doe"
 * Returns null when the URL doesn't look like a /in/ profile URL.
 */
export function publicIdentifierFromUrl(url: string): string | null {
  const m = url.match(/linkedin\.com\/in\/([^/?#]+)/i)
  return m ? m[1] : null
}

/**
 * Resolve a LinkedIn slug to a Unipile provider_id (the LinkedIn URN).
 * Returns null if Unipile can't find the user (e.g. private profile, account
 * not connected, slug typo).
 */
/**
 * Some configs store DSN without a scheme (e.g. `api6.unipile.com:13670`).
 * Vercel's Rust-based fetch rejects schemeless URLs with "unknown scheme",
 * crashing draft-dm. Normalise by prepending https:// when missing.
 */
function normaliseDsn(dsn: string): string {
  const trimmed = dsn.trim().replace(/\/$/, "")
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

export async function resolveProviderId(
  slug: string,
  creds: UnipileCreds,
): Promise<string | null> {
  const url = `${normaliseDsn(creds.dsn)}/api/v1/users/${encodeURIComponent(slug)}?account_id=${encodeURIComponent(creds.accountId)}`
  try {
    const res = await fetch(url, { headers: headers(creds.apiKey), cache: "no-store" })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      console.warn(`[unipile] resolveProviderId ${slug} failed ${res.status}: ${text.slice(0, 200)}`)
      return null
    }
    const data = (await res.json()) as { provider_id?: string; id?: string }
    return data.provider_id ?? data.id ?? null
  } catch (err) {
    console.warn(`[unipile] resolveProviderId ${slug} threw: ${(err as Error).message}`)
    return null
  }
}

export interface SendDmResult {
  ok: true
  chatId:    string | null
  messageId: string | null
}

export interface SendDmFailure {
  ok: false
  error: string
}

/**
 * Send a brand-new LinkedIn DM. Resolves the recipient's URL → provider_id,
 * then opens a chat with the message body. Returns the new chat + message
 * IDs so callers can record them in the signal log.
 */
export async function sendLinkedInDm(args: {
  creds:        UnipileCreds
  linkedinUrl:  string
  message:      string
}): Promise<SendDmResult | SendDmFailure> {
  const { creds, linkedinUrl, message } = args
  const slug = publicIdentifierFromUrl(linkedinUrl)
  if (!slug) {
    return { ok: false, error: "LinkedIn URL doesn't look like a /in/<slug> profile URL" }
  }

  const providerId = await resolveProviderId(slug, creds)
  if (!providerId) {
    return { ok: false, error: "Unipile couldn't resolve that LinkedIn profile" }
  }

  const url = `${normaliseDsn(creds.dsn)}/api/v1/chats`
  const res = await fetch(url, {
    method:  "POST",
    headers: headers(creds.apiKey),
    body:    JSON.stringify({
      account_id:    creds.accountId,
      attendees_ids: [providerId],
      text:          message,
    }),
    cache: "no-store",
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    return { ok: false, error: `Unipile send failed (${res.status}): ${text.slice(0, 200)}` }
  }

  const data = (await res.json()) as {
    chat_id?:    string
    object?:     { chat_id?: string; id?: string }
    message_id?: string
    id?:         string
  }
  return {
    ok:        true,
    chatId:    data.chat_id ?? data.object?.chat_id ?? data.object?.id ?? null,
    messageId: data.message_id ?? data.id ?? null,
  }
}

export interface SendInviteResult {
  ok: true
  invitationId: string | null
  providerId:   string
}

export interface SendInviteFailure {
  ok: false
  error:      string
  /** True when the failure is the recipient's profile being unresolvable
   *  (we can mark the LinkedIn URL inactive). False for transport / quota
   *  errors that should retry later. */
  fatal:      boolean
  providerId: string | null
}

/**
 * Send a LinkedIn connection invitation. Resolves the recipient's URL ->
 * provider_id, then POSTs to /users/invite with an optional note.
 *
 * Free LinkedIn accounts only allow ~5 invitation notes per month, so most
 * callers should leave `message` undefined.
 */
export async function sendLinkedInInvite(args: {
  creds:        UnipileCreds
  linkedinUrl:  string
  message?:     string
}): Promise<SendInviteResult | SendInviteFailure> {
  const { creds, linkedinUrl, message } = args
  const slug = publicIdentifierFromUrl(linkedinUrl)
  if (!slug) {
    return { ok: false, error: "LinkedIn URL doesn't look like a /in/<slug> profile URL", fatal: true, providerId: null }
  }

  const providerId = await resolveProviderId(slug, creds)
  if (!providerId) {
    return { ok: false, error: "Unipile couldn't resolve that LinkedIn profile", fatal: true, providerId: null }
  }

  const url = `${normaliseDsn(creds.dsn)}/api/v1/users/invite`
  const body: Record<string, unknown> = {
    account_id:  creds.accountId,
    provider_id: providerId,
  }
  if (message && message.trim().length > 0) body.message = message.trim()

  const res = await fetch(url, {
    method:  "POST",
    headers: headers(creds.apiKey),
    body:    JSON.stringify(body),
    cache:   "no-store",
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    // 429 / 5xx are transient; everything else is treated as terminal so the
    // worker doesn't keep retrying a permanent error.
    const fatal = !(res.status === 429 || res.status >= 500)
    return { ok: false, error: `Unipile invite failed (${res.status}): ${text.slice(0, 200)}`, fatal, providerId }
  }

  const data = (await res.json()) as { invitation_id?: string; id?: string }
  return {
    ok:           true,
    invitationId: data.invitation_id ?? data.id ?? null,
    providerId,
  }
}

export interface UnipileRelation {
  /** LinkedIn slug, e.g. "stefan-maritz". Empty when Unipile doesn't surface it. */
  publicIdentifier: string | null
  /** Unipile's internal member_id URN. */
  memberId:         string | null
  firstName:        string | null
  lastName:         string | null
}

/**
 * One page of the connected LinkedIn account's 1st-degree connections.
 * Caller paginates by passing the returned `nextCursor` until it's null.
 * Unipile defaults to ~50 per page; bumped to 100 for fewer round-trips.
 */
export async function listLinkedInRelations(args: {
  creds:  UnipileCreds
  cursor?: string | null
  limit?:  number
}): Promise<{ relations: UnipileRelation[]; nextCursor: string | null }> {
  const { creds, cursor, limit = 100 } = args
  const url = new URL(`${normaliseDsn(creds.dsn)}/api/v1/users/relations`)
  url.searchParams.set("account_id", creds.accountId)
  url.searchParams.set("limit", String(limit))
  if (cursor) url.searchParams.set("cursor", cursor)

  const res = await fetch(url.toString(), { headers: headers(creds.apiKey), cache: "no-store" })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Unipile relations failed (${res.status}): ${text.slice(0, 200)}`)
  }
  const data = (await res.json()) as {
    items?: Array<{ public_identifier?: string; member_id?: string; first_name?: string; last_name?: string }>
    cursor?: string | null
  }
  const items = data.items ?? []
  return {
    relations: items.map(r => ({
      publicIdentifier: r.public_identifier ?? null,
      memberId:         r.member_id ?? null,
      firstName:        r.first_name ?? null,
      lastName:         r.last_name ?? null,
    })),
    nextCursor: data.cursor ?? null,
  }
}

export interface ThreadMessage {
  /** Who sent the message — "us" = the workspace's connected LinkedIn, "them" = the lead. */
  from:      "us" | "them"
  text:      string
  /** ISO timestamp if Unipile gives us one. */
  timestamp: string | null
}

interface UnipileChatRecord {
  id?: string
  chat_id?: string
}

interface UnipileMessageRecord {
  id?:           string
  text?:         string
  body?:         string
  content?:      string
  message?:      string
  is_sender?:    boolean
  sender_id?:    string
  from_provider_id?: string
  timestamp?:    string
  created_at?:   string
}

/**
 * Fetch the recent DM history between the workspace's LinkedIn account and the
 * given lead. Used to feed prior turns into the draft-DM prompt so the model
 * doesn't repeat itself or ignore the lead's replies.
 *
 * Returns [] when there is no chat yet, when the lookup fails for any reason,
 * or when Unipile returns a payload shape we don't recognise. We never want a
 * draft to fail because history pulling broke — the LLM can still draft from
 * the signal context alone.
 */
export async function fetchLinkedInThread(args: {
  creds:       UnipileCreds
  linkedinUrl: string
  /** Cap on messages returned (most recent first). Default 12. */
  limit?:      number
}): Promise<ThreadMessage[]> {
  const { creds, linkedinUrl } = args
  const limit = args.limit ?? 12

  const slug = publicIdentifierFromUrl(linkedinUrl)
  if (!slug) return []

  const providerId = await resolveProviderId(slug, creds)
  if (!providerId) return []

  // Find the chat with this attendee. Unipile's chats list endpoint accepts an
  // `attendee_provider_ids` filter; we ask for a single result, most-recent.
  const base = normaliseDsn(creds.dsn)
  const chatUrl =
    `${base}/api/v1/chats?account_id=${encodeURIComponent(creds.accountId)}` +
    `&attendee_provider_ids=${encodeURIComponent(providerId)}&limit=1`

  let chatId: string | null = null
  try {
    const res = await fetch(chatUrl, { headers: headers(creds.apiKey), cache: "no-store" })
    if (!res.ok) return []
    const data = (await res.json()) as { items?: UnipileChatRecord[]; chats?: UnipileChatRecord[] }
    const list = data.items ?? data.chats ?? []
    chatId = list[0]?.id ?? list[0]?.chat_id ?? null
  } catch {
    return []
  }
  if (!chatId) return []

  // Validate the chat actually includes the expected attendee. Unipile's
  // attendee_provider_ids filter can return the wrong chat in some edge cases
  // (e.g. stale index, account reconnect). If the attendees list doesn't include
  // the lead's providerId, bail out rather than feed wrong context to the model.
  try {
    const detailRes = await fetch(`${base}/api/v1/chats/${encodeURIComponent(chatId)}?account_id=${encodeURIComponent(creds.accountId)}`, {
      headers: { "X-API-KEY": creds.apiKey, Accept: "application/json" },
      cache: "no-store",
    })
    if (detailRes.ok) {
      const detail = await detailRes.json() as { attendees?: Array<{ provider_id?: string; id?: string }> }
      const attendees = detail.attendees ?? []
      const hasExpected = attendees.some(a => (a.provider_id ?? a.id) === providerId)
      if (!hasExpected) {
        console.warn(`[unipile] fetchLinkedInThread: chat ${chatId} attendees don't include ${providerId} — discarding`)
        return []
      }
    }
  } catch {
    // validation is best-effort; proceed if it throws
  }

  // Pull the messages.
  const msgUrl =
    `${base}/api/v1/chats/${encodeURIComponent(chatId)}/messages` +
    `?account_id=${encodeURIComponent(creds.accountId)}&limit=${limit}`
  let messages: UnipileMessageRecord[] = []
  try {
    const res = await fetch(msgUrl, { headers: headers(creds.apiKey), cache: "no-store" })
    if (!res.ok) return []
    const data = (await res.json()) as { items?: UnipileMessageRecord[]; messages?: UnipileMessageRecord[] }
    messages = data.items ?? data.messages ?? []
  } catch {
    return []
  }

  // Normalise. Direction is is_sender=true → us, else → them. Some payloads
  // expose sender_id / from_provider_id instead — fall back to comparing
  // against the recipient's provider_id (anything that's NOT them is us).
  const out: ThreadMessage[] = []
  for (const m of messages) {
    const text = (m.text ?? m.body ?? m.content ?? m.message ?? "").trim()
    if (!text) continue
    let from: ThreadMessage["from"]
    if (typeof m.is_sender === "boolean") {
      from = m.is_sender ? "us" : "them"
    } else {
      const senderId = m.sender_id ?? m.from_provider_id ?? null
      from = senderId && senderId === providerId ? "them" : "us"
    }
    out.push({
      from,
      text,
      timestamp: m.timestamp ?? m.created_at ?? null,
    })
  }
  return out
}
