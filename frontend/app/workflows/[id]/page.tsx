'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuthenticationStatus } from '@nhost/react';
import { useOrg } from '@/components/org-provider';
import StepCard, { OWNER_ONLY_STEP_TYPES } from '@/components/step-card';
import TriggerList from '@/components/trigger-list';
import RunPanel from '@/components/run-panel';
import {
  request,
  WORKFLOW_DETAIL,
  UPDATE_WORKFLOW,
  DELETE_WORKFLOW,
  INSERT_STEP,
  UPDATE_STEP,
  DELETE_STEP,
} from '@/lib/graphql';
import type { StepType, Workflow } from '@/lib/types';

const STEP_TYPES: StepType[] = [
  'llm_call',
  'http_request',
  'db_write',
  'notify',
  'conditional_branch',
  'approval_gate',
];

const STEP_LABELS: Record<string, string> = {
  llm_call: 'LLM call',
  http_request: 'HTTP request',
  db_write: 'DB write',
  notify: 'Notify',
  conditional_branch: 'Conditional branch',
  approval_gate: 'Approval gate',
};

const functionsUrl =
  process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN && process.env.NEXT_PUBLIC_NHOST_REGION
    ? `https://${process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN}.functions.${process.env.NEXT_PUBLIC_NHOST_REGION}.nhost.run/v1`
    : 'http://localhost:8888/v1';

const defaultConfig: Record<StepType, Record<string, unknown>> = {
  llm_call: {
    provider: 'groq',
    model: 'llama-3.1-8b-instant',
    temperature: 0.2,
    system: 'You are a helpful assistant. Respond with JSON.',
    prompt: 'Classify this support ticket into one of {billing, refund, technical, other} with a one-line summary.\n\nTicket: {{ input.ticket }}\n\nReturn JSON: {"category": "...", "sentiment": "...", "summary": "..."}',
  },
  http_request: {
    method: 'GET',
    url: 'https://jsonplaceholder.typicode.com/users/{{ input.customer_id }}',
    headers: {},
    body: null,
  },
  db_write: {
    table: 'step_outputs',
    data: { label: 'step-result', payload: {} },
  },
  notify: {
    channel: 'slack',
    to: 'https://hooks.slack.com/…',
    message: 'Workflow "{{ workflow.name }}" finished with output:\n{{ steps.0.output }}',
  },
  conditional_branch: {
    condition: { source: 'steps.0.output.parsed.category', operator: 'eq', value: 'refund' },
    else_position: null,
  },
  approval_gate: {
    reason: 'This step changes a production record. Please approve to continue.',
    approvers: ['owner', 'editor'],
  },
};

interface Detail {
  workflows_by_pk: Workflow | null;
}

export default function WorkflowBuilderPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuthenticationStatus();
  const { ready, activeMembership, role, canEdit, isOwner } = useOrg();
  const [wf, setWf] = useState<Workflow | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const workflowId = params.id;

  const load = useCallback(async () => {
    try {
      const data = await request<Detail>(WORKFLOW_DETAIL, { id: workflowId });
      setWf(data.workflows_by_pk ?? null);
      setError(null);
    } catch (err) {
      setWf(null);
      setError((err as Error).message);
    }
  }, [workflowId]);

  useEffect(() => {
    if (isLoading || !ready) return;
    if (!isAuthenticated) {
      router.replace('/');
      return;
    }
    void load();
  }, [isLoading, isAuthenticated, ready, workflowId, load, router]);

  const steps = useMemo(
    () => (wf?.steps ? [...wf.steps].sort((a, b) => a.position - b.position) : []),
    [wf],
  );

  const canEditThis = canEdit && wf?.org_id === activeMembership?.org_id;

  const updateStep = async (
    id: string,
    patch: { name?: string; config?: Record<string, unknown> },
  ) => {
    setActionError(null);
    try {
      await request(UPDATE_STEP, { id, ...patch });
      await load();
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const moveStep = async (id: string, dir: -1 | 1) => {
    const idx = steps.findIndex((s) => s.id === id);
    const other = steps[idx + dir];
    if (idx < 0 || !other) return;
    setActionError(null);
    try {
      // Swap positions via a two-phase update to avoid unique constraint collisions.
      const tmp = -1000 - other.position;
      await request(UPDATE_STEP, { id: other.id, position: tmp });
      await request(UPDATE_STEP, { id, position: other.position });
      await request(UPDATE_STEP, { id: other.id, position: idx });
      await load();
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const deleteStep = async (id: string) => {
    if (!window.confirm('Delete this step?')) return;
    setActionError(null);
    try {
      await request(DELETE_STEP, { id });
      await load();
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const addStep = async (type: StepType) => {
    if (!wf) return;
    setActionError(null);
    try {
      const nextPos = steps.reduce((max, s) => Math.max(max, s.position), -1) + 1;
      await request(INSERT_STEP, {
        workflowId,
        stepType: type,
        name: STEP_LABELS[type],
        position: nextPos,
        config: defaultConfig[type],
      });
      await load();
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const saveSettings = async () => {
    if (!wf) return;
    setBusy(true);
    setActionError(null);
    try {
      await request(UPDATE_WORKFLOW, {
        id: wf.id,
        name: wf.name,
        description: wf.description || null,
        is_active: wf.is_active,
      });
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const deleteWorkflow = async () => {
    if (!wf) return;
    if (!window.confirm('Delete this workflow and all of its runs?')) return;
    setActionError(null);
    try {
      await request(DELETE_WORKFLOW, { id: wf.id });
      router.push('/dashboard');
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  if (isLoading || !ready || wf === undefined) {
    return (
      <div className="container">
        <div className="card">
          <span className="spinner" /> Loading workflow…
        </div>
      </div>
    );
  }

  if (!wf) {
    return (
      <div className="container" style={{ maxWidth: 560 }}>
        <div className="card">
          <h2>Workflow not found</h2>
          {error && <div className="error-box">{error}</div>}
          <p className="muted">
            It may have been deleted, or you don&apos;t have access to its organization.
          </p>
          <a href="/dashboard">← Back to dashboard</a>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="row" style={{ marginBottom: 16 }}>
        <a href="/dashboard" className="muted" style={{ fontSize: 13 }}>← dashboard</a>
        <span className="spacer" />
        <span className={`badge ${wf.is_active ? 'completed' : ''}`}>
          {wf.is_active ? 'active' : 'inactive'}
        </span>
        <span className={`badge ${role ?? ''}`}>role: {role}</span>
      </div>

      <div className="row" style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>{wf.name}</h1>
        {wf.description && (
          <span className="muted" style={{ fontSize: 13 }}>{wf.description}</span>
        )}
      </div>

      {actionError && <div className="error-box">{actionError}</div>}

      <div className="row stretch">
        <div style={{ flex: '1 1 55%', minWidth: 340 }}>
          <div className="card">
            <h2>Steps ({steps.length})</h2>
            {steps.length === 0 && (
              <div className="empty" style={{ marginBottom: 10 }}>
                No steps yet. Add one below to build the pipeline.
              </div>
            )}
            {steps.map((s, i) => (
              <StepCard
                key={s.id}
                step={s}
                canEdit={!!canEditThis}
                isOwner={isOwner}
                onUpdate={updateStep}
                onDelete={deleteStep}
                onMove={moveStep}
                isFirst={i === 0}
                isLast={i === steps.length - 1}
              />
            ))}
            {canEditThis && (
              <div className="row" style={{ marginTop: 12 }}>
                <span className="muted" style={{ fontSize: 13 }}>Add step:</span>
                {STEP_TYPES.map((type) => {
                  const ownerOnly = OWNER_ONLY_STEP_TYPES.includes(type);
                  const disabled = ownerOnly && !isOwner;
                  return (
                    <button
                      key={type}
                      className="btn small"
                      disabled={disabled}
                      title={ownerOnly && !isOwner ? 'Restricted to organization owners' : undefined}
                      onClick={() => addStep(type)}
                    >
                      + {STEP_LABELS[type]}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="card">
            <h2>Triggers</h2>
            <TriggerList
              workflowId={wf.id}
              triggers={wf.triggers}
              webhookFunctionUrl={functionsUrl}
              onChanged={load}
            />
          </div>
        </div>

        <div style={{ flex: '1 1 45%', minWidth: 320 }}>
          <RunPanel workflowId={wf.id} orgId={wf.org_id} isActive={wf.is_active} />

          <div className="card">
            <h2>Settings</h2>
            {canEditThis ? (
              <>
                <label>Name</label>
                <input
                  type="text"
                  value={wf.name}
                  onChange={(e) => setWf({ ...wf, name: e.target.value })}
                />
                <label>Description</label>
                <textarea
                  rows={2}
                  value={wf.description ?? ''}
                  onChange={(e) => setWf({ ...wf, description: e.target.value })}
                />
                <label className="inline" style={{ marginTop: 12 }}>
                  <input
                    type="checkbox"
                    checked={wf.is_active}
                    onChange={(e) => setWf({ ...wf, is_active: e.target.checked })}
                  />
                  Workflow is active (can be run)
                </label>
                <div className="row" style={{ marginTop: 12 }}>
                  <button className="btn primary" onClick={saveSettings} disabled={busy}>
                    Save
                  </button>
                  <button className="btn danger" onClick={deleteWorkflow} disabled={busy}>
                    Delete workflow
                  </button>
                </div>
              </>
            ) : (
              <div className="empty">
                Read-only — your role (<strong>{role}</strong>) cannot edit this workflow.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
