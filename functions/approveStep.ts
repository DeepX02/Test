import type { Request, Response } from 'express';
import { verifyAccessToken, getBearerToken } from './_shared/jwt';
import { gql } from './_shared/gql';
import {
  loadWorkflow,
  loadMembership,
  assertCanApprove,
  executeSteps,
  type Workflow,
} from './_shared/runner';
import { AppError, isAppError } from './_shared/errors';

interface StepRunContext {
  stepRunId: string;
  position: number;
  status: string;
  stepType: string;
  workflowId: string;
  orgId: string;
  runId: string;
  runInput: unknown;
}

async function loadStepRunContext(stepRunId: string): Promise<StepRunContext> {
  const data = await gql<{
    step_runs_by_pk: {
      id: string;
      position: number;
      status: string;
      step_type: string;
      workflow_run: {
        id: string;
        input: unknown;
        workflow_id: string;
        workflow: { org_id: string };
      };
    } | null;
  }>(
    `query StepRunContext($id: uuid!) {
       step_runs_by_pk(id: $id) {
         id
         position
         status
         step_type
         workflow_run {
           id
           input
           workflow_id
           workflow { org_id }
         }
       }
     }`,
    { id: stepRunId },
  );
  const row = data.step_runs_by_pk;
  if (!row) {
    throw new AppError(404, 'Step run not found');
  }
  return {
    stepRunId: row.id,
    position: row.position,
    status: row.status,
    stepType: row.step_type,
    workflowId: row.workflow_run.workflow_id,
    orgId: row.workflow_run.workflow.org_id,
    runId: row.workflow_run.id,
    runInput: row.workflow_run.input,
  };
}

/**
 * Hasura Action: approveStep(step_run_id)
 *
 * This is a mid-execution decision, so it can't be a database permission:
 * the handler itself re-checks the approver's role (Layer 2) against the
 * org_members table before marking the gate approved and resuming the run
 * from the next step.
 */
export default async function handler(req: Request, res: Response) {
  try {
    const token = getBearerToken(req.headers);
    if (!token) {
      return res.status(401).json({ message: 'Unauthorized: missing access token' });
    }
    const { userId } = verifyAccessToken(token);

    const input = req.body?.input ?? req.body ?? {};
    const stepRunId = input.step_run_id;
    if (!stepRunId) {
      return res.status(400).json({ message: 'step_run_id is required' });
    }

    const ctx = await loadStepRunContext(stepRunId);

    if (ctx.stepType !== 'approval_gate') {
      throw new AppError(409, 'Only approval_gate steps can be approved');
    }
    if (ctx.status !== 'paused') {
      throw new AppError(409, `Step is not paused (status: ${ctx.status})`);
    }

    const workflow: Workflow = await loadWorkflow(ctx.workflowId);
    const membership = await loadMembership(userId, ctx.orgId);

    // The gate step may declare which roles may approve; default owner/editor.
    const gateStep = workflow.steps.find((s) => s.position === ctx.position);
    const cfg = (gateStep?.config ?? {}) as { approvers?: string[]; roles?: string };
    const approvers: string[] = Array.isArray(cfg.approvers)
      ? cfg.approvers
      : typeof cfg.roles === 'string' && cfg.roles.trim()
        ? cfg.roles.split(',').map((r) => r.trim()).filter(Boolean)
        : ['owner', 'editor'];

    // Layer 2 — role check for the approver, enforced in the handler.
    assertCanApprove(workflow, membership, approvers);

    const now = new Date().toISOString();
    await gql(
      `mutation MarkApproved($id: uuid!, $userId: uuid!, $now: timestamptz!) {
         update_step_runs_by_pk(
           pk_columns: { id: $id }
           _set: {
             status: "succeeded"
             approved_by: $userId
             approved_at: $now
             output: { approved: true }
             finished_at: $now
           }
         ) { id }
       }`,
      { id: stepRunId, userId, now },
    );
    await gql(
      `mutation ResumeRun($id: uuid!) {
         update_workflow_runs_by_pk(
           pk_columns: { id: $id }
           _set: { status: "running", current_step_id: null }
         ) { id }
       }`,
      { id: ctx.runId },
    );

    const result = await executeSteps({
      runId: ctx.runId,
      workflow,
      startPosition: ctx.position + 1,
      runInput: ctx.runInput,
    });

    return res.status(200).json({
      run_id: ctx.runId,
      status: result.status,
      message: result.message,
    });
  } catch (err) {
    console.error('[approveStep]', err);
    if (isAppError(err)) {
      return res.status(err.status).json({ message: err.message });
    }
    return res.status(500).json({ message: (err as Error).message || 'Internal error' });
  }
}
