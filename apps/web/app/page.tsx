import Link from "next/link"

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col bg-[#08302E] text-white">
      <header className="border-b border-white/10 px-8 py-5">
        <div className="mx-auto flex max-w-[1280px] items-center">
          <span className="text-[14px] font-medium text-white">CRM Builder</span>
        </div>
      </header>

      <section className="flex flex-1 flex-col justify-center px-8">
        <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-10 py-16">
          <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">
            Now in private beta
          </p>
          <h1 className="text-[56px] font-bold leading-[1.05] tracking-[-0.02em] text-white sm:text-[72px]">
            Your signal-first CRM,{" "}
            <span className="text-[#2BA98B]">configured for the way you actually sell.</span>
          </h1>
          <p className="max-w-[720px] text-[18px] leading-[28px] text-zinc-300 sm:text-[20px] sm:leading-[32px]">
            Answer a few questions. Upload your pitch deck or CRM export. The signal-first
            methodology is provisioned into a fresh workspace, ready to use in minutes.
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <Link
              href="/wizard"
              className="inline-flex items-center rounded-lg bg-[#2BA98B] px-7 py-4 text-[16px] font-bold text-white transition-colors hover:bg-[#239977] motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60"
            >
              Build my CRM →
            </Link>
            <Link
              href="/wizard"
              className="text-[15px] font-medium text-zinc-200 hover:text-white"
            >
              Watch a 90-second tour →
            </Link>
          </div>
        </div>
      </section>

      <section className="border-t border-white/[0.08] px-8 py-12">
        <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-8 sm:grid-cols-3">
          <ProofStat
            value="9"
            label="Custom objects · 243+ attributes provisioned automatically"
            valueColor="#FFFFFF"
          />
          <ProofStat
            value="6"
            label='Steps from "tell us about your business" to a live workspace'
            valueColor="#FFFFFF"
          />
          <ProofStat
            value="~10 min"
            label="Average build time, including data import and view setup"
            valueColor="#2BA98B"
          />
        </div>
      </section>
    </main>
  )
}

function ProofStat({
  value,
  label,
  valueColor,
}: {
  value: string
  label: string
  valueColor: string
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-[36px] font-bold tracking-[-0.02em]" style={{ color: valueColor }}>
        {value}
      </p>
      <p className="text-[13px] leading-[19px] text-zinc-400">{label}</p>
    </div>
  )
}
