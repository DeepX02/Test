import type { Request, Response } from 'express';
import { gql } from './_shared/gql';
import { loadWorkflow, checkQuota, createRun, executeSteps } from './_shared/runner';
import { AppError, isAppError } from './_shared/errors';

/**
 * Inbound webhook endpoint (Hasura Action `webhookStartRun` or a direct
 * POST to /v1/webhookStartRun).
 *
 * The caller authenticates with the token that was generated when the owner
 * created the webhook trigger — no user session is required, which is what
 * makes it callable by external systems. The handler:
 *   1. Looks up the matching active webhook trigger by token.
 *   2. Checks the owning org's quota.
 *   3. Creates + executes the run.
 */
export default async function handler(req: Request, res: Response) {
  try {
    const body = req.body?.input ?? req.body ?? {};
    const token = body.token;
    const payload = body.payload ?? body.data ?? body;

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ message: 'token is required' });
    }

    const triggers = await gql<{
      workflow_triggers: Array<{ id: string; workflow_id: string }>;
    }>(
      `query WebhookTrigger($token: String!) {
         workflow_triggers(
           where: {
             trigger_type: { _eq: "webhook" }
             is_active: { _eq: true }
             config: { _contains: { token: $token } }
           }
         ) {
           id
           workflow_id
         }
       }`,
      { token },
    );

    if (triggers.workflow_triggers.length === 0) {
      throw new AppError(404, 'No active webhook trigger matches this token');
    }

    const started: Array<{ run_id: string; status: string; message: string }> = [];
    for (const trigger of triggers.workflow_triggers) {
      const workflow = await loadWorkflow(trigger.workflow_id);
      await checkQuota(workflow.org);
      const { runId } = await createRun(workflow, {
        triggeredBy: null,
        triggerType: 'webhook',
        runInput: payload ?? null,
      });
      const result = await executeSteps({ runId, workflow, startPosition: 0, runInput: payload ?? null });
      started.push({ run_id: runId, status: result.status, message: result.message });
    }

    const first = started[0];
    return res.status(200).json({
      run_id: first?.run_id,
      workflow_id: triggers.workflow_triggers[0]?.workflow_id,
      status: first?.status,
      message: first?.message,
      started,
    });
  } catch (err) {
    console.error('[webhookStartRun]', err);
    if (isAppError(err)) {
      return res.status(err.status).json({ message: err.message });
    }
    return res.status(500).json({ message: (err as Error).message || 'Internal error' });
  }
}
