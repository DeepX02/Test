-- AI Agent Workflow Builder — core schema
-- Organization → members → workflows → steps/triggers → runs → step_runs

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  calls_used integer not null default 0 check (calls_used >= 0),
  calls_allowed integer not null default 1000 check (calls_allowed >= 0),
  quota_period_start timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.org_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);

create table public.workflows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  description text,
  created_by uuid,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workflow_steps (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  step_type text not null check (step_type in ('llm_call', 'http_request', 'db_write', 'notify', 'conditional_branch', 'approval_gate')),
  name text not null,
  position integer not null,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workflow_id, position)
);

create table public.workflow_triggers (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  trigger_type text not null check (trigger_type in ('manual', 'webhook', 'scheduled', 'database_event')),
  name text not null default 'Trigger',
  config jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  last_fired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  triggered_by uuid,
  trigger_type text not null default 'manual',
  status text not null default 'running'
    check (status in ('running', 'paused', 'completed', 'failed', 'cancelled')),
  current_step_id uuid,
  input jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.step_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_run_id uuid not null references public.workflow_runs(id) on delete cascade,
  workflow_step_id uuid not null references public.workflow_steps(id) on delete cascade,
  step_type text not null,
  position integer not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'succeeded', 'failed', 'paused')),
  input jsonb,
  output jsonb,
  error text,
  attempt_count integer not null default 0,
  approved_by uuid,
  approved_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Target table for db_write steps
create table public.step_outputs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  workflow_id uuid,
  workflow_run_id uuid,
  step_run_id uuid,
  label text,
  payload jsonb,
  created_at timestamptz not null default now()
);

-- notify steps write here; a Hasura Event Trigger fires the actual alert
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  workflow_run_id uuid,
  step_run_id uuid,
  channel text not null default 'slack',
  to_address text,
  title text,
  message text,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed')),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Watched table for database_event triggers
create table public.demo_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete set null,
  message text,
  created_at timestamptz not null default now()
);
