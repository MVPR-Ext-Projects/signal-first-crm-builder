"use client"

import { useEffect, useState, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { InterestsPanel } from "./interests-panel"
import { InfluencedByPanel } from "./influenced-by-panel"
import { ExcludePersonButton } from "../components/exclude-person-button"
import { ActivityLogInlineForm, type ActivityType } from "../components/activity-log-form"
import { ManualContactEdit, ManualEditIcon } from "../components/manual-contact-edit"
import type { FunnelStage, ActionType, SignalDetail, Lead } from "./lead-types"
import { CampaignEnrollChip } from "./campaign-enroll-chip"
import { useToast } from "../toast"
// Re-export FunnelStage so existing imports `from "./lead-table-row"` keep
// working without an extra change-site sweep.
export type { FunnelStage } from "./lead-types"

// Display-only label overrides — DB values stay unchanged.
const STAGE_DISPLAY_LABEL: Partial<Record<FunnelStage, string>> = {
  "High Signal":    "Highly engaged",
  "Discovery Call": "Ambassadors",
  "Customer Won":     "Customer Won",
}
const STAGE_ORDER: FunnelStage[] = [
  "Prospect",
  "Signal Found",
  "Engaged",
  "High Signal",
  "Discovery Call",
]

// Avatar tint by stage — keeps row identity visually anchored to the stage
// while leaving the stage pill itself doing the explicit colour-as-state work.
const STAGE_AVATAR: Record<FunnelStage, { bg: string; fg: string }> = {
  Prospect:                { bg: "rgba(156,163,175,0.16)", fg: "#9CA3AF" },
  "Signal Found":          { bg: "rgba(221,128,168,0.16)", fg: "#DD80A8" },
  Engaged:                 { bg: "rgba(34,197,94,0.16)",   fg: "#22C55E" },
  "High Signal":           { bg: "rgba(234,88,12,0.16)",   fg: "#EA580C" },
  "Discovery Call":        { bg: "rgba(56,189,248,0.16)",  fg: "#38BDF8" },
  "Requested Information": { bg: "rgba(251,191,36,0.16)",  fg: "#FBBF24" },
  "Follow Up Call":        { bg: "rgba(251,146,60,0.16)",  fg: "#FB923C" },
  "Sent Information":      { bg: "rgba(129,140,248,0.16)", fg: "#818CF8" },
  "Diligence":             { bg: "rgba(192,132,252,0.16)", fg: "#C084FC" },
  "Contract Negotiation":  { bg: "rgba(52,211,153,0.16)",  fg: "#34D399" },
  "Customer Won":          { bg: "rgba(43,169,139,0.16)",  fg: "#2BA98B" },
}

const STAGE_PILL: Record<FunnelStage, { bg: string; fg: string; dot: string }> = {
  Prospect:                { bg: "rgba(156,163,175,0.16)", fg: "#9CA3AF", dot: "#9CA3AF" },
  "Signal Found":          { bg: "rgba(221,128,168,0.16)", fg: "#DD80A8", dot: "#DD80A8" },
  Engaged:                 { bg: "rgba(34,197,94,0.16)",   fg: "#22C55E", dot: "#22C55E" },
  "High Signal":           { bg: "rgba(234,88,12,0.16)",   fg: "#EA580C", dot: "#EA580C" },
  "Discovery Call":        { bg: "rgba(56,189,248,0.16)",  fg: "#38BDF8", dot: "#38BDF8" },
  "Requested Information": { bg: "rgba(251,191,36,0.16)",  fg: "#FBBF24", dot: "#FBBF24" },
  "Follow Up Call":        { bg: "rgba(251,146,60,0.16)",  fg: "#FB923C", dot: "#FB923C" },
  "Sent Information":      { bg: "rgba(129,140,248,0.16)", fg: "#818CF8", dot: "#818CF8" },
  "Diligence":             { bg: "rgba(192,132,252,0.16)", fg: "#C084FC", dot: "#C084FC" },
  "Contract Negotiation":  { bg: "rgba(52,211,153,0.16)",  fg: "#34D399", dot: "#34D399" },
  "Customer Won":          { bg: "rgba(43,169,139,0.16)",  fg: "#2BA98B", dot: "#2BA98B" },
}

const ACTION_LABELS: Record<ActionType, string> = {
  linkedin: "LinkedIn DM",
  email:    "Cold email",
  call:     "Call",
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
  pr_pitch_sent:             "PR pitch sent",
  pr_journalist_replied:     "Journalist replied",
  pr_coverage_published:     "Coverage published",
}

const VERB_DOT_COLOR: Record<string, string> = {
  liked_post:                "#A78BFA",
  commented_post:            "#C4B5FD",
  viewed_profile:            "#93C5FD",
  followed_our_team_member:  "#F59E0B",
  followed_prospect:         "#10B981",
  followed_our_company:      "#F59E0B",
  sent_connection_request:   "#2BA98B",
  accepted_our_connection:   "#10B981",
  connected:                 "#10B981",
  sent_dm:                   "#2BA98B",
  replied_dm:                "#2BA98B",
  sent_email:                "#F59E0B",
  replied_email:             "#F59E0B",
  booked_meeting:            "#FCD34D",
  ai_search:                 "#FB7185",
  pr_pitch_sent:             "#94A3B8",
  pr_journalist_replied:     "#38BDF8",
  pr_coverage_published:     "#FCD34D",
}

// Legacy source_type labels/colors for signals without verb fields
const SOURCE_LABELS: Record<string, string> = {
  "Manual Note":      "Note",
  "Call":             "Call",
  "Call (Voicemail)": "Call (voicemail)",
  "Other":            "Other",
}
const SOURCE_DOT_COLOR: Record<string, string> = {
  "Manual Note":      "#FCD34D",
  "Call":             "#2DD4BF",
  "Call (Voicemail)": "#6B7280",
  "Other":            "#6B7280",
}

interface SignalDisplay {
  label:       string
  dotColor:    string
  linkUrl:     string | null
  contentText: string | null
  isManual:    boolean
}

function first(name: string | null | undefined): string {
  return name?.split(" ")[0] ?? name ?? ""
}

function buildSignalDisplay(s: SignalDetail): SignalDisplay {
  const { signalVerb: verb, signalActor: actor, signalObject: object, verbDescription: vdesc } = s
  const isManual = s.source === "Manual Note" || s.source === "Call" || s.source === "Call (Voicemail)"

  // No verb → legacy signal. Use description as the label if meaningful.
  if (!verb) {
    const legacyLabel = s.description
      ? s.description.slice(0, 80) + (s.description.length > 80 ? "…" : "")
      : (SOURCE_LABELS[s.source ?? ""] ?? s.source ?? "Unknown signal")
    return {
      label:       legacyLabel,
      dotColor:    SOURCE_DOT_COLOR[s.source ?? ""] ?? "#6B7280",
      linkUrl:     s.url ?? null,
      contentText: isManual ? s.description ?? null : null,
      isManual,
    }
  }

  const isPostUrl = vdesc ? /\/(feed\/update|posts)\//.test(vdesc) : false
  const linkUrl   = isPostUrl ? vdesc : (s.url ?? null)
  const contentText = vdesc && !isPostUrl ? vdesc : null

  let label: string

  switch (verb) {
    case "liked_post":
      label = object ? `Liked ${first(object)}'s post` : "Liked a post"
      break
    case "commented_post":
      label = object ? `Commented on ${first(object)}'s post` : "Commented on a post"
      break
    case "viewed_profile":
      label = object ? `Viewed ${object}'s LinkedIn profile` : "Viewed a profile"
      break
    case "followed_our_team_member":
      label = object ? `Followed ${object} on LinkedIn` : "Followed a team member"
      break
    case "followed_prospect": {
      const a = actor ?? s.source?.match(/^(\w+)(?:\s+\w+)?\s+Followed$/i)?.[1] ?? null
      label = a ? `${a} followed them on LinkedIn` : "Team followed this contact"
      break
    }
    case "followed_our_company":
      label = "Followed our company on LinkedIn"
      break
    case "sent_connection_request":
      label = actor ? `${actor} sent a connection request` : "Connection request sent"
      break
    case "accepted_our_connection":
      // Teamfluence puts the prospect's name in signalActor. Render as
      // "{prospect} accepted connection"; the team-member name in
      // signalObject is implicit (it's our account that sent the request).
      label = actor ? `${first(actor)} accepted connection` : "Accepted connection"
      break
    case "connected":
      label = object ? `Connected with ${object}` : "Connected on LinkedIn"
      break
    case "sent_dm": {
      const vd = s.verbDescription ?? null
      const a = actor ?? (vd?.match(/^(tom(?: lawrence)?|camille(?: oster)?|john(?: mayhew)?|konrad|laura)\b/i)?.[1]?.split(" ")[0] ?? null)
      label = a ? `${a} sent a DM` : "Team sent a DM"
      break
    }
    case "replied_dm":
      label = "Replied to a DM"
      break
    case "booked_meeting":
      label = "Booked a meeting"
      break
    case "ai_search":
      label = "AI search"
      break
    default:
      label = VERB_LABELS[verb] ?? verb
  }

  return {
    label,
    dotColor:    VERB_DOT_COLOR[verb] ?? "#6B7280",
    linkUrl,
    contentText,
    isManual,
  }
}

const ICP_GROUP_PALETTE: Record<string, { bg: string; fg: string }> = {
  Issuer:               { bg: "rgba(245,158,11,0.10)",  fg: "#F59E0B" },
  "Liquidity Provider": { bg: "rgba(167,139,250,0.10)", fg: "#A78BFA" },
  Exchange:             { bg: "rgba(244,114,182,0.10)", fg: "#F472B6" },
  "Payment Provider":   { bg: "rgba(43,169,139,0.10)",  fg: "#2BA98B" },
}

// Module-level cache: post URL → fetched title (or null if fetch failed)
const postTitleCache = new Map<string, string | null>()

function PostHeadline({ url, workspaceId, fallback }: { url: string; workspaceId: string; fallback?: React.ReactNode }) {
  const [title, setTitle] = useState<string | null | undefined>(
    postTitleCache.has(url) ? postTitleCache.get(url) : undefined,
  )

  useEffect(() => {
    if (title !== undefined) return
    let cancelled = false
    fetch(`/api/dashboard/${workspaceId}/post-title?url=${encodeURIComponent(url)}`)
      .then(r => r.json())
      .then((d: { title: string | null }) => {
        postTitleCache.set(url, d.title)
        if (!cancelled) setTitle(d.title)
      })
      .catch(() => {
        postTitleCache.set(url, null)
        if (!cancelled) setTitle(null)
      })
    return () => { cancelled = true }
  }, [url, workspaceId, title])

  if (!title) return fallback ?? null
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={stop}
      className="block truncate text-[12px] italic text-zinc-400 hover:text-[#2BA98B] hover:underline"
    >
      "{title}"
    </a>
  )
}

function formatDate(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  const ms = Date.now() - d.getTime()
  const day = 86_400_000
  if (ms < day) {
    const hours = Math.floor(ms / 3_600_000)
    if (hours < 1) return "just now"
    return hours === 1 ? "1 hr ago" : `${hours} hrs ago`
  }
  if (ms < 7 * day) {
    const days = Math.floor(ms / day)
    return days === 1 ? "yesterday" : `${days} days ago`
  }
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
}

function shortenUrl(url: string): string {
  return url
    .replace("https://www.linkedin.com/", "li/")
    .replace("https://linkedin.com/", "li/")
    .replace(/\?.*$/, "")
}

function initials(name: string | null): string {
  if (!name) return "·"
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0]?.toUpperCase() ?? "")
    .join("") || "·"
}

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()

// ─── Contact status chips ──────────────────────────────────────────────────

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

function classifyLinkedin(
  linkedin: string | null,
  signals: SignalDetail[],
  linkedinConnected: boolean | null = null,
): "connected" | "not_connected" | "none" {
  if (!linkedin) return "none"
  // Authoritative DB flag takes precedence over signal-window inference.
  if (linkedinConnected === true)  return "connected"
  if (linkedinConnected === false) return "not_connected"
  // Fall back to scanning the loaded signal window.
  const connected = signals.some(
    s => s.signalVerb === "accepted_our_connection" || s.signalVerb === "connected",
  )
  return connected ? "connected" : "not_connected"
}

function ContactStatusChip({
  type,
  status,
  href,
}: {
  type: "email" | "linkedin" | "dm"
  status: "corporate" | "personal" | "none" | "connected" | "not_connected"
  href?: string
}) {
  const muted = status === "none" || (type === "dm" && status === "not_connected")

  let badgeBg: string | null = null
  let badgeTick = true
  let tooltip = ""

  if (type === "email") {
    if (status === "corporate") { badgeBg = "#14B8A6"; tooltip = "Corporate - verified" }
    else if (status === "personal") { badgeBg = "#F59E0B"; tooltip = "Personal - free webmail" }
    else { tooltip = "No email on file" }
  } else if (type === "dm") {
    if (status === "connected") { badgeBg = "#14B8A6"; tooltip = "DM via LinkedIn - 1st-degree" }
    else if (status === "not_connected") { tooltip = "Not connected on LinkedIn" }
    else { tooltip = "No LinkedIn URL" }
  } else {
    if (status === "connected") { badgeBg = "#14B8A6"; tooltip = "Connected - 1st-degree" }
    else if (status === "not_connected") { badgeBg = "#F43F5E"; badgeTick = false; tooltip = "Not connected" }
    else { tooltip = "No LinkedIn URL" }
  }

  const chip = (
    <div
      title={tooltip}
      className={`relative flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[7px] bg-white/[0.06] ${!muted && href ? "transition-colors hover:bg-white/[0.12] motion-reduce:transition-none" : ""}`}
    >
      {type === "email" ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={muted ? "text-zinc-600" : "text-[#A1A1AA]"}>
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
        </svg>
      ) : type === "dm" ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={muted ? "text-zinc-600" : "text-[#A1A1AA]"}>
          <path d="m22 2-7 20-4-9-9-4Z" />
          <path d="M22 2 11 13" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden className={muted ? "text-zinc-600" : "text-[#A1A1AA]"}>
          <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.268 2.37 4.268 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
        </svg>
      )}
      {badgeBg && (
        <div
          className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full ring-2 ring-[#0D1F1A]"
          style={{ backgroundColor: badgeBg }}
          aria-hidden
        >
          {badgeTick ? (
            <svg width="7" height="7" viewBox="0 0 10 10" fill="none" stroke="#0A0A0A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="1.5,5 4,7.5 8.5,2.5" />
            </svg>
          ) : (
            <svg width="7" height="7" viewBox="0 0 10 10" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <line x1="2" y1="2" x2="8" y2="8" />
              <line x1="8" y1="2" x2="2" y2="8" />
            </svg>
          )}
        </div>
      )}
    </div>
  )

  if (href && !muted) {
    return (
      <a
        href={href}
        target={type === "linkedin" || type === "dm" ? "_blank" : undefined}
        rel="noopener noreferrer"
        onClick={stop}
        aria-label={tooltip}
      >
        {chip}
      </a>
    )
  }
  return chip
}

function PlusChip({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      type="button"
      title="Log activity"
      onClick={onClick}
      className="relative flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[7px] bg-white/[0.06] transition-colors hover:bg-white/[0.12] motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-[#A1A1AA]">
        <path d="M5 12h14" />
        <path d="M12 5v14" />
      </svg>
    </button>
  )
}

// ─── Row action chips (Notes column) ─────────────────────────────────────────

function ActionChip({
  title,
  color,
  active,
  confirm,
  loading = false,
  onClick,
  children,
}: {
  title: string
  color: string
  active?: boolean
  confirm?: boolean
  loading?: boolean
  onClick: (e: React.MouseEvent) => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`relative flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[7px] transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60 ${
        confirm
          ? "bg-rose-500/[0.16] hover:bg-rose-500/[0.24]"
          : active
            ? "bg-white/[0.12]"
            : "bg-white/[0.06] hover:bg-white/[0.12]"
      }`}
      style={{ color }}
    >
      {loading ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden className="animate-spin">
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
      ) : children}
    </button>
  )
}

function RowActionChips({
  workspaceId,
  contactId,
  linkedinUrl,
  fullName,
  doNotContactUntil,
  onActivityLog,
}: {
  workspaceId: string
  contactId: number
  linkedinUrl: string | null
  fullName: string | null
  doNotContactUntil: string | null
  onActivityLog: (type: ActivityType) => void
}) {
  const router = useRouter()
  const toast = useToast()
  const isDnc = !!doNotContactUntil && new Date(doNotContactUntil).getTime() > Date.now()

  const [enriching,   setEnriching]   = useState(false)
  const [dncConfirm,  setDncConfirm]  = useState(false)
  const [dncBusy,     setDncBusy]     = useState(false)
  const [excConfirm,  setExcConfirm]  = useState(false)
  const [excBusy,     setExcBusy]     = useState(false)

  async function handleEnrich(e: React.MouseEvent) {
    e.stopPropagation()
    if (!linkedinUrl || enriching) return
    setEnriching(true)
    const label = fullName ?? "Contact"
    toast.info("Fetching email", `Surfe lookup running for ${label}...`)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/enrich-contact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkedinUrl }),
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
    if (!dncConfirm) { setDncConfirm(true); return }
    setDncBusy(true)
    await fetch(`/api/dashboard/${workspaceId}/contacts/${contactId}/dnc`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: isDnc ? "release" : "set", reason: "Marked via row action." }),
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
    await fetch(`/api/dashboard/${workspaceId}/exclude-contact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ linkedinUrl }),
    })
    setExcConfirm(false)
    setExcBusy(false)
    router.refresh()
  }

  return (
    <div className="flex items-center gap-1">
      {/* Call */}
      <ActionChip title="Log call" color="#2BA98B" onClick={(e) => { e.stopPropagation(); onActivityLog("call") }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1.27h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.9a16 16 0 0 0 6 6l.9-.9a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 21.73 16.92z" />
        </svg>
      </ActionChip>

      {/* Note */}
      <ActionChip title="Add note" color="#2BA98B" onClick={(e) => { e.stopPropagation(); onActivityLog("note") }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z" />
        </svg>
      </ActionChip>

      {/* Surfe email fetch */}
      {linkedinUrl && (
        <ActionChip title="Fetch email via Surfe" color="#F59E0B" loading={enriching} onClick={handleEnrich}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
            <path d="M8 16H3v5" />
          </svg>
        </ActionChip>
      )}

      {/* DNC / Pause */}
      <ActionChip
        title={isDnc ? "Release DNC" : dncConfirm ? "Confirm - mark DNC?" : "Mark DNC"}
        color={isDnc ? "#EF4444" : "#F59E0B"}
        confirm={dncConfirm}
        loading={dncBusy}
        onClick={handleDnc}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="6" y="4" width="4" height="16" />
          <rect x="14" y="4" width="4" height="16" />
        </svg>
      </ActionChip>

      {/* Exclude */}
      {linkedinUrl && (
        <ActionChip
          title={excConfirm ? "Confirm - exclude person?" : "Exclude person"}
          color="#F43F5E"
          confirm={excConfirm}
          loading={excBusy}
          onClick={handleExclude}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="10" />
            <path d="m4.9 4.9 14.2 14.2" />
          </svg>
        </ActionChip>
      )}
    </div>
  )
}

/** Total table columns. Bumps to 9 when a Persona column is rendered. */
export function tableColSpan(hasPersona: boolean): number {
  return hasPersona ? 9 : 8
}

export function LeadTableRow({
  lead,
  workspaceId,
  personaNames = [],
  unipileConfigured = false,
}: {
  lead: Lead
  workspaceId: string
  /** Configured persona names (for the row's clickable persona pill menu). */
  personaNames?: string[]
  unipileConfigured?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  // Chips in the Notes column can pre-select an activity type when opening
  // the expanded panel. Cleared after ExpandedPanel picks it up.
  const [pendingActivity, setPendingActivity] = useState<ActivityType | null>(null)

  function openWithActivity(type: ActivityType) {
    setOpen(true)
    setPendingActivity(type)
  }

  const canExpand = lead.signals.length > 0
  const latestSignal = lead.signals[0] ?? null
  const latestDisplay = latestSignal ? buildSignalDisplay(latestSignal) : null
  const avatar = STAGE_AVATAR[lead.stage]

  return (
    <>
      <tr
        className={`border-b border-white/[0.06] transition-colors motion-reduce:transition-none ${canExpand ? "cursor-pointer hover:bg-white/[0.04]" : ""} ${open ? "bg-[#2BA98B]/[0.06]" : ""}`}
        onClick={() => canExpand && setOpen(o => !o)}
      >
        {/* 1. Person · Company — always visible. Job title on line 2, company
            on line 3 so the column can stay narrow and the right-hand columns
            (Persona, Score) fit on a single horizontal viewport. */}
        <td className="px-5 py-4 w-[260px] max-w-[260px]">
          <div className="flex items-start gap-3.5">
            <div className="pt-2">
              {canExpand ? <Chevron open={open} /> : <span className="block w-3" />}
            </div>
            <div
              className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-[13px] font-bold"
              style={{ backgroundColor: avatar.bg, color: avatar.fg }}
              aria-hidden
            >
              {initials(lead.fullName)}
            </div>
            <div className="min-w-0 flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5 min-w-0">
                <p className="truncate text-[15px] font-semibold text-white">
                  {lead.fullName ?? "-"}
                </p>
                {lead.contactId !== null && (
                  <ManualEditIcon onClick={() => { setOpen(true); setEditing(true) }} />
                )}
              </div>
              {(lead.company || lead.icpGroup) && (
                <p className="truncate text-[12px] text-zinc-400" title={lead.company ?? undefined}>
                  {lead.company}
                  {lead.icpGroup && (
                    <span
                      className="ml-2 inline-flex items-center rounded-full px-2 py-0 align-middle text-[10px] font-semibold"
                      style={{
                        backgroundColor: ICP_GROUP_PALETTE[lead.icpGroup]?.bg ?? "rgba(147,197,253,0.10)",
                        color: ICP_GROUP_PALETTE[lead.icpGroup]?.fg ?? "#93C5FD",
                      }}
                    >
                      {lead.icpGroup}
                    </span>
                  )}
                </p>
              )}
              {lead.jobTitle && (
                <p className="truncate text-[12px] text-zinc-500" title={lead.jobTitle}>
                  {lead.jobTitle}
                </p>
              )}
            </div>
          </div>
        </td>

        {/* 2. Links — md+. Brand-tile profile links (LinkedIn-blue + X-black)
            so the column is purely "open external profile". Connection status
            for LinkedIn is preserved as a small badge on the chip; the same
            status also surfaces on the DM chip in the Actions column. */}
        <td className="hidden md:table-cell px-3 py-4 w-[88px]">
          <div className="flex items-center gap-1.5">
            <LinkedInBrandLink
              href={lead.linkedin ?? null}
              status={classifyLinkedin(lead.linkedin, lead.signals, lead.linkedinConnected)}
            />
            {lead.twitterUrl && <XBrandLink href={lead.twitterUrl} />}
            {lead.crmUrl && (
              <IconLink href={lead.crmUrl} title="Open in CRM">
                <ExternalIcon />
              </IconLink>
            )}
          </div>
        </td>

        {/* 3. Campaigns chips (email + DM + add) — lg+ */}
        <td className="hidden lg:table-cell px-3 py-4 w-[112px]">
          <div className="flex items-center gap-1.5">
            <ContactStatusChip
              type="email"
              status={classifyEmail(lead.email)}
              href={lead.email ? `mailto:${lead.email}` : undefined}
            />
            <ContactStatusChip
              type="dm"
              status={classifyLinkedin(lead.linkedin, lead.signals, lead.linkedinConnected)}
              href={lead.linkedin ?? undefined}
            />
            {lead.contactId !== null && (
              <CampaignEnrollChip
                workspaceId={workspaceId}
                contactId={lead.contactId}
              />
            )}
          </div>
        </td>

        {/* 4. Stage — md+. Read-only here. Manual stage override is set
            at the company level on the Companies page; it rolls down to
            every contact at that company. */}
        <td className="hidden md:table-cell px-3 py-4 w-[140px]">
          <StagePillReadOnly stage={lead.stage} isManual={lead.stageIsManual} />
        </td>

        {/* 5. Latest signal — xl+ */}
        <td className="hidden xl:table-cell px-3 py-4 w-[200px] max-w-[200px]">
          {latestDisplay ? (
            <div className="flex flex-col gap-0.5">
              <span className="truncate text-[13px] text-zinc-200">{latestDisplay.label}</span>
              <span className="text-[12px] text-zinc-400">{formatDate(latestSignal!.date)}</span>
            </div>
          ) : (
            <span className="text-[13px] text-zinc-500">—</span>
          )}
        </td>

        {/* 7. Persona — xl+. Same breakpoint as Action / Latest signal so the
            row can still pack down on narrower screens. Only renders when the
            workspace has personas configured. */}
        {personaNames.length > 0 && (
          <td className="hidden xl:table-cell px-2 py-4 w-[120px]">
            {lead.contactId !== null ? (
              <PersonaPillMenu
                workspaceId={workspaceId}
                contactId={lead.contactId}
                current={lead.persona}
                isManual={lead.personaIsManual}
                names={personaNames}
                linkedinUrl={lead.linkedin}
              />
            ) : (
              <span className="text-[13px] text-zinc-500">—</span>
            )}
          </td>
        )}

        {/* 8. Notes — action chips, xl+ */}
        <td className="hidden xl:table-cell px-2 py-4 w-[160px]">
          {lead.contactId !== null && (
            <RowActionChips
              workspaceId={workspaceId}
              contactId={lead.contactId}
              linkedinUrl={lead.linkedin}
              fullName={lead.fullName}
              doNotContactUntil={lead.doNotContactUntil}
              onActivityLog={openWithActivity}
            />
          )}
        </td>

        {/* 9. Score — always visible */}
        <td className="px-5 py-4 text-right whitespace-nowrap w-[88px]">
          <div className="flex flex-col items-end gap-0.5">
            <span className="text-[22px] font-bold leading-none tracking-[-0.02em] text-white tabular-nums">
              {lead.score}
            </span>
            <span className="text-[11px] text-zinc-500 tabular-nums">/{lead.signalCount}</span>
          </div>
        </td>
      </tr>

      {open && (
        <tr className="bg-black/20">
          <td colSpan={tableColSpan(personaNames.length > 0)} className="px-7 py-7 border-b border-white/[0.06]">
            <ExpandedPanel
              lead={lead}
              workspaceId={workspaceId}
              contactId={lead.contactId ?? 0}
              editing={editing}
              onCloseEditing={() => setEditing(false)}
              initialActivity={pendingActivity}
              onInitialActivityConsumed={() => setPendingActivity(null)}
            />
          </td>
        </tr>
      )}
    </>
  )
}

// ─── Expanded panel ──────────────────────────────────────────────────────────

const DESC_TRUNCATE = 120

function ExpandedPanel({
  lead,
  workspaceId,
  contactId,
  editing,
  onCloseEditing,
  initialActivity,
  onInitialActivityConsumed,
}: {
  lead: Lead
  workspaceId: string
  contactId: number
  editing: boolean
  onCloseEditing: () => void
  initialActivity?: ActivityType | null
  onInitialActivityConsumed?: () => void
}) {
  const router = useRouter()
  const [expandedDescs, setExpandedDescs] = useState<Set<number>>(new Set())
  const [editingIdx,    setEditingIdx]    = useState<number | null>(null)
  const [editText,      setEditText]      = useState("")
  const [sigBusy,       setSigBusy]       = useState(false)
  const [activityType,  setActivityType]  = useState<ActivityType | null>(null)

  useEffect(() => {
    if (initialActivity) {
      setActivityType(initialActivity)
      onInitialActivityConsumed?.()
    }
  }, [initialActivity]) // eslint-disable-line react-hooks/exhaustive-deps

  function toggleDesc(i: number) {
    setExpandedDescs(prev => {
      const next = new Set(prev)
      if (next.has(i)) { next.delete(i) } else { next.add(i) }
      return next
    })
  }

  async function saveEdit(s: SignalDetail) {
    if (!s.id || !editText.trim()) return
    setSigBusy(true)
    if (s.isNote) {
      await fetch(`/api/dashboard/${workspaceId}/notes/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: editText.trim() }),
      })
    } else {
      await fetch(`/api/dashboard/${workspaceId}/signals/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: editText.trim() }),
      })
    }
    setSigBusy(false)
    setEditingIdx(null)
    router.refresh()
  }

  async function deleteEntry(s: SignalDetail) {
    if (!s.id) return
    if (!window.confirm("Delete this entry?")) return
    setSigBusy(true)
    const path = s.isNote ? "notes" : "signals"
    await fetch(`/api/dashboard/${workspaceId}/${path}/${s.id}`, { method: "DELETE" })
    setSigBusy(false)
    router.refresh()
  }

  return (
    <div className="space-y-4">
      {/* Header + all action buttons in one row */}
      <div>
        <p className="mb-2 text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">
          Engagement history · {lead.signals.length} of {lead.signalCount} most recent
        </p>
      </div>

      {contactId > 0 && (
        <ActivityLogInlineForm
          workspaceId={workspaceId}
          contactId={contactId}
          activeType={activityType}
          onClose={() => setActivityType(null)}
          onSaved={() => { router.refresh() }}
        />
      )}

      {/* Manually edit fields form - opened by the pen icon next to the
          contact name. Controlled by parent state (editing) so closing
          the form doesn't collapse the row. */}
      {contactId > 0 && editing && (
        <ManualContactEdit
          workspaceId={workspaceId}
          contactId={contactId}
          initial={{
            email:              lead.email,
            linkedinUrl:        lead.linkedin,
            twitterUrl:         lead.twitterUrl,
            jobTitle:           lead.jobTitle,
            fullName:           lead.fullName,
            companyName:        lead.company,
            linkedinConnected:  lead.linkedinConnected,
          }}
          onClose={onCloseEditing}
        />
      )}

      {/* Engagement timeline */}
      <ul className="overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.02]">
        {lead.signals.map((s, i) => {
          const d           = buildSignalDisplay(s)
          const last        = i === lead.signals.length - 1
          const isEditing   = editingIdx === i
          const isExpandedD = expandedDescs.has(i)
          const bodyText    = d.contentText ?? (d.isManual ? s.description : null)
          const isLong      = (bodyText?.length ?? 0) > DESC_TRUNCATE
          const displayBody = isLong && !isExpandedD
            ? bodyText!.slice(0, DESC_TRUNCATE) + "…"
            : bodyText
          return (
            <li
              key={i}
              className={`flex items-start gap-3.5 px-5 py-3.5 ${last ? "" : "border-b border-white/[0.06]"}`}
            >
              <span
                className="mt-[7px] h-2 w-2 flex-shrink-0 rounded-full"
                style={{ backgroundColor: d.dotColor }}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  {d.linkUrl ? (
                    <a href={d.linkUrl} target="_blank" rel="noopener noreferrer" onClick={stop} className="text-[14px] font-semibold text-white hover:text-[#2BA98B] hover:underline">{d.label}</a>
                  ) : (
                    <span className="text-[14px] font-semibold text-white">{d.label}</span>
                  )}
                  <span className="flex shrink-0 items-center gap-1.5">
                    {d.isManual && s.id && (
                      <>
                        <button type="button" onClick={(e) => { e.stopPropagation(); setEditingIdx(i); setEditText(s.description ?? "") }} title="Edit" disabled={sigBusy} className="text-zinc-600 hover:text-zinc-300 disabled:opacity-40">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        </button>
                        <button type="button" onClick={(e) => { e.stopPropagation(); deleteEntry(s) }} title="Delete" disabled={sigBusy} className="text-zinc-600 hover:text-rose-400 disabled:opacity-40">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                        </button>
                      </>
                    )}
                    <span className="whitespace-nowrap text-[12px] text-zinc-400 tabular-nums">{formatDate(s.date)}</span>
                  </span>
                </div>
                {/* Score delta + post headline (or raw URL fallback for post verbs) */}
                {!isEditing && (s.scoreDelta > 0 || d.linkUrl) && (
                  <div className="mt-0.5 flex items-baseline gap-2">
                    {s.scoreDelta > 0 && (
                      <span className="text-[11px] font-medium text-[#2BA98B]">+{s.scoreDelta} pts</span>
                    )}
                    {d.linkUrl && (s.signalVerb === "liked_post" || s.signalVerb === "commented_post") && (
                      <PostHeadline url={d.linkUrl} workspaceId={workspaceId} fallback={
                        <a href={d.linkUrl} target="_blank" rel="noopener noreferrer" onClick={stop} className="break-all text-[12px] text-[#2BA98B] hover:underline">{shortenUrl(d.linkUrl)}</a>
                      } />
                    )}
                  </div>
                )}
                {isEditing ? (
                  <div className="mt-2 space-y-1.5" onClick={stop}>
                    <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={3} autoFocus className="w-full resize-none rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[13px] text-zinc-200 placeholder-zinc-500 focus:border-[#2BA98B]/40 focus:outline-none focus:ring-1 focus:ring-[#2BA98B]/40" />
                    <div className="flex gap-2">
                      <button type="button" onClick={(e) => { e.stopPropagation(); saveEdit(s) }} disabled={sigBusy || !editText.trim()} className="rounded-md bg-[#2BA98B] px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-[#239977] disabled:opacity-50">{sigBusy ? "Saving…" : "Save"}</button>
                      <button type="button" onClick={(e) => { e.stopPropagation(); setEditingIdx(null) }} disabled={sigBusy} className="rounded-md px-3 py-1.5 text-[12px] text-zinc-400 hover:text-white">Cancel</button>
                    </div>
                  </div>
                ) : displayBody ? (
                  <div className="mt-0.5">
                    {d.linkUrl ? (
                      <a href={d.linkUrl} target="_blank" rel="noopener noreferrer" onClick={stop} className="text-[13px] leading-[19px] text-zinc-300 hover:text-[#2BA98B] hover:underline">{displayBody}</a>
                    ) : (
                      <p className="text-[13px] leading-[19px] text-zinc-300">{displayBody}</p>
                    )}
                    {isLong && (
                      <button type="button" onClick={(e) => { e.stopPropagation(); toggleDesc(i) }} className="mt-0.5 text-[12px] text-zinc-500 hover:text-zinc-300">
                        {isExpandedD ? "Hide ↑" : "Show post ↓"}
                      </button>
                    )}
                  </div>
                ) : d.linkUrl && s.signalVerb !== "liked_post" && s.signalVerb !== "commented_post" ? (
                  <a href={d.linkUrl} target="_blank" rel="noopener noreferrer" onClick={stop} className="mt-0.5 inline-block break-all text-[12px] text-[#2BA98B] hover:underline">{shortenUrl(d.linkUrl)}</a>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>

      <InfluencedByPanel workspaceId={workspaceId} linkedinUrl={lead.linkedin} />
      <InterestsPanel
        workspaceId={workspaceId}
        linkedinUrl={lead.linkedin}
        twitterUrl={lead.twitterUrl}
      />
    </div>
  )
}

// ─── Stage pill (read-only + interactive) ────────────────────────────────────

function StagePillReadOnly({ stage, isManual }: { stage: FunnelStage; isManual: boolean }) {
  const c = STAGE_PILL[stage]
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold whitespace-nowrap"
      style={{ backgroundColor: c.bg, color: c.fg }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: c.dot }} />
      {isManual && <span className="text-[9px]" aria-hidden>📌</span>}
      {STAGE_DISPLAY_LABEL[stage] ?? stage}
    </span>
  )
}


// Persona-pill colour palette — stable per-name via a small hash so the same
// persona always renders the same colour across the table. Mirrors the pattern
// used by Prospect Type tags and stage pills, just with a wider palette so a
// workspace with a handful of personas gets visibly distinct chips.
const PERSONA_PALETTE: { bg: string; fg: string; dot: string }[] = [
  { bg: "rgba(43,169,139,0.16)",  fg: "#A7F3D0", dot: "#2BA98B" }, // teal
  { bg: "rgba(147,197,253,0.16)", fg: "#BFDBFE", dot: "#93C5FD" }, // blue
  { bg: "rgba(167,139,250,0.16)", fg: "#DDD6FE", dot: "#A78BFA" }, // violet
  { bg: "rgba(244,114,182,0.16)", fg: "#FBCFE8", dot: "#F472B6" }, // pink
  { bg: "rgba(245,158,11,0.16)",  fg: "#FDE68A", dot: "#F59E0B" }, // amber
  { bg: "rgba(34,211,238,0.16)",  fg: "#A5F3FC", dot: "#22D3EE" }, // cyan
  { bg: "rgba(239,68,68,0.16)",   fg: "#FECACA", dot: "#EF4444" }, // rose
]

function personaTone(name: string): { bg: string; fg: string; dot: string } {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return PERSONA_PALETTE[h % PERSONA_PALETTE.length]
}

// ─── Persona pill (clickable manual-override menu) ──────────────────────────

export function PersonaPillMenu({
  workspaceId,
  contactId,
  current,
  isManual,
  names,
  linkedinUrl,
}: {
  workspaceId: string
  contactId:   number
  current:     string | null
  isManual:    boolean
  names:       string[]
  linkedinUrl?: string | null
}) {
  const router = useRouter()
  const [open,  setOpen]  = useState(false)
  const [busy,  setBusy]  = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      const t = e.target as HTMLElement
      if (!t.closest("[data-persona-menu]")) setOpen(false)
    }
    document.addEventListener("click", onDocClick)
    return () => document.removeEventListener("click", onDocClick)
  }, [open])

  async function setPersona(persona: string | null) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/dashboard/${workspaceId}/contacts/${contactId}/persona`,
        {
          method:  "PATCH",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ persona }),
        },
      )
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Failed (${res.status})`)
        setBusy(false)
        return
      }
      setOpen(false)
      setBusy(false)
      router.refresh()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const label = current ?? "No persona"
  const tone = current ? personaTone(current) : { bg: "rgba(156,163,175,0.16)", fg: "#9CA3AF", dot: "#9CA3AF" }

  return (
    <span data-persona-menu className="relative inline-block">
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(o => !o) }}
        title={isManual
          ? "Manual override active — click to change or clear"
          : current
            ? "Auto-classified — click to override"
            : "No persona match yet — click to set one manually"}
        aria-label={`Persona: ${label}${isManual ? " (manually set)" : ""}. Click to change.`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold whitespace-nowrap transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60 motion-reduce:transition-none"
        style={{ backgroundColor: tone.bg, color: tone.fg }}
      >
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tone.dot }} />
        <span className="truncate max-w-[80px]">{label}</span>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          onClick={stop}
          className="absolute left-0 z-30 mt-1.5 w-52 overflow-hidden rounded-xl border border-white/10 bg-[#0B3D2E] shadow-[0_12px_32px_rgba(0,0,0,0.45)]"
        >
          <div className="border-b border-white/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">
            Set persona
          </div>
          {names.length === 0 ? (
            <p className="px-3 py-2 text-[11px] text-zinc-500">No personas configured. Add some in Settings → Personas.</p>
          ) : (
            names.map(name => {
              const isCurrent = name === current
              return (
                <button
                  key={name}
                  type="button"
                  role="menuitem"
                  onClick={(e) => { e.stopPropagation(); setPersona(name) }}
                  disabled={busy}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12px] transition-colors hover:bg-white/[0.06] disabled:opacity-50 ${
                    isCurrent ? "font-semibold text-white" : "text-zinc-300"
                  }`}
                >
                  <span>{name}</span>
                  {isCurrent && (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              )
            })
          )}
          {isManual && (
            <button
              type="button"
              role="menuitem"
              onClick={(e) => { e.stopPropagation(); setPersona(null) }}
              disabled={busy}
              className="flex w-full items-center px-3 py-2 text-left text-[12px] text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white disabled:opacity-50 border-t border-white/10"
            >
              Clear override (auto-classify)
            </button>
          )}
          {linkedinUrl && (
            <div className="flex justify-end border-t border-white/10 px-3 py-2" onClick={(e) => e.stopPropagation()}>
              <ExcludePersonButton
                workspaceId={workspaceId}
                linkedinUrl={linkedinUrl}
                name="this person"
                showLabel
              />
            </div>
          )}
          {error && (
            <p className="border-t border-white/10 bg-rose-500/10 px-3 py-1.5 text-[10px] text-rose-300">
              {error}
            </p>
          )}
        </div>
      )}
    </span>
  )
}

// SendDmButton is now the shared component imported from ../components/send-dm-button

// ─── Icons ──────────────────────────────────────────────────────────────────

function IconLink({
  href,
  title,
  children,
}: {
  href: string
  title: string
  children: React.ReactNode
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={stop}
      title={title}
      aria-label={title}
      className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-white/[0.06] text-zinc-300 transition-colors hover:bg-white/[0.12] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60 motion-reduce:transition-none"
    >
      {children}
    </a>
  )
}

function LinkedInIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.268 2.37 4.268 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  )
}

export function TwitterIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  )
}

/** LinkedIn brand-tile profile link. Solid LinkedIn-blue background, white
 *  "in" mark. Optional connection-status badge on the corner so the chip
 *  doubles as "open profile" + "connection state at a glance". */
function LinkedInBrandLink({
  href,
  status,
}: {
  href:   string | null
  status: "connected" | "not_connected" | "none"
}) {
  if (!href) {
    return (
      <span
        title="No LinkedIn URL"
        aria-label="No LinkedIn URL"
        className="relative inline-flex h-7 w-7 items-center justify-center rounded-[7px] bg-zinc-700/40 text-zinc-500"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.268 2.37 4.268 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452z" />
        </svg>
      </span>
    )
  }

  const connected = status === "connected"
  const badgeBg   = connected ? "#14B8A6" : "#F43F5E"
  const tooltip   = connected ? "Open LinkedIn profile - 1st-degree connection" : "Open LinkedIn profile - not connected"

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={stop}
      title={tooltip}
      aria-label={tooltip}
      style={{ backgroundColor: "#0A66C2" }}
      className="relative inline-flex h-7 w-7 items-center justify-center rounded-[7px] text-white transition-[filter] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60 motion-reduce:transition-none"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.268 2.37 4.268 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452z" />
      </svg>
      <span
        className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full ring-2 ring-[#0D1F1A]"
        style={{ backgroundColor: badgeBg }}
        aria-hidden
      >
        {connected ? (
          <svg width="7" height="7" viewBox="0 0 10 10" fill="none" stroke="#0A0A0A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="1.5,5 4,7.5 8.5,2.5" />
          </svg>
        ) : (
          <svg width="7" height="7" viewBox="0 0 10 10" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <line x1="2" y1="2" x2="8" y2="8" />
            <line x1="8" y1="2" x2="2" y2="8" />
          </svg>
        )}
      </span>
    </a>
  )
}

/** X (Twitter) brand-tile profile link. Solid black background, white X. */
function XBrandLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={stop}
      title="Open X profile"
      aria-label="Open X profile"
      className="relative inline-flex h-7 w-7 items-center justify-center rounded-[7px] bg-black text-white transition-[filter] hover:brightness-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60 motion-reduce:transition-none"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    </a>
  )
}

function ExternalIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      className={`text-zinc-400 flex-shrink-0 transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-90 text-[#2BA98B]" : ""}`}
      aria-hidden
    >
      <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// DncToggleButton has moved to ../components/dnc-toggle-button so the
// pre-enrichment tab can render the same affordance.
