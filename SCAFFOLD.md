# Scaffold walkthrough

You're scaffolding a signal-first CRM from a template handed over as a zip file. This doc takes you from "I just unzipped this" to "I have a working dashboard at my own URL." Should take 45-60 minutes the first time.

Companion docs (read in this order *after* you've got the dashboard live):
1. `README.md` — orientation
2. `PHILOSOPHY.md` — design tenets ("the why")
3. `CLAUDE.md` — operating manual (auto-loads in Claude Code sessions)
4. `GLOSSARY.md`, `ARCHITECTURE.md`, `docs/adr/`, `docs/WEBHOOKS.md`, `docs/CAMPAIGNS.md`, `docs/CONTACTS.md` — drill-down

If you hit something that isn't in this walkthrough, `SETUP.md` has more detail + troubleshooting.

---

## Prerequisites

- Node.js >= 20 ([install](https://nodejs.org/))
- A GitHub account (for version-controlling your customisations)
- A Vercel account (free Hobby tier works for evaluation)
- A CRM, if you want the mirror (optional — `crmProvider: "none"` runs CRM-free). One of:
  - **HubSpot** — a private app with `crm.objects.contacts.{read,write}` + `crm.objects.companies.{read,write}` scopes, or
  - **Attio** — a workspace access token, plus a custom `signals` object provisioned (see `docs/CRM-ADAPTERS.md`)
- An Anthropic API key (for the AI features — persona classification, draft DMs)
- (Optional) [Teamfluence](https://myteamfluence.com?via=tl), Dripify, Unipile, Calendly accounts for the inbound integrations
- (Optional) A PR coverage source for the trust-nested loop. The signal-first approach is PR-source-agnostic - any agency's coverage works (fed manually). An **MVPR account** is the automated path: its REST API feeds earned coverage, the journalist outreach threads behind it, and PR-performance data (response/coverage rates) in as a first-class signal source, so you don't track it by hand. See `docs/PR-LinkedIn-Measurement.md`

---

## Step 1 — Unzip and open in Claude Code

```bash
unzip signal-first-crm-<sha>.zip -d signal-first-crm
cd signal-first-crm
claude  # opens Claude Code in this directory; CLAUDE.md auto-loads
```

If you don't have Claude Code installed yet: https://claude.com/claude-code

You can use any editor (VS Code, Cursor, vim) but Claude Code is the intended workflow — `CLAUDE.md` auto-loads as cognitive context every session, and the slash commands in `.claude/commands/` plus the sub-agents in `.claude/agents/` are tuned for daily work in this codebase.

## Step 2 — Install dependencies

```bash
npm install
```

Takes 1-2 minutes. The monorepo has three workspaces (`apps/web`, `apps/attribution`, `packages/*`). They install together.

## Step 3 — Version-control your copy

The template is a one-shot drop. You'll customise it, and you want your customisations under version control. Create a private GitHub repo owned by your org:

```bash
git init
git add -A
git commit -m "Initial scaffold from signal-first-crm template"
gh repo create <your-org>/signal-first-crm --private --source=. --push
```

(If you don't have the `gh` CLI, create the repo manually on github.com, then add the remote: `git remote add origin <url>` and `git push -u origin main`.)

## Step 4 — Create a Vercel project

- Go to https://vercel.com/new
- Click "Import Git Repository," pick the repo you just created
- Vercel auto-detects Next.js — accept the build defaults
- Don't deploy yet; we need to provision storage first

## Step 5 — Provision storage via the Vercel Marketplace

In your new Vercel project: **Storage** tab → **Create Database**.

Add both:
- **Upstash Redis** (Hobby tier is enough to start) — stores workspace config + encrypted secrets
- **Neon Postgres** (Hobby tier) — stores contacts, signals, companies, outreach log

Both auto-provision the right env vars on your Vercel project. You'll see things like `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING` appear in your project's environment variables.

## Step 6 — Pull env vars locally

```bash
vercel link                # link this directory to the Vercel project
vercel env pull .env.local # pull the auto-provisioned vars into .env.local
```

`.env.local` is git-ignored by default — don't commit it.

## Step 7 — Set the app-level secrets

Edit `.env.local` and add these four values:

```
ENCRYPTION_KEY=<run: openssl rand -base64 32>
CRON_SECRET=<run: openssl rand -hex 32>
ANTHROPIC_API_KEY=<your Anthropic key>
RESEND_API_KEY=<optional - leave empty if you're not sending outbound email>
```

- `ENCRYPTION_KEY` is used to encrypt tenant secrets (CRM tokens, webhook signing secrets) at rest in Redis. Once set, do NOT rotate it without running the recovery script — rotating will lock workspaces out of their encrypted fields.
- `CRON_SECRET` gates the cron endpoints — Vercel passes this in the Authorization header when firing scheduled jobs.
- `ANTHROPIC_API_KEY` powers the persona classifier, the draft-DM generator, and the writing-style fingerprint analyser.
- `RESEND_API_KEY` is only needed if you'll send outbound email through Resend.

## Step 8 — Initialise the Postgres schema

```bash
node scripts/init-db.mjs
```

Creates all tables from `apps/web/lib/db/schema.sql`. Re-runnable safely — uses `CREATE TABLE IF NOT EXISTS` everywhere.

## Step 9 — (Optional) Customize the seed before importing

Open `seed/example-workspace.json`. The seed carries an example workspace ("Acme Demo") shaped as a B2B platform-observability company. It's there to show what a populated workspace looks like, not as a starting point you'd ship with.

For a fresh workspace you'll likely want to edit:
- `"name"` — replace `"Acme Demo Workspace"` with your company name
- `messaging.personas` — three pre-filled personas (Engineering Manager, VP Engineering, Platform Engineer) demonstrate the schema's depth (JTBD, value props, pain points, objections). Rewrite for your buyers
- `targetCompanyKeywords` / `excludeCompanyKeywords` — 25 target + 10 exclude keywords are dev-tools / cloud-native shaped
- `exclusionRules` (targetCountries, excludeIndustries, minEmployees) — tune to your ICP
- `icpGroups`, `prospectTypes` — generic starter set
- `internalLinkedinUrls`, `internalEmailDomains`, `internalCompanyNames` — replace with YOUR team's identifiers. The placeholders (`your-team-member-1`, `yourcompany.com`) are obviously stand-ins. These fields are how the system distinguishes "signal from a prospect" vs "signal from our own team"

Or skip and edit later via the dashboard's settings pages after you're live.

## Step 10 — Seed the workspace

```bash
node scripts/seed-workspaces.mjs
```

Reads `seed/example-workspace.json`, generates a fresh workspace UUID, encrypts any `enc:`-prefixed fields, and writes to Upstash Redis.

**The script prints your workspace ID and dashboard URL at the end — write them down.** You'll need them in step 14.

## Step 11 — Push app-level secrets to Vercel

The auto-provisioned Marketplace vars are already on Vercel. You need to push the four secrets you set in `.env.local` (they're local-only by default):

```bash
vercel env add ENCRYPTION_KEY production
vercel env add CRON_SECRET production
vercel env add ANTHROPIC_API_KEY production
vercel env add RESEND_API_KEY production  # skip if blank
```

When prompted, paste the value from `.env.local`.

(Repeat for `preview` and `development` environments if you want previews to work.)

## Step 12 — Deploy

```bash
vercel deploy --prod
```

Wait for "● Ready." This usually takes 1-3 minutes for a first deploy.

## Step 13 — Verify the deploy by content (not just status)

The Vercel "● Ready" badge can lie — it means "the build process completed," not "the right thing is running." Always content-verify:

```bash
node scripts/verify-vercel-deploy.mjs --url https://<your-deploy>.vercel.app --expect "Signal-First"
```

You should see a confirmation that the marker string was found in the production HTML.

## Step 14 — Visit your dashboard

Open `https://<your-deploy>.vercel.app/dashboard/<workspace-id>` (the workspace ID from step 10).

You'll be prompted for an access token — that's also printed by the seed script. Paste it.

You should now see the SDR action list, mostly empty (because no signals have been ingested yet).

## Step 15 — Connect your CRM (optional)

Postgres is the system of record; the CRM is an optional mirror. Skip this entirely with `crmProvider: "none"`. Otherwise pick one — `docs/CRM-ADAPTERS.md` has the full comparison and config.

In the dashboard, Settings → Integrations:
- **HubSpot** — set `crmProvider: "hubspot"`, paste your private-app access token, test the connection.
- **Attio** — set `crmProvider: "attio"`, paste your Attio access token, and make sure the custom `signals` object exists in your Attio workspace (see `docs/CRM-ADAPTERS.md`).

Either way, contacts don't bulk-sync on connect — they mirror as signals arrive via the webhooks.

## Step 16 — (Optional) Connect the inbound integrations

Each one wires the same way: configure their webhook to point at `https://<your-deploy>.vercel.app/api/webhooks/<your-workspace-id>/<provider>`, then paste the signing secret in `/settings/webhooks` on the dashboard.

- **Teamfluence** — LinkedIn engagement signals (likes, comments, follows, profile views). Note: Teamfluence does not issue a webhook signing secret — the workspace UUID in the URL is the auth credential.
- **Dripify** — LinkedIn outbound automation events.
- **Unipile** — LinkedIn DM replies + send/delivery status.
- **Calendly** — meeting bookings. Register the webhook via Calendly's API and store the signing key.
- **Resend** — email lifecycle events (delivered, opened, clicked, bounced, complained). Note: the Resend webhook lands in the `apps/attribution/` sub-app, not `apps/web/` — it's the click-tracking app.

`docs/WEBHOOKS.md` has the per-provider cookbook with auth model, idempotency strategy, and CRM-push decision.

## Step 17 — Connect a PR coverage source (MVPR = the automated path)

The trust-nested loop runs on earned coverage from any PR source - with a traditional agency you'd feed coverage in by hand and track rates in a spreadsheet. MVPR automates that via its API. If your workspace has an MVPR account: Settings → PR → paste your MVPR API key + per-tenant baseUrl (the URL embeds your MVPR company id). The cron syncs every 6h; hit "Sync now" to backfill.

What the API gives you that a manual agency relationship doesn't (automatically):
- **Coverage** — earned articles/podcasts/awards with tier + publication domain authority, in `mvpr_coverage`.
- **Journalist threads** — the outreach behind the coverage, in `mvpr_threads`: who you pitched, who replied, which messages converted.
- **PR-performance tracking** — response rate, coverage rate, and which intents/angles land, on the PR reports surface.
- **PR signals** — coverage + journalist responses flow in as `pr_*` signal verbs, so earned media is a first-class part of the funnel, not a separate report.

Optional: the system works without it (feed coverage manually, or skip the PR loop entirely). MVPR just makes the feeding + tracking automatic. The differentiator is the signal-first approach itself, not the coverage vendor. See `docs/PR-LinkedIn-Measurement.md`.

## Step 18 — Start working

Open Claude Code in the repo. `CLAUDE.md` auto-loads. Try the slash commands:

- `/audit-personas` — analyse the seeded persona library for gaps, overlaps, sparse fields.
- `/review-fingerprint` — sanity-check a writing-style fingerprint against sample output.
- `/add-signal-verb` — guided flow for adding a new verb (touches schema comment, verb model, dashboard label map).
- `/add-webhook` — scaffold a new inbound webhook handler from the cookbook contract.
- `/migrate-schema` — scaffold a new Postgres migration script.

Spawn the sub-agents after touching code in their area:

- `multi-tenancy-reviewer` — after editing any DB or workspace-config code.
- `persona-coverage-auditor` — after editing personas.
- `signal-verb-consistency-checker` — after adding or renaming a verb.
- `fingerprint-scope-checker` — after editing a draft endpoint or fingerprint logic.

---

## What the first hour likely feels like

- Steps 1-8 (unzip → schema init): ~30 minutes. Most of it is waiting on `npm install` and Marketplace provisioning.
- Steps 9-14 (seed → live dashboard): ~20 minutes.
- Steps 15-18 (integrations + first customisations): open-ended.

## Documented open work the template ships with

These are flagged in the ADRs and aren't blockers, but you'll want to wire them up as you customize:

- **ADR-012** — The Calendly handler ingests `booked_meeting` signals but doesn't yet set `manual_stage = 'Discovery Call'` on the contact/company. The pseudocode is in ADR-012; helper goes in `apps/web/lib/db/contact-store.ts`.
- **ADR-013** — The `FUNNEL_ORDER` constant (`apps/web/lib/funnel-order.ts`) + `funnel_rank()` SQL helper haven't been created yet. Required for the don't-regress guard in ADR-012's rollup.
- **`docs/WEBHOOKS.md`** Dripify section flags: the signature comparison currently uses `!==`, should be `crypto.timingSafeEqual`. Small fix when you next touch the file.
- Verify `companies.manual_stage` column exists in your schema (most ADR-012/013 work depends on it). If not, write a migration script with the `/migrate-schema` slash command.

These are intentional — the template ships with documented gaps so your team exercises the knowledge base + agents on real work.

## If something goes wrong

| Symptom | Likely cause + fix |
|---|---|
| "Workspace not found" on dashboard load | Seed script didn't succeed. Check `KV_REST_API_URL` / `KV_REST_API_TOKEN` in `.env.local`, rerun `seed-workspaces.mjs`. |
| "Database not configured" | `POSTGRES_URL` missing locally. Run `vercel env pull .env.local` again. |
| Vercel shows "Ready" but pages 500 | Content-verify with `scripts/verify-vercel-deploy.mjs`. The badge lies. Tail logs: `vercel logs --follow`. |
| Encrypted-field roundtrip failing | `ENCRYPTION_KEY` either missing or got rotated. Run `scripts/inspect-workspace-encrypted-fields.mjs` (read-only) to inventory affected workspaces BEFORE doing anything else. |
| `npm install` fails on lock-file conflict | Delete `node_modules` and `package-lock.json`, then `npm install` fresh. |
| Webhook signature verification fails | Most providers (Calendly, Stripe, HubSpot, Unipile) use HMAC-SHA-256. Confirm the signing secret in `/settings/webhooks` matches what the provider sent you (no trailing whitespace). Teamfluence is the exception — see `docs/WEBHOOKS.md`. |

## Getting help

- The knowledge base (`PHILOSOPHY.md`, `ARCHITECTURE.md`, `GLOSSARY.md`, `docs/adr/`, `docs/WEBHOOKS.md`, `docs/CAMPAIGNS.md`, `docs/CONTACTS.md`, plus `CLAUDE.md` as the running operating manual) is meant to be exhaustive for a Claude Code session. Most "how do I..." questions are answered by asking Claude Code with the relevant files loaded.
- If something architectural feels unclear or contradictory after reading the relevant ADR, that's worth flagging back to the template maintainer — it's signal that the doc needs improving.
