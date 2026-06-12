"use client"

import { Fragment, useState } from "react"
import { useRouter } from "next/navigation"
import { ContactCheckbox } from "./company-selection"
import { ActivityLogInlineForm, type ActivityType } from "../components/activity-log-form"
import { SendEmailButton, SendDmButton } from "../components/send-button"
import { ManualContactEdit } from "../components/manual-contact-edit"
import { useToast } from "../toast"

interface CompanyContactRow {
  id:                    number
  fullName:              string | null
  jobTitle:              string | null
  linkedinUrl:           string | null
  twitterUrl:            string | null
  email:                 string | null
  companyName:           string | null
  linkedinConnected:     boolean | null
  linkedinInvitePending: boolean
  signalScore:           number
  signalCount:           number
  lastSignalAt:          string | Date | null
  lastSignalType:        string | null
  lastSignalDescription: string | null
  lastSignalVerb:        string | null
  lastSignalActor:       string | null
  lastSignalObject:      string | null
  lastVerbDescription:   string | null
  lastEngagementUrl:     string | null
  isChampion:            boolean
  doNotContactUntil:     string | Date | null
}

const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "yahoo.fr",
  "hotmail.com", "hotmail.co.uk", "hotmail.fr", "outlook.com", "live.com",
  "live.co.uk", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com",
  "protonmail.com", "pm.me", "proton.me", "mail.com", "ymail.com",
  "zoho.com", "fastmail.com", "hey.com",
])

function classifyEmail(email: string | null): "corporate" | "personal" | "none" {
  if (!email) return "none"
  const domain = email.split("@")[1]?.toLowerCase() ?? ""
  return FREE_EMAIL_DOMAINS.has(domain) ? "personal" : "corporate"
}

// Cap displayed job titles so LinkedIn-headline bios don't blow out the row.
// Full title still surfaces via the title attribute (hover tooltip).
const JOB_TITLE_MAX = 35
function clampJobTitle(title: string): string {
  if (title.length <= JOB_TITLE_MAX) return title
  return title.slice(0, JOB_TITLE_MAX).trimEnd() + "…"
}

// When a verb falls through getSignalDisplay's switch (e.g. call_not_answered
// has no explicit case yet), the raw snake_case verb name comes through. This
// renders that as plain space-separated lowercase text so the cell reads as
// inline content rather than a code identifier.
function humanizeSignalLabel(label: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(label)) return label
  return label.replace(/_/g, " ")
}

// Shared chip + badge style so the row chips match the StatusIcon pattern
// used at the top of each CompanyCard. Same h-3.5 / black 1px border / 7px
// glyph / white strokes everywhere - keeps the visual language consistent
// between the company-header status icons and the per-person row chips.
const CHIP_BASE   = "relative inline-flex h-6 w-6 items-center justify-center rounded-[6px] bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60 motion-reduce:transition-none"
const CHIP_ACTIVE = "transition-colors hover:bg-white/[0.12]"
const CHIP_CONFIRM = "bg-rose-500/[0.16] hover:bg-rose-500/[0.24]"

function StatusBadge({ present, pending }: { present: boolean; pending?: boolean }) {
  const bg = pending ? "#F59E0B" : present ? "#14B8A6" : "#AA5882"
  return (
    <span
      className="pointer-events-none absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full"
      style={{ backgroundColor: bg, border: "1px solid #000" }}
      aria-hidden
    >
      {pending ? (
        // Diagonal upward arrow - invite queued, awaiting send / accept
        <svg width="7" height="7" viewBox="0 0 10 10" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <line x1="2" y1="8" x2="8" y2="2" />
          <polyline points="3.5 2 8 2 8 6.5" />
        </svg>
      ) : present ? (
        <svg width="7" height="7" viewBox="0 0 10 10" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="1.5 5.5 4 8 8.5 2" />
        </svg>
      ) : (
        <svg width="7" height="7" viewBox="0 0 10 10" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
          <line x1="2" y1="2" x2="8" y2="8" />
          <line x1="8" y1="2" x2="2" y2="8" />
        </svg>
      )}
    </span>
  )
}

/** Render-prop wrapper that picks the right channel-specific Send component.
 *  When the action isn't possible (no LinkedIn for DM, no email/LI for email)
 *  the trigger renders muted with a no-op opener. */
function SendChipTrigger({
  workspaceId,
  contact,
  channel,
  unipileConfigured,
  children,
}: {
  workspaceId:       string
  contact:           CompanyContactRow
  channel:           "linkedin_dm" | "email"
  unipileConfigured: boolean
  children:          (open: () => void) => React.ReactNode
}) {
  const possible =
    channel === "linkedin_dm"
      ? !!(contact.linkedinUrl && unipileConfigured)
      : !!(contact.email || contact.linkedinUrl)
  if (!possible) return <>{children(() => { /* no-op */ })}</>

  const sharedProps = {
    workspaceId,
    linkedinUrl:   contact.linkedinUrl ?? undefined,
    email:         contact.email ?? undefined,
    name:          contact.fullName ?? "this contact",
    renderTrigger: children,
  }
  return channel === "linkedin_dm"
    ? <SendDmButton    {...sharedProps} />
    : <SendEmailButton {...sharedProps} />
}

/** Links cluster: pure profile-link chips for external research.
 *  Clicking opens the contact's LinkedIn or X profile in a new tab.
 *  Connection / invite actions live in ActionsChips. */
function LinksChips({ contact }: { contact: CompanyContactRow }) {
  const linkedinUrl = contact.linkedinUrl
  const twitterUrl  = contact.twitterUrl

  const linkedinHref = linkedinUrl
    ? (linkedinUrl.startsWith("http") ? linkedinUrl : `https://${linkedinUrl}`)
    : null
  const twitterHref = twitterUrl
    ? (twitterUrl.startsWith("http") ? twitterUrl : `https://${twitterUrl}`)
    : null

  const stopRow = (e: React.MouseEvent) => e.stopPropagation()

  return (
    <div className="flex items-center gap-1.5" onClick={stopRow}>
      {linkedinHref && (
        <a
          href={linkedinHref}
          target="_blank"
          rel="noopener noreferrer"
          title="Open LinkedIn profile"
          aria-label="Open LinkedIn profile"
          onClick={stopRow}
          style={{ backgroundColor: "#0A66C2" }}
          className="relative inline-flex h-6 w-6 items-center justify-center rounded-[6px] text-white transition-[filter] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60 motion-reduce:transition-none"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.268 2.37 4.268 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452z" />
          </svg>
        </a>
      )}
      {twitterHref && (
        <a
          href={twitterHref}
          target="_blank"
          rel="noopener noreferrer"
          title="Open X profile"
          aria-label="Open X profile"
          onClick={stopRow}
          className="relative inline-flex h-6 w-6 items-center justify-center rounded-[6px] bg-black text-white transition-[filter] hover:brightness-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60 motion-reduce:transition-none"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
        </a>
      )}
    </div>
  )
}

/** LinkedIn connect / invite action chip - lives in Actions, not Links.
 *  - Not connected + URL + Unipile configured: click queues an invite via
 *    /api/dashboard/:wsId/linkedin-invite-queue/enqueue. Badge flips to
 *    yellow pending optimistically.
 *  - Pending or connected: click opens the LinkedIn profile in a new tab
 *    (same fall-through the old Links column used). */
function LinkedInConnectChip({
  workspaceId,
  contact,
  unipileConfigured,
}: {
  workspaceId:       string
  contact:           CompanyContactRow
  unipileConfigured: boolean
}) {
  const router = useRouter()
  const toast  = useToast()
  const linkedinUrl = contact.linkedinUrl
  const liConnected = !!linkedinUrl && contact.linkedinConnected === true
  const [pending, setPending] = useState(!!contact.linkedinInvitePending)
  const [busy,    setBusy]    = useState(false)

  const inviteable  = !!linkedinUrl && !liConnected && !pending && unipileConfigured
  const profileHref = linkedinUrl
    ? (linkedinUrl.startsWith("http") ? linkedinUrl : `https://${linkedinUrl}`)
    : null

  const tooltip =
    !linkedinUrl        ? "No LinkedIn URL on file"
      : liConnected     ? "Connected on LinkedIn - 1st-degree (click to open profile)"
      : pending         ? "Invite queued - awaiting send / accept (click to open profile)"
      : inviteable      ? "Not connected - click to queue a LinkedIn invite"
      : !unipileConfigured ? "Not connected. Configure Unipile in Settings to enable click-to-invite"
      : "Not connected on LinkedIn"

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation()
    e.preventDefault()
    if (liConnected || pending) {
      if (profileHref) window.open(profileHref, "_blank", "noopener,noreferrer")
      return
    }
    if (!inviteable) {
      if (profileHref) window.open(profileHref, "_blank", "noopener,noreferrer")
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/linkedin-invite-queue/enqueue`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ contactId: contact.id }),
      })
      if (res.ok) {
        setPending(true)
        toast.success("Invite queued", `${contact.fullName ?? "Contact"} will receive a connection request within the next hour.`)
        router.refresh()
      } else {
        const text = await res.text().catch(() => "")
        let msg = `HTTP ${res.status}`
        if (text) {
          try { const d = JSON.parse(text) as { error?: string }; if (d.error) msg = d.error } catch { msg = text.slice(0, 200) }
        }
        if (res.status === 409) {
          setPending(true)
          toast.info("Already queued", msg)
        } else {
          toast.error("Queue failed", msg)
        }
      }
    } catch (err) {
      toast.error("Queue failed", err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!linkedinUrl) {
    return (
      <span title={tooltip} className={CHIP_BASE}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden className="text-zinc-600">
          <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.268 2.37 4.268 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452z" />
        </svg>
        <StatusBadge present={false} />
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      title={tooltip}
      aria-label={tooltip}
      className={`${CHIP_BASE} ${CHIP_ACTIVE} disabled:cursor-not-allowed disabled:opacity-60`}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden className="text-[#A1A1AA]">
        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.268 2.37 4.268 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452z" />
      </svg>
      <StatusBadge present={liConnected} pending={pending && !liConnected} />
    </button>
  )
}

/** Actions cluster: outreach actions. LinkedIn connect-request, Email,
 *  LinkedIn DM, and Call. Email + DM open the AI Send composer; Call opens
 *  the log-call form (placeholder dialer). Status badges on the LinkedIn
 *  connect, Email and DM chips mirror the people-page Actions column. */
function ActionsChips({
  workspaceId,
  contact,
  unipileConfigured,
  onActivityLog,
}: {
  workspaceId:       string
  contact:           CompanyContactRow
  unipileConfigured: boolean
  onActivityLog:     (type: ActivityType) => void
}) {
  const email             = contact.email
  const linkedinUrl       = contact.linkedinUrl
  const linkedinConnected = contact.linkedinConnected
  const emailClass        = classifyEmail(email)
  const emailPresent      = emailClass !== "none"
  const dmReady           = !!linkedinUrl && unipileConfigured && linkedinConnected === true

  const emailTooltip =
    emailClass === "corporate" ? `Email ${email} - corporate`
      : emailClass === "personal" ? `Email ${email} - personal`
        : linkedinUrl ? "No email - resolve via LinkedIn (Send composer)"
          : "No email or LinkedIn on file"
  const dmTooltip =
    !linkedinUrl ? "No LinkedIn URL"
      : !unipileConfigured ? "DM unavailable - Unipile not configured"
        : dmReady ? "DM via LinkedIn - 1st-degree"
          : "DM unavailable - not yet connected"

  const stopRow = (e: React.MouseEvent) => e.stopPropagation()

  return (
    <div className="flex items-center gap-1.5" onClick={stopRow}>
      <LinkedInConnectChip workspaceId={workspaceId} contact={contact} unipileConfigured={unipileConfigured} />

      <SendChipTrigger workspaceId={workspaceId} contact={contact} channel="email" unipileConfigured={unipileConfigured}>
        {(open) => (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); if (emailPresent || linkedinUrl) open() }}
            disabled={!emailPresent && !linkedinUrl}
            title={emailTooltip}
            aria-label={emailTooltip}
            className={`${CHIP_BASE} ${emailPresent || linkedinUrl ? CHIP_ACTIVE : "cursor-not-allowed"}`}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={emailPresent ? "text-[#A1A1AA]" : "text-zinc-600"}>
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
            </svg>
            <StatusBadge present={emailPresent} />
          </button>
        )}
      </SendChipTrigger>

      <SendChipTrigger workspaceId={workspaceId} contact={contact} channel="linkedin_dm" unipileConfigured={unipileConfigured}>
        {(open) => (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); if (dmReady) open() }}
            disabled={!dmReady}
            title={dmTooltip}
            aria-label={dmTooltip}
            className={`${CHIP_BASE} ${dmReady ? CHIP_ACTIVE : "cursor-not-allowed"}`}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={dmReady ? "text-[#A1A1AA]" : "text-zinc-600"}>
              <path d="m22 2-7 20-4-9-9-4Z" />
              <path d="M22 2 11 13" />
            </svg>
            <StatusBadge present={dmReady} />
          </button>
        )}
      </SendChipTrigger>

      {/* Call - placeholder until we wire a real dialer (Twilio Voice +
          Voice Intelligence is the current frontrunner). No status badge. */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onActivityLog("call") }}
        title="Log call"
        aria-label="Log call"
        className={`${CHIP_BASE} ${CHIP_ACTIVE}`}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-[#A1A1AA]">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1.27h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.9a16 16 0 0 0 6 6l.9-.9a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 21.73 16.92z" />
        </svg>
      </button>
    </div>
  )
}

/** Right cluster: housekeeping actions. Note / Surfe fetch / DNC pause /
 *  Exclude. Action chips - no status badges. */
function ContactActionChipsRight({
  workspaceId,
  contact,
  onActivityLog,
}: {
  workspaceId:   string
  contact:       CompanyContactRow
  onActivityLog: (type: ActivityType) => void
}) {
  const router = useRouter()
  const toast  = useToast()

  const linkedinUrl = contact.linkedinUrl
  const isDnc = !!contact.doNotContactUntil && new Date(contact.doNotContactUntil).getTime() > Date.now()

  const [enriching,  setEnriching]  = useState(false)
  const [dncConfirm, setDncConfirm] = useState(false)
  const [dncBusy,    setDncBusy]    = useState(false)
  const [excConfirm, setExcConfirm] = useState(false)
  const [excBusy,    setExcBusy]    = useState(false)

  async function handleEnrich(e: React.MouseEvent) {
    e.stopPropagation()
    if (!linkedinUrl || enriching) return
    setEnriching(true)
    const label = contact.fullName ?? "Contact"
    toast.info("Fetching email", `Surfe lookup running for ${label}...`)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/enrich-contact`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ linkedinUrl }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error("Fetch failed", body.error ?? "Surfe returned an error.")
      } else if (body.status === "enriched" && body.email) {
        toast.success("Email found", `${label} updated with ${body.email}${body.credits ? ` · ${body.credits} credit${body.credits === 1 ? "" : "s"} used` : ""}.`)
        router.refresh()
      } else if (body.status === "no_match") {
        toast.info("No match", `Surfe didn't find an email for ${label}.`)
      } else {
        toast.info("No update", `No email found for ${label}.`)
      }
    } catch {
      toast.error("Fetch failed", "Network error - try again.")
    } finally {
      setEnriching(false)
    }
  }

  async function handleDnc(e: React.MouseEvent) {
    e.stopPropagation()
    if (dncBusy) return
    if (!dncConfirm && !isDnc) { setDncConfirm(true); return }
    setDncBusy(true)
    await fetch(`/api/dashboard/${workspaceId}/contacts/${contact.id}/dnc`, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ action: isDnc ? "release" : "set", reason: "Marked via row action." }),
    })
    setDncConfirm(false)
    setDncBusy(false)
    router.refresh()
  }

  async function handleExclude(e: React.MouseEvent) {
    e.stopPropagation()
    if (excBusy) return
    if (!excConfirm) { setExcConfirm(true); return }
    setExcBusy(true)
    // Fall back to contactId when there's no LinkedIn URL on the row -
    // without a URL there's nothing to add to the future-webhook filter,
    // but we can still delete the contact + their signals by id.
    const body: Record<string, unknown> = linkedinUrl ? { linkedinUrl } : { contactId: contact.id }
    await fetch(`/api/dashboard/${workspaceId}/exclude-contact`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    })
    setExcConfirm(false)
    setExcBusy(false)
    router.refresh()
  }

  const stopRow = (e: React.MouseEvent) => e.stopPropagation()

  return (
    <div className="flex items-center gap-1.5" onClick={stopRow}>
      {/* Note - opens the row's log-note form. */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onActivityLog("note") }}
        title="Add note"
        aria-label="Add note"
        className={`${CHIP_BASE} ${CHIP_ACTIVE}`}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-[#A1A1AA]">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z" />
        </svg>
      </button>

      {/* Surfe email fetch - only when we have a LinkedIn URL to look up. */}
      {linkedinUrl && (
        <button
          type="button"
          onClick={handleEnrich}
          disabled={enriching}
          title="Fetch email via Surfe"
          aria-label="Fetch email via Surfe"
          className={`${CHIP_BASE} ${CHIP_ACTIVE} disabled:opacity-60`}
        >
          {enriching ? (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden className="animate-spin text-[#A1A1AA]">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-[#A1A1AA]">
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
              <path d="M8 16H3v5" />
            </svg>
          )}
        </button>
      )}

      {/* DNC pause / release. Two-click confirm on set; single click to release. */}
      <button
        type="button"
        onClick={handleDnc}
        disabled={dncBusy}
        title={isDnc ? "Release DNC pause" : dncConfirm ? "Confirm - mark DNC?" : "Mark DNC (6-month pause)"}
        aria-label={isDnc ? "Release DNC" : "Mark DNC"}
        className={`${CHIP_BASE} ${dncConfirm ? CHIP_CONFIRM : CHIP_ACTIVE} disabled:opacity-60`}
      >
        {dncBusy ? (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden className="animate-spin text-[#A1A1AA]">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        ) : (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-[#A1A1AA]">
            <rect x="6" y="4" width="4" height="16" />
            <rect x="14" y="4" width="4" height="16" />
          </svg>
        )}
      </button>

      {/* Exclude - permanent block. Renders for every row; the API
          falls back to contactId when no LinkedIn URL is available. */}
      <button
        type="button"
        onClick={handleExclude}
        disabled={excBusy}
        title={excConfirm ? "Confirm - exclude person permanently?" : "Exclude person (permanent block)"}
        aria-label="Exclude person"
        className={`${CHIP_BASE} ${excConfirm ? CHIP_CONFIRM : CHIP_ACTIVE} disabled:opacity-60`}
      >
        {excBusy ? (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden className="animate-spin text-[#A1A1AA]">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        ) : (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-[#A1A1AA]">
            <circle cx="12" cy="12" r="10" />
            <path d="m4.9 4.9 14.2 14.2" />
          </svg>
        )}
      </button>
    </div>
  )
}

interface SignalRow {
  id:              number | null
  sourceType:      string | null
  engagementUrl:   string | null
  description:     string | null
  occurredAt:      string | null
  signalVerb:      string | null
  signalActor:     string | null
  signalObject:    string | null
  verbDescription: string | null
  scoreDelta:      number
}

const VERB_LABELS: Record<string, string> = {
  liked_post:                "Liked post",
  commented_post:            "Commented on post",
  viewed_profile:            "Viewed profile",
  followed_our_team_member:  "Followed team member",
  followed_prospect:         "Team followed",
  followed_our_company:      "Followed our company",
  sent_connection_request:   "Connection request sent",
  accepted_our_connection:   "Accepted connection",
  connected:                 "Connected",
  sent_dm:                   "DM sent",
  replied_dm:                "DM reply",
  sent_email:                "Email sent",
  replied_email:             "Email reply",
  booked_meeting:            "Booked meeting",
  ai_search:                 "AI search",
}

const VERB_DOT: Record<string, string> = {
  liked_post:                "#A78BFA",
  commented_post:            "#C4B5FD",
  viewed_profile:            "#60A5FA",
  followed_our_team_member:  "#FCD34D",
  followed_prospect:         "#34D399",
  followed_our_company:      "#FCD34D",
  sent_connection_request:   "#2BA98B",
  accepted_our_connection:   "#34D399",
  connected:                 "#34D399",
  sent_dm:                   "#2BA98B",
  replied_dm:                "#2BA98B",
  sent_email:                "#F59E0B",
  replied_email:             "#F59E0B",
  booked_meeting:            "#FCD34D",
  ai_search:                 "#F87171",
}

const LEGACY_LABELS: Record<string, string> = {
  "Manual Note":      "Note",
  "Call":             "Call",
  "Call (Voicemail)": "Call (voicemail)",
  "Other":            "Other",
}
const LEGACY_DOT: Record<string, string> = {
  "Manual Note":      "#FCD34D",
  "Call":             "#2DD4BF",
  "Call (Voicemail)": "#6B7280",
  "Other":            "#6B7280",
}

function firstName(name: string | null | undefined): string {
  return name?.split(" ")[0] ?? name ?? ""
}

function getSignalDisplay(s: SignalRow): { label: string; dot: string; linkUrl: string | null; bodyText: string | null; isManual: boolean } {
  const { signalVerb: verb, signalActor: actor, signalObject: object, verbDescription: vdesc } = s
  const isManual = s.sourceType === "Manual Note" || s.sourceType === "Call" || s.sourceType === "Call (Voicemail)"

  if (!verb) {
    const legacyLabel = s.description
      ? s.description.slice(0, 80) + (s.description.length > 80 ? "…" : "")
      : (LEGACY_LABELS[s.sourceType ?? ""] ?? s.sourceType ?? "—")
    return {
      label:    legacyLabel,
      dot:      LEGACY_DOT[s.sourceType ?? ""] ?? "#6B7280",
      linkUrl:  s.engagementUrl ?? null,
      bodyText: isManual ? s.description ?? null : null,
      isManual,
    }
  }

  const isPostUrl = vdesc ? /\/(feed\/update|posts)\//.test(vdesc) : false
  const linkUrl   = isPostUrl ? vdesc : (s.engagementUrl ?? null)
  const bodyText  = vdesc && !isPostUrl ? vdesc : null

  let label: string

  switch (verb) {
    case "liked_post":        label = object ? `Liked ${firstName(object)}'s post` : "Liked a post"; break
    case "commented_post":    label = object ? `Commented on ${firstName(object)}'s post` : "Commented on a post"; break
    case "viewed_profile":    label = object ? `Viewed ${object}'s LinkedIn profile` : "Viewed a profile"; break
    case "followed_our_team_member": label = object ? `Followed ${object} on LinkedIn` : "Followed a team member"; break
    case "followed_prospect": {
      const a = actor ?? s.sourceType?.match(/^(\w+)(?:\s+\w+)?\s+Followed$/i)?.[1] ?? null
      label = a ? `${a} followed them on LinkedIn` : "Team followed this contact"; break
    }
    case "followed_our_company": label = "Followed our company on LinkedIn"; break
    case "sent_connection_request": label = actor ? `${actor} sent a connection request` : "Connection request sent"; break
    case "accepted_our_connection":
      // Teamfluence puts the prospect's name in signalActor. Render as
      // "{prospect} accepted connection"; the team-member name in
      // signalObject is implicit (it's our account that sent the request).
      label = actor ? `${firstName(actor)} accepted connection` : "Accepted connection"
      break
    case "connected":         label = object ? `Connected with ${object}` : "Connected on LinkedIn"; break
    case "sent_dm": {
      const vd = s.verbDescription ?? null
      const a = actor ?? (vd?.match(/^(tom(?: lawrence)?|camille(?: oster)?|john(?: mayhew)?|konrad|laura)\b/i)?.[1]?.split(" ")[0] ?? null)
      label = a ? `${a} sent a DM` : "Team sent a DM"; break
    }
    case "booked_meeting":    label = "Booked a meeting"; break
    case "ai_search":         label = "AI search"; break
    default:                  label = VERB_LABELS[verb] ?? verb
  }

  return { label, dot: VERB_DOT[verb] ?? "#6B7280", linkUrl, bodyText, isManual }
}

function fmtDate(val: string | Date | null): string {
  if (!val) return "—"
  const d = new Date(val as string)
  if (Number.isNaN(d.getTime())) return "—"
  const ms = Date.now() - d.getTime()
  const day = 86_400_000
  if (ms < day)         return "today"
  if (ms < 2 * day)     return "yesterday"
  if (ms < 7 * day)     return `${Math.floor(ms / day)}d ago`
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" })
}

function shortenUrl(url: string): string {
  return url
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/\/$/, "")
    .slice(0, 60)
}

const DESC_TRUNCATE = 120

function SignalHistory({
  signals,
  loading,
  workspaceId,
  onMutated,
}: {
  signals: SignalRow[] | null
  loading: boolean
  workspaceId: string
  onMutated: () => void
}) {
  const [expanded,   setExpanded]   = useState<Set<number>>(new Set())
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [editText,   setEditText]   = useState("")
  const [busy,       setBusy]       = useState(false)

  if (loading) return <div className="py-4 text-[12px] text-zinc-500">Loading signals…</div>
  if (!signals || signals.length === 0) return <div className="py-4 text-[12px] text-zinc-500">No signals recorded yet.</div>

  function toggleExpand(i: number) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(i)) { next.delete(i) } else { next.add(i) }
      return next
    })
  }

  function startEdit(i: number, current: string | null) {
    setEditingIdx(i)
    setEditText(current ?? "")
  }

  async function saveEdit(s: SignalRow) {
    if (!s.id || !editText.trim()) return
    setBusy(true)
    await fetch(`/api/dashboard/${workspaceId}/signals/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: editText.trim() }),
    })
    setBusy(false)
    setEditingIdx(null)
    onMutated()
  }

  async function deleteEntry(s: SignalRow) {
    if (!s.id) return
    if (!window.confirm("Delete this entry?")) return
    setBusy(true)
    await fetch(`/api/dashboard/${workspaceId}/signals/${s.id}`, { method: "DELETE" })
    setBusy(false)
    onMutated()
  }

  return (
    <ul className="divide-y divide-white/[0.04]">
      {signals.map((s, i) => {
        const d           = getSignalDisplay(s)
        const isEditing   = editingIdx === i
        const isExpandedD = expanded.has(i)
        const bodyText    = d.bodyText ?? (d.isManual ? s.description : null)
        const isLong      = (bodyText?.length ?? 0) > DESC_TRUNCATE
        const displayBody = isLong && !isExpandedD
          ? bodyText!.slice(0, DESC_TRUNCATE) + "…"
          : bodyText
        return (
          <li key={i} className="flex items-start gap-3 py-2.5">
            <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ backgroundColor: d.dot }} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                {d.linkUrl ? (
                  <a href={d.linkUrl} target="_blank" rel="noopener noreferrer" className="text-[12px] font-medium text-zinc-200 hover:text-[#2BA98B] hover:underline">{d.label}</a>
                ) : (
                  <span className="text-[12px] font-medium text-zinc-200">{d.label}</span>
                )}
                <span className="flex shrink-0 items-center gap-1">
                  {d.isManual && s.id && (
                    <>
                      <button type="button" onClick={() => startEdit(i, s.description)} title="Edit" disabled={busy} className="text-zinc-600 hover:text-zinc-300 disabled:opacity-40">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                      </button>
                      <button type="button" onClick={() => deleteEntry(s)} title="Delete" disabled={busy} className="text-zinc-600 hover:text-rose-400 disabled:opacity-40">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                      </button>
                    </>
                  )}
                  <span className="whitespace-nowrap text-[11px] text-zinc-500 tabular-nums">{fmtDate(s.occurredAt)}</span>
                </span>
              </div>
              {!isEditing && s.scoreDelta > 0 && (
                <span className="text-[10px] font-medium text-[#2BA98B]">+{s.scoreDelta} pts</span>
              )}
              {isEditing ? (
                <div className="mt-1.5 space-y-1.5">
                  <textarea
                    value={editText}
                    onChange={e => setEditText(e.target.value)}
                    rows={3}
                    autoFocus
                    className="w-full resize-none rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-zinc-200 placeholder-zinc-500 focus:border-[#2BA98B]/40 focus:outline-none focus:ring-1 focus:ring-[#2BA98B]/40"
                  />
                  <div className="flex gap-2">
                    <button type="button" onClick={() => saveEdit(s)} disabled={busy || !editText.trim()} className="rounded-md bg-[#2BA98B] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#239977] disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
                    <button type="button" onClick={() => setEditingIdx(null)} disabled={busy} className="rounded-md px-2.5 py-1 text-[11px] text-zinc-400 hover:text-white">Cancel</button>
                  </div>
                </div>
              ) : displayBody ? (
                <div className="mt-0.5">
                  {d.linkUrl ? (
                    <a href={d.linkUrl} target="_blank" rel="noopener noreferrer" className="text-[12px] leading-snug text-zinc-400 hover:text-[#2BA98B] hover:underline">{displayBody}</a>
                  ) : (
                    <p className="text-[12px] leading-snug text-zinc-400">{displayBody}</p>
                  )}
                  {isLong && (
                    <button type="button" onClick={() => toggleExpand(i)} className="mt-0.5 text-[11px] text-zinc-500 hover:text-zinc-300">
                      {isExpandedD ? "Hide ↑" : "Show post ↓"}
                    </button>
                  )}
                </div>
              ) : d.linkUrl ? (
                <a href={d.linkUrl} target="_blank" rel="noopener noreferrer" className="mt-0.5 inline-block break-all text-[11px] text-[#2BA98B] hover:underline">{shortenUrl(d.linkUrl)}</a>
              ) : null}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function ContactRow({
  contact,
  workspaceId,
  isLast,
  unipileConfigured,
}: {
  contact:     CompanyContactRow
  workspaceId: string
  isLast:      boolean
  unipileConfigured: boolean
}) {
  const [open,         setOpen]         = useState(false)
  const [loading,      setLoading]      = useState(false)
  const [signals,      setSignals]      = useState<SignalRow[] | null>(null)
  const [activityType, setActivityType] = useState<ActivityType | null>(null)
  const [editing,      setEditing]      = useState(false)

  async function fetchSignals() {
    setLoading(true)
    try {
      const res  = await fetch(`/api/dashboard/${workspaceId}/contacts/${contact.id}`)
      const data = await res.json().catch(() => ({}))
      setSignals((data.contact?.recentSignals ?? []) as SignalRow[])
    } catch {
      setSignals([])
    } finally {
      setLoading(false)
    }
  }

  async function toggle() {
    setOpen(o => !o)
    if (!open && signals === null) {
      await fetchSignals()
    }
  }

  function openActivityForm(type: ActivityType) {
    if (!open) {
      setOpen(true)
      if (signals === null) void fetchSignals()
    }
    setActivityType(type)
  }

  // Build the inline latest-signal display by feeding the contact's last*
  // fields through the same verb-aware label renderer as the expanded
  // SignalHistory. Means a "followed_prospect" signal renders as
  // "Tom followed them on LinkedIn" instead of a bare "Post Reaction".
  const latestSignal = contact.lastSignalAt
    ? getSignalDisplay({
        id:              null,
        sourceType:      contact.lastSignalType,
        engagementUrl:   contact.lastEngagementUrl,
        description:     contact.lastSignalDescription,
        occurredAt:      null,
        signalVerb:      contact.lastSignalVerb,
        signalActor:     contact.lastSignalActor,
        signalObject:    contact.lastSignalObject,
        verbDescription: contact.lastVerbDescription,
        scoreDelta:      0,
      })
    : null

  const stop = (e: React.MouseEvent) => e.stopPropagation()

  return (
    <Fragment>
      <tr
        className={`border-b border-white/[0.04] transition-colors motion-reduce:transition-none cursor-pointer hover:bg-white/[0.03] ${open ? "bg-[#2BA98B]/[0.05]" : ""} ${isLast && !open ? "last:border-0" : ""}`}
        onClick={toggle}
      >
        {/* pl-5 matches the company-card summary's px-5 so the contact-row
            checkbox sits at the same x-position as the company-level
            CompanyCheckbox above it. */}
        <td className="w-12 pl-5 pr-3 py-2.5 align-middle" onClick={e => e.stopPropagation()}>
          <ContactCheckbox contactId={contact.id} companyName={contact.companyName} />
        </td>

        {/* Chevron + Name (line 1) + Job title / Champion (line 2) */}
        <td className="px-5 py-2.5 align-top">
          <div className="flex items-start gap-2">
            <svg
              width="10"
              height="10"
              viewBox="0 0 14 14"
              fill="none"
              className="mt-[5px] shrink-0 text-zinc-500 transition-transform motion-reduce:transition-none"
              style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
              aria-hidden
            >
              <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div className="min-w-0">
              <span className="inline-flex items-center gap-1.5 max-w-full">
                <span className="truncate text-[13px] font-semibold text-white">{contact.fullName ?? "(unknown)"}</span>
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); setEditing(o => !o) }}
                  title="Edit profile"
                  aria-label="Edit profile"
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#2BA98B]/60 motion-reduce:transition-none"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z" />
                  </svg>
                </button>
              </span>
              {(contact.jobTitle || contact.isChampion) && (
                <div className="mt-0.5 flex items-center gap-1.5 min-w-0">
                  {contact.jobTitle && (
                    <span
                      className="truncate text-[11px] text-zinc-400"
                      title={contact.jobTitle}
                    >
                      {clampJobTitle(contact.jobTitle)}
                    </span>
                  )}
                  {contact.isChampion && (
                    <span
                      className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-amber-400/[0.14] px-1.5 py-0 text-[9px] font-bold uppercase tracking-[0.04em] text-amber-200"
                      title={`Most engagements at this company (${contact.signalCount} signal${contact.signalCount === 1 ? "" : "s"})`}
                    >
                      <svg width="7" height="7" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                        <path d="M12 2 14.91 8.09 21.5 9.27 16.91 14 18 21 12 17.77 6 21 7.09 14 2.5 9.27 9.09 8.09 12 2Z" />
                      </svg>
                      Champion
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </td>

        {/* Links - external profile shortcuts (LinkedIn + X). Click opens
            the public profile in a new tab; no actions, no status badges. */}
        <td className="hidden md:table-cell w-[72px] px-3 py-2.5 align-middle" onClick={stop}>
          <LinksChips contact={contact} />
        </td>

        {/* Actions - outreach actions: LinkedIn connect / Email / DM / Call.
            Email and DM open the AI Send composer pre-pinned to their channel.
            The LinkedIn chip queues a connect request when not yet connected. */}
        <td className="hidden md:table-cell w-[144px] px-3 py-2.5 align-middle" onClick={stop}>
          <ActionsChips
            workspaceId={workspaceId}
            contact={contact}
            unipileConfigured={unipileConfigured}
            onActivityLog={openActivityForm}
          />
        </td>

        {/* Latest signal - verb-aware label on line 1, date (formerly its
            own When column) on line 2 in muted 11px text to mirror the
            name + job title styling on the left. */}
        <td className="px-5 py-2.5 align-top text-zinc-200">
          <div className="max-w-[340px]">
            {latestSignal ? (
              latestSignal.linkUrl ? (
                <a
                  href={latestSignal.linkUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={stop}
                  className="block truncate text-[12px] text-zinc-200 hover:text-[#2BA98B] hover:underline"
                  title={latestSignal.bodyText ?? latestSignal.label}
                >
                  {humanizeSignalLabel(latestSignal.label)}
                </a>
              ) : (
                <span
                  className="block truncate text-[12px] text-zinc-200"
                  title={latestSignal.bodyText ?? latestSignal.label}
                >
                  {humanizeSignalLabel(latestSignal.label)}
                </span>
              )
            ) : (
              <span className="text-[10px] uppercase tracking-[0.06em] text-zinc-500">No engagement yet</span>
            )}
            {contact.lastSignalAt && (
              <span className="mt-0.5 block truncate text-[11px] text-zinc-400 tabular-nums">
                {fmtDate(contact.lastSignalAt)}
              </span>
            )}
          </div>
        </td>

        {/* Contact (right) - housekeeping: Note / Surfe / DNC pause /
            Exclude. Sits where the When column used to be. */}
        <td className="hidden md:table-cell w-[156px] px-3 py-2.5 align-middle" onClick={stop}>
          <ContactActionChipsRight
            workspaceId={workspaceId}
            contact={contact}
            onActivityLog={openActivityForm}
          />
        </td>

        {/* Score */}
        <td className={`px-5 py-2.5 align-middle text-right font-mono font-semibold tabular-nums ${contact.signalScore > 0 ? "text-white" : "text-zinc-600"}`}>
          {contact.signalScore}
        </td>
      </tr>

      {editing && (
        <tr className={`bg-black/20 ${isLast && !open ? "" : "border-b border-white/[0.04]"}`}>
          <td colSpan={7} className="px-7 py-4">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">Edit profile</p>
            <ManualContactEdit
              workspaceId={workspaceId}
              contactId={contact.id}
              initial={{
                email:             contact.email,
                linkedinUrl:       contact.linkedinUrl,
                twitterUrl:        contact.twitterUrl,
                jobTitle:          contact.jobTitle,
                fullName:          contact.fullName,
                companyName:       contact.companyName,
                linkedinConnected: contact.linkedinConnected,
              }}
              onClose={() => setEditing(false)}
            />
          </td>
        </tr>
      )}

      {open && (
        <tr className={`bg-black/20 ${isLast ? "" : "border-b border-white/[0.04]"}`}>
          <td colSpan={7} className="px-7 py-4">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">
              Engagement history · up to 10 most recent
            </p>
            <ActivityLogInlineForm
              workspaceId={workspaceId}
              contactId={contact.id}
              activeType={activityType}
              onClose={() => setActivityType(null)}
              onSaved={fetchSignals}
            />
            <SignalHistory signals={signals} loading={loading} workspaceId={workspaceId} onMutated={fetchSignals} />
          </td>
        </tr>
      )}
    </Fragment>
  )
}

export function ContactsList({
  workspaceId,
  contacts,
  unipileConfigured = false,
}: {
  workspaceId: string
  contacts:    CompanyContactRow[]
  unipileConfigured?: boolean
}) {
  if (contacts.length === 0) {
    return (
      <div className="border-t border-white/[0.06] px-5 py-4 text-[12px] text-zinc-400">
        No people scored at this company yet.
      </div>
    )
  }
  return (
    <div className="border-t border-white/[0.06]">
      {/* table-fixed locks each column to its declared width so Name
          can't absorb the leftover horizontal space and push Links far
          to the right. Mirrors the explicit-width pattern the people
          page uses. */}
      <table className="w-full table-fixed text-[13px]">
        <thead>
          <tr className="border-b border-white/[0.04]">
            <th className="w-12 pl-5 pr-3 py-2.5" aria-label="Select" />
            <th className="w-[240px] px-5 py-2.5 text-left text-[10px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Name</th>
            <th className="hidden md:table-cell w-[72px] px-3 py-2.5 text-left text-[10px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Links</th>
            <th className="hidden md:table-cell w-[144px] px-3 py-2.5 text-left text-[10px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Actions</th>
            <th className="px-5 py-2.5 text-left text-[10px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Latest signal</th>
            <th className="hidden md:table-cell w-[156px] px-3 py-2.5 text-left text-[10px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Manage</th>
            <th className="w-[96px] px-5 py-2.5 text-right text-[10px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Score</th>
          </tr>
        </thead>
        <tbody>
          {contacts.map((contact, i) => (
            <ContactRow
              key={contact.id}
              contact={contact}
              workspaceId={workspaceId}
              isLast={i === contacts.length - 1}
              unipileConfigured={unipileConfigured}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}
