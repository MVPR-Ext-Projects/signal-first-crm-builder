export default function WizardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#08302E] text-white">
      <header className="border-b border-white/10 px-8 py-4">
        <div className="mx-auto flex max-w-[960px] items-center gap-3">
          <span className="text-[14px] font-medium text-white">CRM Builder</span>
          <span className="ml-3 inline-flex items-center rounded-full bg-[#2BA98B]/[0.16] px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">
            Beta
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-[960px] px-4 py-12 sm:px-8">{children}</main>
    </div>
  )
}
