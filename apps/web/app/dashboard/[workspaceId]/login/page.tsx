'use client'

/**
 * Dashboard login page — per-workspace password gate.
 *
 * Shown when a workspace has an accessToken configured and the visitor's
 * cookie doesn't match. On success the auth API sets the cookie and we
 * redirect to the Companies dashboard (the default landing).
 */

import { use, useState } from "react"
import { useRouter } from "next/navigation"

export default function LoginPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}) {
  const { workspaceId } = use(params)
  const router = useRouter()

  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      })

      const data = await res.json()

      if (!res.ok || !data.ok) {
        setError(data.error ?? "Invalid password")
        setLoading(false)
        return
      }

      router.push(`/dashboard/${workspaceId}/companies`)
    } catch {
      setError("Something went wrong. Please try again.")
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#08302E] px-4 py-16 text-white">
      <div className="mx-auto flex w-full max-w-[880px] flex-col overflow-hidden rounded-3xl border border-white/10 bg-white/[0.03] md:flex-row">
        {/* Left panel — context */}
        <div className="flex flex-col justify-between gap-6 border-b border-white/10 bg-[#2BA98B]/[0.06] p-10 md:w-1/2 md:border-b-0 md:border-r">
          <div className="space-y-6">
            <p className="text-[13px] font-medium text-white">{workspaceId}</p>
            <div className="space-y-3">
              <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">
                SDR Dashboard
              </p>
              <h1 className="text-[28px] font-bold leading-[1.15] tracking-[-0.02em] text-white">
                Welcome back.
              </h1>
              <p className="text-[14px] leading-[22px] text-zinc-300">
                Enter your shared access password to open today&rsquo;s SDR Action List, queues, and pipelines.
              </p>
            </div>
          </div>
          <p className="text-[11px] leading-[18px] text-zinc-400">
            Per-workspace access · cookie-based · expires after 30 days of inactivity.
          </p>
        </div>

        {/* Right panel — form */}
        <div className="flex flex-col justify-center gap-6 p-10 md:w-1/2">
          <div className="space-y-1.5">
            <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">
              Sign in
            </p>
            <h2 className="text-[24px] font-bold tracking-[-0.01em] text-white">
              Access password
            </h2>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <label htmlFor="password" className="text-[13px] font-medium text-white">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoFocus
                autoComplete="current-password"
                placeholder="Enter access password"
                className="w-full rounded-lg border border-white/14 bg-white/[0.04] px-4 py-3.5 text-[15px] text-white placeholder-zinc-500 outline-none transition-colors focus:border-[#2BA98B] focus:ring-1 focus:ring-[#2BA98B]/40"
              />
            </div>

            {error && (
              <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-300">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading || !password}
              className="w-full rounded-lg bg-[#2BA98B] px-4 py-3.5 text-[15px] font-bold text-white transition-colors hover:bg-[#239977] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
            >
              {loading ? "Checking…" : "Open SDR dashboard →"}
            </button>
          </form>

          <p className="text-[13px] text-zinc-400">
            Forgotten the password? Ask the workspace admin to reset it from{" "}
            <span className="font-medium text-[#2BA98B]">Settings → Access</span>.
          </p>
        </div>
      </div>
    </div>
  )
}
