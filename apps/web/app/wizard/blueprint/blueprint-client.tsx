"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import type { WorkspaceBlueprint } from "@signal-first/blueprint-schema"

export default function BlueprintClient({
  blueprint,
  sessionId: _sessionId,
}: {
  blueprint: WorkspaceBlueprint
  sessionId: string
}) {
  const router = useRouter()
  const [openSection, setOpenSection] = useState<string | null>("objects")

  const includedObjects = blueprint.customObjects.filter((o) => o.include)
  const includedLists = blueprint.lists.filter((l) => l.include)

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <div className="inline-flex items-center gap-2 rounded-full bg-emerald-500/16 px-3 py-1.5">
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-[10px] font-bold text-[#08302E]">✓</span>
          <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-emerald-400">Blueprint generated</span>
        </div>
        <h1 className="text-[30px] font-bold tracking-[-0.02em] text-white">
          {blueprint.metadata.companyName} is ready to build
        </h1>
        <p className="max-w-[640px] text-[15px] leading-[23px] text-zinc-300">{blueprint.rationale}</p>
      </div>

      {/* Summary pills */}
      <div className="flex flex-wrap gap-2">
        <Pill label={blueprint.metadata.businessModel.toUpperCase()} />
        <Pill label={blueprint.metadata.salesMotion} />
        <Pill label={`${includedObjects.length} custom objects`} />
        <Pill label={`${blueprint.companyAttributes.length + blueprint.peopleAttributes.length} attributes`} />
        <Pill label={`${includedLists.length} lists`} />
        {blueprint.seedInstructions.length > 0 && (
          <Pill label={`${blueprint.seedInstructions.reduce((a, s) => a + s.estimatedRowCount, 0).toLocaleString()} records to import`} color="emerald" />
        )}
      </div>

      {/* Accordion sections */}
      <div className="space-y-3">
        <AccordionSection
          id="objects"
          title="Custom Objects"
          count={includedObjects.length}
          open={openSection === "objects"}
          onToggle={() => setOpenSection(openSection === "objects" ? null : "objects")}
        >
          <div className="space-y-3">
            {includedObjects.map((obj) => (
              <div key={obj.apiSlug} className="rounded-xl bg-white/[0.04] p-4">
                <div className="flex items-start justify-between">
                  <div className="space-y-0.5">
                    <p className="text-[15px] font-semibold text-white">{obj.pluralNoun}</p>
                    <p className="font-mono text-[12px] text-zinc-400">{obj.apiSlug}</p>
                  </div>
                  <span className="text-[12px] text-zinc-400">{obj.attributes.length} attributes</span>
                </div>
                <p className="mt-2 text-[14px] leading-[21px] text-zinc-300">{obj.reason}</p>
              </div>
            ))}
            {blueprint.customObjects.filter((o) => !o.include).map((obj) => (
              <div key={obj.apiSlug} className="rounded-xl bg-white/[0.02] p-4 opacity-50">
                <p className="text-[14px] text-zinc-300 line-through">{obj.pluralNoun}</p>
                <p className="text-[12px] text-zinc-400">{obj.reason}</p>
              </div>
            ))}
          </div>
        </AccordionSection>

        <AccordionSection
          id="company-attrs"
          title="Company Attributes"
          count={blueprint.companyAttributes.length}
          open={openSection === "company-attrs"}
          onToggle={() => setOpenSection(openSection === "company-attrs" ? null : "company-attrs")}
        >
          <AttributeList attributes={blueprint.companyAttributes} />
        </AccordionSection>

        <AccordionSection
          id="people-attrs"
          title="People Attributes"
          count={blueprint.peopleAttributes.length}
          open={openSection === "people-attrs"}
          onToggle={() => setOpenSection(openSection === "people-attrs" ? null : "people-attrs")}
        >
          <AttributeList attributes={blueprint.peopleAttributes} />
        </AccordionSection>

        <AccordionSection
          id="lists"
          title="Lists & Pipelines"
          count={includedLists.length}
          open={openSection === "lists"}
          onToggle={() => setOpenSection(openSection === "lists" ? null : "lists")}
        >
          <div className="space-y-3">
            {includedLists.map((list) => (
              <div key={list.apiSlug} className="rounded-xl bg-white/[0.04] p-4">
                <div className="flex items-start justify-between">
                  <div className="space-y-0.5">
                    <p className="text-[15px] font-semibold text-white">{list.name}</p>
                    <p className="font-mono text-[12px] text-zinc-400">{list.parentObject} → {list.apiSlug}</p>
                  </div>
                  <span className="text-[12px] text-zinc-400">{list.attributes.length} fields</span>
                </div>
                <p className="mt-2 text-[14px] leading-[21px] text-zinc-300">{list.reason}</p>
              </div>
            ))}
          </div>
        </AccordionSection>

        {blueprint.seedInstructions.length > 0 && (
          <AccordionSection
            id="seed"
            title="Data Import"
            count={blueprint.seedInstructions.length}
            open={openSection === "seed"}
            onToggle={() => setOpenSection(openSection === "seed" ? null : "seed")}
          >
            <div className="space-y-3">
              {blueprint.seedInstructions.map((s, i) => (
                <div key={i} className="rounded-xl bg-white/[0.04] p-4">
                  <p className="text-[15px] font-semibold text-white">
                    {s.estimatedRowCount.toLocaleString()} records → {s.targetObject}
                    {s.targetList ? ` / ${s.targetList}` : ""}
                  </p>
                  <p className="mt-1 text-[14px] leading-[21px] text-zinc-300">{s.notes}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {Object.entries(s.columnMappings).map(([from, to]) => (
                      <span key={from} className="rounded bg-white/[0.08] px-2 py-0.5 text-[11px] text-zinc-300">
                        {from} → {to}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </AccordionSection>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-white/10 pt-6">
        <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">Step 4 of 4</p>
        <button
          onClick={() => router.push("/wizard/connect")}
          className="rounded-lg bg-[#2BA98B] px-5 py-2.5 text-[14px] font-bold text-white transition-colors hover:bg-[#239977] motion-reduce:transition-none"
        >
          Connect your CRM and build it →
        </button>
      </div>
    </div>
  )
}

function Pill({ label, color = "zinc" }: { label: string; color?: "zinc" | "emerald" }) {
  const styles = {
    zinc: "bg-white/[0.08] text-zinc-200",
    emerald: "bg-emerald-500/16 text-emerald-300",
  }
  return (
    <span className={`rounded-full px-3 py-1 text-[12px] font-semibold ${styles[color]}`}>{label}</span>
  )
}

function AccordionSection({
  id: _id,
  title,
  count,
  open,
  onToggle,
  children,
}: {
  id: string
  title: string
  count: number
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03]">
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-white/[0.02] motion-reduce:transition-none"
      >
        <span className="text-[15px] font-semibold text-white">{title}</span>
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-white/[0.08] px-2.5 py-0.5 text-[12px] font-semibold text-zinc-200">{count}</span>
          <span className="text-[12px] text-zinc-400">{open ? "Collapse ▴" : "Expand ▾"}</span>
        </div>
      </button>
      {open && <div className="border-t border-white/[0.08] px-5 py-4">{children}</div>}
    </div>
  )
}

function AttributeList({ attributes }: { attributes: WorkspaceBlueprint["companyAttributes"] }) {
  return (
    <div className="divide-y divide-white/[0.06]">
      {attributes.map((attr) => (
        <div key={attr.apiSlug} className="flex items-start justify-between py-3">
          <div className="space-y-0.5">
            <p className="text-[14px] font-semibold text-white">{attr.title}</p>
            <p className="font-mono text-[12px] text-zinc-400">{attr.apiSlug}</p>
          </div>
          <div className="flex items-center gap-2 text-right">
            <span className="rounded bg-white/[0.08] px-2 py-0.5 text-[11px] font-medium text-zinc-300">{attr.type}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
