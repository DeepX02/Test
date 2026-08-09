# AI Agent Workflow Builder

A mini-n8n for chaining AI agent steps, built on **nhost** (managed PostgreSQL +
Hasura GraphQL + Auth + Serverless Functions) with a **Next.js** frontend and
real-time run streaming over GraphQL subscriptions.

Workflows live inside **organizations**. Every action is checked against **two
permission layers**: org + role scoping enforced in Hasura permission rules
(validated against the DB, not trusted from request headers), and step-level
gating (owner-only node types, approval gates, webhook tokens) enforced in the
serverless function handlers. Runs stream live via `graphql-ws` subscriptions.

## Features

- **6 step types**: `llm_call` (Groq / OpenAI / OpenRouter / Gemini, with a
  zero-config stub fallback), `http_request`, `db_write` (owner-only),
  `notify` (owner-only), `conditional_branch`, `approval_gate`.
- **4 trigger types**: manual, webhook (token-authenticated), scheduled
  (cron), database_event.
- **Two permission layers** — see [docs/architecture.md](docs/architecture.md).
- **Live run streaming** — step-by-step `pending → running → succeeded/paused`
  updates via GraphQL subscriptions, no polling.
- **Approval gates** — runs pause mid-flight and resume only after a role-checked
  approval.
- **Multi-tenant orgs** with `owner` / `editor` / `viewer` roles and a role
  switcher.
- **Per-org quota** (`calls_used` / `calls_allowed`) on a rolling 30-day window,
  surfaced in the UI.
- **Computed field** `organizations.monthly_usage` exposing this month's runs,
  average duration, and quota percent via Hasura.

## Repository layout

```
functions/          nhost serverless functions (runner engine, Actions, triggers)
  _shared/          runner.ts, executors, providers, templates, admin graphql, auth
  triggerWorkflowRun.ts     Action: verify role → check quota → run synchronously
  approveStep.ts            Action: role-check → resume paused gate
  webhookStartRun.ts        Action + raw HTTP endpoint (token-gated)
  events/                   cron + db-event + notify delivery handlers
nhost/
  nhost.toml        project config (Hasura, Auth, Functions, Storage)
  migrations/       Postgres schema, indexes, monthly_usage SQL function
  metadata/         Hasura metadata: tables, relationships, permissions,
                    actions, cron + event triggers
  seeds/            two orgs, six demo users, Acme demo workflow
  emails/           (required by nhost)
frontend/           Next.js 15 App Router app
docs/               architecture deep-dive + live demo script
scripts/            demo-helper.mjs (create users / add members / list)
```

## Quick start

### Prerequisites

- Node 20+ (22 recommended)
- Docker (for local `nhost up`) **or** a free [nhost.io](https://nhost.io)
  cloud project
- nhost CLI: `npm i -g nhost` or `npx nhost@latest`

### 1. Start the backend

```bash
nhost up
```

This applies `nhost/migrations`, `nhost/metadata`, and runs `nhost/seeds`.
You'll get:
- Postgres + Hasura Console: <http://localhost:8080>
- Auth (nhost): <http://localhost:1337>
- Functions: <http://localhost:8888>

### 2. Run the frontend

```bash
cd frontend
npm install
cp .env.example .env.local   # defaults to local nhost
npm run dev                  # http://localhost:3000
```

### 3. Sign in with a demo account

| Email | Org | Role |
|---|---|---|
| alice@acme.com | Acme Corp | owner |
| bob@acme.com | Acme Corp | editor |
| carol@acme.com | Acme Corp | viewer |
| dave@globex.com | Globex Inc | owner |
| erin@globex.com | Globex Inc | editor |
| frank@globex.com | Globex Inc | viewer |

All passwords: **`WorkflowDemo123!`**

Open the seeded **Support Triage** workflow as `alice@acme.com` and click
**▶ Run workflow** to watch it stream through the LLM classify → HTTP lookup →
branch → approval gate → db_write pipeline.

## Deploying to the cloud

1. `nhost deploy --prod` from the repo root (pushes migrations, metadata, and
   functions). Note your project **subdomain** and **region**.
2. In the nhost dashboard → **Secrets**, optionally set:
   - `LLM_API_KEY_GROQ` / `LLM_API_KEY_OPENAI` / `LLM_API_KEY_OPENROUTER` /
     `LLM_API_KEY_GEMINI` (without these, `llm_call` uses the stub)
   - `SLACK_WEBHOOK_URL` (real Slack delivery for `notify`)
3. Apply the seeds if the deploy didn't: run `nhost/seeds/default/*.sql` in the
   Hasura Console SQL tab.
4. Deploy the frontend (Vercel etc.) with env vars `NEXT_PUBLIC_NHOST_SUBDOMAIN`
   and `NEXT_PUBLIC_NHOST_REGION`.

## Demoing

See **[docs/demo-script.md](docs/demo-script.md)** — a 4-minute script covering
permission layers 1 & 2, live streaming, approval gates, branching, all trigger
types, cross-org isolation, and quota.

## Notes

- `nhost.toml` pins specific Hasura/Auth/Storage versions; if the CLI warns
  about them, update the pins to whatever your nhost CLI expects — the rest of
  the configuration is version-agnostic.
- The webhook endpoint is both a Hasura Action (`webhookStartRun`) and a raw
  `POST /v1/webhookStartRun` function endpoint; the Action is what the UI uses.
- `scripts/demo-helper.mjs` can create users / assign org memberships / list
  the current state for recording the demo.
