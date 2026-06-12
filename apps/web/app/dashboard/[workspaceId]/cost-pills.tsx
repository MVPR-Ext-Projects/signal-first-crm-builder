/**
 * Header cost pills — one chip per provider with usage this month.
 *
 * Shape pulled from the Paper design (artboard "G — SDR dashboard — Improved"):
 * 24px tall, rounded-md, white/[0.05] bg with a thin border, a 14×14 colour
 * tile with the provider's letter, and a JetBrains Mono count.
 *
 * Hidden when the workspace has no MTD usage at all. Per-provider pills are
 * only rendered for providers with usage > 0 — keeps the bar tidy as new
 * providers come online.
 *
 * Tooltip via title attribute shows the dollar cost and event count for that
 * provider so SDRs can sanity-check the figures without opening the costs page.
 */

import { getUsageBreakdown, startOfThisMonth, type ProviderTotal } from "@/lib/db/usage-store"

interface PillStyle {
  /** Letter rendered in the colour tile. */
  mark:   string
  /** Tile background colour (hex). */
  bg:     string
  /** Letter colour — picked for AA contrast against the tile. */
  fg:     string
  /** Friendly label for the tooltip + accessible name. */
  label:  string
  /** Singular unit name for the tooltip (e.g. "credits", "tokens"). */
  unit:   string
}

const PROVIDER_STYLES: Record<string, PillStyle> = {
  surfe:     { mark: "S",  bg: "#2BA98B", fg: "#08302E", label: "Surfe",     unit: "credits"  },
  apify:     { mark: "A",  bg: "#F59E0B", fg: "#1F2937", label: "Apify",     unit: "runs"     },
  apollo:    { mark: "Ap", bg: "#8B5CF6", fg: "#FFFFFF", label: "Apollo",    unit: "credits"  },
  resend:    { mark: "R",  bg: "#FFFFFF", fg: "#08302E", label: "Resend",    unit: "emails"   },
  anthropic: { mark: "∗",  bg: "#C5764A", fg: "#FFFFFF", label: "Anthropic", unit: "tokens"   },
  openai:    { mark: "O",  bg: "#10B981", fg: "#08302E", label: "OpenAI",    unit: "tokens"   },
  unipile:   { mark: "U",  bg: "#3B82F6", fg: "#FFFFFF", label: "Unipile",   unit: "messages" },
}

// Render order — most informative providers first. Anything not in the list
// (vercel, neon — these are platform allocations, not usage pills) is filtered
// out before render.
const PILL_ORDER = ["surfe", "apify", "anthropic", "unipile", "openai", "apollo", "resend"]

function formatUnits(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`
  // Drop trailing decimals on small whole numbers.
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

export async function CostPills({ workspaceId }: { workspaceId: string }) {
  const { byProvider, totalCents } = await getUsageBreakdown(workspaceId, startOfThisMonth())

  const pillProviders = byProvider.filter((p): p is ProviderTotal =>
    p.units > 0 && PROVIDER_STYLES[p.provider] !== undefined,
  )
  if (pillProviders.length === 0) return null

  const ordered = [...pillProviders].sort((a, b) =>
    PILL_ORDER.indexOf(a.provider) - PILL_ORDER.indexOf(b.provider),
  )

  return (
    <a
      href={`/dashboard/${workspaceId}/costs`}
      className="flex items-center gap-1.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B] motion-reduce:transition-none"
      aria-label={`This month's usage: ${formatDollars(totalCents)} across ${ordered.length} provider${ordered.length === 1 ? "" : "s"}. View breakdown.`}
      title={`This month: ${formatDollars(totalCents)}`}
    >
      {ordered.map(p => {
        const style = PROVIDER_STYLES[p.provider]
        return (
          <span
            key={p.provider}
            className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.05] px-2 py-1 text-[11px]"
            title={`${style.label}: ${formatDollars(p.cents)} this month · ${formatUnits(p.units)} ${style.unit} · ${p.events} event${p.events === 1 ? "" : "s"}`}
          >
            <span
              className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] font-extrabold"
              style={{ backgroundColor: style.bg, color: style.fg, fontSize: "9px", lineHeight: 1 }}
              aria-hidden
            >
              {style.mark}
            </span>
            <span className="font-mono font-semibold tabular-nums text-white">
              {formatDollars(p.cents)}
            </span>
          </span>
        )
      })}
    </a>
  )
}
