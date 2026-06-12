/**
 * ReportsTabs - small pill nav at the top of each report page so
 * /reports (Funnel velocity) and /reports/pr (PR coverage) discover
 * each other. Server-rendered; active state passed in by the parent.
 */

type Tab = "funnel" | "pr"

const TABS: Array<{ key: Tab; label: string; suffix: string }> = [
  { key: "funnel", label: "Funnel velocity", suffix: ""    },
  { key: "pr",     label: "PR coverage",     suffix: "/pr" },
]

export function ReportsTabs({
  workspaceId,
  active,
}: {
  workspaceId: string
  active:      Tab
}) {
  return (
    <div className="inline-flex rounded-xl border border-white/10 bg-white/[0.02] p-1">
      {TABS.map(t => {
        const isActive = t.key === active
        return (
          <a
            key={t.key}
            href={`/dashboard/${workspaceId}/reports${t.suffix}`}
            aria-current={isActive ? "page" : undefined}
            className={`rounded-lg px-3.5 py-1.5 text-[12px] font-semibold transition-colors motion-reduce:transition-none ${
              isActive
                ? "bg-white/[0.08] text-white"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {t.label}
          </a>
        )
      })}
    </div>
  )
}
