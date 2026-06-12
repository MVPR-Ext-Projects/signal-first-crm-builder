/**
 * SDR Action List — per-workspace lead queue for Sales Development Reps.
 *
 * Reads people from the gtm-os Postgres projection ordered by engagement
 * score, enriches with company name, signal history (content engaged with),
 * and derives the recommended outreach action (LinkedIn DM / Email / Call).
 */

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { getLeads, getSdrPageCounts, getLatestActivity, isDbConfigured, periodSince, type LeadRow, type Period, type SortMode, type PersonaFilter, type TeamFilter } from "@/lib/db/contact-store"
import { findTeamMember } from "@/lib/workspace-config"
import { TeamMemberSelect } from "../team-member-select"
import { SearchBar } from "../search-bar"
import { PaginationFooter } from "../pagination-footer"
import { LeadTableRow } from "./lead-table-row"
import type { FunnelStage, ActionType, Lead } from "./lead-types"
import { PreEnrichmentTab } from "./pre-enrichment-tab"
import { PersonaSelect } from "./persona-select"
import { StageSelect } from "./stage-select"
import { EnrichmentSelect } from "./enrichment-select"
import { PeriodSelect } from "./period-select"
import { CreateProspectButton } from "./create-prospect-button"

type Tab = "all" | "queue"

// ─── Types (Lead / FunnelStage / ActionType) live in ./lead-types ──

// Order matters — used by the stage filter pills (left → right) and for
// any ordering-aware UI. Mirrors the funnel from prospect → won meeting.
const STAGE_ORDER: FunnelStage[] = [
  "Prospect",
  "Signal Found",
  "Engaged",
  "High Signal",
  "Discovery Call",
]

// Display-only label overrides. DB values stay unchanged.
const STAGE_DISPLAY_LABEL: Partial<Record<FunnelStage, string>> = {
  "High Signal":    "Highly engaged",
  "Discovery Call": "Ambassadors",
  "Customer Won":   "Customer Won",
}

// ─── Action type derivation ───────────────────────────────────────────────────

function getActionType(stage: FunnelStage, hasEmail: boolean, hasPhone: boolean): ActionType {
  if (stage === "Customer Won") {
    if (hasEmail) return "email"
    return "linkedin"
  }
  if (stage === "Discovery Call") {
    if (hasPhone) return "call"
    if (hasEmail) return "email"
    return "linkedin"
  }
  if (stage === "High Signal") {
    if (hasPhone) return "call"
    if (hasEmail) return "email"
    return "linkedin"
  }
  if (stage === "Engaged")  return "linkedin"
  if (stage === "Prospect") return "linkedin"
  return "email"
}

const ACTION_GUIDANCE: Record<FunnelStage, Record<ActionType, string>> = {
  "Customer Won": {
    linkedin: "Existing customer — focus on retention and expansion",
    email:    "Existing customer — focus on retention and expansion",
    call:     "Existing customer — focus on retention and expansion",
  },
  "Contract Negotiation": {
    linkedin: "Final terms - stay responsive, escalate blockers fast",
    email:    "Final terms - stay responsive, escalate blockers fast",
    call:     "Final terms - stay responsive, escalate blockers fast",
  },
  "Diligence": {
    linkedin: "Commercial review - answer fast, surface objections early",
    email:    "Commercial review - answer fast, surface objections early",
    call:     "Commercial review - answer fast, surface objections early",
  },
  "Sent Information": {
    linkedin: "Ball in their court - patient nudge after a few days, no pressure",
    email:    "Ball in their court - patient nudge after a few days, no pressure",
    call:     "Ball in their court - patient nudge after a few days, no pressure",
  },
  "Follow Up Call": {
    linkedin: "Next meeting booked - bring sharper questions and concrete options",
    email:    "Next meeting booked - bring sharper questions and concrete options",
    call:     "Next meeting booked - bring sharper questions and concrete options",
  },
  "Requested Information": {
    linkedin: "They asked for materials - send a focused, relevant piece",
    email:    "They asked for materials - send a focused, relevant piece",
    call:     "They asked for materials - send a focused, relevant piece",
  },
  "Discovery Call": {
    linkedin: "Meeting booked — confirm logistics + share an agenda",
    email:    "Meeting booked — confirm logistics + share an agenda",
    call:     "Meeting booked — confirm logistics + share an agenda",
  },
  "High Signal": {
    linkedin: "Reference their last engagement specifically — keep it short, one ask",
    email:    "Personalise to their last signal — one clear CTA, no deck",
    call:     "They know you — reference what they engaged with, be direct",
  },
  "Engaged": {
    linkedin: "Invite to an upcoming event, webinar, or roundtable",
    email:    "Share a high-value resource — no pitch",
    call:     "Warm enough — reference their activity, soft ask",
  },
  "Signal Found": {
    linkedin: "Don't connect yet — they need more signals first",
    email:    "Share a relevant thought piece — no ask, no pitch",
    call:     "Too early — wait for more signals",
  },
  "Prospect": {
    linkedin: "Top-of-funnel — engage with their content first, no DM yet",
    email:    "Hold — wait for signal activity before outreach",
    call:     "Hold — no engagement yet",
  },
}

// ─── Stage colour tokens ───────────────────────────────────────────────────────
// Single source of truth — referenced by the stat-block filters and the row
// pills. Dot is the small status indicator; hex is used directly so the value
// survives Tailwind purging.

const STAGE_COLOR: Record<FunnelStage, { dot: string; text: string }> = {
  Prospect:                { dot: "#9CA3AF", text: "#9CA3AF" },
  "Signal Found":          { dot: "#93C5FD", text: "#93C5FD" },
  Engaged:                 { dot: "#2BA98B", text: "#2BA98B" },
  "High Signal":           { dot: "#10B981", text: "#10B981" },
  "Discovery Call":        { dot: "#F59E0B", text: "#F59E0B" },
  "Requested Information": { dot: "#FBBF24", text: "#FBBF24" },
  "Follow Up Call":        { dot: "#FB923C", text: "#FB923C" },
  "Sent Information":      { dot: "#818CF8", text: "#818CF8" },
  "Diligence":             { dot: "#C084FC", text: "#C084FC" },
  "Contract Negotiation":  { dot: "#34D399", text: "#34D399" },
  "Customer Won":          { dot: "#A78BFA", text: "#C4B5FD" },
}

const STAGE_HINT: Record<FunnelStage, string> = {
  Prospect:                "Score 0–2 · monitor only",
  "Signal Found":          "Score 3–5 · nurture, no pitch",
  Engaged:                 "Score 6–25 · LinkedIn touchpoint",
  "High Signal":           "Score ≥ 26 · contact today",
  "Discovery Call":        "Meeting booked · confirm logistics",
  "Requested Information": "Asked for info · share materials",
  "Follow Up Call":        "Second meeting booked",
  "Sent Information":      "Awaiting their review",
  "Diligence":             "Commercial review in progress",
  "Contract Negotiation":  "Terms being agreed",
  "Customer Won":          "Existing customer",
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function SdrPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>
  searchParams: Promise<{ sort?: string; period?: string; tab?: string; stage?: string; persona?: string; excluded?: string; team?: string; p?: string; q?: string }>
}) {
  const { workspaceId } = await params
  const search = (await searchParams) ?? {}
  // Sort modes: "recent-desc" (default) = newest signal first,
  // "recent-asc" = oldest signal first, "score-desc" = highest score first,
  // "score-asc" = lowest score first. URL param uses the same string.
  // Legacy ?sort=recent maps to recent-desc for back-compat with bookmarks.
  const rawSort = typeof search.sort === "string" ? search.sort : ""
  const normalizedSort = rawSort === "recent" ? "recent-desc" : rawSort
  const sortMode: SortMode = (["recent-desc", "recent-asc", "score-desc", "score-asc", "score-then-recent", "recent-then-score"] as SortMode[]).includes(normalizedSort as SortMode)
    ? (normalizedSort as SortMode)
    : "recent-desc"
  const period: Period = (["week", "month", "all"] as Period[]).includes(search.period as Period)
    ? (search.period as Period)
    : "all"
  // Backwards compat: ?tab=companies used to render an inner Companies tab on
  // this page. Companies are now a top-level page; redirect anyone landing on
  // the old URL.
  if (search.tab === "companies") {
    redirect(`/dashboard/${workspaceId}/companies`)
  }
  // Backwards compat: ?tab=action was the old "Persona Match" tab. That tab
  // is gone — its filter ("__matched__") is now a pseudo-option in the persona
  // dropdown. Stale ?tab=action URLs get redirected to the dropdown form so
  // bookmarks keep working.
  if (search.tab === "action") {
    redirect(`/dashboard/${workspaceId}/sdr?persona=__matched__`)
  }
  const tab: Tab = search.tab === "queue" ? "queue" : "all"
  const stageFilter: FunnelStage | null =
    STAGE_ORDER.includes(search.stage as FunnelStage) ? (search.stage as FunnelStage) : null
  // Persona filter — null = any. "__none__" = only contacts with no persona
  // match. Otherwise = a specific persona name. Validated against the
  // workspace's configured personas below so a stale URL doesn't 500.
  const personaParam = typeof search.persona === "string" ? search.persona : null
  // ?excluded=1 brings in contacts from Excluded-tagged companies; default
  // is to hide them with a count pill so the user sees what's been filtered.
  const includeExcluded = search.excluded === "1"
  // ?team=<id> narrows to a saved team-member's rules + explicit assignments.
  // Validated against config.teamMembers below; stale ids fall through to no filter.
  const teamParam = typeof search.team === "string" ? search.team : null
  // Pagination — 1-indexed `?p=N` URL param. Page size is fixed; large
  // workspaces (1k+ rows) bottleneck on the LATERAL signal aggregation in
  // getLeads, so capping the read here is what makes the page fast.
  const PAGE_SIZE = 100
  const pageRaw = typeof search.p === "string" ? Number(search.p) : 1
  const pageNum = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1
  const offset = (pageNum - 1) * PAGE_SIZE
  const searchQuery = typeof search.q === "string" ? search.q : null
  const since = periodSince(period)
  // getLatestActivity + getWorkspaceConfig don't depend on each other — run
  // them concurrently to save round trips on every load.
  const [lastActivity, config] = await Promise.all([
    getLatestActivity(workspaceId),
    getWorkspaceConfig(workspaceId),
  ])

  if (config?.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) {
      redirect(`/dashboard/${workspaceId}/login`)
    }
  }

  let leads: Lead[]

  const enrichmentFilter = tab === "queue" ? "unenriched" : "enriched"
  // The "All People" tab uses 0 so every enriched lead shows regardless of
  // score; the queue tab uses 1 to skip true-zero contacts that haven't even
  // been engaged.
  const minScore = tab === "queue" ? 1 : 0

  // Validate the persona filter against the configured personas (plus the two
  // pseudo-values __matched__ / __none__). Anything else falls back to "no
  // filter" so a stale URL doesn't 500.
  const configuredPersonaNames = (config?.messaging?.personas ?? [])
    .map(p => p.name?.trim())
    .filter((n): n is string => !!n)
  const personaFilter: PersonaFilter =
    personaParam === "__matched__" || personaParam === "__none__"
      ? personaParam
      : personaParam && configuredPersonaNames.includes(personaParam)
        ? personaParam
        : null

  // The "Excluded" toggle now means "show ONLY contacts at Excluded-tagged
  // companies" — single-state click. Default (off) hides them as before.
  const onlyExcluded = includeExcluded

  // Resolve team filter from URL + workspace config. Stale ?team= ids fall
  // through to no filter rather than 404.
  const activeTeamMember = config ? findTeamMember(config, teamParam) : null
  const teamFilter: TeamFilter | undefined = activeTeamMember
    ? { assignedTo: activeTeamMember.id }
    : undefined
  const teamMembers = config?.teamMembers ?? []

  // Toolbar pills (enriched / for enrichment / excluded) honour the active
  // stage filter so clicking a stage stat-block narrows all three to that
  // stage. They DO NOT honour the tab's enrichment filter — each pill carries
  // its own enrichment semantic and they need to sum to the full total under
  // the current stage. Stage stat-blocks also use stage-only context.
  // The four count aggregates ride in one query (single base scan, four
  // filtered aggregations) so they don't compete with `leads` for DB
  // compute when run in parallel.
  const [counts, leadRows] = isDbConfigured() ? await Promise.all([
    getSdrPageCounts(workspaceId, since, enrichmentFilter, stageFilter, teamFilter, searchQuery),
    // Fetch one extra row beyond the page size to detect "has next page"
    // without paying for a separate COUNT query.
    getLeads(workspaceId, minScore, sortMode, since, enrichmentFilter, stageFilter, personaFilter, onlyExcluded, teamFilter, PAGE_SIZE + 1, offset, searchQuery),
  ]) : [{ all: 0, queue: 0, excluded: 0, stages: {} as Record<string, number> }, [] as LeadRow[]]
  const { all: allCount, queue: queueCount, excluded: excludedCount, stages: stageCounts } = counts
  const hasNextPage = leadRows.length > PAGE_SIZE
  const visibleLeadRows = hasNextPage ? leadRows.slice(0, PAGE_SIZE) : leadRows
  const unipileConfigured = !!config?.messaging?.unipile?.apiKey

  if (isDbConfigured()) {
    const rows = visibleLeadRows
    const KNOWN_STAGES = new Set<string>(STAGE_ORDER)
    leads = rows.map((row: LeadRow): Lead => {
      const stage         = (KNOWN_STAGES.has(row.effectiveStage) ? row.effectiveStage : "Prospect") as FunnelStage
      const stageIsManual = row.manualStage !== null
      const actionType    = getActionType(stage, !!row.email, false)
      return {
        recordId:   row.crmContactId,
        contactId:  row.id,
        crmUrl:     row.crmUrl,
        fullName:   row.fullName,
        linkedin:   row.linkedinUrl,
        twitterUrl: row.twitterUrl,
        email:      row.email,
        jobTitle:   row.jobTitle,
        company:    row.companyName,
        icpGroup:   row.icpGroup,
        persona:        row.persona,
        personaIsManual: row.manualPersona !== null,
        score:      row.signalScore,
        signalCount: row.signalCount,
        stage,
        stageIsManual,
        actionType,
        guidance:   ACTION_GUIDANCE[stage][actionType],
        signals:    [
          ...row.recentSignals.map(s => ({
            id:              s.id ?? null,
            source:          s.sourceType,
            url:             s.engagementUrl,
            description:     s.description,
            date:            s.occurredAt,
            signalVerb:      s.signalVerb ?? null,
            signalActor:     s.signalActor ?? null,
            signalObject:    s.signalObject ?? null,
            verbDescription: s.verbDescription ?? null,
            scoreDelta:      s.scoreDelta ?? 0,
            isNote:          false,
          })),
          // Task #12 — notes live in a separate table now; merge into the
          // same timeline array (sorted by date below) so the UI renders
          // them inline with signals. The "Manual Note" source label drives
          // the existing display affordances (edit/delete buttons, dot color).
          ...(row.recentNotes ?? []).map(n => ({
            id:              n.id,
            source:          "Manual Note",
            url:             null,
            description:     n.body,
            date:            typeof n.occurredAt === "string" ? n.occurredAt : new Date(n.occurredAt as unknown as string).toISOString(),
            signalVerb:      null,
            signalActor:     null,
            signalObject:    null,
            verbDescription: null,
            scoreDelta:      0,
            isNote:          true,
          })),
        ].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")),
        lastEnrichmentStatus: row.lastEnrichmentStatus ?? null,
        lastEnrichmentAt:     typeof row.lastEnrichmentAt === "string"
          ? row.lastEnrichmentAt
          : (row.lastEnrichmentAt as Date | null)?.toISOString?.() ?? null,
        doNotContactUntil:    typeof row.doNotContactUntil === "string"
          ? row.doNotContactUntil
          : (row.doNotContactUntil as Date | null)?.toISOString?.() ?? null,
        linkedinConnected:    row.linkedinConnected ?? null,
      }
    })
  } else {
    return (
      <div className="flex items-center justify-center py-32">
        <p className="text-zinc-400 text-sm">Postgres not configured. Set DATABASE_URL to enable the SDR view.</p>
      </div>
    )
  }

  // Persona Match is applied entirely SQL-side now. No in-page filter pass.
  const lastUpdatedLabel = formatLastUpdated(lastActivity)
  // Total people pill = the three exclusive buckets (enriched-non-excluded,
  // unenriched-non-excluded, excluded). Their sum is the workspace total
  // under the current stage filter (if any).
  const totalPeople = allCount + queueCount + excludedCount
  const totalLabel = String(totalPeople)

  return (
    <div className="space-y-7">
      {/* Title block */}
      <div>
        <p className="mb-1.5 text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">
          Today · highest signal first
        </p>
        <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[30px] font-bold tracking-[-0.02em] text-white">SDR Action List</h1>
            <span
              className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] px-3 py-1 text-[12px] font-medium text-zinc-200"
              title={stageFilter ? `${totalLabel} contacts in ${stageFilter}` : `${totalLabel} contacts in this workspace`}
            >
              <span className="tabular-nums font-semibold">{totalLabel}</span>
              <span className="text-zinc-400">{totalPeople === 1 ? "person" : "people"}</span>
              {stageFilter && (
                <span className="text-zinc-500">· {stageFilter}</span>
              )}
            </span>
            {activeTeamMember && (
              <span
                className="inline-flex items-center gap-1.5 rounded-full bg-[#2BA98B]/[0.16] px-3 py-1 text-[12px] font-medium text-white"
                title={`Filtering by ${activeTeamMember.name}`}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <circle cx="12" cy="8" r="4" />
                  <path d="M4 21v-1a8 8 0 0 1 16 0v1" />
                </svg>
                <span className="font-semibold">{activeTeamMember.name}</span>
              </span>
            )}
        </div>
        <p className="mt-1.5 text-[15px] leading-[22px] text-zinc-300">
          {lastUpdatedLabel ? `Last updated ${lastUpdatedLabel}.` : ""}
          {stageFilter && (
            <>
              {lastUpdatedLabel ? " · " : ""}
              <a
                href={buildHref(workspaceId, { sort: sortMode, period, tab, stage: null })}
                className="text-[#2BA98B] hover:underline"
              >
                Clear stage filter
              </a>
            </>
          )}
        </p>
      </div>

      {/* Stat block filters — click to filter, click active to clear */}
      <StageStatBlocks
        workspaceId={workspaceId}
        counts={stageCounts}
        active={stageFilter}
        sortMode={sortMode}
        period={period}
        tab={tab}
      />

      {/* Tabs + filter bar — single row, packs left to right with the
          tabs first and the filters next to them. Surfe credits live on
          the global cost pill in the header, not duplicated here. */}
      <div className="flex flex-wrap items-center gap-2">
        <StageSelect
          workspaceId={workspaceId}
          tab={tab}
          sortMode={sortMode}
          period={period}
          persona={personaFilter}
          active={stageFilter}
        />
        {teamMembers.length > 0 && (
          <TeamMemberSelect members={teamMembers} active={activeTeamMember?.id ?? null} />
        )}
        <EnrichmentSelect
          workspaceId={workspaceId}
          tab={tab}
          sortMode={sortMode}
          period={period}
          stage={stageFilter}
          persona={personaFilter}
          includeExcluded={includeExcluded}
          allCount={allCount}
          queueCount={queueCount}
          excludedCount={excludedCount}
        />
        {configuredPersonaNames.length > 0 && (
          <PersonaSelect
            workspaceId={workspaceId}
            tab={tab}
            sortMode={sortMode}
            period={period}
            stage={stageFilter}
            names={configuredPersonaNames}
            active={personaFilter}
          />
        )}
        <PeriodSelect workspaceId={workspaceId} sortMode={sortMode} period={period} tab={tab} stage={stageFilter} persona={personaFilter} />
        <div className="ml-auto flex items-center gap-2">
          <SearchBar placeholder="Search people or companies" />
          <SortToggle workspaceId={workspaceId} sortMode={sortMode} period={period} tab={tab} />
        </div>
      </div>

      {/* Table */}
      {tab === "queue" ? (
        <PreEnrichmentTab workspaceId={workspaceId} leads={leads} />
      ) : leads.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-white/10 bg-white/[0.03] py-20">
          <p className="text-sm text-zinc-400">
            {stageFilter
              ? `No contacts in the ${stageFilter} stage match the current filter.`
              : allCount === 0
                ? "No enriched contacts yet — switch to the For enrichment tab to start."
                : "No profiles found."}
          </p>
          {!stageFilter && <CreateProspectButton workspaceId={workspaceId} />}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.03]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/[0.08]">
                <th className="px-5 py-3.5 text-left text-[12px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Person · Company</th>
                <th className="hidden md:table-cell px-3 py-3.5 text-left text-[12px] font-bold uppercase tracking-[0.10em] text-[#2BA98B] w-[88px]">Links</th>
                <th className="hidden lg:table-cell px-3 py-3.5 text-left text-[12px] font-bold uppercase tracking-[0.10em] text-[#2BA98B] w-[112px]">Actions</th>
                <th className="hidden md:table-cell px-3 py-3.5 text-left text-[12px] font-bold uppercase tracking-[0.10em] text-[#2BA98B] w-[140px]">Stage</th>
                <th className="hidden xl:table-cell px-3 py-3.5 text-left text-[12px] font-bold uppercase tracking-[0.10em] text-[#2BA98B] w-[200px]">Latest signal</th>
                {configuredPersonaNames.length > 0 && (
                  <th className="hidden xl:table-cell px-2 py-3.5 text-left text-[12px] font-bold uppercase tracking-[0.10em] text-[#2BA98B] w-[120px]">Persona</th>
                )}
                <th className="hidden xl:table-cell px-2 py-3.5 text-left text-[12px] font-bold uppercase tracking-[0.10em] text-[#2BA98B] w-[160px]">Notes</th>
                <th className="px-5 py-3.5 text-right text-[12px] font-bold uppercase tracking-[0.10em] text-[#2BA98B] w-[88px]">Score</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <LeadTableRow
                  key={lead.recordId}
                  lead={lead}
                  workspaceId={workspaceId}
                  personaNames={configuredPersonaNames}
                  unipileConfigured={unipileConfigured}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination — filter / sort / tab clicks DON'T carry ?p, so they
          reset to page 1 naturally — that's the right behaviour because
          page N under a different filter shows different rows. */}
      <PaginationFooter
        pageNum={pageNum}
        hasNextPage={hasNextPage}
        prevHref={buildHref(workspaceId, {
          sort: sortMode, period, tab,
          stage: stageFilter,
          persona: personaFilter,
          excluded: includeExcluded,
          query: searchQuery,
          page: pageNum - 1,
        })}
        nextHref={buildHref(workspaceId, {
          sort: sortMode, period, tab,
          stage: stageFilter,
          persona: personaFilter,
          excluded: includeExcluded,
          query: searchQuery,
          page: pageNum + 1,
        })}
      />
    </div>
  )
}

// ─── Stat block filters ───────────────────────────────────────────────────────
// Each block is a clickable filter. Active block gets a teal ring + filled
// background; clicking it again clears the filter (toggle behaviour, same as
// the previous StagePills). The 5-stage funnel is read left → right.

function StageStatBlocks({
  workspaceId,
  counts,
  active,
  sortMode,
  period,
  tab,
}: {
  workspaceId: string
  counts:      Record<string, number>
  active:      FunnelStage | null
  sortMode:    SortMode
  period:      Period
  tab:         Tab
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5 sm:gap-0 sm:overflow-hidden sm:rounded-2xl sm:border sm:border-white/10 sm:bg-white/[0.03]">
      {STAGE_ORDER.map((stage, i) => {
        const isActive = active === stage
        const colour = STAGE_COLOR[stage]
        const count = counts[stage] ?? 0
        return (
          <div
            key={stage}
            className={`relative flex flex-col gap-1.5 px-5 py-5 max-sm:rounded-2xl max-sm:border max-sm:border-white/10 max-sm:bg-white/[0.03] ${
              i < 4 ? "sm:border-r sm:border-white/[0.08]" : ""
            } ${
              isActive
                ? "bg-[#2BA98B]/[0.20] ring-2 ring-inset ring-[#2BA98B] shadow-[inset_0_-3px_0_0_#2BA98B]"
                : ""
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: colour.dot }} aria-hidden />
              <span
                className={`text-[12px] font-bold uppercase tracking-[0.12em] ${isActive ? "text-white" : ""}`}
                style={{ color: isActive ? undefined : colour.text }}
              >
                {STAGE_DISPLAY_LABEL[stage] ?? stage}
              </span>
            </div>
            <span className={`text-[36px] font-bold leading-[1.05] tracking-[-0.02em] tabular-nums ${
              isActive ? "text-[#2BA98B]" : "text-white"
            }`}>
              {count}
            </span>
            <span className={`text-[12px] ${isActive ? "text-zinc-200" : "text-zinc-400"}`}>{STAGE_HINT[stage]}</span>
            {isActive && (
              <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full bg-[#2BA98B] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-[#08302E]">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Filtered
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── "Last updated" formatter ─────────────────────────────────────────────────

function formatLastUpdated(lastActivity: Date | null): string | null {
  if (!lastActivity) return null
  const ms = Date.now() - lastActivity.getTime()
  const min = Math.floor(ms / 60_000)
  const hr  = Math.floor(ms / 3_600_000)
  const day = Math.floor(ms / 86_400_000)
  if (min < 1)   return "just now"
  if (min < 60)  return `${min} min${min === 1 ? "" : "s"} ago`
  if (hr  < 24)  return `${hr} hr${hr === 1 ? "" : "s"} ago`
  if (day < 7)   return `${day} day${day === 1 ? "" : "s"} ago`
  return lastActivity.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
}

// ─── URL builder ──────────────────────────────────────────────────────────────

function buildHref(
  workspaceId: string,
  params: { sort?: string; period?: string; tab?: string; stage?: FunnelStage | null; persona?: string | null; excluded?: boolean; page?: number; query?: string | null },
): string {
  const qs = new URLSearchParams()
  // "recent-desc" is the default sort, so omit it from the URL.
  if (params.sort   && params.sort   !== "recent-desc") qs.set("sort", params.sort)
  if (params.period && params.period !== "all")    qs.set("period", params.period)
  if (params.tab    && params.tab    !== "all")    qs.set("tab",    params.tab)
  if (params.stage)                                qs.set("stage",  params.stage)
  if (params.persona)                              qs.set("persona", params.persona)
  if (params.excluded)                             qs.set("excluded", "1")
  if (params.query)                                qs.set("q",       params.query)
  // Page 1 is implicit — only emit ?p when the user has navigated deeper.
  if (params.page && params.page > 1)              qs.set("p", String(params.page))
  const q = qs.toString()
  return `/dashboard/${workspaceId}/sdr${q ? "?" + q : ""}`
}

// ─── Toggles ──────────────────────────────────────────────────────────────────

interface ToolbarState {
  workspaceId: string
  sortMode:    SortMode
  period:      Period
  tab:         Tab
}

function SortToggle({ workspaceId, sortMode, period, tab }: ToolbarState) {
  const recentActive = sortMode === "recent-desc" || sortMode === "recent-asc"
                    || sortMode === "score-then-recent" || sortMode === "recent-then-score"
  const scoreActive  = sortMode === "score-desc"  || sortMode === "score-asc"
                    || sortMode === "score-then-recent" || sortMode === "recent-then-score"
  const bothActive   = recentActive && scoreActive

  function nextRecentMode(): SortMode {
    if (bothActive) return sortMode === "score-then-recent" ? "recent-then-score" : "score-then-recent"
    if (recentActive) return sortMode === "recent-desc" ? "recent-asc" : "recent-desc"
    return "score-then-recent"
  }
  function nextScoreMode(): SortMode {
    if (bothActive) return sortMode === "recent-then-score" ? "score-then-recent" : "recent-then-score"
    if (scoreActive) return sortMode === "score-desc" ? "score-asc" : "score-desc"
    return "recent-then-score"
  }

  const recentArrow = (sortMode === "recent-asc" || sortMode === "recent-then-score") ? "↑" : "↓"
  const scoreArrow  = (sortMode === "score-asc"  || sortMode === "score-then-recent") ? "↑" : "↓"

  return (
    <div className="inline-flex items-center gap-1 rounded-xl bg-white/[0.04] p-1 text-[12px]">
      <a
        href={buildHref(workspaceId, { sort: nextRecentMode(), period, tab })}
        aria-pressed={recentActive}
        title={bothActive ? "Both active — click to switch primary sort" : recentActive ? "Toggle direction" : "Add Recent sort"}
        className={`rounded-lg px-3 py-1.5 transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60 ${
          recentActive ? "bg-white/[0.10] font-semibold text-white" : "text-zinc-400 hover:text-zinc-200"
        }`}
      >
        Recent {recentArrow}
      </a>
      <a
        href={buildHref(workspaceId, { sort: nextScoreMode(), period, tab })}
        aria-pressed={scoreActive}
        title={bothActive ? "Both active — click to switch primary sort" : scoreActive ? "Toggle direction" : "Add Score sort"}
        className={`rounded-lg px-3 py-1.5 transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60 ${
          scoreActive ? "bg-white/[0.10] font-semibold text-white" : "text-zinc-400 hover:text-zinc-200"
        }`}
      >
        Score {scoreArrow}
      </a>
    </div>
  )
}


