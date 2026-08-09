export type OrgRole = 'owner' | 'editor' | 'viewer';

export type StepType =
  | 'llm_call'
  | 'http_request'
  | 'db_write'
  | 'notify'
  | 'conditional_branch'
  | 'approval_gate';

export type TriggerType = 'manual' | 'webhook' | 'scheduled' | 'database_event';

export type RunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type StepRunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'paused';

export interface OrgMembership {
  id: string;
  org_id: string;
  role: OrgRole;
  org: { id: string; name: string };
}

export interface MonthlyUsage {
  org_id: string;
  calls_used: number;
  calls_allowed: number;
  calls_used_percent: number;
  runs_this_month: number;
  completed_runs_this_month: number;
  failed_runs_this_month: number;
  paused_runs: number;
  avg_run_duration_seconds: number | null;
}

export interface WorkflowStep {
  id: string;
  workflow_id: string;
  step_type: StepType;
  name: string;
  position: number;
  config: Record<string, unknown>;
}

export interface WorkflowTrigger {
  id: string;
  workflow_id: string;
  trigger_type: TriggerType;
  name: string;
  config: Record<string, unknown>;
  is_active: boolean;
  last_fired_at: string | null;
}

export interface WorkflowRun {
  id: string;
  workflow_id: string;
  triggered_by: string | null;
  trigger_type: string;
  status: RunStatus;
  current_step_id: string | null;
  input: unknown;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  updated_at: string;
}

export interface StepRun {
  id: string;
  workflow_run_id: string;
  workflow_step_id: string;
  step_type: StepType;
  position: number;
  status: StepRunStatus;
  input: unknown;
  output: unknown;
  error: string | null;
  attempt_count: number;
  approved_by: string | null;
  approved_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  workflow_step?: { name: string };
}

export interface Workflow {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  steps: WorkflowStep[];
  triggers: WorkflowTrigger[];
}
