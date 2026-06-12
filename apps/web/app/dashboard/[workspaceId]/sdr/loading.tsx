/**
 * Loading skeleton for the SDR Action List. Server query touches contacts +
 * recent signals + counts across half a dozen dimensions; this skeleton
 * lands instantly and matches the real layout so the transition into live
 * data is a smooth swap rather than a layout shift.
 */

export default function SdrLoading() {
  return (
    <div className="space-y-7" aria-label="Loading leads" role="status">
      {/* Title block */}
      <div>
        <div className="mb-1.5 h-3 w-48 animate-pulse rounded bg-white/[0.08]" />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="h-9 w-56 animate-pulse rounded bg-white/[0.08]" />
            <div className="h-7 w-32 animate-pulse rounded-full bg-white/[0.06]" />
          </div>
          <div className="h-9 w-44 animate-pulse rounded-xl bg-white/[0.04]" />
        </div>
        <div className="mt-3 h-4 w-72 animate-pulse rounded bg-white/[0.05]" />
      </div>

      {/* Stage stat blocks */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5 sm:gap-0 sm:overflow-hidden sm:rounded-2xl sm:border sm:border-white/10 sm:bg-white/[0.03]">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2 px-5 py-5 max-sm:rounded-2xl max-sm:border max-sm:border-white/10 max-sm:bg-white/[0.03]">
            <div className="h-3 w-20 animate-pulse rounded bg-white/[0.08]" />
            <div className="h-9 w-12 animate-pulse rounded bg-white/[0.08]" />
            <div className="h-3 w-28 animate-pulse rounded bg-white/[0.05]" />
          </div>
        ))}
      </div>

      {/* Filter bar: Stage · SDR · Enrichment · Persona · Period · Sort */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="h-7 w-24 animate-pulse rounded-full bg-white/[0.06]" />
        <div className="h-7 w-28 animate-pulse rounded-full bg-white/[0.06]" />
        <div className="h-7 w-32 animate-pulse rounded-full bg-white/[0.06]" />
        <div className="h-7 w-28 animate-pulse rounded-full bg-white/[0.06]" />
        <div className="h-7 w-28 animate-pulse rounded-full bg-white/[0.06]" />
        <div className="h-9 w-36 animate-pulse rounded-xl bg-white/[0.04]" />
      </div>

      {/* Lead row skeletons */}
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-white/[0.06] px-5 py-4 last:border-0">
            <div className="h-10 w-10 flex-shrink-0 animate-pulse rounded-full bg-white/[0.06]" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="h-4 w-44 animate-pulse rounded bg-white/[0.08]" />
              <div className="h-3 w-56 animate-pulse rounded bg-white/[0.05]" />
              <div className="h-3 w-36 animate-pulse rounded bg-white/[0.04]" />
            </div>
            <div className="hidden md:block h-6 w-20 animate-pulse rounded-full bg-white/[0.04]" />
            <div className="hidden xl:block h-6 w-24 animate-pulse rounded-full bg-white/[0.04]" />
            <div className="h-8 w-12 animate-pulse rounded bg-white/[0.04]" />
          </div>
        ))}
      </div>
    </div>
  )
}
