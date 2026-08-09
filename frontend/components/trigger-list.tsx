'use client';

import { useState } from 'react';
import { useOrg } from './org-provider';
import { request, INSERT_TRIGGER, UPDATE_TRIGGER, DELETE_TRIGGER, WEBHOOK_START_RUN } from '@/lib/graphql';
import type { TriggerType, WorkflowTrigger } from '@/lib/types';

const TRIGGER_LABELS: Record<string, string> = {
  manual: 'Manual',
  webhook: 'Webhook',
  scheduled: 'Scheduled (cron)',
  database_event: 'Database event',
};

export function newWebhookToken(): string {
  const c = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : null;
  if (c) return c;
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

interface TriggerListProps {
  workflowId: string;
  triggers: WorkflowTrigger[];
  webhookFunctionUrl: string;
  onChanged: () => void;
}

export default function TriggerList({
  workflowId,
  triggers,
  webhookFunctionUrl,
  onChanged,
}: TriggerListProps) {
  const { isOwner, canEdit } = useOrg();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [webhookRun, setWebhookRun] = useState<string | null>(null);

  const add = async (type: TriggerType) => {
    setBusy(true);
    setError(null);
    try {
      let config: Record<string, unknown> = {};
      let name = TRIGGER_LABELS[type];
      if (type === 'webhook') {
        config = { token: newWebhookToken() };
        name = 'Inbound webhook';
      } else if (type === 'scheduled') {
        config = { schedule: '*/5 * * * *' };
        name = 'Every 5 minutes';
      } else if (type === 'database_event') {
        config = { table: 'demo_events', operation: 'INSERT' };
        name = 'demo_events INSERT';
      }
      await request(INSERT_TRIGGER, { workflowId, triggerType: type, name, config });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const updateActive = async (id: string, is_active: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await request(UPDATE_TRIGGER, { id, is_active });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await request(DELETE_TRIGGER, { id });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const simulateWebhook = async (token: string) => {
    setBusy(true);
    setError(null);
    setWebhookRun(null);
    try {
      const res = await request<{ webhookStartRun: { run_id: string; status: string; message: string } }>(
        WEBHOOK_START_RUN,
        { token, payload: { ticket: 'Customer wants a refund for order #1042', customer_id: 1 } },
      );
      setWebhookRun(res.webhookStartRun.message);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const webhook = triggers.find((t) => t.trigger_type === 'webhook');
  const token = String(webhook?.config?.token ?? '');
  const endpoint = `${webhookFunctionUrl}/webhookStartRun`;

  return (
    <div>
      {triggers.length === 0 && (
        <div className="empty" style={{ marginBottom: 10 }}>No triggers yet.</div>
      )}
      {triggers.map((t) => (
        <div className="step-card" key={t.id}>
          <div className="head">
            <span className={`badge ${t.trigger_type === 'webhook' && !isOwner ? 'owner' : ''}`}>
              {TRIGGER_LABELS[t.trigger_type] ?? t.trigger_type}
            </span>
            <strong>{t.name}</strong>
            <span className={`badge ${t.is_active ? 'completed' : ''}`}>
              {t.is_active ? 'active' : 'inactive'}
            </span>
            <span className="spacer" />
            {canEdit && (
              <>
                <button className="btn small" onClick={() => updateActive(t.id, !t.is_active)}>
                  {t.is_active ? 'Deactivate' : 'Activate'}
                </button>
                <button className="btn small danger" onClick={() => remove(t.id)}>
                  Delete
                </button>
              </>
            )}
          </div>
          {t.trigger_type === 'webhook' && canEdit && (
            <div className="body">
              <div className="muted" style={{ fontSize: 13 }}>
                POST <code className="mono">{endpoint}</code> with JSON body{' '}
                <code className="mono">{'{"token": "<your token>", "payload": {...}}'}</code>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <button
                  className="btn small"
                  disabled={busy}
                  onClick={() => simulateWebhook(token)}
                  title="Sends a sample payload as if an external service called the webhook"
                >
                  Simulate webhook call
                </button>
              </div>
            </div>
          )}
          {t.trigger_type === 'scheduled' && (
            <div className="body">
              <div className="muted" style={{ fontSize: 13 }}>
                Cron: <code className="mono">{String((t.config as Record<string, unknown>)?.schedule ?? '')}</code>{' '}
                — checked once per minute
              </div>
            </div>
          )}
          {t.trigger_type === 'database_event' && (
            <div className="body">
              <div className="muted" style={{ fontSize: 13 }}>
                Table: <code className="mono">{String((t.config as Record<string, unknown>)?.table ?? '')}</code>{' '}
                on INSERT
              </div>
            </div>
          )}
        </div>
      ))}

      {canEdit && (
        <div className="row" style={{ marginTop: 4 }}>
          <span className="muted" style={{ fontSize: 13 }}>Add trigger:</span>
          {(Object.keys(TRIGGER_LABELS) as TriggerType[]).map((type) => {
            const ownerOnly = type === 'webhook';
            const disabled = busy || (ownerOnly && !isOwner);
            return (
              <button
                key={type}
                className="btn small"
                disabled={disabled}
                title={ownerOnly && !isOwner ? 'Webhook triggers are restricted to owners' : undefined}
                onClick={() => add(type)}
              >
                + {TRIGGER_LABELS[type]}
              </button>
            );
          })}
        </div>
      )}
      {error && <div className="error-box">{error}</div>}
      {webhookRun && (
        <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>{webhookRun}</div>
      )}
    </div>
  );
}
