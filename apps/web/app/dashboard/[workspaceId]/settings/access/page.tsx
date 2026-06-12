/**
 * Access & password settings page.
 *
 * Hosts the password setter for the workspace's dashboard gate. Handles both:
 *  - First-time setup (workspace has no accessToken yet) - shown after the
 *    auth gate has been open. Anyone with the URL can set the password and
 *    claim the workspace.
 *  - Rotation (workspace has an accessToken) - requires current password.
 *
 * Hash anchor /settings#access keeps working too (settings-shell still
 * lists "Access & password" in the left nav; it now points here directly).
 */

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { SettingsShell } from "../settings-shell"
import { ChangePasswordButton } from "../../sdr/change-password"

export const dynamic = "force-dynamic"

export default async function AccessSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}) {
  const { workspaceId } = await params
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

  const isFirstTimeSetup = !config.accessToken

  return (
    <SettingsShell
      workspaceId={workspaceId}
      active="access"
      eyebrow={`${config.name ?? workspaceId} · Access`}
      title="Access & password"
      description={
        isFirstTimeSetup
          ? "This workspace doesn't have a password set yet. Until one is set, anyone with the dashboard URL can load it. Set one now."
          : "Manage the password used to sign in to this workspace's dashboard."
      }
    >
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
        <h2 className="mb-1 text-[16px] font-bold text-white">
          Dashboard password
        </h2>
        <p className="mb-4 text-[13px] leading-[20px] text-zinc-400">
          {isFirstTimeSetup
            ? "The first person to set a password claims the workspace - the auth gate locks behind them."
            : "Click below to rotate the password. You'll need to enter the current one to confirm."}
        </p>
        <ChangePasswordButton workspaceId={workspaceId} isFirstTimeSetup={isFirstTimeSetup} />
      </section>
    </SettingsShell>
  )
}
