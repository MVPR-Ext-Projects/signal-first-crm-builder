# Setup

You're scaffolding a signal-first CRM from this template. The goal: a working dashboard at your own URL, seeded with an example workspace ("Acme Demo", a B2B platform-observability shape) so the system isn't empty, that you can then customize with your own personas + ICP.

## Prerequisites

- Node.js >= 20
- A Vercel account (free tier works for evaluation)
- (Optional) A CRM for the mirror: HubSpot (private app with `crm.objects.contacts.{read,write}` + `crm.objects.companies.{read,write}` scopes) or Attio (workspace access token). `crmProvider: "none"` runs CRM-free. See `docs/CRM-ADAPTERS.md`
- (Optional) A Teamfluence account if you want LinkedIn-signal ingestion
- (Optional) A Dripify account if you want LinkedIn-outbound ingestion
- (Optional) A PR coverage source for the trust-nested loop. The approach is PR-source-agnostic (any agency's coverage works, fed manually); an MVPR account is the automated path - its API feeds earned coverage, journalist outreach threads, and PR-performance data in as a first-class signal source instead of you tracking it by hand. See `docs/PR-LinkedIn-Measurement.md`

## Step 1 — Clone and install

```bash
git clone <this-repo-url> my-crm
cd my-crm
npm install
```

## Step 2 — Provision storage

You need:
- **Upstash Redis** (workspace config, encrypted secrets)
- **Postgres** (the projection — contacts, signals, companies, etc.)

Easiest: create a new Vercel project, link this repo, and add `Upstash Redis` + `Neon Postgres` via the Vercel Marketplace. Both auto-provision env vars.

```bash
vercel link
vercel env pull .env.local
```

This pulls `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `POSTGRES_URL`, etc. into `.env.local`.

## Step 3 — Set required secrets

Edit `.env.local` and set these app-level secrets (do NOT commit):

```
ENCRYPTION_KEY=<32 random bytes, base64-encoded — `openssl rand -base64 32`>
CRON_SECRET=<long random string — `openssl rand -hex 32`>
ANTHROPIC_API_KEY=<your Anthropic key — used for persona classification + draft DM>
RESEND_API_KEY=<optional, for sending emails>
```

See `.env.example` for the full list with explanations.

## Step 4 — Initialise the database

```bash
node scripts/init-db.mjs
```

This creates the Postgres schema from `apps/web/lib/db/schema.sql`. Re-run is safe — uses `CREATE TABLE IF NOT EXISTS`.

## Step 5 — Seed your workspace

```bash
node scripts/seed-workspaces.mjs
```

This reads `seed/example-workspace.json` (the Acme Demo example: 3 personas for a B2B platform-observability company plus matching ICP keywords + exclusion rules), generates a fresh workspace UUID, and writes the config to Upstash Redis under `workspace:<uuid>:config`. The script prints the workspace ID and dashboard URL at the end.

## Step 6 — Customize the seed

The seeded example ("Acme Demo") is shaped as a B2B platform-observability company. To make it yours, edit `seed/example-workspace.json` BEFORE running `seed-workspaces.mjs`, or use the dashboard's Settings page after seeding.

Things you'll likely want to change:
- `name`: replace `"Acme Demo Workspace"` with your company name.
- `messaging.personas`: 3 personas come pre-filled (Engineering Manager, VP Engineering, Platform Engineer). Each has rich JTBD / value props / pain points — rewrite for your buyers.
- `targetCompanyKeywords` / `excludeCompanyKeywords`: 25 target keywords + 10 exclude keywords are dev-tools / cloud-native shaped. Replace with your own.
- `exclusionRules.targetCountries`, `exclusionRules.excludeIndustries`: tune to your ICP.
- `icpGroups`, `prospectTypes`: starting set, generic. Reshape for your motion.
- `internalLinkedinUrls`, `internalEmailDomains`, `internalCompanyNames`: replace with your team's identifiers — these are how the system distinguishes "signal from a prospect" vs "signal from our own team." The placeholders (`your-team-member-1`, `yourcompany.com`) are obviously stand-in values; replace them.

## Step 7 — Connect HubSpot

In the dashboard at `https://<your-deploy>/dashboard/<workspace-id>/settings/integrations`, paste your HubSpot private-app access token. Test the connection.

## Step 8 — (Optional) Connect Teamfluence / Dripify / Calendly

If you want inbound LinkedIn signals: paste your Teamfluence / Dripify webhook secrets in `/settings/webhooks`. The webhook URLs are auto-derived from your deploy URL.

If you want Calendly meeting-booked signals: configure the Calendly webhook with the URL shown in `/settings/integrations` and paste the signing secret.

## Step 9 — Deploy

```bash
vercel deploy --prod
```

Wait for it to report Ready, then verify with content (don't trust the badge):

```bash
node scripts/verify-vercel-deploy.mjs --url https://<your-deploy>.vercel.app --expect "<marker-string-from-page>"
```

## Step 10 — First customizations with Claude Code

Open this repo in Claude Code. Read `CLAUDE.md` (it's the canonical architecture map). Try these as starter prompts:

- "Rewrite the four personas in `seed/example-workspace.json` for our buyers in [your industry]."
- "Add a new signal verb `submitted_form` and wire it through the schema comment, the verb model, the dashboard label map."
- "Add a webhook handler for [our marketing automation tool] that creates a signal when [event] happens."

## Troubleshooting

- **"CRM not configured"** at runtime: workspace config is missing `hubspot.accessToken`. Set it in `/settings/integrations` or via `seed-workspaces.mjs`.
- **Build fails on Vercel "● Ready" but blank pages**: see CLAUDE.md "Verify Vercel deploys by content, not status." Run `scripts/verify-vercel-deploy.mjs`.
- **Encrypted-field roundtrip failing**: `ENCRYPTION_KEY` is missing or was rotated. Run `scripts/inspect-workspace-encrypted-fields.mjs` (read-only) to inventory affected fields before clearing.
