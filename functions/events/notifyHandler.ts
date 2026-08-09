import type { Request, Response } from 'express';
import { gql } from '../_shared/gql';
import { validWebhookSecret } from '../_shared/webhook';

/**
 * Event trigger: fires on every notifications INSERT (created by notify steps).
 * Delivers the alert (real Slack webhook if SLACK_WEBHOOK_URL is set,
 * otherwise a logged/simulated delivery) and records the outcome.
 */
export default async function handler(req: Request, res: Response) {
  if (!validWebhookSecret(req.headers)) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  const event = req.body?.event;
  const row = event?.data?.new;
  if (!row?.id) {
    return res.status(200).json({ message: 'No insert payload' });
  }

  try {
    await gql(
      `mutation Sending($id: uuid!) {
         update_notifications_by_pk(pk_columns: { id: $id }, _set: { status: "sending" }) { id }
       }`,
      { id: row.id },
    );

    if (row.channel === 'slack' && process.env.SLACK_WEBHOOK_URL) {
      const slackRes = await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: `*${row.title ?? 'Workflow alert'}*\n${row.message ?? ''}`,
        }),
      });
      if (!slackRes.ok) throw new Error(`Slack webhook returned ${slackRes.status}`);
    } else {
      // Simulated delivery (no Slack webhook configured).
      console.log(`[notify] simulated ${row.channel} delivery to ${row.to_address ?? '#'}: ${row.title ?? ''}`);
    }

    await gql(
      `mutation Sent($id: uuid!, $now: timestamptz!) {
         update_notifications_by_pk(
           pk_columns: { id: $id }
           _set: { status: "sent", sent_at: $now }
         ) { id }
       }`,
      { id: row.id, now: new Date().toISOString() },
    );
    return res.status(200).json({ message: 'delivered' });
  } catch (err) {
    console.error('[notifyHandler] delivery failed:', err);
    await gql(
      `mutation Failed($id: uuid!) {
         update_notifications_by_pk(pk_columns: { id: $id }, _set: { status: "failed" }) { id }
       }`,
      { id: row.id },
    ).catch(() => undefined);
    return res.status(200).json({ message: 'delivery failed, marked failed' });
  }
}
