'use client';

import type { StepType } from '@/lib/types';

interface StepConfigFormProps {
  stepType: StepType;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}

function Field({
  label,
  value,
  onChange,
  textarea,
  mono,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  textarea?: boolean;
  mono?: boolean;
  hint?: string;
}) {
  return (
    <>
      <label>{label}</label>
      {textarea ? (
        <textarea
          rows={3}
          className={mono ? 'mono' : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          type="text"
          className={mono ? 'mono' : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {hint && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{hint}</div>}
    </>
  );
}

export default function StepConfigForm({ stepType, config, onChange }: StepConfigFormProps) {
  const get = (key: string): string => {
    const v = config[key];
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v;
    return JSON.stringify(v);
  };

  const set = (key: string, value: string) => {
    onChange({ ...config, [key]: value });
  };

  // JSON-aware setter: stores raw string if unparsable, else parsed value.
  const setJson = (key: string, raw: string) => {
    let value: unknown = raw;
    if (raw.trim() === '') value = null;
    else {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw; // keep as string
      }
    }
    onChange({ ...config, [key]: value });
  };

  // Conditional branch: canonical storage is `{ condition: { source, operator, value } }`.
  const condition = (config.condition ?? {}) as Record<string, unknown>;
  const getCondition = (key: string): string => {
    const v = condition[key];
    if (v === undefined || v === null) return '';
    return typeof v === 'string' ? v : String(v);
  };
  const setCondition = (key: string, value: string) => {
    onChange({ ...config, condition: { ...condition, [key]: value } });
  };

  // Approval gate: canonical storage is `{ approvers: string[] }`.
  const approvers = Array.isArray(config.approvers) ? (config.approvers as string[]).join(', ') : '';
  const setApprovers = (raw: string) => {
    const list = raw
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    onChange({ ...config, approvers: list });
  };

  return (
    <div>
      {stepType === 'llm_call' && (
        <>
          <Field label="Provider" value={get('provider') || 'groq'} onChange={(v) => set('provider', v)} hint="groq | openai | openrouter | gemini | stub" />
          <Field label="Model" value={get('model')} onChange={(v) => set('model', v)} hint="e.g. llama-3.1-8b-instant" />
          <Field label="Temperature" value={String(get('temperature') ?? '0.2')} onChange={(v) => set('temperature', v)} />
          <Field label="System prompt" value={get('system')} onChange={(v) => set('system', v)} textarea />
          <Field label="User prompt" value={get('prompt')} onChange={(v) => set('prompt', v)} textarea hint="Supports {{ input.* }} and {{ steps.<pos>.output.* }} templates" />
        </>
      )}
      {stepType === 'http_request' && (
        <>
          <Field label="Method" value={get('method') || 'GET'} onChange={(v) => set('method', v)} hint="GET | POST | PUT | PATCH | DELETE" />
          <Field label="URL" value={get('url')} onChange={(v) => set('url', v)} mono hint="Templates supported, e.g. https://api.example.com/users/{{ input.customer_id }}" />
          <Field label="Headers (JSON)" value={get('headers')} onChange={(v) => setJson('headers', v)} mono />
          <Field label="Body (JSON)" value={get('body')} onChange={(v) => setJson('body', v)} mono textarea />
        </>
      )}
      {stepType === 'db_write' && (
        <>
          <Field label="Target table" value={get('table') || 'step_outputs'} onChange={(v) => set('table', v)} hint="Restricted to step_outputs by the runner" />
          <Field label="Data (JSON)" value={get('data')} onChange={(v) => setJson('data', v)} mono textarea hint="Written with org_id/run/step ids injected server-side" />
        </>
      )}
      {stepType === 'notify' && (
        <>
          <Field label="Channel" value={get('channel') || 'slack'} onChange={(v) => set('channel', v)} hint="slack (via webhook) | email (simulated)" />
          <Field label="To" value={get('to')} onChange={(v) => set('to', v)} hint="Slack webhook URL, or email address" />
          <Field label="Message" value={get('message')} onChange={(v) => set('message', v)} textarea hint="Templates supported" />
        </>
      )}
      {stepType === 'conditional_branch' && (
        <>
          <Field
            label="Source (path to value)"
            value={getCondition('source') || 'last.output'}
            onChange={(v) => setCondition('source', v)}
            mono
            hint="e.g. steps.0.output.parsed.category or input.customer_id"
          />
          <Field
            label="Operator"
            value={getCondition('operator') || 'eq'}
            onChange={(v) => setCondition('operator', v)}
            hint="eq | neq | contains | starts_with | truthy | exists | gt | lt"
          />
          <Field
            label="Value (for eq/neq/contains/gt/lt)"
            value={getCondition('value')}
            onChange={(v) => setCondition('value', v)}
          />
          <Field
            label="Else position (empty = stop run)"
            value={get('else_position')}
            onChange={(v) => setJson('else_position', v)}
            hint="Optional. If set, jumps to that step when condition is false."
          />
        </>
      )}
      {stepType === 'approval_gate' && (
        <>
          <Field
            label="Message to approvers"
            value={get('reason')}
            onChange={(v) => set('reason', v)}
            textarea
            hint="Shown next to Approve / Reject"
          />
          <Field
            label="Allowed roles"
            value={approvers}
            onChange={(v) => setApprovers(v)}
            hint="Comma-separated; only these org roles may approve. Empty = owner/editor."
          />
        </>
      )}
    </div>
  );
}
