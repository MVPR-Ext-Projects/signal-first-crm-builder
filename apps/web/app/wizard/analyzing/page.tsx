"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"

const PROGRESS_STEPS = [
  "Reading your pitch deck",
  "Analysing your ICP and sales motion",
  "Mapping to the signal-first methodology",
  "Selecting the right objects and pipelines",
  "Customising attributes for your industry",
  "Generating your workspace blueprint",
] as const

export default function AnalyzingPage() {
  const router = useRouter()
  const [activeStep, setActiveStep] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Cycle through steps every 3s. The actual analysis runs in parallel —
    // the progress UI is illustrative, not driven by the backend yet.
    const interval = setInterval(() => {
      setActiveStep((i) => Math.min(i + 1, PROGRESS_STEPS.length - 1))
    }, 3000)

    async function runAnalysis() {
      try {
        const res = await fetch("/api/wizard/run-analysis", { method: "POST" })
        if (!res.ok) {
          const body = await res.json() as { error?: string }
          throw new Error(body.error ?? "Analysis failed")
        }
        clearInterval(interval)
        router.push("/wizard/blueprint")
      } catch (err) {
        clearInterval(interval)
        setError(err instanceof Error ? err.message : "Something went wrong")
      }
    }

    void runAnalysis()
    return () => clearInterval(interval)
  }, [router])

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-500/16 text-[22px]" aria-hidden>⚠</div>
        <h2 className="text-[22px] font-bold text-white">Analysis failed</h2>
        <p className="max-w-[480px] text-[14px] text-zinc-300">{error}</p>
        <button
          onClick={() => router.back()}
          className="mt-2 rounded-lg border border-white/18 px-4 py-2 text-[13px] font-medium text-zinc-200 hover:border-white/30 hover:text-white"
        >
          ← Go back
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-3xl border border-white/10 bg-white/[0.03] px-12 py-14">
      <div className="mb-8 inline-flex items-center gap-2 rounded-full bg-[#2BA98B]/[0.16] px-3 py-1.5">
        <span className="h-2 w-2 rounded-full bg-[#2BA98B] motion-reduce:animate-none animate-pulse" />
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">
          Live · streaming from model
        </span>
      </div>

      <h1 className="text-[30px] font-bold leading-[1.1] tracking-[-0.02em] text-white">
        Building your CRM blueprint
      </h1>
      <p className="mt-4 max-w-[560px] text-[16px] leading-[26px] text-zinc-300">
        We&rsquo;re reading your context, mapping it to the signal-first methodology, and choosing
        the right objects, lists, and attributes for your sales motion.
      </p>

      <ul className="mt-8 space-y-1.5">
        {PROGRESS_STEPS.map((label, i) => (
          <Step key={label} label={label} state={i < activeStep ? "done" : i === activeStep ? "active" : "pending"} />
        ))}
      </ul>

      <p className="mt-8 text-[13px] leading-[20px] text-zinc-400">
        Don&rsquo;t refresh — this usually takes 20–40 seconds. We&rsquo;ll move you to the blueprint review automatically.
      </p>
    </div>
  )
}

function Step({ label, state }: { label: string; state: "done" | "active" | "pending" }) {
  if (state === "active") {
    return (
      <li className="-mx-3 flex items-center gap-3.5 rounded-xl bg-[#2BA98B]/[0.10] px-3 py-3.5">
        <div className="flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-full border-2 border-[#2BA98B]">
          <div className="h-2.5 w-2.5 rounded-full bg-[#2BA98B] motion-reduce:animate-none animate-pulse" />
        </div>
        <span className="flex-1 text-[15px] font-semibold text-white">{label}</span>
        <span className="text-[12px] font-medium text-[#2BA98B]">in progress…</span>
      </li>
    )
  }
  if (state === "done") {
    return (
      <li className="flex items-center gap-3.5 py-3 border-t border-white/[0.06] first:border-t-0">
        <div className="flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-full bg-[#2BA98B] text-[13px] font-bold text-[#08302E]">
          ✓
        </div>
        <span className="flex-1 text-[15px] font-medium text-zinc-200">{label}</span>
      </li>
    )
  }
  return (
    <li className="flex items-center gap-3.5 py-3 border-t border-white/[0.06] first:border-t-0">
      <div className="h-[26px] w-[26px] flex-shrink-0 rounded-full border border-white/18" />
      <span className="flex-1 text-[15px] font-medium text-zinc-400">{label}</span>
    </li>
  )
}
