-- Indexes for the hot query paths (org scoping, run lookups, live subscriptions)
create index idx_org_members_user_id on public.org_members (user_id);
create index idx_org_members_org_id on public.org_members (org_id);
create index idx_workflows_org_id on public.workflows (org_id);
create index idx_workflow_steps_workflow_position on public.workflow_steps (workflow_id, position);
create index idx_workflow_triggers_workflow on public.workflow_triggers (workflow_id);
create index idx_workflow_runs_workflow_started on public.workflow_runs (workflow_id, started_at desc);
create index idx_workflow_runs_status on public.workflow_runs (status);
create index idx_step_runs_run_position on public.step_runs (workflow_run_id, position);
create index idx_step_runs_status on public.step_runs (status);
create index idx_notifications_org on public.notifications (org_id);
create index idx_demo_events_org on public.demo_events (org_id);

-- Aggregation: org-level usage this month + average run duration.
-- Exposed to GraphQL as a computed field on organizations (`monthly_usage`).
create or replace function public.org_monthly_usage(org_row public.organizations)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'org_id', org_row.id,
    'calls_used', org_row.calls_used,
    'calls_allowed', org_row.calls_allowed,
    'calls_used_percent', round((org_row.calls_used::numeric * 100.0) / nullif(org_row.calls_allowed, 0), 1),
    'runs_this_month', (
      select count(*)::int
      from public.workflow_runs r
      join public.workflows w on w.id = r.workflow_id
      where w.org_id = org_row.id
        and r.started_at >= date_trunc('month', now())
    ),
    'completed_runs_this_month', (
      select count(*)::int
      from public.workflow_runs r
      join public.workflows w on w.id = r.workflow_id
      where w.org_id = org_row.id
        and r.status = 'completed'
        and r.finished_at >= date_trunc('month', now())
    ),
    'failed_runs_this_month', (
      select count(*)::int
      from public.workflow_runs r
      join public.workflows w on w.id = r.workflow_id
      where w.org_id = org_row.id
        and r.status = 'failed'
        and r.finished_at >= date_trunc('month', now())
    ),
    'paused_runs', (
      select count(*)::int
      from public.workflow_runs r
      join public.workflows w on w.id = r.workflow_id
      where w.org_id = org_row.id and r.status = 'paused'
    ),
    'avg_run_duration_seconds', (
      select round(avg(extract(epoch from (r.finished_at - r.started_at)))::numeric, 1)
      from public.workflow_runs r
      join public.workflows w on w.id = r.workflow_id
      where w.org_id = org_row.id
        and r.status = 'completed'
        and r.finished_at is not null
    )
  );
$$;
