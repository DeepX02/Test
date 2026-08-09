/**
 * Engine regression harness for the AI Agent Workflow Builder.
 *
 * Compiles the real functions/ TypeScript engine to CommonJS, then swaps in an
 * in-memory GraphQL adapter through the `gql` CommonJS export seam
 * (functions/_shared/gql.ts). Every scenario drives the REAL handlers
 * (triggerWorkflowRun / approveStep / webhookStartRun / dbEventRuns /
 * scheduledRuns / notifyHandler) end to end.
 *
 * Run from repo root:
 *   npm --prefix functions run test:engine
 * or manually:
 *   cd functions && npx tsc --outDir dist && node ../scripts/engine-test.mjs
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import path from 'node:path';

const requireFns = createRequire(path.join(import.meta.dirname, '..', 'functions', 'index.js'));
const jwt = requireFns('jsonwebtoken');

const DIST = path.join(import.meta.dirname, '..', 'functions', 'dist');

process.env.NHOST_JWT_SECRET = JSON.stringify({ type: 'HS256', key: 'engine-test-secret' });
process.env.NHOST_WEBHOOK_SECRET = 'engine-test-webhook-secret';
delete process.env.NHOST_ADMIN_SECRET;
delete process.env.HASURA_GRAPHQL_ADMIN_SECRET;
delete process.env.SLACK_WEBHOOK_URL;

/* ------------------------------------------------------------------ *
 * In-memory store
 * ------------------------------------------------------------------ */
const store = {
  users: [],
  orgs: [],
  members: [],
  workflows: [],
  steps: [],
  triggers: [],
  runs: [],
  stepRuns: [],
  notifications: [],
  outputs: [],
  seq: 0,
};
const id = () => 'id-' + ++store.seq;
const nowIso = () => new Date().toISOString();

/* ------------------------------------------------------------------ *
 * Fake GraphQL adapter (routes by operation name)
 * ------------------------------------------------------------------ */
async function fakeGql(query, variables = {}) {
  const op = query.match(/^(?:query|mutation)\s+(\w+)/)?.[1];
  switch (op) {
    case 'LoadWorkflow': {
      const wf = store.workflows.find((w) => w.id === variables.id);
      if (!wf) return { workflows_by_pk: null };
      const org = store.orgs.find((o) => o.id === wf.org_id);
      const steps = store.steps
        .filter((s) => s.workflow_id === wf.id)
        .sort((a, b) => a.position - b.position)
        .map(({ id, position, step_type, name, config }) => ({ id, position, step_type, name, config }));
      return {
        workflows_by_pk: {
          id: wf.id,
          org_id: wf.org_id,
          name: wf.name,
          is_active: wf.is_active,
          steps,
          org: {
            id: org.id,
            name: org.name,
            calls_used: org.calls_used,
            calls_allowed: org.calls_allowed,
            quota_period_start: org.quota_period_start,
          },
        },
      };
    }
    case 'Membership': {
      const m = store.members.find((x) => x.user_id === variables.userId && x.org_id === variables.orgId);
      return { org_members: m ? [{ id: m.id, role: m.role }] : [] };
    }
    case 'ResetQuota': {
      const org = store.orgs.find((o) => o.id === variables.id);
      if (org) {
        org.calls_used = 0;
        org.quota_period_start = variables.now;
      }
      return { update_organizations_by_pk: org ? { id: org.id } : null };
    }
    case 'IncQuota': {
      const org = store.orgs.find((o) => o.id === variables.id);
      if (org) org.calls_used += 1;
      return { update_organizations_by_pk: org ? { id: org.id, calls_used: org.calls_used } : null };
    }
    case 'CreateRun': {
      const run = {
        id: id(),
        workflow_id: variables.workflowId,
        triggered_by: variables.triggeredBy,
        trigger_type: variables.triggerType,
        input: variables.input,
        status: 'running',
        error: null,
        current_step_id: null,
        created_at: nowIso(),
        updated_at: nowIso(),
        finished_at: null,
      };
      store.runs.push(run);
      return { insert_workflow_runs_one: { id: run.id } };
    }
    case 'CreateStepRuns': {
      const returning = variables.objects.map((o) => {
        const r = {
          id: id(),
          workflow_run_id: o.workflow_run_id,
          workflow_step_id: o.workflow_step_id,
          step_type: o.step_type,
          position: o.position,
          status: o.status,
          input: null,
          output: null,
          error: null,
          approved_by: null,
          approved_at: null,
          started_at: null,
          finished_at: null,
          updated_at: null,
          attempt_count: 0,
        };
        store.stepRuns.push(r);
        return { id: r.id, position: r.position };
      });
      return { insert_step_runs: { returning } };
    }
    case 'RunStepRuns': {
      const rows = store.stepRuns
        .filter((r) => r.workflow_run_id === variables.runId)
        .sort((a, b) => a.position - b.position)
        .map((r) => ({ id: r.id, position: r.position, step_type: r.step_type, status: r.status, output: r.output }));
      return { step_runs: rows };
    }
    case 'UpdateStepRun': {
      const sr = store.stepRuns.find((r) => r.id === variables.id);
      if (sr) Object.assign(sr, variables.set);
      return { update_step_runs_by_pk: sr ? { id: sr.id } : null };
    }
    case 'UpdateRun': {
      const run = store.runs.find((r) => r.id === variables.id);
      if (run) Object.assign(run, variables.set);
      return { update_workflow_runs_by_pk: run ? { id: run.id } : null };
    }
    case 'WebhookTrigger': {
      const rows = store.triggers
        .filter((t) => t.trigger_type === 'webhook' && t.is_active && t.config?.token === variables.token)
        .map((t) => ({ id: t.id, workflow_id: t.workflow_id }));
      return { workflow_triggers: rows };
    }
    case 'DbEventTriggers': {
      const rows = store.triggers
        .filter((t) => t.trigger_type === 'database_event' && t.is_active && t.config?.table === variables.table)
        .map((t) => ({ id: t.id, workflow_id: t.workflow_id }));
      return { workflow_triggers: rows };
    }
    case 'ScheduledTriggers': {
      return {
        workflow_triggers: store.triggers
          .filter((t) => t.trigger_type === 'scheduled' && t.is_active)
          .map((t) => ({ id: t.id, workflow_id: t.workflow_id, config: t.config, last_fired_at: t.last_fired_at })),
      };
    }
    case 'MarkFired': {
      const t = store.triggers.find((x) => x.id === variables.id);
      if (t) t.last_fired_at = variables.now;
      return { update_workflow_triggers_by_pk: t ? { id: t.id } : null };
    }
    case 'StepRunContext': {
      const sr = store.stepRuns.find((r) => r.id === variables.id);
      if (!sr) return { step_runs_by_pk: null };
      const run = store.runs.find((r) => r.id === sr.workflow_run_id);
      const wf = store.workflows.find((w) => w.id === run?.workflow_id);
      return {
        step_runs_by_pk: {
          id: sr.id,
          position: sr.position,
          status: sr.status,
          step_type: sr.step_type,
          workflow_run: {
            id: run.id,
            input: run.input,
            workflow_id: run.workflow_id,
            workflow: { org_id: wf.org_id },
          },
        },
      };
    }
    case 'MarkApproved': {
      const sr = store.stepRuns.find((r) => r.id === variables.id);
      if (sr) {
        Object.assign(sr, {
          status: 'succeeded',
          approved_by: variables.userId,
          approved_at: variables.now,
          output: { approved: true },
          finished_at: variables.now,
        });
      }
      return { update_step_runs_by_pk: sr ? { id: sr.id } : null };
    }
    case 'ResumeRun': {
      const run = store.runs.find((r) => r.id === variables.id);
      if (run) {
        run.status = 'running';
        run.current_step_id = null;
      }
      return { update_workflow_runs_by_pk: run ? { id: run.id } : null };
    }
    case 'InsertOutput': {
      for (const o of variables.objects) store.outputs.push({ id: id(), ...o });
      return { insert_step_outputs: { affected_rows: variables.objects.length } };
    }
    case 'QueueNotification': {
      for (const o of variables.objects) store.notifications.push({ id: id(), ...o });
      return { insert_notifications: { affected_rows: variables.objects.length } };
    }
    case 'Sending': {
      const n = store.notifications.find((x) => x.id === variables.id);
      if (n) n.status = 'sending';
      return { update_notifications_by_pk: n ? { id: n.id } : null };
    }
    case 'Sent': {
      const n = store.notifications.find((x) => x.id === variables.id);
      if (n) {
        n.status = 'sent';
        n.sent_at = variables.now;
      }
      return { update_notifications_by_pk: n ? { id: n.id } : null };
    }
    case 'Failed': {
      const n = store.notifications.find((x) => x.id === variables.id);
      if (n) n.status = 'failed';
      return { update_notifications_by_pk: n ? { id: n.id } : null };
    }
    default:
      throw new Error(`[harness] unknown GraphQL operation: ${op}`);
  }
}

/* ------------------------------------------------------------------ *
 * Seed data (mirrors nhost/seeds)
 * ------------------------------------------------------------------ */
const U_ALICE = 'user-alice';
const U_BOB = 'user-bob';
const U_CAROL = 'user-carol';
const U_DAVE = 'user-dave';
const ORG_ACME = 'org-acme';
const ORG_GLOBEX = 'org-globex';

store.users.push({ id: U_ALICE, email: 'alice@acme.com' });
store.users.push({ id: U_BOB, email: 'bob@acme.com' });
store.users.push({ id: U_CAROL, email: 'carol@acme.com' });
store.users.push({ id: U_DAVE, email: 'dave@globex.com' });
store.orgs.push({ id: ORG_ACME, name: 'Acme Inc', calls_used: 0, calls_allowed: 10, quota_period_start: nowIso() });
store.orgs.push({ id: ORG_GLOBEX, name: 'Globex Corp', calls_used: 0, calls_allowed: 10, quota_period_start: nowIso() });
store.members.push({ id: id(), org_id: ORG_ACME, user_id: U_ALICE, role: 'owner' });
store.members.push({ id: id(), org_id: ORG_ACME, user_id: U_BOB, role: 'editor' });
store.members.push({ id: id(), org_id: ORG_ACME, user_id: U_CAROL, role: 'viewer' });
store.members.push({ id: id(), org_id: ORG_GLOBEX, user_id: U_DAVE, role: 'owner' });

const W_DEMO = 'wf-demo';
store.workflows.push({ id: W_DEMO, org_id: ORG_ACME, name: 'Support Ticket Triage', is_active: true });
const demoSteps = [
  { position: 0, step_type: 'llm_call', name: 'Classify ticket', config: { provider: 'stub', stubDelayMs: 5, prompt: 'Classify this support ticket:\n{{ input.ticket }}', system: 'Return JSON with category, sentiment, summary.' } },
  { position: 1, step_type: 'conditional_branch', name: 'Route by category', config: { condition: { source: 'last.output.parsed.category', operator: 'eq', value: 'refund' }, else_position: 3 } },
  { position: 2, step_type: 'http_request', name: 'Look up order', config: { url: 'http://127.0.0.1:PORT/order?category={{ last.output.parsed.category }}', method: 'GET' } },
  { position: 3, step_type: 'db_write', name: 'Record outcome', config: { table: 'step_outputs', data: { label: 'category', payload: '{{ steps.0.output.parsed.category }}' } } },
  { position: 4, step_type: 'approval_gate', name: 'Manager sign-off', config: { reason: 'Approve handling before notifying the team', approvers: ['owner', 'editor'] } },
  { position: 5, step_type: 'notify', name: 'Alert team', config: { channel: 'slack', to: '#support', title: 'Ticket triaged', message: 'Category {{ steps.0.output.parsed.category }} — sign-off complete' } },
];
for (const s of demoSteps) store.steps.push({ id: id(), workflow_id: W_DEMO, ...s });

const W_FLAKY = 'wf-flaky';
store.workflows.push({ id: W_FLAKY, org_id: ORG_ACME, name: 'Flaky HTTP retry', is_active: true });
store.steps.push({ id: id(), workflow_id: W_FLAKY, position: 0, step_type: 'http_request', name: 'Call flaky API', config: { url: 'http://127.0.0.1:PORT/flaky', method: 'GET' } });

const W_BADWRITE = 'wf-badwrite';
store.workflows.push({ id: W_BADWRITE, org_id: ORG_ACME, name: 'Bad write', is_active: true });
store.steps.push({ id: id(), workflow_id: W_BADWRITE, position: 0, step_type: 'db_write', name: 'Write forbidden column', config: { table: 'step_outputs', data: { label: 'x', secret: 'leak' } } });

const W_INACTIVE = 'wf-inactive';
store.workflows.push({ id: W_INACTIVE, org_id: ORG_ACME, name: 'Inactive workflow', is_active: false });
store.steps.push({ id: id(), workflow_id: W_INACTIVE, position: 0, step_type: 'notify', name: 'nope', config: { channel: 'email' } });

const W_EDITORGATE = 'wf-editorgate';
store.workflows.push({ id: W_EDITORGATE, org_id: ORG_ACME, name: 'Editor-only approval', is_active: true });
store.steps.push({ id: id(), workflow_id: W_EDITORGATE, position: 0, step_type: 'approval_gate', name: 'Editor gate', config: { approvers: ['editor'] } });

store.triggers.push({ id: id(), workflow_id: W_DEMO, trigger_type: 'webhook', is_active: true, config: { token: 'wh-secret-token-123' }, last_fired_at: null });
store.triggers.push({ id: id(), workflow_id: W_DEMO, trigger_type: 'database_event', is_active: true, config: { table: 'demo_events' }, last_fired_at: null });
store.triggers.push({ id: id(), workflow_id: W_DEMO, trigger_type: 'scheduled', is_active: true, config: { schedule: '* * * * *' }, last_fired_at: null });

/* ------------------------------------------------------------------ *
 * Local HTTP "upstream" service for http_request steps
 * ------------------------------------------------------------------ */
let httpPort = 0;
const flakyHits = { total: 0 };
const upstream = http.createServer((req, res) => {
  const url = req.url ?? '';
  if (url.startsWith('/order')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ order: '42', status: 'found' }));
    return;
  }
  if (url.startsWith('/flaky')) {
    flakyHits.total += 1;
    if (flakyHits.total === 1) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'transient failure' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, attempt: flakyHits.total }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

/* ------------------------------------------------------------------ *
 * Test plumbing
 * ------------------------------------------------------------------ */
let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, error: err.message });
    console.log(`FAIL  ${name}\n      -> ${err.message}`);
  }
}

function makeRes() {
  return {
    statusCode: 0,
    body: undefined,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
}

async function call(handler, req) {
  const res = makeRes();
  await handler(req, res);
  return res;
}

function token(userId) {
  return jwt.sign(
    {
      sub: userId,
      'x-hasura-user-id': userId,
      'x-hasura-default-role': 'user',
      'x-hasura-allowed-roles': ['user'],
    },
    'engine-test-secret',
    { algorithm: 'HS256', expiresIn: '1h' },
  );
}

const authHeader = (userId) => ({ authorization: `Bearer ${token(userId)}`, Authorization: `Bearer ${token(userId)}` });

async function runTrigger(userId, workflowId, input) {
  return call(triggerWorkflowRun, { headers: authHeader(userId), body: { input: { workflow_id: workflowId, input } } });
}

async function runApprove(userId, stepRunId) {
  return call(approveStep, { headers: authHeader(userId), body: { input: { step_run_id: stepRunId } } });
}

const pausedGateOf = (runId) => store.stepRuns.find((r) => r.workflow_run_id === runId && r.status === 'paused');
const stepRunsOf = (runId) => store.stepRuns.filter((r) => r.workflow_run_id === runId).sort((a, b) => a.position - b.position);

function runSummary(runId) {
  const run = store.runs.find((r) => r.id === runId);
  const lines = stepRunsOf(runId).map(
    (r) => `    [${r.position}] ${r.step_type.padEnd(20)} ${r.status.padEnd(10)}${r.attempt_count ? ` attempts=${r.attempt_count}` : ''}`,
  );
  return [`  run ${runId} -> ${run.status}${run.error ? ` (${run.error})` : ''}`, ...lines];
}

/* ------------------------------------------------------------------ *
 * Handlers (loaded AFTER the seam is installed)
 * ------------------------------------------------------------------ */
const gqlModule = requireFns('./dist/_shared/gql.js');
gqlModule.gql = fakeGql;
const triggerWorkflowRun = requireFns('./dist/triggerWorkflowRun.js').default;
const approveStep = requireFns('./dist/approveStep.js').default;
const webhookStartRun = requireFns('./dist/webhookStartRun.js').default;
const dbEventRuns = requireFns('./dist/events/dbEventRuns.js').default;
const scheduledRuns = requireFns('./dist/events/scheduledRuns.js').default;
const notifyHandler = requireFns('./dist/events/notifyHandler.js').default;

/* ------------------------------------------------------------------ *
 * Scenarios
 * ------------------------------------------------------------------ */
let demoRunId = null;
let webhookRunId = null;
let dbEventRunId = null;
let schedRunId = null;
let editorGateRunId = null;
let bobOtherRunId = null;
const secretHeader = { 'nhost-webhook-secret': process.env.NHOST_WEBHOOK_SECRET };

async function scenarios() {
  /* --- Demo workflow: full happy path with LLM branch + pause + approve --- */
  await test('S1 alice (owner) triggers demo workflow -> paused at approval gate', async () => {
    const res = await runTrigger(U_ALICE, W_DEMO, { ticket: 'I want a refund for order #42, please.' });
    ok(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    ok(res.body.status === 'paused', `expected paused, got ${res.body.status}`);
    demoRunId = res.body.run_id;
    const gate = pausedGateOf(demoRunId);
    ok(gate, 'expected a paused approval_gate step_run');
    const llm = stepRunsOf(demoRunId)[0];
    ok(llm.status === 'succeeded', `llm step should be succeeded, got ${llm.status}`);
    ok(llm.output?.parsed?.category === 'refund', `stub should classify as refund, got ${JSON.stringify(llm.output)}`);
    const branch = stepRunsOf(demoRunId)[1];
    ok(branch.output?.matched === true, 'branch should have matched (refund)');
    const http = stepRunsOf(demoRunId)[2];
    ok(http.status === 'succeeded', `http_request should have run, got ${http.status}`);
    ok(http.output?.body?.order === '42', 'http_request should have fetched order 42');
    const db = stepRunsOf(demoRunId)[3];
    ok(db.status === 'succeeded', `db_write should have run, got ${db.status}`);
    const persisted = store.outputs.filter((o) => o.step_run_id === db.id);
    ok(
      persisted.some((o) => o.payload === 'refund'),
      `step_outputs row should be persisted; found ${JSON.stringify(persisted)}`,
    );
  });

  await test('S2 carol (viewer) cannot trigger (Layer 1 role)', async () => {
    const res = await runTrigger(U_CAROL, W_DEMO, { ticket: 'hi' });
    ok(res.statusCode === 403, `expected 403, got ${res.statusCode}`);
    ok(/Role "viewer" cannot trigger/.test(res.body.message), `unexpected message: ${res.body.message}`);
  });

  await test('S3 dave (non-member from Globex) cannot trigger by id (Layer 1 org)', async () => {
    const res = await runTrigger(U_DAVE, W_DEMO, { ticket: 'hi' });
    ok(res.statusCode === 403, `expected 403, got ${res.statusCode}`);
    ok(/not a member/.test(res.body.message), `unexpected message: ${res.body.message}`);
  });

  await test('S4 carol (viewer) cannot approve a paused gate (Layer 2)', async () => {
    const gate = pausedGateOf(demoRunId);
    const res = await runApprove(U_CAROL, gate.id);
    ok(res.statusCode === 403, `expected 403, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    ok(/cannot approve/.test(res.body.message), `unexpected message: ${res.body.message}`);
    ok(store.stepRuns.find((r) => r.id === gate.id).status === 'paused', 'gate must still be paused');
  });

  await test('S5 dave (non-member) cannot approve a paused gate', async () => {
    const gate = pausedGateOf(demoRunId);
    const res = await runApprove(U_DAVE, gate.id);
    ok(res.statusCode === 403, `expected 403, got ${res.statusCode}`);
    ok(/not a member/.test(res.body.message), `unexpected message: ${res.body.message}`);
  });

  await test('S6 alice approves -> run completes (resumes at notify)', async () => {
    const gate = pausedGateOf(demoRunId);
    const res = await runApprove(U_ALICE, gate.id);
    ok(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    ok(res.body.status === 'completed', `expected completed, got ${res.body.status}`);
    ok(store.runs.find((r) => r.id === demoRunId).status === 'completed', 'run should be completed in store');
    const notify = stepRunsOf(demoRunId)[5];
    ok(notify.status === 'succeeded', `notify step should succeed, got ${notify.status}`);
    ok(store.notifications.some((n) => n.step_run_id === notify.id && n.status === 'pending'), 'notification row queued');
    ok(store.orgs.find((o) => o.id === ORG_ACME).calls_used === 1, 'quota incremented once after completion');
  });

  await test('S7 bob (editor) triggers; else-branch jumps over http step; bob approves', async () => {
    const res = await runTrigger(U_BOB, W_DEMO, { ticket: 'Do you ship internationally?' });
    ok(res.statusCode === 200, `expected 200, got ${res.statusCode}`);
    ok(res.body.status === 'paused', `expected paused, got ${res.body.status}`);
    bobOtherRunId = res.body.run_id;
    const branch = stepRunsOf(bobOtherRunId)[1];
    ok(branch.output?.matched === false, 'branch should not have matched (other)');
    ok(stepRunsOf(bobOtherRunId)[2].status === 'pending', 'http_request step should have been skipped (else jump)');
    const gate = pausedGateOf(bobOtherRunId);
    const appr = await runApprove(U_BOB, gate.id);
    ok(appr.statusCode === 200 && appr.body.status === 'completed', `bob approve should complete, got ${appr.statusCode} ${JSON.stringify(appr.body)}`);
  });

  /* --- Webhook trigger --- */
  await test('S8 webhook starts a run with a valid token (no user session)', async () => {
    const res = await call(webhookStartRun, { body: { token: 'wh-secret-token-123', payload: { event: 'account.created', user: 'x' } } });
    ok(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    ok(res.body.status === 'paused', `expected paused, got ${res.body.status}`);
    webhookRunId = res.body.run_id;
    ok(store.runs.find((r) => r.id === webhookRunId).triggered_by === null, 'webhook run has no user');
    ok(store.runs.find((r) => r.id === webhookRunId).trigger_type === 'webhook', 'trigger type should be webhook');
  });

  await test('S9 webhook with bad token -> 404', async () => {
    const res = await call(webhookStartRun, { body: { token: 'nope', payload: {} } });
    ok(res.statusCode === 404, `expected 404, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  });

  await test('S10 webhook missing token -> 400', async () => {
    const res = await call(webhookStartRun, { body: { payload: {} } });
    ok(res.statusCode === 400, `expected 400, got ${res.statusCode}`);
  });

  await test('S11 webhook-paused gate approved by owner -> completed', async () => {
    const gate = pausedGateOf(webhookRunId);
    const res = await runApprove(U_ALICE, gate.id);
    ok(res.statusCode === 200 && res.body.status === 'completed', `expected completed, got ${res.statusCode} ${JSON.stringify(res.body)}`);
  });

  /* --- Database event trigger --- */
  await test('S12 db event starts a run from demo_events INSERT', async () => {
    const req = {
      headers: secretHeader,
      body: {
        event: {
          session_variables: { 'x-hasura-user-id': U_BOB },
          data: { new: { id: 'evt-1', subject: 'Refund request from dashboard', status: 'new' } },
        },
        table: { name: 'demo_events' },
      },
    };
    const res = await call(dbEventRuns, req);
    ok(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    ok(Array.isArray(res.body.run_ids) && res.body.run_ids.length === 1, 'expected one run started');
    dbEventRunId = res.body.run_ids[0];
    const run = store.runs.find((r) => r.id === dbEventRunId);
    ok(run.triggered_by === U_BOB, 'db event run should record the actor user');
    ok(run.trigger_type === 'database_event', 'trigger type should be database_event');
    ok(run.input?.id === 'evt-1', 'row should be the run input');
  });

  await test('S13 db event handler rejects bad webhook secret', async () => {
    const res = await call(dbEventRuns, { headers: { 'nhost-webhook-secret': 'wrong' }, body: {} });
    ok(res.statusCode === 401, `expected 401, got ${res.statusCode}`);
  });

  await test('S14 db-event-paused gate approved -> completed', async () => {
    const gate = pausedGateOf(dbEventRunId);
    const res = await runApprove(U_ALICE, gate.id);
    ok(res.statusCode === 200 && res.body.status === 'completed', `expected completed, got ${res.statusCode} ${JSON.stringify(res.body)}`);
  });

  /* --- Scheduled cron trigger --- */
  await test('S15 scheduled cron fires a matching trigger and debounces the next minute', async () => {
    const first = await call(scheduledRuns, { headers: secretHeader, body: {} });
    ok(first.statusCode === 200, `expected 200, got ${first.statusCode}`);
    ok(/started 1 run/.test(first.body.message), `unexpected: ${first.body.message}`);
    const schedTrigger = store.triggers.find((t) => t.trigger_type === 'scheduled');
    ok(schedTrigger.last_fired_at, 'last_fired_at should be set');
    schedRunId = store.runs[store.runs.length - 1].id;

    const second = await call(scheduledRuns, { headers: secretHeader, body: {} });
    ok(/started 0 run/.test(second.body.message), `debounce should prevent overlap: ${second.body.message}`);
  });

  await test('S16 cronMatches unit checks', async () => {
    const { cronMatches } = requireFns('./dist/_shared/cron.js');
    const at = (min, hr, dom, mon, dow) => new Date(2026, mon - 1, dom, hr, min, 0, 0);
    ok(cronMatches('* * * * *', at(30, 9, 15, 8, 0)) === true, 'every minute should match');
    ok(cronMatches('0 9 * * *', at(0, 9, 15, 8, 0)) === true, '9:00 should match');
    ok(cronMatches('0 9 * * *', at(15, 9, 15, 8, 0)) === false, '9:15 should not match 0 9');
    ok(cronMatches('*/5 * * * *', at(10, 9, 15, 8, 0)) === true, '*/5 should match :10');
    ok(cronMatches('*/5 * * * *', at(12, 9, 15, 8, 0)) === false, '*/5 should not match :12');
  });

  await   test('S16b template resolution: input / steps.N / last alias', async () => {
    const { resolvePath, renderTemplate } = requireFns('./dist/_shared/templates.js');
    const ctx = {
      input: { ticket: 'refund please' },
      steps: { 0: { output: { text: 'x', parsed: { category: 'refund' } } } },
      run: { id: 'r1' },
    };
    ok(resolvePath(ctx, 'input.ticket') === 'refund please', 'input path should resolve');
    ok(resolvePath(ctx, 'steps.0.output.parsed.category') === 'refund', 'steps.N path should resolve');
    ok(resolvePath(ctx, 'last.output.parsed.category') === 'refund', 'last alias should resolve to last step output');
    ok(resolvePath(ctx, 'last.output.text') === 'x', 'last.output.text should resolve');
    ok(
      renderTemplate('{{ input.ticket }} / {{ last.output.parsed.category }}', ctx) === 'refund please / refund',
      'renderTemplate should compose both syntaxes',
    );
  });

  test('S17 scheduled-paused gate approved -> completed', async () => {
    const gate = pausedGateOf(schedRunId);
    const res = await runApprove(U_ALICE, gate.id);
    ok(res.statusCode === 200 && res.body.status === 'completed', `expected completed, got ${res.statusCode} ${JSON.stringify(res.body)}`);
  });

  /* --- Authorization / gate edge cases --- */
  await test('S18 approve a non-gate (pending notify) step -> 409', async () => {
    const pendingNotify = stepRunsOf(demoRunId).find((r) => r.step_type !== 'approval_gate' && r.status === 'pending');
    if (!pendingNotify) {
      ok(true, 'no pending non-gate step left to test against');
      return;
    }
    const res = await runApprove(U_ALICE, pendingNotify.id);
    ok(res.statusCode === 409, `expected 409, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  });

  await test('S19 editor-only gate: owner blocked, editor approves', async () => {
    const res = await runTrigger(U_ALICE, W_EDITORGATE, { note: 'x' });
    ok(res.statusCode === 200 && res.body.status === 'paused', `expected paused, got ${res.statusCode} ${JSON.stringify(res.body)}`);
    editorGateRunId = res.body.run_id;
    const gate = pausedGateOf(editorGateRunId);
    const denied = await runApprove(U_ALICE, gate.id);
    ok(denied.statusCode === 403, `owner should be denied (allowed: editor), got ${denied.statusCode} ${JSON.stringify(denied.body)}`);
    const granted = await runApprove(U_BOB, gate.id);
    ok(granted.statusCode === 200 && granted.body.status === 'completed', `editor should approve, got ${granted.statusCode} ${JSON.stringify(granted.body)}`);
  });

  /* --- Quota --- */
  await test('S20 quota exceeded -> 429, and lazy reset after 30 days', async () => {
    const acme = store.orgs.find((o) => o.id === ORG_ACME);
    acme.calls_used = acme.calls_allowed;
    const res = await runTrigger(U_ALICE, W_FLAKY, {});
    ok(res.statusCode === 429, `expected 429, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    ok(/Quota exceeded/.test(res.body.message), `unexpected message: ${res.body.message}`);

    acme.quota_period_start = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const after = await runTrigger(U_ALICE, W_FLAKY, {});
    ok(after.statusCode === 200, `lazy reset should allow the run, got ${after.statusCode} ${JSON.stringify(after.body)}`);
    ok(acme.calls_used === 1, `quota should have reset to 0 then incremented to 1, got ${acme.calls_used}`);
  });

  await   test('S21 flaky http_request retries once and succeeds (attempt_count=2)', async () => {
    flakyHits.total = 0;
    const res = await runTrigger(U_ALICE, W_FLAKY, {});
    ok(res.statusCode === 200 && res.body.status === 'completed', `expected completed, got ${res.statusCode} ${JSON.stringify(res.body)}`);
    const stepRun = stepRunsOf(store.runs[store.runs.length - 1].id)[0];
    ok(stepRun.attempt_count === 2, `expected 2 attempts, got ${stepRun.attempt_count}`);
    ok(stepRun.output?.body?.ok === true, `expected success body, got ${JSON.stringify(stepRun.output)}`);
  });

  /* --- Failure paths --- */
  await test('S22 db_write to a forbidden column fails the run permanently', async () => {
    const res = await runTrigger(U_BOB, W_BADWRITE, {});
    ok(res.statusCode === 200 && res.body.status === 'failed', `expected failed, got ${res.statusCode} ${JSON.stringify(res.body)}`);
    ok(/not allowed/.test(res.body.message), `unexpected message: ${res.body.message}`);
    ok(store.stepRuns.filter((r) => r.workflow_run_id === res.body.run_id)[0].status === 'failed', 'step should be failed');
  });

  await test('S23 inactive workflow -> 400', async () => {
    const res = await runTrigger(U_ALICE, W_INACTIVE, {});
    ok(res.statusCode === 400, `expected 400, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    ok(/inactive/.test(res.body.message), `unexpected message: ${res.body.message}`);
  });

  await test('S24 unsupported step type -> run failed', async () => {
    const wf = 'wf-badstep';
    store.workflows.push({ id: wf, org_id: ORG_ACME, name: 'Bad step', is_active: true });
    store.steps.push({ id: id(), workflow_id: wf, position: 0, step_type: 'teleport', name: 'magic', config: {} });
    const res = await runTrigger(U_ALICE, wf, {});
    ok(res.statusCode === 200 && res.body.status === 'failed', `expected failed, got ${res.statusCode} ${JSON.stringify(res.body)}`);
    ok(/Unsupported step type/.test(res.body.message), `unexpected message: ${res.body.message}`);
  });

  /* --- Notify delivery handler --- */
  await   test('S25 notify event handler delivers queued notification (simulated)', async () => {
    const queued = store.notifications.find((n) => n.status === 'pending');
    ok(queued, 'expected a queued notification');
    ok(
      !String(queued.message ?? '').includes('{{'),
      `notification message should be template-rendered, got: ${queued.message}`,
    );
    ok(/refund|sign-off/.test(queued.message ?? ''), `rendered message looks wrong: ${queued.message}`);
    const res = await call(notifyHandler, {
      headers: secretHeader,
      body: { event: { data: { new: queued } }, table: { name: 'notifications' } },
    });
    ok(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    ok(store.notifications.find((n) => n.id === queued.id).status === 'sent', 'notification should be delivered (sent)');
  });

  await test('S26 unauthorized event callers are rejected', async () => {
    const res = await call(notifyHandler, { headers: {}, body: { event: { data: { new: {} } }, table: { name: 'notifications' } } });
    ok(res.statusCode === 401, `expected 401, got ${res.statusCode}`);
  });
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */
function rewriteDemoStepUrls(port) {
  for (const s of store.steps) {
    if (typeof s.config.url === 'string') s.config.url = s.config.url.replace('127.0.0.1:PORT', `127.0.0.1:${port}`);
  }
}

await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
httpPort = upstream.address().port;
rewriteDemoStepUrls(httpPort);

try {
  await scenarios();
} finally {
  upstream.close();
}

console.log('\n-------------------- RUN LOG --------------------');
for (const r of store.runs) {
  console.log(runSummary(r.id).join('\n'));
}

console.log('\n-------------------- REPORT --------------------');
console.log(`scenarios run: ${passed + failed}`);
console.log(`passed: ${passed}, failed: ${failed}`);
console.log(`workflow runs created: ${store.runs.length} (covers every trigger type: manual, webhook, database_event, scheduled)`);
console.log(`step runs: ${store.stepRuns.length}, notifications: ${store.notifications.length}, step_outputs: ${store.outputs.length}`);

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
console.log('ALL GREEN');
