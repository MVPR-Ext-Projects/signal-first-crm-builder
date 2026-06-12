/**
 * SettingsShell — left-rail nav + content layout shared by every settings
 * sub-page (enrichment, messaging, personas, …). Server component; nav state
 * is derived from the active prop.
 */

type SettingsSection =
  | "enrichment"
  | "enrichmentCandidates"
  | "outreach"
  | "companyMessaging"
  | "prospectTypes"
  | "webhooks"
  | "team"
  | "exclusion"
  | "scoring"
  | "campaigns"
  | "pr"
  | "access"
  | "stripe"

const NAV: { value: SettingsSection; label: string; href: (ws: string) => string }[] = [
  { value: "enrichment",           label: "Enrichment providers",   href: ws => `/dashboard/${ws}/settings` },
  { value: "enrichmentCandidates", label: "Enrichment candidates",  href: ws => `/dashboard/${ws}/settings/enrichment-candidates` },
  { value: "outreach",             label: "Outreach Settings",      href: ws => `/dashboard/${ws}/settings/outreach` },
  { value: "companyMessaging",     label: "Company Messaging",      href: ws => `/dashboard/${ws}/settings/company-messaging` },
  { value: "prospectTypes",        label: "Custom Tags",            href: ws => `/dashboard/${ws}/settings/prospect-types` },
  { value: "webhooks",             label: "Webhook destinations",   href: ws => `/dashboard/${ws}/settings/webhooks` },
  { value: "team",                 label: "Team filters",           href: ws => `/dashboard/${ws}/settings/team-filters` },
  { value: "exclusion",            label: "Exclusion filters",      href: ws => `/dashboard/${ws}/settings/exclusion-filters` },
  { value: "scoring",              label: "Engagement scoring",     href: ws => `/dashboard/${ws}/settings/scoring` },
  { value: "campaigns",            label: "Channel Settings",       href: ws => `/dashboard/${ws}/settings/channel-settings` },
  { value: "pr",                   label: "PR coverage",            href: ws => `/dashboard/${ws}/settings/pr` },
  { value: "stripe",               label: "Stripe (revenue)",       href: ws => `/dashboard/${ws}/settings/stripe` },
  { value: "access",               label: "Access & password",      href: ws => `/dashboard/${ws}/settings/access` },
]

export function SettingsShell({
  workspaceId,
  active,
  eyebrow,
  title,
  description,
  children,
}: {
  workspaceId: string
  active: SettingsSection
  eyebrow: string
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-12 lg:flex-row lg:items-start">
      <aside className="flex flex-shrink-0 flex-col gap-1 lg:w-[240px]">
        <p className="mb-4 text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">
          Workspace settings
        </p>
        {NAV.map(item => {
          const isActive = item.value === active
          return (
            <a
              key={item.value}
              href={item.href(workspaceId)}
              className={`rounded-xl px-3.5 py-2.5 text-[14px] transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60 ${
                isActive
                  ? "bg-[#2BA98B]/[0.16] font-semibold text-white"
                  : "font-medium text-zinc-300 hover:bg-white/[0.04]"
              }`}
            >
              {item.label}
            </a>
          )
        })}
      </aside>

      <main className="min-w-0 flex-1 space-y-8">
        <header className="space-y-2">
          <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">
            {eyebrow}
          </p>
          <h1 className="text-[30px] font-bold tracking-[-0.02em] text-white">{title}</h1>
          <p className="max-w-[640px] text-[15px] leading-[23px] text-zinc-300">
            {description}
          </p>
        </header>
        {children}
      </main>
    </div>
  )
}
