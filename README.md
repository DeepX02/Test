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
  zero-config stub fallback), `http_request` (with one retry on failure),
  `db_write` (owner-only), `notify` (owner-only), `conditional_branch` (LLM
  output drives branching, incl. `else_position` jumps), `approval_gate`
  (pause / resume).
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
  nhost.toml        project config (Hasura, Auth, Functions)
  migrations/       Postgres schema, indexes, monthly_usage SQL function
  metadata/         Hasura metadata: tables, relationships, permissions,
                    actions, cron + event triggers
  seeds/            two orgs, six demo users, Acme demo workflow
  emails/           (required by nhost)
frontend/           Next.js 15 App Router app
docs/               architecture deep-dive + live demo script
scripts/            engine-test.mjs + demo-helper.mjs
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
branch → approval gate → db_write → notify pipeline. Run it with a refund
keyword (e.g. *"I want a refund for order #42"*) to hit the branch → approval
gate path, and with any other message to see the branch end the run early.

## Verifying the engine (27 automated scenarios)

The core engine — all four trigger types, both permission layers, approval
pause/resume, branching, quota, retries, and failure paths — is exercised end
to end against a real execution harness. It compiles the actual
`functions/` TypeScript, swaps in an in-memory GraphQL adapter through the
`gql` export seam, and drives the real handlers with mock requests:

```bash
npm --prefix functions run test:engine
```

Run with Node 18+ (no Docker, no nhost, no API keys required). The harness
(`scripts/engine-test.mjs`) currently runs **27 scenarios** covering:

- **Manual trigger** happy path: `llm_call` (stub) → `conditional_branch`
  (LLM output drives the branch) → `http_request` (real HTTP against a local
  upstream) → `db_write` → `approval_gate` (pause) → `notify`, then resume via
  `approveStep`.
- **Layer 1 (role + org)**: viewer cannot trigger (403), non-member from
  another org cannot trigger by id (403), inactive workflow is refused (400).
- **Layer 2 (approval)**: viewer cannot approve (403), non-member cannot
  approve (403), non-paused / non-gate steps are refused (409), and a gate
  configured with `approvers: ['editor']` blocks the owner and lets an editor
  through.
- **Branching**: `else_position` jump skips the HTTP step; branch end stops the
  run early.
- **Other triggers**: webhook start (valid token / bad token 404 / missing
  token 400), database_event start from a `demo_events` INSERT (webhook-secret
  enforced), scheduled cron start with `last_fired_at` debounce.
- **Quota**: `429` when exhausted, lazy 30-day reset, increment on completion.
- **Retries & failures**: transient HTTP 5xx is retried once
  (`attempt_count=2`); forbidden `db_write` columns and unknown step types
  fail the run permanently; notify event delivery (simulated Slack).
- **Templates**: `{{ input.* }}`, `{{ steps.N.output.* }}` and the
  `{{ last.output.* }}` alias all resolve.

Every scenario asserts the HTTP status code, the run/step statuses, and the
persisted rows. Exit code is non-zero on any failure.

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

## Final Task checklist

| Requirement | Where it's implemented | Verified by |
|---|---|---|
| Two organizations, users & roles | `nhost/seeds` (`Acme` = alice/bob/carol, `Globex` = dave/erin/frank) | S2–S5, S19 |
| Org A owner builds a ≥3-step workflow incl. `llm_call`, `http_request`, `conditional_branch` driven by LLM output | seeded *Support Triage* workflow | S1 |
| Started two ways (manual + webhook/event) | `triggerWorkflowRun` Action + `webhookStartRun` / `dbEventRuns` / `scheduledRuns` | S1, S8–S15 |
| `approval_gate` pause; only owner/editor may approve | `approveStep` handler + `org_members` role re-check | S1, S4–S6, S19 |
| Live step-by-step streaming incl. paused state | `RUN_PROGRESS` subscription over `graphql-ws` | — (frontend build) |
| Org B user cannot see / trigger / approve Org A by id | Layer-1 & Layer-2 checks in handlers + Hasura filters | S3, S5 |

## Notes

- `nhost.toml` pins specific Hasura/Auth versions; if the CLI warns about them,
  update the pins to whatever your nhost CLI expects — the rest of the
  configuration is version-agnostic.
- The webhook endpoint is both a Hasura Action (`webhookStartRun`) and a raw
  `POST /v1/webhookStartRun` function endpoint; the Action is what the UI uses.
- `scripts/demo-helper.mjs` can create users / assign org memberships / list
  the current state for recording the demo.
