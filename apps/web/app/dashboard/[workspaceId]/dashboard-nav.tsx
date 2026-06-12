"use client"

/**
 * Top-level dashboard nav — three tabs: Companies | People | Signals.
 *
 * Companies is the default landing — accounts buy, people engage. The
 * Companies page unfurls the people whose signals are driving each
 * account's score. People keeps the /sdr URL for back-compat with
 * bookmarks. Signals is a raw chronological list — useful for confirming
 * ingestion is wired up.
 *
 * Active state is derived from the URL pathname via usePathname().
 */

import { usePathname } from "next/navigation"

interface NavItem {
  label: string
  suffix: "/sdr" | "/companies" | "/signals" | "/actions" | "/reports"
}

const ITEMS: NavItem[] = [
  { label: "Companies", suffix: "/companies" },
  { label: "People",    suffix: "/sdr"       },
  { label: "Signals",   suffix: "/signals"   },
  { label: "Channels",  suffix: "/actions"   },
  { label: "Reports",   suffix: "/reports"   },
]

export function DashboardNav({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname()
  const base = `/dashboard/${workspaceId}`

  return (
    <nav
      aria-label="Dashboard sections"
      className="flex items-center gap-6"
    >
      {ITEMS.map((item, i) => {
        const href = `${base}${item.suffix}`
        const active = pathname === href || pathname?.startsWith(`${href}/`)
        return (
          <div key={item.suffix} className="flex items-center gap-6">
            {item.suffix === "/actions" && (
              <span className="h-4 w-px bg-white/[0.12]" aria-hidden />
            )}
            <a
              href={href}
              aria-current={active ? "page" : undefined}
              className={`relative text-[13px] transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60 ${
                active
                  ? "font-semibold text-white"
                  : "font-medium text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {item.label}
              {active && (
                <span
                  aria-hidden
                  className="absolute inset-x-0 -bottom-1 h-[2px] rounded-full bg-[#2BA98B]"
                />
              )}
            </a>
          </div>
        )
      })}
    </nav>
  )
}
