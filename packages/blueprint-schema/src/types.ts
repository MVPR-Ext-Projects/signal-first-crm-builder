import { z } from "zod"

// ─── Attribute types ──────────────────────────────────────────────────────────

export const AttributeTypeSchema = z.enum([
  "text",
  "number",
  "currency",
  "checkbox",
  "date",
  "timestamp",
  "select",
  "multi-select",
  "status",
  "record-reference",
  "email-address",
  "phone-number",
  "domain",
  "url",
  "rating",
])
export type AttributeType = z.infer<typeof AttributeTypeSchema>

export const AttributeDefSchema = z.object({
  apiSlug: z.string(),
  title: z.string(),
  type: AttributeTypeSchema,
  isRequired: z.boolean().default(false),
  isMultiselect: z.boolean().default(false),
  selectOptions: z.array(z.string()).optional(),
  recordReferenceTarget: z.string().optional(), // api slug of target object
  reason: z.string(), // AI must explain why this attribute is included
})
export type AttributeDef = z.infer<typeof AttributeDefSchema>

// ─── Object definition ────────────────────────────────────────────────────────

export const CustomObjectDefSchema = z.object({
  apiSlug: z.string(),
  singularNoun: z.string(),
  pluralNoun: z.string(),
  description: z.string(),
  attributes: z.array(AttributeDefSchema),
  include: z.boolean(),
  reason: z.string(),
})
export type CustomObjectDef = z.infer<typeof CustomObjectDefSchema>

// ─── List definition ──────────────────────────────────────────────────────────

export const ListDefSchema = z.object({
  apiSlug: z.string(),
  name: z.string(),
  parentObject: z.string(), // api slug of parent object (people, companies, or custom)
  description: z.string(),
  attributes: z.array(AttributeDefSchema),
  include: z.boolean(),
  reason: z.string(),
})
export type ListDef = z.infer<typeof ListDefSchema>

// ─── Seed instructions (from CSV import) ─────────────────────────────────────

export const SeedInstructionSchema = z.object({
  targetObject: z.string(), // api slug of object to seed (people, companies, etc.)
  targetList: z.string().optional(), // api slug of list to add records to
  columnMappings: z.record(z.string(), z.string()), // csvHeader → CRM attribute slug
  estimatedRowCount: z.number(),
  notes: z.string(),
})
export type SeedInstruction = z.infer<typeof SeedInstructionSchema>

// ─── Top-level blueprint ──────────────────────────────────────────────────────

export const BusinessModelSchema = z.enum(["b2b", "b2c", "b2b2c", "marketplace"])
export type BusinessModel = z.infer<typeof BusinessModelSchema>

export const SalesMotionSchema = z.enum(["inbound", "outbound", "plg", "hybrid", "partner-led"])
export type SalesMotion = z.infer<typeof SalesMotionSchema>

export const WorkspaceBlueprintSchema = z.object({
  metadata: z.object({
    companyName: z.string(),
    businessModel: BusinessModelSchema,
    salesMotion: SalesMotionSchema,
    icpSummary: z.string(),
    primaryIndustry: z.string(),
    dealType: z.enum(["transactional", "enterprise", "self-serve", "mixed"]),
    hasMediaPRComponent: z.boolean(),
    hasFundraisingComponent: z.boolean(),
    hasPartnerMotion: z.boolean(),
  }),
  customObjects: z.array(CustomObjectDefSchema),
  companyAttributes: z.array(AttributeDefSchema),
  peopleAttributes: z.array(AttributeDefSchema),
  lists: z.array(ListDefSchema),
  seedInstructions: z.array(SeedInstructionSchema),
  rationale: z.string(),
})
export type WorkspaceBlueprint = z.infer<typeof WorkspaceBlueprintSchema>

// ─── Questionnaire input ──────────────────────────────────────────────────────

export const QuestionnaireSchema = z.object({
  // Core
  icpDescription: z.string(),
  salesMotion: SalesMotionSchema,
  businessModel: BusinessModelSchema,
  personaTypes: z.array(z.string()),   // e.g. ["VP Marketing", "Head of Comms"]
  buyerPersonas: z.array(z.string()),  // decision makers / buying committee
  toolsUsed: z.array(z.string()),      // any tools they already use

  // CRM & data
  existingCrm: z.string().optional(),  // "HubSpot", "Salesforce", "Pipedrive", "None", etc.
  entityScale: z.string().optional(),  // rough number of contacts / companies in their universe

  // LinkedIn & signal collection
  targetingB2BProfessionals: z.boolean().optional(), // true = LinkedIn signals are primary source
  linkedinBrandBuilding: z.boolean().optional(),     // building personal/company brand on LinkedIn
  signalTools: z.array(z.string()).optional(),        // e.g. ["Sales Navigator", "Teamfluence", "Dripify"]

  // Enrichment
  enrichmentTools: z.array(z.string()).optional(),   // e.g. ["Surfe", "Clay", "Apollo", "Clearbit"]

  // Channels
  marketingChannels: z.array(z.string()).optional(), // ["LinkedIn Personal", "LinkedIn Company", "Email", "PR", "Events", "Paid Ads", "Newsletter", "Podcast", "Partnership"]

  // Integrations
  hasFirefliesTranscripts: z.boolean().optional(),   // → include call_transcript object

  additionalContext: z.string().optional(),
})
export type Questionnaire = z.infer<typeof QuestionnaireSchema>
