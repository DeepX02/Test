'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useOrg } from './org-provider';
import {
  request,
  subscribe,
  LATEST_RUN,
  RUN_PROGRESS,
  RUN_HISTORY,
  TRIGGER_WORKFLOW_RUN,
  APPROVE_STEP,
  INSERT_DEMO_EVENT,
  type RunProgressData,
} from '@/lib/graphql';
import type { WorkflowRun } from '@/lib/types';

interface RunPanelProps {
  workflowId: string;
  orgId: string;
  isActive: boolean;
}

export default function RunPanel({ workflowId, orgId, isActive }: RunPanelProps) {
  const { canTrigger, role } = useOrg();
  const [inputText, setInputText] = useState(
    '{\n  "ticket": "Customer wants a refund for order #1042",\n  "customer_id": 1\n}',
  );
  const [running, setRunning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [run, setRun] = useState<RunProgressData['workflow_runs_by_pk']>(null);
  const [steps, setSteps] = useState<RunProgressData['step_runs']>([]);
  const [history, setHistory] = useState<WorkflowRun[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [subError, setSubError] = useState<string | null>(null);

  const activeRunIdRef = useRef<string | null>(null);
  const subsRef = useRef<Array<() => void>>([]);

  const loadHistory = useCallback(async () => {
    try {
      const data = await request<{ workflow_runs: WorkflowRun[] }>(RUN_HISTORY, { workflowId });
      setHistory(data.workflow_runs);
      setHistoryError(null);
    } catch (err) {
      setHistoryError((err as Error).message);
    }
  }, [workflowId]);

  const attachRunSubscription = useCallback(
    (runId: string) => {
      const unsub = subscribe<RunProgressData>(
        RUN_PROGRESS,
        { runId },
        (res) => {
          if (res.errors?.length) {
            setSubError(res.errors.map((e) => e.message).join('; '));
            return;
          }
          setSubError(null);
          setRun(res.data?.workflow_runs_by_pk ?? null);
          setSteps(res.data?.step_runs ?? []);
        },
      );
      subsRef.current.push(unsub);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const unsubLatest = subscribe<{ workflow_runs: Array<{ id: string }> }>(
      LATEST_RUN,
      { workflowId },
      (res) => {
        if (res.errors?.length) {
          setSubError(res.errors.map((e) => e.message).join('; '));
          return;
        }
        const latest = res.data?.workflow_runs?.[0];
        if (latest && latest.id !== activeRunIdRef.current) {
          activeRunIdRef.current = latest.id;
          attachRunSubscription(latest.id);
          if (!cancelled) {
            // switch the visible run immediately
            setRun(null);
            setSteps([]);
          }
        }
      },
    );

    void loadHistory();

    return () => {
      cancelled = true;
      unsubLatest();
      subsRef.current.forEach((u) => u());
      subsRef.current = [];
    };
  }, [workflowId, attachRunSubscription, loadHistory]);

  const triggerRun = async () => {
    setRunning(true);
    setActionError(null);
    try {
      let input: unknown = null;
      if (inputText.trim()) {
        try {
          input = JSON.parse(inputText);
        } catch {
          throw new Error('Run input is not valid JSON');
        }
      }
      const res = await request<{ triggerWorkflowRun: { run_id: string; status: string; message: string } }>(
        TRIGGER_WORKFLOW_RUN,
        { workflowId, input },
      );
      // Immediately attach to the new run if the subscription hasn't caught it yet.
      if (res.triggerWorkflowRun.run_id && res.triggerWorkflowRun.run_id !== activeRunIdRef.current) {
        activeRunIdRef.current = res.triggerWorkflowRun.run_id;
        attachRunSubscription(res.triggerWorkflowRun.run_id);
        setRun(null);
        setSteps([]);
      }
      await loadHistory();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const approve = async (stepRunId: string) => {
    setRunning(true);
    setActionError(null);
    try {
      await request<{ approveStep: { message: string } }>(APPROVE_STEP, { stepRunId });
      await loadHistory();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const fireDemoEvent = async () => {
    setRunning(true);
    setActionError(null);
    try {
      await request(INSERT_DEMO_EVENT, {
        orgId,
        message: `demo event ${new Date().toISOString()}`,
      });
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const statusLabel = (status: string) => status;

  return (
    <>
      <div className="card">
        <h2>Run workflow</h2>
        {!isActive && (
          <div className="empty" style={{ marginBottom: 10 }}>
            This workflow is inactive — reactivate it in settings to run it.
          </div>
        )}
        {canTrigger ? (
          <>
            <label>Run input (JSON)</label>
            <textarea
              rows={5}
              className="mono"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
            />
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn primary" onClick={triggerRun} disabled={running || !isActive}>
                {running ? 'Running…' : '▶ Run workflow'}
              </button>
              <button
                className="btn"
                onClick={fireDemoEvent}
                disabled={running}
                title="Inserts a row into demo_events — starts runs for any database_event trigger"
              >
                Fire demo event
              </button>
            </div>
          </>
        ) : (
          <div className="empty">
            Your role (<strong>{role}</strong>) can view runs but cannot trigger them.
          </div>
        )}
        {actionError && <div className="error-box">{actionError}</div>}
        {subError && <div className="error-box">Subscription error: {subError}</div>}
      </div>

      {run && (
        <div className="card">
          <div className="row" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>Live run</h2>
            <span className="spacer" />
            <span className={`badge ${run.status}`}>{statusLabel(run.status)}</span>
          </div>
          {run.error && <div className="error-box">Run error: {run.error}</div>}
          {run.status === 'paused' && (
            <div className="muted" style={{ marginBottom: 10, fontSize: 13 }}>
              ⏸ Awaiting approval — approvers can resume below.
            </div>
          )}
          {steps.map((s) => (
            <div className="step-card" key={s.id}>
              <div className="head">
                <span className={`status-dot ${s.status}`} />
                <span className="badge">{s.step_type}</span>
                <strong>{s.workflow_step?.name ?? s.step_type}</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  {statusLabel(s.status)}
                  {s.attempt_count > 1 ? ` (retry ${s.attempt_count - 1})` : ''}
                </span>
                <span className="spacer" />
                {s.status === 'paused' && canTrigger && (
                  <button className="btn primary small" onClick={() => approve(s.id)} disabled={running}>
                    Approve & resume
                  </button>
                )}
              </div>
              {s.error && <div className="error-box">{s.error}</div>}
              {(s.input !== null && s.input !== undefined) || (s.output !== null && s.output !== undefined) ? (
                <details style={{ marginTop: 8 }}>
                  <summary>input / output</summary>
                  <pre className="json">{JSON.stringify({ input: s.input, output: s.output }, null, 2)}</pre>
                </details>
              ) : null}
            </div>
          ))}
          {steps.length === 0 && (
            <div className="empty">Waiting for steps to start…</div>
          )}
        </div>
      )}

      {history.length > 0 && (
        <div className="card">
          <h2>Run history</h2>
          {historyError && <div className="error-box">{historyError}</div>}
          {history.map((r) => (
            <div className="step-card" key={r.id}>
              <div className="head">
                <span className={`status-dot ${r.status}`} />
                <span className={`badge ${r.status}`}>{r.status}</span>
                <span className="muted" style={{ fontSize: 12 }}>{r.trigger_type}</span>
                <span className="muted" style={{ fontSize: 12 }}>
                  {new Date(r.started_at).toLocaleString()}
                </span>
                <span className="spacer" />
                <span className="muted" style={{ fontSize: 12, fontFamily: 'monospace' }}>
                  {r.id.slice(0, 8)}
                </span>
              </div>
              {r.error && <div className="error-box">{r.error}</div>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
