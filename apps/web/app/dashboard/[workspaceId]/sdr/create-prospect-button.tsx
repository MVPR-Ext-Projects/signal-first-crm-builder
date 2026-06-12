"use client"

import { useState } from "react"
import { CreateProspectModal } from "./create-prospect-modal"

export function CreateProspectButton({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-[13px] font-medium text-zinc-400 transition-colors hover:border-[#2BA98B]/40 hover:text-[#2BA98B] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#2BA98B]/40"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        Create prospect
      </button>
      {open && (
        <CreateProspectModal workspaceId={workspaceId} onClose={() => setOpen(false)} />
      )}
    </>
  )
}
