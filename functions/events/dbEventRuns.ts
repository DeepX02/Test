import type { Request, Response } from 'express';
import { gql } from '../_shared/gql';
import { loadWorkflow, checkQuota, createRun, executeSteps } from '../_shared/runner';
import { validWebhookSecret } from '../_shared/webhook';
import { AppError, isAppError } from '../_shared/errors';

/**
 * Event trigger: fires on demo_events INSERT. Starts a run for every workflow
 * that has an active `database_event` trigger watching the `demo_events` table.
 * The inserted row becomes the run's input.
 */
export default async function handler(req: Request, res: Response) {
  if (!validWebhookSecret(req.headers)) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  const event = req.body?.event;
  const tableName = req.body?.table?.name;
  const row = event?.data?.new;
  if (!row?.id) {
    return res.status(200).json({ message: 'No insert payload' });
  }

  try {
    const triggers = await gql<{
      workflow_triggers: Array<{ id: string; workflow_id: string }>;
    }>(
      `query DbEventTriggers($table: String!) {
         workflow_triggers(
           where: {
             trigger_type: { _eq: "database_event" }
             is_active: { _eq: true }
             config: { _contains: { table: $table } }
           }
         ) {
           id
           workflow_id
         }
       }`,
      { table: tableName ?? 'demo_events' },
    );

    const actorUserId = (event?.session_variables?.['x-hasura-user-id'] as string) ?? null;
    const started: string[] = [];
    for (const trigger of triggers.workflow_triggers) {
      const workflow = await loadWorkflow(trigger.workflow_id);
      await checkQuota(workflow.org);
      const { runId } = await createRun(workflow, {
        triggeredBy: actorUserId,
        triggerType: 'database_event',
        runInput: row,
      });
      const result = await executeSteps({ runId, workflow, startPosition: 0, runInput: row });
      started.push(result.run_id);
    }
    return res.status(200).json({ message: `started ${started.length} run(s)`, run_ids: started });
  } catch (err) {
    console.error('[dbEventRuns]', err);
    if (isAppError(err)) return res.status(err.status).json({ message: err.message });
    return res.status(500).json({ message: (err as Error).message || 'Internal error' });
  }
}
