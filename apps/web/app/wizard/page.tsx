"use client"

import { useEffect, useRef, useState } from "react"
import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport, type UIMessage } from "ai"
import type { WorkspaceBlueprint } from "@signal-first/blueprint-schema"

const INITIAL_MESSAGES: UIMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "Hi — I'll set up your CRM workspace using the signal-first methodology. Tell me about your business — what do you do, and who do you sell to?",
      },
    ],
  },
]

export default function WizardPage() {
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState("")

  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
    messages: INITIAL_MESSAGES,
  })

  const isLoading = status === "streaming" || status === "submitted"

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  function handleSend() {
    const text = draft.trim()
    if (!text || isLoading) return
    setDraft("")
    sendMessage({ text })
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-3">
        <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">
          Step 1 of 4 · Workspace setup
        </p>
        <h1 className="text-[30px] font-bold tracking-[-0.02em] text-white">
          Tell me about your business
        </h1>
      </div>

      <div className="flex flex-col gap-7">
        {messages.map((message) => (
          <Message key={message.id} message={message} />
        ))}

        {isLoading && messages[messages.length - 1]?.role === "user" && (
          <AssistantBubble>
            <Spinner />
          </AssistantBubble>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="sticky bottom-4 flex flex-col gap-2.5">
        <div className="flex items-end gap-3 rounded-2xl border border-white/14 bg-white/[0.04] px-4 py-3 backdrop-blur focus-within:border-[#2BA98B]/60">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Tell me about your business…"
            rows={1}
            className="flex-1 resize-none bg-transparent text-[16px] text-white placeholder-zinc-500 outline-none"
            style={{ minHeight: "24px", maxHeight: "120px" }}
            onInput={(e) => {
              const el = e.currentTarget
              el.style.height = "auto"
              el.style.height = `${Math.min(el.scrollHeight, 120)}px`
            }}
          />
          <button
            onClick={handleSend}
            disabled={!draft.trim() || isLoading}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#2BA98B] text-white transition-colors hover:bg-[#239977] disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none"
            aria-label="Send message"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
        <p className="text-center text-[12px] font-medium text-zinc-400">
          Enter to send · Shift+Enter for new line
        </p>
      </div>
    </div>
  )
}

function Message({ message }: { message: UIMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex flex-row-reverse gap-3.5">
        <div className="flex flex-col items-end gap-1.5">
          <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-white/60">You</p>
          <div className="max-w-[86%] rounded-2xl bg-white px-[18px] py-3.5">
            {message.parts.map((part, i) => {
              if (part.type === "text" && part.text) {
                return (
                  <p key={i} className="m-0 whitespace-pre-wrap text-[16px] leading-[26px] text-[#08302E]">
                    {part.text}
                  </p>
                )
              }
              return null
            })}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex gap-3.5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#2BA98B] text-[13px] font-extrabold text-[#08302E]" aria-hidden>
        m
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">Builder</p>
        {message.parts.map((part, i) => {
          if (part.type === "text" && part.text) {
            return (
              <p key={i} className="m-0 whitespace-pre-wrap text-[16px] leading-[26px] text-white">
                {part.text}
              </p>
            )
          }

          if (part.type === "tool-generateBlueprint") {
            if (part.state === "input-available" || part.state === "input-streaming") {
              return (
                <div key={i} className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
                  <div className="flex items-center gap-2 text-[14px] text-zinc-300">
                    <Spinner />
                    Generating your workspace blueprint…
                  </div>
                </div>
              )
            }
            if (part.state === "output-available") {
              const output = part.output as { blueprint: WorkspaceBlueprint } | null
              if (output?.blueprint) {
                return <BlueprintCard key={i} blueprint={output.blueprint} />
              }
            }
          }

          return null
        })}
      </div>
    </div>
  )
}

function AssistantBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-3.5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#2BA98B] text-[13px] font-extrabold text-[#08302E]" aria-hidden>
        m
      </div>
      <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
        {children}
      </div>
    </div>
  )
}

function Spinner() {
  return (
    <div className="flex gap-1">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-[#2BA98B] animate-bounce motion-reduce:animate-none"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  )
}

function BlueprintCard({ blueprint }: { blueprint: WorkspaceBlueprint }) {
  const [open, setOpen] = useState(true)
  const includedObjects = blueprint.customObjects.filter((o) => o.include)
  const includedLists = blueprint.lists.filter((l) => l.include)

  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start justify-between gap-4 p-5 text-left"
      >
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-[11px] font-bold text-[#08302E]">
              ✓
            </span>
            <span className="text-[18px] font-semibold tracking-[-0.01em] text-white">
              {blueprint.metadata.companyName}
            </span>
          </div>
          <p className="ml-[30px] text-[14px] text-zinc-400">
            {blueprint.metadata.businessModel.toUpperCase()} · {blueprint.metadata.salesMotion} ·{" "}
            {includedObjects.length} custom objects, {includedLists.length} lists
          </p>
        </div>
        <span className="text-[12px] text-zinc-400">{open ? "Collapse ▴" : "Expand ▾"}</span>
      </button>

      {open && (
        <div className="space-y-5 border-t border-white/[0.08] px-5 pb-5 pt-4">
          <p className="text-[15px] leading-[24px] text-zinc-300">{blueprint.rationale}</p>

          {includedObjects.length > 0 && (
            <Section title="Custom objects" count={includedObjects.length}>
              {includedObjects.map((obj) => (
                <Row
                  key={obj.apiSlug}
                  label={obj.pluralNoun}
                  sub={obj.apiSlug}
                  note={obj.reason}
                  badge={`${obj.attributes.length} attrs`}
                />
              ))}
            </Section>
          )}

          {includedLists.length > 0 && (
            <Section title="Lists & pipelines" count={includedLists.length}>
              {includedLists.map((list) => (
                <Row
                  key={list.apiSlug}
                  label={list.name}
                  sub={list.apiSlug}
                  note={list.reason}
                  badge={`${list.attributes.length} fields`}
                />
              ))}
            </Section>
          )}

          <div className="flex items-center justify-between gap-3 rounded-xl bg-[#2BA98B]/[0.08] p-4">
            <div className="flex flex-col gap-1">
              <p className="text-[14px] font-semibold text-white">Ready to build this in your CRM?</p>
              <p className="text-[13px] text-zinc-400">We&rsquo;ll create the objects, lists, and attributes in your workspace.</p>
            </div>
            <button className="rounded-lg bg-[#2BA98B] px-4 py-2.5 text-[14px] font-bold text-white transition-colors hover:bg-[#239977] motion-reduce:transition-none">
              Connect your CRM →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between border-b border-white/[0.08] pb-2">
        <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">{title}</p>
        <p className="text-[12px] text-zinc-400">{count} included</p>
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  )
}

function Row({ label, sub, note, badge }: { label: string; sub: string; note: string; badge: string }) {
  return (
    <div className="flex items-start gap-4 border-b border-white/[0.06] py-3.5 last:border-0">
      <div className="flex flex-1 flex-col gap-1">
        <div className="flex items-center gap-2.5">
          <p className="m-0 text-[15px] font-semibold text-white">{label}</p>
          <p className="m-0 font-mono text-[12px] text-zinc-400">{sub}</p>
        </div>
        <p className="m-0 text-[14px] leading-[21px] text-zinc-300">{note}</p>
      </div>
      <span className="shrink-0 rounded-full bg-white/[0.08] px-2.5 py-0.5 text-[11px] font-semibold tracking-[0.04em] text-zinc-200">
        {badge}
      </span>
    </div>
  )
}
