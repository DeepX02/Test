# Architecture — AI Agent Workflow Builder

A mini-n8n for chaining AI agent steps, built on nhost (Postgres + Hasura + Auth +
Functions) with a Next.js frontend. The interesting parts of this project are the
**two permission layers** and the **approval-gate pause/resume flow**, so this
document focuses on those.

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 15 (App Router), `@nhost/react`, `graphql-ws` for live subscriptions |
| BaaS | nhost — managed Postgres, Hasura GraphQL, Auth (JWT), Serverless Functions |
| Backend logic | TypeScript serverless functions (runner engine, Actions, triggers) |
| Realtime | Hasura GraphQL subscriptions over WebSocket (`graphql-ws` subprotocol) |

## Data model

```
organizations 1──n org_members n──1 auth.users
organizations 1──n workflows 1──n workflow_steps
                            1──n workflow_triggers
                            1──n workflow_runs 1──n step_runs
workflow_runs n──1 workflow_steps   (current_step_id → paused approval gate)
step_runs     n──1 workflow_steps   (workflow_step_id)
step_outputs  (db_write target)     notifications (notify queue)
demo_events   (database_event trigger source)
```

- **`organizations`** — tenant boundary. Holds the quota counters
  (`calls_used`, `calls_allowed`, `quota_period_start` for a rolling 30-day period).
  `monthly_usage` is a Hasura **computed field** backed by a SQL function that
  aggregates the current month's runs and average duration.
- **`org_members`** — the single source of truth for `user → org → role`.
  Every permission rule joins back to this table.
- **`workflow_runs` / `step_runs`** — have **no** user insert/update permissions.
  They are created and mutated only by the function handlers (admin secret). Users
  can only read them.

## Permission Layer 1 — org + role scoping in Hasura

Every table that contains tenant data (`workflows`, `workflow_steps`,
`workflow_triggers`, `workflow_runs`, `step_runs`, `step_outputs`,
`notifications`, `demo_events`) is filtered by the same pattern on **select**:

```json
{
  "org": {
    "members": {
      "_and": [
        { "user_id": { "_eq": "X-Hasura-User-Id" } },
        { "role": { "_eq": "X-Hasura-Org-Role" } }
      ]
    }
  }
}
```

Two session variables are sent by the client: `x-hasura-org-id` and
`x-hasura-org-role`. The trick that makes this safe is that the role claim is
**not trusted on its own** — the filter requires a row in `org_members` where
`user_id` equals the caller's JWT subject *and* `role` equals the claimed role.
A user cannot escalate by forging the header, because the DB row still says
`viewer`.

Insert/update/delete permissions are role-gated too:

- **owner** — full CRUD on workflows/steps/triggers + org_members.
- **editor** — CRUD on workflows/steps/triggers, can trigger runs.
- **viewer** — read only; cannot trigger runs.

## Permission Layer 2 — step-level gating (owner-only node types)

Two step types (`db_write`, `notify`) and the `webhook` trigger are marked
**owner-only**. This is enforced in two complementary places:

1. **Hasura insert/update `check` + select filter** on `workflow_steps`:
   the request must come from an owner/editor of the org, AND if the step type
   is owner-only, the role must be `owner`. An editor gets a GraphQL permission
   error if they try to add or edit a `db_write` step.

2. **The runner re-validates in the function handler.** Even with admin-level
   code paths, `runWorkflow()` refuses to execute a `db_write`/`notify` step
   unless the workflow's org has an owner executing, and the `db_write` target
   table is whitelisted to `step_outputs` with `org_id`/run ids injected
   server-side. Defense in depth.

## Approval gates — pause / resume

The `approval_gate` step type makes a run pause mid-flight and wait for a human.

- `triggerWorkflowRun` executes the workflow **synchronously**. When the runner
  hits an `approval_gate`, it:
  1. writes the `step_run` with `status='paused'`,
  2. sets `workflow_runs.status='paused'` and `current_step_id=<gate step_run>`,
  3. returns. The client's subscription instantly shows the pause.
- `approveStep`:
  1. decodes the caller's JWT,
  2. loads the step_run → workflow → org,
  3. **re-checks `org_members`** for an allowed role (default `owner`,`editor`;
     configurable per step), returning HTTP 403 otherwise,
  4. marks the step_run `succeeded` with `approved_by`/`approved_at`,
  5. flips the run back to `running` and resumes `executeSteps()` from the next
     position, reading previous step outputs back from the DB so templates
     like `{{ steps.0.output.parsed.category }}` still resolve.

Because both Actions are synchronous, the UI stays consistent via the existing
subscription — no manual refresh.

## The runner engine

`functions/_shared/runner.ts` walks `workflow_steps` ordered by `position`, and
for each step:

1. renders its `config` against a template context
   `{ input, run, workflow, steps, last }` (double-mustache syntax, values can
   be JSON-path strings like `steps.0.output.parsed.category`),
2. executes the step (LLM call / HTTP / branch / gate / db write / notify),
3. writes the `step_run` row (status, output, error, attempt count),
4. decides the next position (linear, branch target, `else_position`, or stop).

Run lifecycle ends in `completed`, `failed`, or `cancelled`, at which point the
org's `calls_used` quota is incremented (rollover-safe via `quota_period_start`).
Quota is checked *before* a run starts.

**LLM providers:** Groq, OpenAI, OpenRouter, Gemini (via `LLM_API_KEY_*` env
vars). With no key configured, `llm_call` falls back to a **stub** that returns
a deterministic classification after a short simulated delay — so the whole demo
works with zero external dependencies.

## Triggers

| Trigger | How it starts a run |
|---|---|
| manual | `triggerWorkflowRun` Action (Run button) |
| webhook | `webhookStartRun` — Action AND a raw `POST /v1/webhookStartRun` endpoint; matches a secret token owned by a `webhook` trigger |
| scheduled | Hasura cron trigger → `events/scheduledRuns` every minute; matches `config.schedule` (5-field cron) |
| database_event | Hasura event trigger on `demo_events` INSERT → `events/dbEventRuns` |

`notify` steps write a `notifications` row; a Hasura event trigger delivers them
(Slack webhook if `SLACK_WEBHOOK_URL` is set, else simulated).

All event/cron endpoints verify the `nhost-webhook-secret` header so only Hasura
can invoke them.

## Realtime

The builder subscribes to `workflow_runs` (latest) and `step_runs` for a run.
`functions/_shared/admin.ts` performs all server-side writes with the admin
secret; the frontend uses `graphql-ws` with the user's JWT + org session vars,
so permission rules still apply to what the client can see.

## Key security decisions

- Role claims are validated against the DB, never trusted from the header.
- Runs/step runs are admin-only for writes; users act through Actions that
  re-verify membership and role.
- Owner-only step types are enforced both in Hasura permissions and in the
  runner.
- `db_write` targets are whitelisted and org-scoped server-side.
- Webhook tokens are unguessable UUIDs; event/cron handlers verify the webhook
  secret.
