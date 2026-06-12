/**
 * Shared AI classifier - Claude Haiku 4.5 via Vercel AI Gateway.
 *
 * Two shapes today:
 *
 *   classifyCallNote      Used by recordCallNote when an SDR logs a call
 *                         against a contact. Returns a 3-way outcome
 *                         (not_answered / answered / answered_problem_fit)
 *                         plus a "no longer at this company" flag that
 *                         drives company_status mutation + needs_enrichment.
 *
 *   classifyReplyIntent   Used on the first DM reply (Unipile webhook) and
 *                         on inbound email replies. Detects "not interested"
 *                         / "unsubscribe" intent so the Do-Not-Contact
 *                         marker can be set automatically.
 *
 * Both are synchronous - the result determines downstream verb / score
 * and we can't defer it. Haiku 4.5 is fast enough (~1s) for the live
 * write path.
 *
 * The codebase pattern is Vercel AI Gateway via plain model strings - no
 * provider SDK and no per-workspace key wiring. The master plan called
 * out workspace-owned Anthropic keys; in practice the platform routes
 * everything through the Gateway and pays the bill. Token usage is
 * logged so per-workspace cost attribution still flows through usage_log.
 */

import { generateObject } from "ai"
import { z } from "zod"
import { logAiTokens } from "../usage-log"

const MODEL = "anthropic/claude-haiku-4-5-20251001"

// ─── Call-note classification ────────────────────────────────────────────────

export type CallOutcome = "not_answered" | "answered" | "answered_problem_fit"

export interface CallNoteClassification {
  outcome:             CallOutcome
  noLongerAtCompany:   boolean
  confidence:          number
  reason:              string
}

const CallNoteSchema = z.object({
  outcome: z.enum(["not_answered", "answered", "answered_problem_fit"])
    .describe(
      "not_answered: voicemail / no answer / line dead. " +
      "answered: call connected and the number was correct, including the 'no longer at the company' sub-case where the number works but the person has moved on. " +
      "answered_problem_fit: call connected AND the note suggests the person has the problem we solve AND is interested in continuing the conversation."
    ),
  noLongerAtCompany: z.boolean()
    .describe(
      "TRUE only when the note explicitly implies the contact no longer works at the company on record (e.g. 'she's moved to a different firm', 'he left last month'). FALSE otherwise."
    ),
  confidence: z.number().min(0).max(1)
    .describe("0.0 to 1.0 - how confident you are in the outcome classification."),
  reason: z.string()
    .describe("One short sentence explaining the classification, quoting the note where possible."),
})

const CALL_NOTE_SYSTEM = `You classify SDR call notes into a 3-way outcome.

Rules:
- "not_answered" means the call did not connect. Voicemail, no answer, line disconnected, hung up before speaking, busy signal.
- "answered" means the call connected and the number was correct. Includes the sub-case where the person now works elsewhere (the number worked, just the contact has moved). Includes neutral or non-committal conversations.
- "answered_problem_fit" requires BOTH conditions: (a) the call connected AND (b) the note implies the person has the problem we solve OR explicitly expressed interest in continuing the conversation.

Be conservative: when in doubt between "answered" and "answered_problem_fit", choose "answered". Real problem-fit signals are explicit.

The "noLongerAtCompany" flag is only TRUE when the note states the person has left the company on record. Vague language like "didn't seem to know about it" does not count.`

export async function classifyCallNote(args: {
  workspaceId: string
  noteText:    string
  voicemailHint?: boolean
}): Promise<CallNoteClassification> {
  const { workspaceId, noteText, voicemailHint } = args

  const userMessage =
    voicemailHint
      ? `The SDR marked this call as a voicemail/no-answer (strong hint, but classify the note text on its own merits):\n\n${noteText}`
      : noteText

  const result = await generateObject({
    model:       MODEL,
    schema:      CallNoteSchema,
    system:      CALL_NOTE_SYSTEM,
    prompt:      userMessage,
    temperature: 0.1,
  })

  void logAiTokens({
    workspaceId,
    model:        MODEL,
    inputTokens:  result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
    metadata:     { route: "ai/classifier", shape: "call_note" },
  })

  return result.object
}

// ─── Reply-intent classification (for DNC detection) ─────────────────────────

export type ReplyIntent = "not_interested" | "unsubscribe" | "wrong_person" | "neutral_or_positive"

export interface ReplyIntentClassification {
  intent:     ReplyIntent
  snippet:    string
  confidence: number
}

const ReplyIntentSchema = z.object({
  intent: z.enum(["not_interested", "unsubscribe", "wrong_person", "neutral_or_positive"])
    .describe(
      "not_interested: declines the conversation, says no, asks to stop, expresses disinterest. " +
      "unsubscribe: explicitly asks to be removed from a list, marked as spam intent, opt-out language. " +
      "wrong_person: says you've got the wrong contact (not them, not their role). " +
      "neutral_or_positive: any reply that isn't one of the above - questions, scheduling, agreement, or even a curt 'thanks but' that doesn't actually refuse."
    ),
  snippet: z.string()
    .describe("A short quoted phrase from the reply that justifies the classification. Maximum 200 chars. Empty string if neutral_or_positive."),
  confidence: z.number().min(0).max(1)
    .describe("0.0 to 1.0 - how confident you are in the intent classification."),
})

const REPLY_INTENT_SYSTEM = `You classify the intent of a single inbound reply from a sales prospect.

We only act on the negative intents - "not_interested", "unsubscribe", "wrong_person" - to mark the contact as Do-Not-Contact. Anything else is "neutral_or_positive" and gets no DNC action.

Be conservative on negatives. A short / curt reply is not the same as a refusal. Sarcasm is hard to detect - treat ambiguous replies as neutral_or_positive. We would rather miss a soft no than wrongly silence an engaged conversation.

Examples of "not_interested": "not for us", "not a fit right now", "please stop", "I'll pass".
Examples of "unsubscribe": "unsubscribe me", "remove from your list", "stop emailing".
Examples of "wrong_person": "you've got the wrong person", "I'm not in that role anymore", "try [other contact]".
Examples of "neutral_or_positive": "can you send more info?", "let's schedule", "what's the price?", "ok thanks".`

export async function classifyReplyIntent(args: {
  workspaceId: string
  replyText:   string
  channel:     "linkedin_dm" | "email"
}): Promise<ReplyIntentClassification> {
  const { workspaceId, replyText, channel } = args

  const result = await generateObject({
    model:       MODEL,
    schema:      ReplyIntentSchema,
    system:      REPLY_INTENT_SYSTEM,
    prompt:      `Channel: ${channel}\n\nReply:\n${replyText}`,
    temperature: 0.1,
  })

  void logAiTokens({
    workspaceId,
    model:        MODEL,
    inputTokens:  result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
    metadata:     { route: "ai/classifier", shape: "reply_intent", channel },
  })

  return result.object
}
