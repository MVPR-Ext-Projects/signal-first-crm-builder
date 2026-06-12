/**
 * Pagination footer shared by SDR / Companies / Signals pages.
 * URL-driven via the parent page's buildHref — this component is purely
 * presentational. Renders nothing when there's only one page worth of
 * results (page = 1 AND no next page).
 */

export function PaginationFooter({
  pageNum,
  hasNextPage,
  prevHref,
  nextHref,
}: {
  pageNum:     number
  hasNextPage: boolean
  prevHref:    string
  nextHref:    string
}) {
  if (pageNum <= 1 && !hasNextPage) return null
  const prevDisabled = pageNum <= 1
  const nextDisabled = !hasNextPage
  return (
    <div className="mt-4 flex items-center justify-between text-[13px] text-zinc-400">
      <PaginationLink label="← Previous" href={prevHref} disabled={prevDisabled} />
      <span className="tabular-nums">Page {pageNum}</span>
      <PaginationLink label="Next →" href={nextHref} disabled={nextDisabled} />
    </div>
  )
}

function PaginationLink({ label, href, disabled }: { label: string; href: string; disabled: boolean }) {
  if (disabled) {
    return (
      <span className="rounded-full border border-white/[0.06] px-3 py-1.5 text-zinc-600">{label}</span>
    )
  }
  return (
    <a
      href={href}
      className="rounded-full border border-white/[0.10] bg-white/[0.04] px-3 py-1.5 text-zinc-200 transition hover:border-white/[0.20] hover:bg-white/[0.08]"
    >
      {label}
    </a>
  )
}
