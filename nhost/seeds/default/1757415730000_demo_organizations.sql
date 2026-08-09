-- Demo seed: two organizations with users & roles, plus a complete
-- demo workflow in Org A (llm_call -> http_request -> conditional_branch
-- -> approval_gate -> db_write -> notify) with manual, webhook and
-- database_event triggers.
--
-- All demo accounts use the password: WorkflowDemo123!
-- (bcrypt hash below was generated with bcryptjs, cost 10)

set check_function_bodies = false;

-- Organizations ---------------------------------------------------------------
insert into public.organizations (id, name, calls_used, calls_allowed, quota_period_start)
values
  ('00000000-0000-0000-0000-00000000000a', 'Acme Corp (Org A)', 0, 50, now()),
  ('00000000-0000-0000-0000-00000000000b', 'Globex Inc (Org B)', 0, 50, now())
on conflict (id) do nothing;

-- Auth users ------------------------------------------------------------------
insert into auth.users (id, email, password_hash, email_verified, display_name, locale, default_role, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000101', 'alice@acme.com',  '$2b$10$n9Guu.Lo42NOXgpbIoTpLOZ3wF/PEbkw6qMXjKncxHdobpx4hdlKa', true, 'Alice (Owner A)',  'en', 'user', now(), now()),
  ('00000000-0000-0000-0000-000000000102', 'bob@acme.com',    '$2b$10$n9Guu.Lo42NOXgpbIoTpLOZ3wF/PEbkw6qMXjKncxHdobpx4hdlKa', true, 'Bob (Editor A)',   'en', 'user', now(), now()),
  ('00000000-0000-0000-0000-000000000103', 'carol@acme.com',  '$2b$10$n9Guu.Lo42NOXgpbIoTpLOZ3wF/PEbkw6qMXjKncxHdobpx4hdlKa', true, 'Carol (Viewer A)', 'en', 'user', now(), now()),
  ('00000000-0000-0000-0000-000000000201', 'dave@globex.com', '$2b$10$n9Guu.Lo42NOXgpbIoTpLOZ3wF/PEbkw6qMXjKncxHdobpx4hdlKa', true, 'Dave (Owner B)',   'en', 'user', now(), now()),
  ('00000000-0000-0000-0000-000000000202', 'erin@globex.com', '$2b$10$n9Guu.Lo42NOXgpbIoTpLOZ3wF/PEbkw6qMXjKncxHdobpx4hdlKa', true, 'Erin (Editor B)',  'en', 'user', now(), now()),
  ('00000000-0000-0000-0000-000000000203', 'frank@globex.com','$2b$10$n9Guu.Lo42NOXgpbIoTpLOZ3wF/PEbkw6qMXjKncxHdobpx4hdlKa', true, 'Frank (Viewer B)', 'en', 'user', now(), now())
on conflict (id) do nothing;

insert into auth.user_roles (user_id, role)
select id, 'user' from auth.users where id in (
  '00000000-0000-0000-0000-000000000101',
  '00000000-0000-0000-0000-000000000102',
  '00000000-0000-0000-0000-000000000103',
  '00000000-0000-0000-0000-000000000201',
  '00000000-0000-0000-0000-000000000202',
  '00000000-0000-0000-0000-000000000203'
)
on conflict (user_id, role) do nothing;

-- Memberships ------------------------------------------------------------------
insert into public.org_members (org_id, user_id, role)
values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000101', 'owner'),
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000102', 'editor'),
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000103', 'viewer'),
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000201', 'owner'),
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000202', 'editor'),
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000203', 'viewer')
on conflict (org_id, user_id) do nothing;

-- Demo workflow in Org A (built by the owner, Alice) ---------------------------
insert into public.workflows (id, org_id, name, description, created_by)
values (
  '00000000-0000-0000-0000-00000000000f',
  '00000000-0000-0000-0000-00000000000a',
  'Support Triage',
  'Classifies a support ticket, looks up the customer, requires human approval for refunds, then saves and alerts.',
  '00000000-0000-0000-0000-000000000101'
)
on conflict (id) do nothing;

insert into public.workflow_steps (id, workflow_id, step_type, name, position, config)
values
  (
    '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-00000000000f',
    'llm_call', 'Classify the request', 0,
    '{"provider":"groq","model":"llama-3.1-8b-instant","temperature":0.2,"system":"You classify customer support tickets. Reply with ONLY one JSON object: {\"category\": \"refund|billing|tech|other\", \"sentiment\": \"positive|neutral|negative\", \"summary\": \"<one sentence>\"}.","prompt":"Ticket: {{ input.ticket }}\nClassify it."}'
  ),
  (
    '00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-00000000000f',
    'http_request', 'Look up customer', 1,
    '{"method":"GET","url":"https://jsonplaceholder.typicode.com/users/{{ input.customer_id }}","headers":{},"body":null}'
  ),
  (
    '00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-00000000000f',
    'conditional_branch', 'Refund? proceed : stop', 2,
    '{"condition":{"source":"steps.0.output.parsed.category","operator":"eq","value":"refund"},"else_position":null}'
  ),
  (
    '00000000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-00000000000f',
    'approval_gate', 'Human approval for refund', 3,
    '{"reason":"Refund decisions require human sign-off","approvers":["owner","editor"]}'
  ),
  (
    '00000000-0000-0000-0000-000000000015', '00000000-0000-0000-0000-00000000000f',
    'db_write', 'Save triage outcome', 4,
    '{"table":"step_outputs","data":{"label":"triage-outcome","payload":{"category":"{{ steps.0.output.parsed.category }}","summary":"{{ steps.0.output.parsed.summary }}","customer_name":"{{ steps.1.output.body.name }}"}}}'
  ),
  (
    '00000000-0000-0000-0000-000000000016', '00000000-0000-0000-0000-00000000000f',
    'notify', 'Alert the operations team', 5,
    '{"channel":"slack","to":"#ops","title":"Refund for customer {{ input.customer_id }}","message":"{{ steps.0.output.parsed.summary }}"}'
  )
on conflict (id) do nothing;

insert into public.workflow_triggers (id, workflow_id, trigger_type, name, config, is_active)
values
  (
    '00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-00000000000f',
    'manual', 'Run manually', '{}', true
  ),
  (
    '00000000-0000-0000-0000-000000000022', '00000000-0000-0000-0000-00000000000f',
    'webhook', 'Inbound webhook', '{"token":"c4a7d3f0-9b2e-4f1a-8c6d-2e9a0b1c2d3e"}', true
  ),
  (
    '00000000-0000-0000-0000-000000000023', '00000000-0000-0000-0000-00000000000f',
    'database_event', 'demo_events watcher', '{"table":"demo_events"}', true
  )
on conflict (id) do nothing;
