/**
 * Prospect import page.
 *
 * Two entry points:
 *  1. AI chat — paste anything (names, LinkedIn URLs, email signatures, CSV text)
 *  2. CSV/Excel file upload
 *
 * Both routes go through parse → de-dup preview → confirm → import.
 */

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { getWorkspaceConfig } from "@/lib/workspace-config"
import { ImportForm } from "./import-form"

export const dynamic = "force-dynamic"

export default async function ImportPage({
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

  return (
    <div className="flex flex-col gap-8 max-w-[720px]">
      <div>
        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">
          Import
        </p>
        <h1 className="mt-1.5 text-[22px] font-bold text-white">Add prospects</h1>
        <p className="mt-1 text-[14px] text-zinc-400">
          Paste names, LinkedIn URLs, email signatures, or upload a CSV. Contacts are
          de-duplicated before import and start at Prospect stage.
        </p>
      </div>
      <ImportForm workspaceId={workspaceId} />
    </div>
  )
}
