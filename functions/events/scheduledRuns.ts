import type { Request, Response } from 'express';
import { gql } from '../_shared/gql';
import { loadWorkflow, checkQuota, createRun, executeSteps } from '../_shared/runner';
import { cronMatches } from '../_shared/cron';
import { validWebhookSecret } from '../_shared/webhook';
import { AppError, isAppError } from '../_shared/errors';

/**
 * Cron trigger (every minute): fires runs for workflows whose `scheduled`
 * trigger config.schedule matches the current minute. A debounce on
 * last_fired_at prevents overlapping runs.
 */
export default async function handler(req: Request, res: Response) {
  if (!validWebhookSecret(req.headers)) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  try {
    const triggers = await gql<{
      workflow_triggers: Array<{ id: string; workflow_id: string; config: unknown; last_fired_at: string | null }>;
    }>(
      `query ScheduledTriggers {
         workflow_triggers(where: { trigger_type: { _eq: "scheduled" }, is_active: { _eq: true } }) {
           id
           workflow_id
           config
           last_fired_at
         }
       }`,
    );

    const now = new Date();
    let started = 0;
    for (const trigger of triggers.workflow_triggers) {
      const cfg = (trigger.config ?? {}) as { schedule?: string };
      if (!cfg.schedule || !cronMatches(cfg.schedule, now)) continue;
      if (trigger.last_fired_at && now.getTime() - new Date(trigger.last_fired_at).getTime() < 55000) continue;

      await gql(
        `mutation MarkFired($id: uuid!, $now: timestamptz!) {
           update_workflow_triggers_by_pk(pk_columns: { id: $id }, _set: { last_fired_at: $now }) { id }
         }`,
        { id: trigger.id, now: now.toISOString() },
      );

      const workflow = await loadWorkflow(trigger.workflow_id);
      await checkQuota(workflow.org);
      const { runId } = await createRun(workflow, {
        triggeredBy: null,
        triggerType: 'scheduled',
        runInput: { scheduled_at: now.toISOString() },
      });
      await executeSteps({ runId, workflow, startPosition: 0, runInput: { scheduled_at: now.toISOString() } });
      started += 1;
    }
    return res.status(200).json({ message: `checked ${triggers.workflow_triggers.length} trigger(s), started ${started} run(s)` });
  } catch (err) {
    console.error('[scheduledRuns]', err);
    if (isAppError(err)) return res.status(err.status).json({ message: err.message });
    return res.status(500).json({ message: (err as Error).message || 'Internal error' });
  }
}
