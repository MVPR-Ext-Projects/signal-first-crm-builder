/**
 * Loading skeleton for the Companies page. Next.js streams this in as soon
 * as the user navigates, so the heavy server query for getCompaniesWithContacts
 * (200+ rows + per-company contacts) doesn't leave the user staring at a blank
 * page or the previous route's content. Mirrors the real header / toolbar /
 * card grid layout so the transition into the live data feels like a fade
 * rather than a layout pop.
 */

export default function CompaniesLoading() {
  return (
    <div className="space-y-7" aria-label="Loading companies" role="status">
      {/* Header */}
      <div>
        <div className="mb-1.5 h-3 w-44 animate-pulse rounded bg-white/[0.08]" />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="h-9 w-40 animate-pulse rounded-lg bg-white/[0.08]" />
            <div className="h-7 w-28 animate-pulse rounded-full bg-white/[0.06]" />
          </div>
          <div className="h-9 w-44 animate-pulse rounded-xl bg-white/[0.04]" />
        </div>
        <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded bg-white/[0.05]" />
      </div>

      {/* Stage stat blocks - 11 columns, matches current page */}
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-11 sm:gap-0 sm:overflow-hidden sm:rounded-2xl sm:border sm:border-white/10 sm:bg-white/[0.03]">
        {Array.from({ length: 11 }).map((_, i) => (
          <div
            key={i}
            className={`flex flex-col gap-2 px-4 py-4 max-sm:rounded-2xl max-sm:border max-sm:border-white/10 max-sm:bg-white/[0.03] sm:gap-1.5 sm:px-2.5 sm:py-3 ${
              i < 10 ? "sm:border-r sm:border-white/[0.08]" : ""
            }`}
          >
            <div className="flex items-center gap-2 sm:h-[16px] sm:gap-1">
              <div className="h-2 w-2 animate-pulse rounded-full bg-white/[0.10] sm:h-1.5 sm:w-1.5" />
              <div className="h-2.5 w-16 animate-pulse rounded bg-white/[0.08] sm:h-2 sm:w-12" />
            </div>
            <div className="h-9 w-10 animate-pulse rounded bg-white/[0.10] sm:h-5 sm:w-7" />
            <div className="h-3 w-24 animate-pulse rounded bg-white/[0.05] sm:h-2.5 sm:w-16" />
          </div>
        ))}
      </div>

      {/* Filter row */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="h-7 w-24 animate-pulse rounded-full bg-white/[0.06]" />
          <div className="h-7 w-20 animate-pulse rounded-full bg-white/[0.06]" />
          <div className="h-7 w-16 animate-pulse rounded-full bg-white/[0.06]" />
          <div className="h-7 w-16 animate-pulse rounded-full bg-white/[0.06]" />
        </div>
        <div className="h-8 w-36 animate-pulse rounded-xl bg-white/[0.04]" />
      </div>

      {/* Company cards */}
      <div className="space-y-3">
        {Array.from({ length: 7 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4"
          >
            <div className="h-3.5 w-3.5 shrink-0 animate-pulse rounded bg-white/[0.06]" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-48 animate-pulse rounded bg-white/[0.08]" />
              <div className="h-3 w-64 animate-pulse rounded bg-white/[0.05]" />
            </div>
            <div className="hidden items-center gap-3 md:flex">
              <div className="h-6 w-20 animate-pulse rounded-full bg-white/[0.06]" />
              <div className="h-6 w-16 animate-pulse rounded-full bg-white/[0.06]" />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <div className="h-7 w-7 animate-pulse rounded-lg bg-white/[0.06]" />
              <div className="h-7 w-7 animate-pulse rounded-lg bg-white/[0.06]" />
              <div className="h-8 w-10 animate-pulse rounded bg-white/[0.06]" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
