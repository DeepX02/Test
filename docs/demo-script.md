# Final Task — live demo walkthrough

This is the script for the final task video/live demo. It exercises the two
permission layers, live subscriptions, approval gates, quota, and every trigger
type. ~4 minutes.

## Accounts

All six demo accounts use the password **`WorkflowDemo123!`**.

| Email | Org | Role | Sees |
|---|---|---|---|
| alice@acme.com | Acme Corp | **owner** | Acme workflows + full control |
| bob@acme.com | Acme Corp | **editor** | Acme workflows, can run/edit, no owner steps |
| carol@acme.com | Acme Corp | **viewer** | Acme workflows, read-only |
| dave@globex.com | Globex Inc | **owner** | only Globex workflows |
| erin@globex.com | Globex Inc | **editor** | only Globex workflows |
| frank@globex.com | Globex Inc | **viewer** | only Globex workflows |

## 0. Prerequisites (pre-recorded, not shown live)

1. `nhost up` (or deployed project) with migrations + metadata applied.
2. Seeds loaded — creates the two orgs, six users, and Acme's demo workflow
   "Support Triage" (5 steps, 3 triggers).
3. Frontend running at `localhost:3000`.

## 1. Sign in as an owner and show the seeded workflow (30 s)

- Sign in as **alice@acme.com**.
- Land on the dashboard for **Acme Corp**: one workflow "Support Triage",
  quota badge showing `0 / 100`.
- Open **Support Triage**. Point out:

  - **5 steps**: `llm_call` (classify) → `http_request` (look up customer) →
    `conditional_branch` (category == "refund") → `approval_gate` →
    `db_write` (save result). Point at the `badge owner` markers on
    `db_write`.
  - **3 triggers**: manual, webhook (with token), database_event.

## 2. Manual run + approval gate + live streaming (60 s)

- In the Run panel, input is prefilled:
  `{"ticket": "Customer wants a refund for order #1042", "customer_id": 1}`.
- Click **▶ Run workflow**.
- Watch the **live run** card stream: step 1 `running` → `succeeded`, step 2 →
  `succeeded`, step 3 succeeds, step 4 **`paused`** — the run header flips to
  `paused` and a banner says *"Awaiting approval"*.
- Click **Approve & resume**. Steps 5–6 run (db_write then notify), run header
  flips to `completed`. History list appends the run. Quota badge increments
  to `1 / 100`.
- Because the run input contains `"refund"`, the LLM classified category=refund
  and the branch continued. Show the step output JSON (the `parsed.category`
  field) under the details toggle.

## 3. Branch the other way (20 s)

- Edit the input to a non-refund ticket, e.g.
  `{"ticket": "Need help with login", "customer_id": 2}`, run again.
- The branch step **stops the run** after step 3 (category ≠ refund) — no
  approval gate reached. Run status `completed` with 3 steps. This proves
  conditional branching is driven by real LLM output.

## 4. Webhook trigger (30 s)

- In the triggers panel, note the webhook token. Click **Simulate webhook call**.
- A new run appears instantly with trigger type **webhook** (see history). Step
  through to the gate and approve to finish.
- Alternatively call the endpoint from a terminal:
  ```bash
  curl -X POST http://localhost:8888/v1/webhookStartRun \
    -H 'content-type: application/json' \
    -d '{"token":"<token from UI>","payload":{"ticket":"refund please","customer_id":3}}'
  ```

## 5. Database-event trigger (30 s)

- The demo workflow has a `database_event` trigger on `demo_events` INSERT.
- Click **Fire demo event** in the Run panel → a run starts automatically with
  trigger type `database_event`. Approve to complete.

## 6. Permission Layer 2 — owner-only steps (30 s)

- Sign in as **bob@acme.com** (Acme **editor**).
- Open Support Triage. Steps are editable, but the `+ DB write` and `+ Notify`
  buttons are **disabled** ("Restricted to organization owners").
- Open the existing `db_write` step → its Config is disabled with the message
  "This step type is restricted to organization owners."
- Switch to **alice@acme.com** → both are available.

## 7. Permission Layer 1 — cross-org isolation (45 s)

- Sign in as **dave@globex.com** (Globex **owner**) in a private window.
- Dashboard shows **zero Acme workflows** — only Globex's (the seed also gives
  Globex a workflow so the list isn't empty).
- Try to open Acme's workflow by URL — the builder shows *Workflow not found*.
- (Optional, GraphQL console) `triggerWorkflowRun` against Acme's workflow id
  returns HTTP 403: *"You are not a member of this workflow's organization"*.
- Show the **role switcher** in the header: Dave is owner of Globex, and
  switching orgs shows only his own org's data.

## 8. Viewer role (30 s)

- Sign in as **carol@acme.com** (Acme **viewer**).
- Can open the workflow, see steps/triggers/runs and live runs — but the Run
  button is absent ("Your role (viewer) cannot trigger"), all edit controls are
  disabled.

## 9. Quota (20 s)

- As alice (owner), set Acme's `calls_allowed` to `1` (SQL editor:
  `update organizations set calls_allowed = 1 where id = '…00000000a';`).
- Run the workflow once (uses quota). Run again → the Action returns
  `Quota exceeded (1/1)` and no run is created. Reset `calls_allowed` back to 100.

## What to emphasize

- Role claims are validated against the DB — forging `x-hasura-org-role` doesn't
  grant anything (permission rules join `org_members` on the JWT subject).
- Runs/step_runs are admin-written; user actions go through Actions that
  re-check membership + role.
- Owner-only node types enforced in Hasura *and* re-checked in the runner.
- Live streaming is real GraphQL subscriptions (`graphql-ws`), not polling.
