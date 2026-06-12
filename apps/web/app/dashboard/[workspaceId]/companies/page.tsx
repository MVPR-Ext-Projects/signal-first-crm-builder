/**
 * Companies page — one card per company that's produced any signal, with
 * the people from that company unfurled underneath. Each person row shows
 * their latest signal so the SDR can see at a glance which engagement is
 * driving the company's score.
 *
 * Auth gate matches the SDR page. DB-only — the Postgres projection is
 * the source of truth for the Companies view.
 */

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import {
  getWorkspaceConfig,
  resolveProspectTypes,
  resolveDefaultExcludedProspectTypes,
  findTeamMember,
} from "@/lib/workspace-config"
import {
  getCompaniesWithSignals,
  attachContactsToCompanies,
  isDbConfigured,
  type CompanyWithContactsRow,
  type CompanyContactRow,
  type SortMode,
  type TeamFilter,
} from "@/lib/db/contact-store"
import { TeamMemberSelect } from "../team-member-select"
import { SearchBar } from "../search-bar"
import { CompanyFetchButton } from "../sdr/company-fetch-button"
import { CompaniesToolbar, CompaniesSortToggle } from "./companies-toolbar"
import { ProspectTypePill } from "./prospect-type-pill"
import { CompanyAssignmentPicker } from "./company-assignment-picker"
import { CompanyMrrPill } from "./company-mrr-pill"
import { CompanyStagePicker } from "./company-stage-picker"
import { CompanyEditButton } from "./company-edit-button"
import { CompanyDaIcon } from "./company-fetch-da-button"
import { ContactsList } from "./contacts-list"
import { CompanyCampaignChip } from "../components/company-campaign-chip"
import { PaginationFooter } from "../pagination-footer"
import { CreateCompanyButton } from "./create-company-button"
import { SelectionProvider, SelectionHeaderCheckbox, CompanyCheckbox, SelectionActionBar } from "./company-selection"

export const dynamic = "force-dynamic"

type CompanyStage =
  | "Prospect"
  | "Signal Found"
  | "Engaged"
  | "High Signal"
  | "Discovery Call"
  | "Requested Information"
  | "Follow Up Call"
  | "Sent Information"
  | "Diligence"
  | "Contract Negotiation"
  | "Customer Won"

const COMPANY_STAGE_ORDER: CompanyStage[] = [
  "Prospect",
  "Signal Found",
  "Engaged",
  "High Signal",
  "Discovery Call",
  "Requested Information",
  "Sent Information",
  "Follow Up Call",
  "Diligence",
  "Contract Negotiation",
  "Customer Won",
]

const COMPANY_STAGE_COLOR: Record<CompanyStage, { dot: string; text: string }> = {
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
  "Customer Won":          { dot: "#A78BFA", text: "#A78BFA" },
}

// Display-only label overrides so the long sales-stage names fit on a
// single line at sm+. DB values stay canonical; only the tile label is
// shortened. Order matches COMPANY_STAGE_ORDER for at-a-glance review.
const COMPANY_STAGE_DISPLAY_LABEL: Partial<Record<CompanyStage, string>> = {
  "Discovery Call":        "Disc Call",
  "Requested Information": "Info Request",
  "Follow Up Call":        "2nd Call",
  "Sent Information":      "Sent Info",
  "Contract Negotiation":  "Negotiation",
  "Customer Won":          "Won",
}

// Split into a score-range pill (only on the auto-derived stages) and a
// short description so the tile can render the range as a compact chip
// and leave the descriptive text underneath in muted small caps.
const COMPANY_STAGE_HINT: Record<CompanyStage, { score?: string; text: string }> = {
  Prospect:                { score: "0–4",   text: "Just appearing" },
  "Signal Found":          { score: "5–19",  text: "Early engagement" },
  Engaged:                 { score: "20–49", text: "Multi-person interest" },
  "High Signal":           { score: "≥ 50",  text: "Ready to outreach" },
  "Discovery Call":        { text: "Meeting booked" },
  "Requested Information": { text: "Asked for info" },
  "Follow Up Call":        { text: "Second meeting booked" },
  "Sent Information":      { text: "Awaiting their review" },
  "Diligence":             { text: "Commercial review" },
  "Contract Negotiation":  { text: "Terms being agreed" },
  "Customer Won":          { text: "Deal closed" },
}

function fmtRelative(when: string | Date | null): string {
  if (!when) return "—"
  const t = typeof when === "string" ? new Date(when) : when
  const ms = Date.now() - t.getTime()
  if (ms < 60_000)     return "just now"
  if (ms < 3600_000)   return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

/**
 * Render a company's employee range, e.g. "11–50", "10,001+", or "—".
 * Returns an empty string when no headcount data is known so the caller
 * can decide not to render the chip at all.
 */
function formatEmployees(min: number | null, max: number | null): string {
  if (min == null && max == null) return ""
  const fmt = (n: number) => n.toLocaleString("en-US")
  if (min != null && max == null) return `${fmt(min)}+`
  if (min == null && max != null) return `≤${fmt(max)}`
  if (min === max && min != null) return fmt(min)
  return `${fmt(min!)}–${fmt(max!)}`
}

function buildStageHref(
  workspaceId: string,
  stage: CompanyStage | null,
  carry: Record<string, string | string[] | undefined>,
): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(carry)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) {
      for (const item of v) if (item) sp.append(k, item)
    } else if (v !== "") {
      sp.set(k, v)
    }
  }
  if (stage) sp.set("stage", stage)
  const qs = sp.toString()
  return qs ? `/dashboard/${workspaceId}/companies?${qs}` : `/dashboard/${workspaceId}/companies`
}

const SORT_MODES: SortMode[] = ["recent-desc", "recent-asc", "score-desc", "score-asc", "score-then-recent", "recent-then-score"]

function parseSearchParams(search: Record<string, string | string[] | undefined>): {
  stageFilter:   CompanyStage | null
  selected:      string[]
  untagged:      boolean | undefined
  sortMode:      SortMode
  selectedSizes: string[]
} {
  const stageRaw = typeof search.stage === "string" ? search.stage : undefined
  const stageFilter = COMPANY_STAGE_ORDER.includes(stageRaw as CompanyStage)
    ? (stageRaw as CompanyStage) : null

  // ?type can repeat: ?type=Software&type=Services
  const typeRaw = search.type
  const selected: string[] = Array.isArray(typeRaw)
    ? typeRaw.filter((v): v is string => typeof v === "string")
    : typeof typeRaw === "string" ? [typeRaw] : []

  // untagged: undefined = "use default", "1" = on, "0" = off
  const untaggedRaw = typeof search.untagged === "string" ? search.untagged : undefined
  const untagged: boolean | undefined =
    untaggedRaw === "1" ? true : untaggedRaw === "0" ? false : undefined

  const sortRaw = typeof search.sort === "string" ? search.sort as SortMode : "recent-desc"
  const sortMode: SortMode = SORT_MODES.includes(sortRaw) ? sortRaw : "recent-desc"

  // ?size can repeat: ?size=11–50&size=51–200
  const sizeRaw = search.size
  const selectedSizes: string[] = Array.isArray(sizeRaw)
    ? sizeRaw.filter((v): v is string => typeof v === "string")
    : typeof sizeRaw === "string" ? [sizeRaw] : []

  return { stageFilter, selected, untagged, sortMode, selectedSizes }
}

export default async function CompaniesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const { workspaceId } = await params
  const search = (await searchParams) ?? {}
  const { stageFilter, selected, untagged, sortMode, selectedSizes } = parseSearchParams(search)
  const teamParam = typeof search.team === "string" ? search.team : null
  const searchQuery = typeof search.q === "string" ? search.q : null
  // Pagination — 1-indexed `?p=N` URL param. Page size is fixed; rendering
  // 2k+ company cards (each with multiple client components) is what made
  // the page hang in the browser before this cap.
  const PAGE_SIZE = 100
  const pageRaw = typeof search.p === "string" ? Number(search.p) : 1
  const pageNum = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1
  const offset = (pageNum - 1) * PAGE_SIZE
  const config = await getWorkspaceConfig(workspaceId)

  if (!config) {
    return (
      <div className="flex items-center justify-center py-32">
        <p className="text-[14px] text-zinc-400">Workspace not found.</p>
      </div>
    )
  }

  if (config.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) {
      redirect(`/dashboard/${workspaceId}/login`)
    }
  }

  if (!isDbConfigured()) {
    return (
      <div className="flex items-center justify-center py-32">
        <p className="text-[14px] text-zinc-400">Postgres not configured.</p>
      </div>
    )
  }

  // Resolve the workspace's tag config (fall back to defaults).
  const availableProspectTypes      = resolveProspectTypes(config)
  const defaultExcludedProspectTypes = resolveDefaultExcludedProspectTypes(config)

  // Effective tag selection: if no `?type=` is present in the URL, use the
  // workspace defaults (every available type NOT in defaultExcluded). If
  // the user has explicitly clicked any chip, the URL holds the truth.
  const userHasFiltered = selected.length > 0 || untagged !== undefined
  const effectiveSelected = userHasFiltered
    ? selected
    : availableProspectTypes.filter(v => !defaultExcludedProspectTypes.includes(v))
  // Untagged defaults to true when no explicit type filter is active (so
  // newly-arriving untagged companies are visible). When the user picks a
  // specific tag, default to false so only the matching tag is shown — not
  // untagged companies alongside it (AND not OR).
  const effectiveUntagged = untagged ?? (selected.length > 0 ? false : true)

  // Resolve team filter from URL + workspace config.
  const activeTeamMember = findTeamMember(config, teamParam)
  const teamFilter: TeamFilter | undefined = activeTeamMember
    ? { assignedTo: activeTeamMember.id }
    : undefined
  const teamMembers = config.teamMembers ?? []

  // Two-step pagination:
  //  1. Pull the WHOLE workspace company list (no contacts) so the stage
  //     stat-blocks count over the full filtered set.
  //  2. Apply stageFilter, slice to the requested page (+1 to detect
  //     hasNextPage), then attach contacts to ONLY the visible page.
  // The contacts query has a per-row LATERAL signal lookup, so capping
  // the input to ~100 keeps a 2k-company workspace from doing thousands
  // of lookups per page load.
  const allCompanies = await getCompaniesWithSignals(workspaceId, null, {
    includeProspectTypes:       effectiveSelected,
    includeUntagged:            effectiveUntagged,
    sortMode,
    teamFilter,
    searchQuery:                searchQuery ?? undefined,
    sizeFilter:                 selectedSizes.length > 0 ? selectedSizes : undefined,
  })
  const apifyConfigured   = !!config.enrichment?.apify?.apiToken
  const mozConfigured     = !!config.enrichment?.moz?.apiKey
  const unipileConfigured = !!config.messaging?.unipile?.apiKey

  const stageCounts: Record<CompanyStage, number> = {
    "Prospect":              0,
    "Signal Found":          0,
    "Engaged":               0,
    "High Signal":           0,
    "Discovery Call":        0,
    "Requested Information": 0,
    "Follow Up Call":        0,
    "Sent Information":      0,
    "Diligence":             0,
    "Contract Negotiation":  0,
    "Customer Won":          0,
  }
  for (const c of allCompanies) {
    if (c.effectiveStage in stageCounts) {
      stageCounts[c.effectiveStage as CompanyStage]++
    }
  }

  const filtered = stageFilter
    ? allCompanies.filter(c => c.effectiveStage === stageFilter)
    : allCompanies
  const pageSlice = filtered.slice(offset, offset + PAGE_SIZE + 1)
  const hasNextPage = pageSlice.length > PAGE_SIZE
  const visibleSlice = hasNextPage ? pageSlice.slice(0, PAGE_SIZE) : pageSlice
  const companies = await attachContactsToCompanies(workspaceId, visibleSlice, null, teamFilter)

  // Round-trip these across stage filter clicks so flipping a stage doesn't
  // wipe the type / sort selection.
  const carryParams: Record<string, string | string[] | undefined> = {
    type:     userHasFiltered ? selected     : undefined,
    untagged: untagged !== undefined ? (untagged ? "1" : "0") : undefined,
    sort:     sortMode === "recent-desc" ? undefined : sortMode,
    size:     selectedSizes.length > 0 ? selectedSizes : undefined,
    // size is also passed to CompaniesToolbar directly via selectedSizes prop
  }

  const allContacts = companies.flatMap(c =>
    c.contacts.map(c2 => ({ id: c2.id, companyName: c.companyName }))
  )

  return (
    <div className="space-y-7">
      <div>
        <p className="mb-1.5 text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">
          {config.name ?? workspaceId} · Companies
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[30px] font-bold tracking-[-0.02em] text-white">Companies</h1>
            <span
              className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] px-3 py-1 text-[12px] font-medium text-zinc-200"
              title={stageFilter
                ? `${filtered.length} companies in ${stageFilter}`
                : `${filtered.length} companies with engagement`}
            >
              <span className="tabular-nums font-semibold">{filtered.length}</span>
              <span className="text-zinc-400">{filtered.length === 1 ? "company" : "companies"}</span>
              {stageFilter && <span className="text-zinc-500">· {stageFilter}</span>}
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
          <div className="flex items-center gap-2" />
        </div>
        <p className="mt-1.5 text-[15px] leading-[22px] text-zinc-300">
          Each card unfurls the people whose signals are driving the company&rsquo;s score.
          {stageFilter && (
            <>
              {" · "}
              <a href={buildStageHref(workspaceId, null, carryParams)} className="text-[#2BA98B] hover:underline">
                Clear stage filter
              </a>
            </>
          )}
        </p>
      </div>

      {/* Stage stat-blocks — same pattern as the People tab */}
      <CompanyStageStatBlocks
        workspaceId={workspaceId}
        counts={stageCounts}
        active={stageFilter}
        carry={carryParams}
      />

      {/* Filters + sort toggle sit below the funnel */}
      <div className="flex flex-wrap items-center gap-2">
        <CompaniesToolbar
          workspaceId={workspaceId}
          available={availableProspectTypes}
          defaultExcluded={defaultExcludedProspectTypes}
        />
        {teamMembers.length > 0 && (
          <TeamMemberSelect members={teamMembers} active={activeTeamMember?.id ?? null} />
        )}
        <div className="ml-auto flex items-center gap-2">
          <SearchBar placeholder="Search companies or people" />
          <CompaniesSortToggle workspaceId={workspaceId} />
        </div>
      </div>

      {!apifyConfigured && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.05] px-4 py-3 text-[12px] text-amber-200">
          Apify token not configured — the &ldquo;Fetch employees&rdquo; action is disabled. Add a token in Settings to enable.
        </div>
      )}

      {companies.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-white/10 bg-white/[0.03] py-20">
          <p className="text-[14px] text-zinc-400">
            {stageFilter
              ? `No companies in the ${stageFilter} stage.`
              : searchQuery
                ? "No companies found."
                : "No companies with signals yet. They’ll appear here once Teamfluence sends an engagement event."}
          </p>
          {!stageFilter && <CreateCompanyButton workspaceId={workspaceId} />}
        </div>
      ) : (
        <SelectionProvider>
          <div className="space-y-3">
            <CompaniesColumnHeader mozConfigured={mozConfigured} allContacts={allContacts} />
            {companies.map((company) => (
              <CompanyCard
                key={company.companyName}
                workspaceId={workspaceId}
                company={company}
                apifyConfigured={apifyConfigured}
                mozConfigured={mozConfigured}
                unipileConfigured={unipileConfigured}
                availableProspectTypes={availableProspectTypes}
                teamMembers={teamMembers}
                carry={{ ...carryParams, stage: stageFilter ?? undefined }}
              />
            ))}
          </div>

          {/* Pagination — filter / sort / stage clicks DON'T carry ?p so they
              reset to page 1 naturally (different filter = different rows). */}
          <PaginationFooter
            pageNum={pageNum}
            hasNextPage={hasNextPage}
            prevHref={buildStageHref(workspaceId, stageFilter, {
              ...carryParams,
              team:     teamParam ?? undefined,
              q:        searchQuery ?? undefined,
              p:        pageNum > 2 ? String(pageNum - 1) : undefined,
            })}
            nextHref={buildStageHref(workspaceId, stageFilter, {
              ...carryParams,
              team:     teamParam ?? undefined,
              q:        searchQuery ?? undefined,
              p:        String(pageNum + 1),
            })}
          />

          <SelectionActionBar workspaceId={workspaceId} />
        </SelectionProvider>
      )}
    </div>
  )
}

function CompanyStageStatBlocks({
  workspaceId,
  counts,
  active,
  carry,
}: {
  workspaceId: string
  counts:      Record<CompanyStage, number>
  active:      CompanyStage | null
  carry:       Record<string, string | string[] | undefined>
}) {
  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-11 sm:gap-0 sm:overflow-hidden sm:rounded-2xl sm:border sm:border-white/10 sm:bg-white/[0.03]">
      {COMPANY_STAGE_ORDER.map((stage, i) => {
        const isActive = active === stage
        const colour = COMPANY_STAGE_COLOR[stage]
        const count = counts[stage] ?? 0
        // Clicking the active tile clears the filter; clicking any other
        // tile narrows the list to that stage. Mirrors the People-page
        // StageStatBlocks behaviour.
        const href = buildStageHref(workspaceId, isActive ? null : stage, carry)
        return (
          <a
            key={stage}
            href={href}
            aria-label={isActive ? `Clear ${stage} filter` : `Filter to ${stage}`}
            className={`relative flex flex-col gap-1 px-4 py-4 transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60 motion-reduce:transition-none max-sm:rounded-2xl max-sm:border max-sm:border-white/10 max-sm:bg-white/[0.03] sm:gap-1.5 sm:px-2.5 sm:py-3 ${
              i < COMPANY_STAGE_ORDER.length - 1 ? "sm:border-r sm:border-white/[0.08]" : ""
            } ${
              isActive
                ? "bg-[#2BA98B]/[0.10] ring-1 ring-inset ring-[#2BA98B]/40"
                : ""
            }`}
          >
            {/* Fixed-height label slot so the count number lands at the
                same y across every tile. Short display labels mean
                everything fits on one line at typical widths. */}
            <div className="flex items-start gap-1.5 sm:h-[16px] sm:gap-1">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full sm:mt-0.5 sm:h-1.5 sm:w-1.5" style={{ backgroundColor: colour.dot }} aria-hidden />
              <span
                className="text-[10px] font-bold uppercase leading-[1.15] tracking-[0.08em] sm:text-[9px] sm:tracking-[0.06em]"
                style={{ color: colour.text }}
              >
                {COMPANY_STAGE_DISPLAY_LABEL[stage] ?? stage}
              </span>
            </div>
            <span className="text-[36px] font-bold leading-[1.05] tracking-[-0.02em] text-white tabular-nums sm:text-[22px]">
              {count}
            </span>
            <div className="flex flex-wrap items-center gap-1">
              {COMPANY_STAGE_HINT[stage].score && (
                <span className="inline-flex items-center rounded-full bg-white/[0.06] px-1.5 py-px text-[10px] font-semibold tabular-nums leading-[1.4] text-zinc-300 sm:px-1 sm:text-[9px]">
                  {COMPANY_STAGE_HINT[stage].score}
                </span>
              )}
              <span className="text-[11px] leading-[1.25] text-zinc-400 sm:text-[10px]">
                {COMPANY_STAGE_HINT[stage].text}
              </span>
            </div>
            {isActive && (
              <span className="absolute right-2 top-2 text-[9px] font-bold uppercase tracking-[0.06em] text-[#2BA98B] sm:right-1.5 sm:top-1.5 sm:text-[8px]">
                ✓
              </span>
            )}
          </a>
        )
      })}
    </div>
  )
}

function CompanyCard({
  workspaceId,
  company,
  apifyConfigured,
  mozConfigured,
  unipileConfigured,
  availableProspectTypes,
  teamMembers,
  carry,
}: {
  workspaceId: string
  company: CompanyWithContactsRow
  apifyConfigured: boolean
  mozConfigured: boolean
  unipileConfigured: boolean
  availableProspectTypes: string[]
  teamMembers: { id: string; name: string }[]
  carry: Record<string, string | string[] | undefined>
}) {
  const initialResult = company.lastEnrichedAt
    ? { rawCount: company.enrichmentCount, matchCount: 0 }
    : null

  return (
    <div className="relative">
      <details
        className="group rounded-2xl border border-white/10 bg-white/[0.03] transition-colors hover:border-white/20 motion-reduce:transition-none"
      >
      <summary
        className="flex cursor-pointer list-none items-center gap-4 px-5 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60"
      >
        <CompanyCheckbox contactIds={company.contacts.map(c => c.id)} companyName={company.companyName} />

        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="shrink-0 text-zinc-400 transition-transform group-open:rotate-90 motion-reduce:transition-none"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>

        {/* Left cluster: company info + links + campaigns — all pinned left */}
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[16px] font-bold text-white">{company.companyName}</span>
              <CompanyEditButton
                workspaceId={workspaceId}
                companyName={company.companyName}
                companyLinkedinUrl={company.companyLinkedinUrl}
                websiteDomain={company.websiteDomain}
              />
            </div>
            <p className="mt-0.5 text-[12px] text-zinc-400">
              {company.contactCount} {company.contactCount === 1 ? "person" : "people"} · {company.signalCount} signal{company.signalCount === 1 ? "" : "s"} · last {fmtRelative(company.lastSignalAt)}
            </p>
            {(formatEmployees(company.employeesMin, company.employeesMax) || company.country || company.industries.length > 0) && (
              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-400">
                {formatEmployees(company.employeesMin, company.employeesMax) && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-white/[0.04] px-2 py-0.5">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </svg>
                    {formatEmployees(company.employeesMin, company.employeesMax)}
                  </span>
                )}
                {company.country && (
                  <span className="inline-flex items-center rounded-full bg-white/[0.04] px-2 py-0.5">
                    {company.country}
                  </span>
                )}
                {company.industries.slice(0, 3).map(ind => (
                  <span key={ind} className="inline-flex items-center rounded-full bg-white/[0.04] px-2 py-0.5">
                    {ind}
                  </span>
                ))}
                {company.industries.length > 3 && (
                  <span className="text-zinc-500">+{company.industries.length - 3} more</span>
                )}
              </p>
            )}
          </div>

          {/* Links: LinkedIn, website, DA */}
          <div className="hidden w-[88px] shrink-0 items-center gap-2 md:flex">
            <StatusIcon present={!!company.companyLinkedinUrl} title={company.companyLinkedinUrl ? "Open company LinkedIn page" : "No LinkedIn URL saved"}>
              {company.companyLinkedinUrl ? (
                <a href={company.companyLinkedinUrl.startsWith("http") ? company.companyLinkedinUrl : `https://${company.companyLinkedinUrl}`} target="_blank" rel="noopener noreferrer" className="inline-flex h-6 w-6 items-center justify-center rounded-[6px] bg-white/[0.06] text-zinc-400 transition-colors hover:text-zinc-200 motion-reduce:transition-none">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.268 2.37 4.268 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" /></svg>
                </a>
              ) : (
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-[6px] bg-white/[0.06] text-zinc-600 opacity-50">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.268 2.37 4.268 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" /></svg>
                </span>
              )}
            </StatusIcon>
            <StatusIcon present={!!company.websiteDomain} title={company.websiteDomain ? `Open ${company.websiteDomain}` : "No website domain saved"}>
              {company.websiteDomain ? (
                <a href={company.websiteDomain.startsWith("http") ? company.websiteDomain : `https://${company.websiteDomain}`} target="_blank" rel="noopener noreferrer" className="inline-flex h-6 w-6 items-center justify-center rounded-[6px] bg-white/[0.06] text-zinc-400 transition-colors hover:text-zinc-200 motion-reduce:transition-none">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 1 4 10 14.5 14.5 0 0 1-4 10 14.5 14.5 0 0 1-4-10 14.5 14.5 0 0 1 4-10z" /><path d="M2 12h20" /></svg>
                </a>
              ) : (
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-[6px] bg-white/[0.06] text-zinc-600 opacity-50">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 1 4 10 14.5 14.5 0 0 1-4 10 14.5 14.5 0 0 1-4-10 14.5 14.5 0 0 1 4-10z" /><path d="M2 12h20" /></svg>
                </span>
              )}
            </StatusIcon>
            {mozConfigured && (
              <CompanyDaIcon
                workspaceId={workspaceId}
                websiteDomain={company.websiteDomain}
                initialDA={company.domainAuthority}
              />
            )}
          </div>

          {/* Campaigns: enrol contacts in a campaign. */}
          <div className="hidden w-[100px] shrink-0 items-center gap-2 md:flex">
            <CompanyCampaignChip
              workspaceId={workspaceId}
              contactIds={company.contacts.map(c => c.id)}
            />
          </div>
        </div>

        {/* Notes: Tag / SDR / stage pills */}
        <div className="hidden min-w-[380px] shrink-0 items-center gap-3 md:flex">
          <ProspectTypePill
            workspaceId={workspaceId}
            companyName={company.companyName}
            initial={company.prospectTypes}
            available={availableProspectTypes}
          />
          <CompanyAssignmentPicker
            workspaceId={workspaceId}
            companyName={company.companyName}
            initialAssignment={company.assignedTeamMemberId}
            members={teamMembers}
          />
          <CompanyStagePicker
            workspaceId={workspaceId}
            companyName={company.companyName}
            effectiveStage={company.effectiveStage}
            manualStage={company.manualStage}
          />
          <CompanyMrrPill
            workspaceId={workspaceId}
            companyName={company.companyName}
            initial={company.dealMrr}
          />
        </div>

        <div className="flex w-[88px] shrink-0 items-center justify-end gap-2">
          {apifyConfigured ? (
            <CompanyFetchButton
              workspaceId={workspaceId}
              companyName={company.companyName}
              companyLinkedinUrl={company.companyLinkedinUrl}
              initialResult={initialResult}
              initialFetchedAt={company.lastEnrichedAt}
            />
          ) : (
            <span className="text-[11px] text-zinc-600">Apify not configured</span>
          )}

          <div className="hidden text-right md:block">
            <p className="text-[20px] font-bold leading-none tabular-nums text-white">{company.signalScore}</p>
          </div>
        </div>
      </summary>

      <ContactsList workspaceId={workspaceId} contacts={company.contacts} unipileConfigured={unipileConfigured} />
      </details>
    </div>
  )
}

function CompaniesColumnHeader({ mozConfigured, allContacts }: { mozConfigured: boolean; allContacts: { id: number; companyName: string | null }[] }) {
  const th = "text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]"
  return (
    <div className="hidden items-center gap-4 rounded-xl border border-white/[0.06] bg-white/[0.02] px-5 py-3 md:flex">
      {/* selection checkbox */}
      <SelectionHeaderCheckbox allContacts={allContacts} />
      {/* chevron spacer */}
      <div className="w-3.5 shrink-0" aria-hidden />
      {/* Left cluster mirrors the card's left cluster */}
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <p className={`flex-1 min-w-0 ${th}`}>Company</p>
        <p className={`w-[88px] shrink-0 ${th}`}>Links</p>
        <p className={`w-[132px] shrink-0 ${th}`}>Actions</p>
      </div>
      {/* Notes */}
      <p className={`w-[380px] shrink-0 ${th}`}>Notes</p>
      {/* Score */}
      <p className={`w-[88px] shrink-0 text-right ${th}`}>Score</p>
    </div>
  )
}

function StatusIcon({ present, title, children }: { present: boolean; title: string; children: React.ReactNode }) {
  return (
    <span className="relative inline-flex shrink-0" title={title}>
      {children}
      <span
        className="pointer-events-none absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full"
        style={{ backgroundColor: present ? '#14B8A6' : '#AA5882', border: '1px solid #000' }}
        aria-hidden
      >
        {present ? (
          <svg width="7" height="7" viewBox="0 0 10 10" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1.5 5.5 4 8 8.5 2" />
          </svg>
        ) : (
          <svg width="7" height="7" viewBox="0 0 10 10" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round">
            <line x1="2" y1="2" x2="8" y2="8" />
            <line x1="8" y1="2" x2="2" y2="8" />
          </svg>
        )}
      </span>
    </span>
  )
}

