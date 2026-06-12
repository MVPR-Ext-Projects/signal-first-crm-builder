"use client"

/**
 * Channel-separated Send composers.
 *
 *   - <SendEmailButton>  - AI-assisted email composer (Resend channel)
 *   - <SendDmButton>     - AI-assisted LinkedIn DM composer (Unipile channel)
 *
 * Each component owns its own modal. There is intentionally no shared
 * channel toggle, so an SDR is never one stray click away from sending
 * an email through the LinkedIn channel or vice versa. The underlying
 * modal body is shared via an internal <SendComposerModal> keyed on a
 * fixed `channel` prop.
 *
 * Visual contract for callers of either component: the email modal uses
 * the brand teal accent; the LinkedIn DM modal uses LinkedIn brand blue.
 * Anyone adding a new "send" surface should import one of these two
 * components - never roll a third "unified send".
 *
 * Both components accept an optional `renderTrigger` so callers can use
 * any custom button (e.g. the inline icon chips on the companies page)
 * as the opener.
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"

// ── Signal display helpers ────────────────────────────────────────────────

interface DmSignal {
  id:              number
  occurredAt:      string
  sourceType:      string | null
  description:     string | null
  signalVerb:      string | null
  signalActor:     string | null
  signalObject:    string | null
  verbDescription: string | null
  engagementUrl:   string | null
  scoreDelta:      number
}

const VERB_LABELS: Record<string, string> = {
  liked_post:                "Liked a post",
  commented_post:            "Commented on a post",
  viewed_profile:            "Viewed profile",
  followed_our_team_member:  "Followed team member",
  followed_our_company:      "Followed company page",
  followed_prospect:         "Team followed them",
  sent_connection_request:   "Sent connection request",
  accepted_our_connection:   "Accepted connection request",
  connected:                 "Connected",
  sent_dm:                   "DM sent",
  replied_dm:                "Replied to DM",
  replied_dm_initial:        "Replied to DM (first)",
  replied_dm_subsequent:     "Replied to DM (subsequent)",
  sent_email:                "Email sent",
  replied_email:             "Replied to email",
  booked_meeting:            "Booked a meeting",
  email_sent:                "Email sent",
  email_delivered:           "Email delivered",
  email_opened:              "Email opened",
  email_clicked:             "Email link clicked",
  email_bounced:             "Email bounced",
  email_complained:          "Email marked as spam",
  clicked_link:              "Link clicked",
  pr_pitch_sent:             "PR pitch sent",
  pr_journalist_replied:     "Journalist replied",
  pr_coverage_published:     "Coverage published",
}

function verbLabel(s: DmSignal): string {
  if (s.signalVerb && VERB_LABELS[s.signalVerb]) return VERB_LABELS[s.signalVerb]
  if (s.sourceType) return s.sourceType
  return "Engagement"
}

function relativeDate(iso: string): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ""
  const diffMs = Date.now() - t
  const min  = 60_000
  const hour = 60 * min
  const day  = 24 * hour
  if (diffMs < hour)    return `${Math.max(1, Math.round(diffMs / min))}m ago`
  if (diffMs < day)     return `${Math.round(diffMs / hour)}h ago`
  if (diffMs < 7 * day) return `${Math.round(diffMs / day)}d ago`
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
}

// ── Channel theming ───────────────────────────────────────────────────────

type Channel = "linkedin_dm" | "email"

function LinkedinGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.268 2.37 4.268 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  )
}

function EnvelopeGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  )
}

interface ChannelTheme {
  label:       string
  /** Brand accent for the channel pill + submit button. */
  accent:      string
  accentHover: string
  /** Glyph rendered in the channel pill and default trigger button. */
  Glyph:       () => React.ReactElement
  sendCopy:    string
  sendingCopy: string
  showSubject: boolean
  charLimit:   number
  placeholder: string
  endpointSlug: "send-dm" | "send-email"
  autoDraftOnOpen: boolean
}

const CHANNEL_THEME: Record<Channel, ChannelTheme> = {
  linkedin_dm: {
    label:           "LinkedIn DM",
    accent:          "#0A66C2",        // LinkedIn brand blue
    accentHover:     "#085196",
    Glyph:           LinkedinGlyph,
    sendCopy:        "Send LinkedIn DM",
    sendingCopy:     "Sending DM...",
    showSubject:     false,
    charLimit:       1900,
    placeholder:     "Type your DM, or click Draft fresh.",
    endpointSlug:    "send-dm",
    autoDraftOnOpen: true,             // matches old send-dm-button UX
  },
  email: {
    label:           "Email",
    accent:          "#2BA98B",        // brand teal
    accentHover:     "#239977",
    Glyph:           EnvelopeGlyph,
    sendCopy:        "Send email",
    sendingCopy:     "Sending email...",
    showSubject:     true,
    charLimit:       8000,
    placeholder:     "Type your email body, or click Draft fresh. Then optionally click Improve to apply the workspace voice.",
    endpointSlug:    "send-email",
    autoDraftOnOpen: false,            // user usually picks subject first
  },
}

// ── Internal: shared composer body (channel is fixed for the lifetime) ────

function SendComposerModal({
  workspaceId,
  linkedinUrl,
  email,
  name,
  channel,
  onClose,
}: {
  workspaceId: string
  linkedinUrl?: string
  email?:       string
  name:         string
  channel:      Channel
  onClose:      () => void
}) {
  const router = useRouter()
  const theme  = CHANNEL_THEME[channel]
  const Glyph  = theme.Glyph

  const [subject, setSubject]   = useState("")
  const [message, setMessage]   = useState("")
  const [busy, setBusy]         = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [sent, setSent]         = useState(false)
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<string[]>([])
  const [fingerprintVersionId, setFingerprintVersionId] = useState<number | null>(null)
  const [signals, setSignals]               = useState<DmSignal[] | null>(null)
  const [signalsLoading, setSignalsLoading] = useState(false)

  async function runDraft() {
    setDrafting(true)
    setError(null)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/draft-message`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ channel, linkedinUrl, email, mode: "draft" }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.draft) {
        setError(data.error ?? `Draft failed (${res.status})`)
        return
      }
      setMessage(data.draft as string)
      setSelectedTemplateIds(Array.isArray(data.selectedTemplateIds) ? data.selectedTemplateIds : [])
      setFingerprintVersionId(typeof data.fingerprintVersionId === "number" ? data.fingerprintVersionId : null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setDrafting(false)
    }
  }

  async function runImprove() {
    if (!message.trim()) return
    setDrafting(true)
    setError(null)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/draft-message`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          channel,
          linkedinUrl,
          email,
          mode:      "improve",
          seed_text: message,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.draft) {
        setError(data.error ?? `Improve failed (${res.status})`)
        return
      }
      setMessage(data.draft as string)
      setFingerprintVersionId(typeof data.fingerprintVersionId === "number" ? data.fingerprintVersionId : null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setDrafting(false)
    }
  }

  useEffect(() => {
    if (theme.autoDraftOnOpen && !message && !drafting) {
      void runDraft()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!linkedinUrl) return
    let cancelled = false
    setSignalsLoading(true)
    fetch(`/api/dashboard/${workspaceId}/contact-signals?linkedinUrl=${encodeURIComponent(linkedinUrl)}`)
      .then(r => (r.ok ? r.json() : { signals: [] }))
      .then((d: { signals?: DmSignal[] }) => { if (!cancelled) setSignals(d.signals ?? []) })
      .catch(() => { if (!cancelled) setSignals([]) })
      .finally(() => { if (!cancelled) setSignalsLoading(false) })
    return () => { cancelled = true }
  }, [workspaceId, linkedinUrl])

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    if (!message.trim()) return
    if (channel === "email" && !subject.trim()) {
      setError("Subject is required for email sends.")
      return
    }
    setBusy(true)
    setError(null)
    try {
      const endpoint = `/api/dashboard/${workspaceId}/${theme.endpointSlug}`
      const body = channel === "linkedin_dm"
        ? { linkedinUrl, message: message.trim(), selectedTemplateIds, fingerprintVersionId }
        : { linkedinUrl, email, subject: subject.trim(), body: message.trim(), selectedTemplateIds, fingerprintVersionId }
      const res = await fetch(endpoint, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Send failed (${res.status})`)
        setBusy(false)
        return
      }
      setSent(true)
      setTimeout(() => {
        onClose()
        router.refresh()
      }, 1200)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  function handleClose() {
    if (busy || drafting) return
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
      onClick={handleClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#0B3D2E] p-6 shadow-[0_12px_32px_rgba(0,0,0,0.45)]"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <span
              className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.10em]"
              style={{ backgroundColor: `${theme.accent}22`, color: theme.accent }}
            >
              <Glyph />
              {theme.label}
            </span>
            <h3 className="mt-2 text-[18px] font-bold text-white">Send to {name}</h3>
          </div>
          <button type="button" onClick={handleClose} disabled={busy} className="text-zinc-400 hover:text-white disabled:opacity-40" aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <line x1="6" y1="6"  x2="18" y2="18" />
              <line x1="6" y1="18" x2="18" y2="6"  />
            </svg>
          </button>
        </div>

        {sent ? (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-[13px] text-emerald-300">
            Sent. Logged in this lead&rsquo;s engagement history.
          </div>
        ) : (
          <form onSubmit={handleSend} className="space-y-3">
            {theme.showSubject && (
              <div>
                <label className="mb-1 block text-[11px] font-medium text-zinc-400">Subject</label>
                <input
                  type="text"
                  value={subject}
                  onChange={e => setSubject(e.target.value)}
                  placeholder="Subject line"
                  required
                  disabled={drafting}
                  maxLength={200}
                  className="w-full rounded-lg border border-white/14 bg-white/[0.04] px-3 py-2 text-[14px] text-white placeholder-zinc-500 focus:outline-none focus:ring-1 disabled:opacity-60"
                  style={{ borderColor: undefined }}
                />
              </div>
            )}

            <div className="relative">
              <textarea
                value={message}
                onChange={e => setMessage(e.target.value)}
                placeholder={drafting ? "AI working..." : theme.placeholder}
                rows={channel === "email" ? 10 : 7}
                required
                disabled={drafting}
                maxLength={theme.charLimit}
                className="w-full resize-none rounded-xl border border-white/14 bg-white/[0.04] px-3 py-2 text-[14px] text-white placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-[#2BA98B]/40 disabled:opacity-60"
              />
              {drafting && (
                <span
                  className="absolute right-2 top-2 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px]"
                  style={{ backgroundColor: `${theme.accent}28`, color: theme.accent }}
                  aria-live="polite"
                >
                  <svg className="animate-spin motion-reduce:animate-none" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden>
                    <path d="M21 12a9 9 0 1 1-6.22-8.55" />
                  </svg>
                  AI working...
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-zinc-500 tabular-nums">{message.length}/{theme.charLimit}</span>
                <button
                  type="button"
                  onClick={runDraft}
                  disabled={drafting || busy}
                  className="inline-flex items-center gap-1 rounded-md border border-white/14 px-2 py-1 text-[10px] text-zinc-300 hover:text-white focus-visible:outline-none focus-visible:ring-2 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Generate a fresh AI draft from scratch"
                >
                  Draft fresh
                </button>
                <button
                  type="button"
                  onClick={runImprove}
                  disabled={drafting || busy || !message.trim()}
                  className="inline-flex items-center gap-1 rounded-md border border-white/14 px-2 py-1 text-[10px] text-zinc-300 hover:text-white focus-visible:outline-none focus-visible:ring-2 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Rewrite the current body in the workspace voice"
                >
                  Improve this
                </button>
              </div>
              <div className="flex items-center gap-2">
                {error && <span className="max-w-[240px] truncate text-[10px] text-rose-400" title={error}>{error}</span>}
                <button type="button" onClick={handleClose} disabled={busy || drafting} className="rounded-md px-3 py-1.5 text-[12px] text-zinc-300 hover:text-white disabled:opacity-50">Cancel</button>
                <button
                  type="submit"
                  disabled={busy || drafting || !message.trim() || (channel === "email" && !subject.trim())}
                  className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-bold text-white transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
                  style={{ backgroundColor: theme.accent }}
                >
                  <Glyph />
                  {busy ? theme.sendingCopy : theme.sendCopy}
                </button>
              </div>
            </div>
          </form>
        )}

        {!sent && linkedinUrl && (
          <div className="mt-5 border-t border-white/10 pt-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-zinc-400">
              Recent engagement
              {signals && signals.length > 0 ? ` · ${signals.length}` : ""}
            </p>
            {signalsLoading && <p className="mt-2 text-[12px] text-zinc-500">Loading...</p>}
            {!signalsLoading && signals && signals.length === 0 && (
              <p className="mt-2 text-[12px] text-zinc-500">No recorded signals for this contact yet.</p>
            )}
            {!signalsLoading && signals && signals.length > 0 && (
              <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto pr-1">
                {signals.map(s => (
                  <li key={s.id} className="flex items-start justify-between gap-3 rounded-md bg-white/[0.04] px-2.5 py-1.5 text-[12px]">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-zinc-200">{verbLabel(s)}</p>
                      {s.description && (
                        <p className="mt-0.5 truncate text-zinc-400" title={s.description}>{s.description}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-0.5">
                      <span className="text-[10px] text-zinc-500 tabular-nums">{relativeDate(s.occurredAt)}</span>
                      {s.scoreDelta > 0 && (
                        <span className="text-[10px] font-medium text-[#2BA98B]">+{s.scoreDelta} pts</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Public components: one per channel ────────────────────────────────────

interface SendChannelButtonProps {
  workspaceId:    string
  linkedinUrl?:   string
  email?:         string
  name:           string
  /** Optional custom trigger. Defaults to a labelled inline button. */
  renderTrigger?: (open: () => void) => React.ReactNode
}

export function SendEmailButton(props: SendChannelButtonProps) {
  return <ChannelButton {...props} channel="email" />
}

export function SendDmButton(props: SendChannelButtonProps) {
  return <ChannelButton {...props} channel="linkedin_dm" />
}

function ChannelButton({
  workspaceId,
  linkedinUrl,
  email,
  name,
  renderTrigger,
  channel,
}: SendChannelButtonProps & { channel: Channel }) {
  const [open, setOpen] = useState(false)
  const theme = CHANNEL_THEME[channel]
  const Glyph = theme.Glyph
  const triggerOpen = () => setOpen(true)

  return (
    <>
      {renderTrigger ? (
        renderTrigger(triggerOpen)
      ) : (
        <button
          type="button"
          onClick={triggerOpen}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 motion-reduce:transition-none"
          style={{ color: theme.accent }}
        >
          <Glyph />
          {theme.sendCopy}
        </button>
      )}
      {open && (
        <SendComposerModal
          workspaceId={workspaceId}
          linkedinUrl={linkedinUrl}
          email={email}
          name={name}
          channel={channel}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
