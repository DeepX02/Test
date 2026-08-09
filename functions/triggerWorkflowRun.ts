import type { Request, Response } from 'express';
import { verifyAccessToken, getBearerToken } from './_shared/jwt';
import {
  loadWorkflow,
  loadMembership,
  assertCanTrigger,
  checkQuota,
  createRun,
  executeSteps,
} from './_shared/runner';
import { AppError, isAppError } from './_shared/errors';

/**
 * Hasura Action: triggerWorkflowRun(workflow_id, input)
 *
 * 1. Verifies the caller is an owner/editor of the workflow's org (Layer 1).
 * 2. Checks the org quota isn't exhausted.
 * 3. Creates the workflow_run + step_runs and executes steps in order.
 * 4. Returns once the run completes, fails, or pauses at an approval gate.
 */
export default async function handler(req: Request, res: Response) {
  try {
    const token = getBearerToken(req.headers);
    if (!token) {
      return res.status(401).json({ message: 'Unauthorized: missing access token' });
    }
    const { userId } = verifyAccessToken(token);

    const input = req.body?.input ?? req.body ?? {};
    const workflowId = input.workflow_id;
    if (!workflowId) {
      return res.status(400).json({ message: 'workflow_id is required' });
    }

    const workflow = await loadWorkflow(workflowId);
    const membership = await loadMembership(userId, workflow.org_id);

    // Layer 1 — org + role scoping, enforced in the handler (not just the DB).
    assertCanTrigger(workflow, membership);

    // Quota check before a run is created.
    await checkQuota(workflow.org);

    const { runId } = await createRun(workflow, {
      triggeredBy: userId,
      triggerType: 'manual',
      runInput: input.input ?? null,
    });

    const result = await executeSteps({
      runId,
      workflow,
      startPosition: 0,
      runInput: input.input ?? null,
    });

    return res.status(200).json({
      run_id: runId,
      workflow_id: workflowId,
      status: result.status,
      message: result.message,
    });
  } catch (err) {
    console.error('[triggerWorkflowRun]', err);
    if (isAppError(err)) {
      return res.status(err.status).json({ message: err.message });
    }
    return res.status(500).json({ message: (err as Error).message || 'Internal error' });
  }
}
