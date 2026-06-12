/**
 * AI configuration for the signal-first CRM builder.
 *
 * Uses Vercel AI Gateway via model strings — no provider SDK needed.
 * OIDC token is auto-provisioned via `vercel env pull`.
 *
 * TODO(template): the original gtm-os codebase shipped an opinionated
 * methodology template (custom objects, company attributes, people
 * attributes, list templates, inclusion rules) plus a full system prompt.
 * Both were stripped when this template was forked. The wizard analyze +
 * chat endpoints still import the constants below; rebuild the methodology
 * template with content appropriate to the target CRM (HubSpot in this
 * template) when the wizard is reactivated.
 */

export const ANALYSIS_MODEL = "anthropic/claude-sonnet-4.6"

// Stub system prompt — replace with a real CRM-build methodology before
// re-enabling the wizard.
export const METHODOLOGY_SYSTEM_PROMPT = `You are a CRM architect helping a company design a workspace. Produce a minimal WorkspaceBlueprint JSON object. This template has not yet been customised for the target CRM — return an empty blueprint shape until the methodology template is rebuilt.`
