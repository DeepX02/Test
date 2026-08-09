'use client';

import { useState } from 'react';
import type { WorkflowStep } from '@/lib/types';
import StepConfigForm from './step-config';

const STEP_LABELS: Record<string, string> = {
  llm_call: 'LLM call',
  http_request: 'HTTP request',
  db_write: 'DB write',
  notify: 'Notify',
  conditional_branch: 'Conditional branch',
  approval_gate: 'Approval gate',
};

export const OWNER_ONLY_STEP_TYPES = ['db_write', 'notify'];

interface StepCardProps {
  step: WorkflowStep;
  canEdit: boolean;
  isOwner: boolean;
  onUpdate: (id: string, patch: { name?: string; config?: Record<string, unknown> }) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  isFirst: boolean;
  isLast: boolean;
}

export default function StepCard({
  step,
  canEdit,
  isOwner,
  onUpdate,
  onDelete,
  onMove,
  isFirst,
  isLast,
}: StepCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState(step.name);
  const [config, setConfig] = useState<Record<string, unknown>>(step.config ?? {});

  const ownerOnly = OWNER_ONLY_STEP_TYPES.includes(step.step_type);
  const editable = canEdit && (!ownerOnly || isOwner);
  const stepLabel = STEP_LABELS[step.step_type] ?? step.step_type;

  const save = () => {
    onUpdate(step.id, { name: name.trim() || step.name, config });
    setExpanded(false);
  };

  return (
    <div className="step-card">
      <div className="head">
        <span className={`badge ${ownerOnly ? 'owner' : ''}`} title={ownerOnly ? 'Owner-only step type' : step.step_type}>
          {stepLabel}
        </span>
        <input
          type="text"
          value={name}
          disabled={!editable}
          onChange={(e) => setName(e.target.value)}
          style={{ width: '100%', minWidth: 140 }}
        />
        <span className="muted" style={{ fontSize: 12 }}>pos {step.position}</span>
        <span className="spacer" />
        <button
          className="btn small"
          disabled={!editable || isFirst}
          onClick={() => onMove(step.id, -1)}
          title="Move up"
        >
          ↑
        </button>
        <button
          className="btn small"
          disabled={!editable || isLast}
          onClick={() => onMove(step.id, 1)}
          title="Move down"
        >
          ↓
        </button>
        <button className="btn small" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Close' : 'Config'}
        </button>
        <button className="btn small danger" disabled={!editable} onClick={() => onDelete(step.id)}>
          Delete
        </button>
      </div>
      {expanded && (
        <div className="body">
          {!canEdit && (
            <div className="empty" style={{ fontSize: 13 }}>
              Read-only role — cannot edit.
            </div>
          )}
          {canEdit && !editable && (
            <div className="empty" style={{ fontSize: 13 }}>
              This step type is restricted to organization owners.
            </div>
          )}
          {editable && (
            <>
              <StepConfigForm stepType={step.step_type} config={config} onChange={setConfig} />
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn primary small" onClick={save}>
                  Save step
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
