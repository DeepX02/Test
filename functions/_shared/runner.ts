import { gql } from './gql';
import { callLlm } from './llm';
import { callHttp, execDbWrite, execNotify, evaluateCondition } from './steps';
import { resolvePath, renderTemplate } from './templates';
import { AppError } from './errors';

export interface WorkflowStep {
  id: string;
  position: number;
  step_type: string;
  name: string;
  config: Record<string, unknown>;
}

export interface Organization {
  id: string;
  name: string;
  calls_used: number;
  calls_allowed: number;
  quota_period_start: string;
}

export interface Workflow {
  id: string;
  org_id: string;
  name: string;
  is_active: boolean;
  steps: WorkflowStep[];
  org: Organization;
}

export interface Membership {
  id: string;
  role: 'owner' | 'editor' | 'viewer';
}

export interface RunResult {
  run_id: string;
  status: 'running' | 'paused' | 'completed' | 'failed';
  message: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Layer 1 (org + role): the caller must be an owner or editor in the org. */
export function assertCanTrigger(workflow: Workflow, membership: Membership | null): void {
  if (!membership) {
    throw new AppError(403, 'You are not a member of this workflow\'s organization');
  }
  if (membership.role !== 'owner' && membership.role !== 'editor') {
    throw new AppError(403, `Role "${membership.role}" cannot trigger workflow runs (owner/editor required)`);
  }
}

/** Layer 2 (approval gate): only allowed org roles may approve a paused step. */
export function assertCanApprove(
  workflow: Workflow,
  membership: Membership | null,
  allowedRoles: string[] = ['owner', 'editor'],
): void {
  if (!membership) {
    throw new AppError(403, 'You are not a member of this workflow\'s organization');
  }
  if (!allowedRoles.includes(membership.role)) {
    throw new AppError(
      403,
      `Role "${membership.role}" cannot approve steps (allowed: ${allowedRoles.join(', ')})`,
    );
  }
}

export async function loadWorkflow(workflowId: string): Promise<Workflow> {
  const data = await gql<{
    workflows_by_pk: {
      id: string;
      org_id: string;
      name: string;
      is_active: boolean;
      steps: Array<{ id: string; position: number; step_type: string; name: string; config: unknown }>;
      org: { id: string; name: string; calls_used: number; calls_allowed: number; quota_period_start: string };
    } | null;
  }>(
    `query LoadWorkflow($id: uuid!) {
       workflows_by_pk(id: $id) {
         id
         org_id
         name
         is_active
         steps(order_by: { position: asc }) {
           id
           position
           step_type
           name
           config
         }
         org {
           id
           name
           calls_used
           calls_allowed
           quota_period_start
         }
       }
     }`,
    { id: workflowId },
  );
  if (!data.workflows_by_pk) {
    throw new AppError(404, 'Workflow not found');
  }
  const wf = data.workflows_by_pk;
  if (!wf.is_active) {
    throw new AppError(400, 'Workflow is inactive');
  }
  return {
    ...wf,
    steps: wf.steps.map((s) => ({ ...s, config: (s.config ?? {}) as Record<string, unknown> })),
  };
}

export async function loadMembership(userId: string, orgId: string): Promise<Membership | null> {
  const data = await gql<{ org_members: Array<{ id: string; role: Membership['role'] }> }>(
    `query Membership($userId: uuid!, $orgId: uuid!) {
       org_members(where: { user_id: { _eq: $userId }, org_id: { _eq: $orgId } }) {
         id
         role
       }
     }`,
    { userId, orgId },
  );
  return data.org_members[0] ?? null;
}

const QUOTA_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/** Check + lazily reset the org quota period before starting a run. */
export async function checkQuota(org: Organization): Promise<void> {
  if (org.quota_period_start) {
    const periodStart = new Date(org.quota_period_start).getTime();
    if (Number.isFinite(periodStart) && Date.now() - periodStart > QUOTA_PERIOD_MS) {
      await gql(
        `mutation ResetQuota($id: uuid!, $now: timestamptz!) {
           update_organizations_by_pk(
             pk_columns: { id: $id }
             _set: { calls_used: 0, quota_period_start: $now }
           ) { id }
         }`,
        { id: org.id, now: new Date().toISOString() },
      );
      org.calls_used = 0;
      org.quota_period_start = new Date().toISOString();
    }
  }
  if (org.calls_used >= org.calls_allowed) {
    throw new AppError(429, `Quota exceeded (${org.calls_used}/${org.calls_allowed} calls this period)`);
  }
}

export async function incrementQuota(orgId: string): Promise<void> {
  await gql(
    `mutation IncQuota($id: uuid!) {
       update_organizations_by_pk(pk_columns: { id: $id }, _inc: { calls_used: 1 }) {
         id
         calls_used
       }
     }`,
    { id: orgId },
  );
}

export interface CreateRunInput {
  triggeredBy: string | null;
  triggerType: string;
  runInput: unknown;
}

export interface CreateRunResult {
  runId: string;
  stepRunIds: Record<number, string>;
}

export async function createRun(workflow: Workflow, opts: CreateRunInput): Promise<CreateRunResult> {
  const run = await gql<{ insert_workflow_runs_one: { id: string } | null }>(
    `mutation CreateRun($workflowId: uuid!, $triggeredBy: uuid, $triggerType: String!, $input: jsonb) {
       insert_workflow_runs_one(object: {
         workflow_id: $workflowId
         triggered_by: $triggeredBy
         trigger_type: $triggerType
         input: $input
         status: "running"
       }) { id }
     }`,
    {
      workflowId: workflow.id,
      triggeredBy: opts.triggeredBy,
      triggerType: opts.triggerType,
      input: opts.runInput ?? null,
    },
  );
  const runId = run.insert_workflow_runs_one?.id;
  if (!runId) throw new AppError(500, 'Failed to create workflow run');

  const objects = workflow.steps.map((s) => ({
    workflow_run_id: runId,
    workflow_step_id: s.id,
    step_type: s.step_type,
    position: s.position,
    status: 'pending',
  }));
  const inserted = await gql<{ insert_step_runs: { returning: Array<{ id: string; position: number }> } }>(
    `mutation CreateStepRuns($objects: [step_runs_insert_input!]!) {
       insert_step_runs(objects: $objects) { returning { id position } }
     }`,
    { objects },
  );
  const stepRunIds: Record<number, string> = {};
  for (const r of inserted.insert_step_runs.returning) stepRunIds[r.position] = r.id;
  return { runId, stepRunIds };
}

interface StepRunRow {
  id: string;
  position: number;
  step_type: string;
  status: string;
  output: unknown;
}

async function loadRunStepRuns(runId: string): Promise<StepRunRow[]> {
  const data = await gql<{ step_runs: StepRunRow[] }>(
    `query RunStepRuns($runId: uuid!) {
       step_runs(where: { workflow_run_id: { _eq: $runId } }, order_by: { position: asc }) {
         id
         position
         step_type
         status
         output
       }
     }`,
    { runId },
  );
  return data.step_runs;
}

async function updateStepRun(stepRunId: string, set: Record<string, unknown>): Promise<void> {
  await gql(
    `mutation UpdateStepRun($id: uuid!, $set: step_runs_set_input!) {
       update_step_runs_by_pk(pk_columns: { id: $id }, _set: $set) { id }
     }`,
    { id: stepRunId, set },
  );
}

async function updateRun(runId: string, set: Record<string, unknown>): Promise<void> {
  await gql(
    `mutation UpdateRun($id: uuid!, $set: workflow_runs_set_input!) {
       update_workflow_runs_by_pk(pk_columns: { id: $id }, _set: $set) { id }
     }`,
    { id: runId, set },
  );
}

async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 2): Promise<{ value: T; attemptsMade: number }> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return { value: await fn(), attemptsMade: i + 1 };
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) {
        const delayMs = 400 * (i + 1);
        console.warn(`[runner] ${label} attempt ${i + 1} failed, retrying in ${delayMs}ms: ${(err as Error).message}`);
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

export interface ExecuteOptions {
  runId: string;
  workflow: Workflow;
  startPosition: number;
  runInput: unknown;
}

export interface RunContext {
  input: unknown;
  run: { id: string };
  steps: Record<number, { id: string; output: unknown }>;
}

/**
 * Execute workflow steps in order, starting at `startPosition`.
 *
 * - llm_call / http_request call real external services with one retry on failure
 * - conditional_branch can jump to `else_position` or stop the run
 * - approval_gate pauses the run and returns `paused`
 * - db_write / notify persist their side effects
 * - the org quota is incremented when the run reaches a terminal state
 */
export async function executeSteps(opts: ExecuteOptions): Promise<RunResult> {
  const { runId, workflow, startPosition, runInput } = opts;
  const rows = await loadRunStepRuns(runId);
  const stepRunIds: Record<number, string> = {};
  const ctx: RunContext = { input: runInput ?? {}, run: { id: runId }, steps: {} };
  for (const row of rows) {
    stepRunIds[row.position] = row.id;
    if (row.status === 'succeeded' && row.output !== null && row.output !== undefined) {
      ctx.steps[row.position] = { id: row.id, output: row.output };
    }
  }

  const finish = async (status: 'completed' | 'failed', error?: string): Promise<RunResult> => {
    const now = new Date().toISOString();
    const set: Record<string, unknown> = { status, finished_at: now, updated_at: now };
    if (error) set.error = error;
    await updateRun(runId, set);
    await incrementQuota(workflow.org_id);
    return { run_id: runId, status, message: error ?? (status === 'completed' ? 'Run completed' : 'Run finished') };
  };

  const steps = workflow.steps;
  let position = startPosition;

  while (position < steps.length) {
    const step = steps.find((s) => s.position === position);
    if (!step) break;
    const stepRunId = stepRunIds[position];
    if (!stepRunId) throw new AppError(500, `Missing step_run for position ${position}`);
    const now = new Date().toISOString();
    const renderedInput = renderTemplate(step.config ?? {}, ctx);
    await updateStepRun(stepRunId, { status: 'running', started_at: now, input: renderedInput, updated_at: now });

    try {
      let output: unknown;
      let attemptsMade = 1;

      switch (step.step_type) {
        case 'llm_call': {
          const result = await withRetry(() => callLlm(step.config ?? {}, ctx), `llm_call ${step.name}`);
          output = result.value;
          attemptsMade = result.attemptsMade;
          break;
        }
        case 'http_request': {
          const result = await withRetry(() => callHttp(step.config ?? {}, ctx), `http_request ${step.name}`);
          output = result.value;
          attemptsMade = result.attemptsMade;
          break;
        }
        case 'conditional_branch': {
          const cfg = step.config ?? {};
          const condition = (cfg.condition ?? {}) as {
            source?: string;
            operator?: string;
            value?: unknown;
          };
          const source = (cfg.source as string) ?? condition.source ?? 'last.output';
          const operator = (cfg.operator as string) ?? condition.operator ?? 'truthy';
          const value = cfg.value !== undefined ? cfg.value : condition.value;
          const actual = resolvePath(ctx, source);
          const matched = evaluateCondition(actual, { source, operator, value });
          output = { source, value: actual, matched };
          ctx.steps[position] = { id: step.id, output };

          if (!matched) {
            const elsePosition = cfg.else_position;
            if (typeof elsePosition === 'number' && elsePosition > position) {
              await updateStepRun(stepRunId, {
                status: 'succeeded',
                output,
                attempt_count: attemptsMade,
                finished_at: new Date().toISOString(),
              });
              position = elsePosition;
              continue;
            }
            // No else branch → the run is done (branch ended early).
            await updateStepRun(stepRunId, {
              status: 'succeeded',
              output,
              attempt_count: attemptsMade,
              finished_at: new Date().toISOString(),
            });
            return finish('completed');
          }
          break;
        }
        case 'approval_gate': {
          const set = { status: 'paused', input: renderedInput, started_at: now, updated_at: now };
          await updateStepRun(stepRunId, set);
          await updateRun(runId, { status: 'paused', current_step_id: stepRunId, updated_at: now });
          return {
            run_id: runId,
            status: 'paused',
            message: 'Run paused — awaiting approval',
          };
        }
        case 'db_write': {
          await execDbWrite(step.config ?? {}, {
            orgId: workflow.org_id,
            workflowId: workflow.id,
            runId,
            stepRunId,
          }, ctx);
          output = { written: true, table: (step.config?.table as string) ?? null };
          break;
        }
        case 'notify': {
          await execNotify(step.config ?? {}, { orgId: workflow.org_id, runId, stepRunId }, ctx);
          output = { queued: true, channel: (step.config?.channel as string) ?? 'slack' };
          break;
        }
        default:
          throw new AppError(400, `Unsupported step type: ${step.step_type}`);
      }

      ctx.steps[position] = { id: step.id, output };
      await updateStepRun(stepRunId, {
        status: 'succeeded',
        output,
        attempt_count: attemptsMade,
        finished_at: new Date().toISOString(),
      });
      position += 1;
    } catch (err) {
      const message = (err as Error).message || 'Step failed';
      console.error(`[runner] step ${step.name} failed:`, err);
      await updateStepRun(stepRunId, {
        status: 'failed',
        error: message,
        finished_at: new Date().toISOString(),
      });
      return finish('failed', message);
    }
  }

  return finish('completed');
}
