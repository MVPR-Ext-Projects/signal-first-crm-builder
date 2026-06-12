import { getWorkspaceConfig } from "@/lib/workspace-config"
import { AvatarMenu } from "./avatar-menu"
import { CostPills } from "./cost-pills"
import { DashboardNav } from "./dashboard-nav"
import { ToastProvider } from "./toast"
import { WorkspaceSwitcher } from "./workspace-switcher"

export default async function DashboardLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ workspaceId: string }>
}) {
  const { workspaceId } = await params
  const config = await getWorkspaceConfig(workspaceId).catch(() => null)
  const workspaceName = config?.name ?? null
  const hasAccessToken = !!config?.accessToken

  return (
    <div className="min-h-screen bg-[#08302E] text-white">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:border focus:border-white/20 focus:bg-[#0B3D2E] focus:px-3 focus:py-1.5 focus:text-sm focus:text-white focus:outline-none focus:ring-2 focus:ring-[#2BA98B]"
      >
        Skip to main content
      </a>
      <header className="border-b border-white/10 px-8 py-3.5">
        <div className="mx-auto flex max-w-[1280px] items-center gap-6">
          <WorkspaceSwitcher
            workspaceId={workspaceId}
            workspaceName={workspaceName ?? "Signal First Dashboard"}
          />
          <span className="hidden sm:block h-4 w-px bg-white/10" aria-hidden />
          <DashboardNav workspaceId={workspaceId} />
          <span className="ml-auto flex items-center gap-3">
            <CostPills workspaceId={workspaceId} />
            <span className="hidden sm:block h-4 w-px bg-white/10" aria-hidden />
            <AvatarMenu
              workspaceId={workspaceId}
              workspaceName={workspaceName}
              hasAccessToken={hasAccessToken}
            />
          </span>
        </div>
      </header>
      <main id="main-content" className="mx-auto max-w-[1280px] px-8 py-8">
        <ToastProvider>{children}</ToastProvider>
      </main>
    </div>
  )
}
