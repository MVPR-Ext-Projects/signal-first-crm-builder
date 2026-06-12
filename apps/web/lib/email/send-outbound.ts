/**
 * Outbound prospect email sender. Wraps Resend for the "send a fingerprint-
 * voiced email to a lead from the SDR / Companies pages" flow.
 *
 * Sends a plain prospect email: from, to, subject, plain-text body.
 *
 * Resolves the sender from WorkspaceConfig.messaging if a role-tagged sender
 * is configured; otherwise falls back to the workspace's 'default' sender
 * or RESEND_FROM_EMAIL.
 *
 * Returns a discriminated result so the caller can stamp outreach_log on
 * success and skip the signal write on failure.
 */

import { Resend } from "resend"
import type { WorkspaceConfig } from "@/lib/workspace-config"

export interface SendOutboundArgs {
  /** Resolved workspace config. The caller already fetched it. */
  config:   WorkspaceConfig
  /** Recipient email address. */
  to:       string
  subject:  string
  /** Plain-text body. We HTML-escape minimally and wrap in <p> per blank line. */
  body:     string
  /** Optional reply-to address. Defaults to the from address. */
  replyTo?: string
}

export type SendOutboundResult =
  | { ok: true;  messageId: string | null }
  | { ok: false; error: string }

const FALLBACK_FROM_ENV = "RESEND_FROM_EMAIL"

function pickSender(
  config: WorkspaceConfig,
): { email: string; name?: string } | null {
  const senders = config.resend?.senders ?? []
  // No 'outbound' role today - fall back to default, then first sender, then env.
  const def = senders.find(s => s.role === "default") ?? senders[0]
  if (def) return { email: def.email, name: def.name }
  const envFrom = process.env[FALLBACK_FROM_ENV]
  if (envFrom) return { email: envFrom }
  return null
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** Plain-text -> minimal HTML: escape, then wrap each blank-line paragraph in <p>. */
function bodyToHtml(body: string): string {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p style="margin:0 0 14px;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:22px;color:#111827;">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
  return paragraphs.join("\n")
}

export async function sendOutboundEmail(args: SendOutboundArgs): Promise<SendOutboundResult> {
  const apiKey = args.config.resend?.apiKey ?? process.env.RESEND_API_KEY
  if (!apiKey) {
    return { ok: false, error: "Resend is not configured for this workspace" }
  }
  const sender = pickSender(args.config)
  if (!sender) {
    return { ok: false, error: "No sender configured. Add one in Workspace settings or set RESEND_FROM_EMAIL." }
  }
  const fromStr = sender.name ? `${sender.name} <${sender.email}>` : sender.email

  try {
    const { data, error } = await new Resend(apiKey).emails.send({
      from:    fromStr,
      to:      [args.to],
      subject: args.subject,
      html:    bodyToHtml(args.body),
      text:    args.body,
      replyTo: args.replyTo,
    })
    if (error) return { ok: false, error: error.message }
    return { ok: true, messageId: data?.id ?? null }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
