"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

type UploadedFile = { name: string; url: string }

export default function UploadPage() {
  const router = useRouter()
  const [pitchDeck, setPitchDeck] = useState<UploadedFile | null>(null)
  const [crmExport, setCrmExport] = useState<UploadedFile | null>(null)
  const [uploading, setUploading] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleFileUpload(
    file: File,
    type: "pitch_deck" | "crm_export",
  ) {
    setUploading(type)
    setError(null)
    try {
      const res = await fetch(`/api/wizard/upload?filename=${encodeURIComponent(file.name)}&type=${type}`, {
        method: "POST",
        body: file,
      })
      if (!res.ok) {
        throw new Error("Upload failed")
      }
      const { url } = await res.json() as { url: string }
      const uploaded = { name: file.name, url }
      if (type === "pitch_deck") setPitchDeck(uploaded)
      else setCrmExport(uploaded)
    } catch {
      setError("Upload failed — please try again")
    } finally {
      setUploading(null)
    }
  }

  async function handleContinue() {
    setSaving(true)
    setError(null)
    try {
      await fetch("/api/wizard/save-uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pitchDeckUrl: pitchDeck?.url,
          crmExportUrl: crmExport?.url,
        }),
      })
      router.push("/wizard/questionnaire")
    } catch {
      setError("Failed to save — please try again")
      setSaving(false)
    }
  }

  return (
    <div className="space-y-9">
      <div className="space-y-3">
        <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">
          Step 1 of 4 · Upload context
        </p>
        <h1 className="text-[30px] font-bold tracking-[-0.02em] text-white">
          Upload your documents
        </h1>
        <p className="max-w-[640px] text-[15px] leading-[23px] text-zinc-300">
          Upload what you have — all files are optional. The more context you give, the better the CRM setup.
        </p>
      </div>

      <div className="space-y-4">
        <FileUploadCard
          title="Pitch deck or one-pager"
          description="PDF — gives us your business model, ICP, and value proposition"
          accept=".pdf"
          uploaded={pitchDeck}
          loading={uploading === "pitch_deck"}
          onFile={(f) => handleFileUpload(f, "pitch_deck")}
          onRemove={() => setPitchDeck(null)}
        />
        <FileUploadCard
          title="Existing CRM export"
          description="CSV or XLSX — we'll map your current data into the new CRM structure"
          accept=".csv,.xlsx,.xls"
          uploaded={crmExport}
          loading={uploading === "crm_export"}
          onFile={(f) => handleFileUpload(f, "crm_export")}
          onRemove={() => setCrmExport(null)}
        />
      </div>

      {error && <p className="text-[13px] text-rose-400">{error}</p>}

      <div className="flex items-center justify-between border-t border-white/10 pt-6">
        <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">Step 1 of 4</p>
        <button
          onClick={handleContinue}
          disabled={saving || uploading !== null}
          className="rounded-lg bg-[#2BA98B] px-5 py-2.5 text-[14px] font-bold text-white transition-colors hover:bg-[#239977] disabled:opacity-50 motion-reduce:transition-none"
        >
          {saving ? "Saving…" : "Continue →"}
        </button>
      </div>
    </div>
  )
}

function FileUploadCard({
  title,
  description,
  accept,
  uploaded,
  loading,
  onFile,
  onRemove,
}: {
  title: string
  description: string
  accept: string
  uploaded: UploadedFile | null
  loading: boolean
  onFile: (f: File) => void
  onRemove: () => void
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[15px] font-semibold text-white">{title}</p>
          <p className="text-[13px] text-zinc-400">{description}</p>
        </div>
        {uploaded && (
          <button onClick={onRemove} className="text-[12px] text-zinc-400 hover:text-white">
            Remove
          </button>
        )}
      </div>

      {uploaded ? (
        <div className="mt-3.5 flex items-center gap-2.5 rounded-xl bg-white/[0.06] px-3.5 py-2.5">
          <span className="text-[16px]" aria-hidden>📄</span>
          <span className="truncate text-[13px] text-white">{uploaded.name}</span>
          <span className="ml-auto text-[11px] font-bold uppercase tracking-[0.06em] text-emerald-400">Uploaded</span>
        </div>
      ) : (
        <label className="mt-3.5 flex cursor-pointer items-center justify-center rounded-xl border border-dashed border-[#2BA98B]/40 bg-[#2BA98B]/[0.06] px-4 py-7 transition-colors hover:border-[#2BA98B]/60 motion-reduce:transition-none">
          {loading ? (
            <span className="text-[13px] text-zinc-300">Uploading…</span>
          ) : (
            <span className="text-[13px] text-zinc-300">
              Drop file here or <span className="font-semibold text-[#2BA98B]">browse</span>
            </span>
          )}
          <input
            type="file"
            accept={accept}
            className="hidden"
            disabled={loading}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) onFile(file)
            }}
          />
        </label>
      )}
    </div>
  )
}
