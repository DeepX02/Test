import { createClient, type ClientOptions } from 'graphql-ws';
import { nhost } from './nhost';
import type {
  OrgMembership,
  Workflow,
  WorkflowRun,
  StepRun,
  MonthlyUsage,
} from './types';

type ErrorPayload = { error: string; status: number; message: string };
type RequestResult<T> =
  | { data: T; error: null }
  | { data: null; error: Array<{ message: string }> | ErrorPayload };

/** Run a query/mutation with the nhost GraphQL client (v3 SDK shape). */
export async function request<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const raw = (await nhost.graphql.request({ document: query, variables })) as unknown as RequestResult<T>;
  if (raw.error) {
    const errors = Array.isArray(raw.error) ? raw.error : [raw.error];
    throw new Error(errors.map((e) => e.message).join('; '));
  }
  return raw.data;
}

export interface SubscriptionResult<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

/**
 * Subscribe to a GraphQL subscription over the Hasura websocket (graphql-ws subprotocol).
 * The access token and the current org session vars are attached to the connection.
 */
export function subscribe<T>(
  query: string,
  variables: Record<string, unknown>,
  onResult: (result: SubscriptionResult<T>) => void,
): () => void {
  const accessToken = nhost.auth.getAccessToken() ?? undefined;
  const wsHeaders: Record<string, string> = { ...(nhost.graphql.getHeaders() ?? {}) };
  if (accessToken) {
    wsHeaders.authorization = `Bearer ${accessToken}`;
  }

  const options: ClientOptions = {
    url: nhost.graphql.wsUrl,
    connectionParams: { headers: wsHeaders },
  };
  const wsClient = createClient(options);

  const unsubscribe = wsClient.subscribe(
    { query, variables },
    {
      next: (result) => onResult(result as unknown as SubscriptionResult<T>),
      error: (err) =>
        onResult({ errors: [{ message: err instanceof Error ? err.message : String(err) }] }),
      complete: () => undefined,
    },
  );

  return () => {
    unsubscribe();
    wsClient.dispose();
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const MY_MEMBERSHIPS = `
  query MyMemberships {
    org_members {
      id
      org_id
      role
      org { id name }
    }
  }
`;

export const DASHBOARD = `
  query Dashboard($orgId: uuid!) {
    organizations(where: { id: { _eq: $orgId } }) {
      id
      name
      calls_used
      calls_allowed
      monthly_usage
    }
    workflows(where: { org_id: { _eq: $orgId } }, order_by: { created_at: desc }) {
      id
      name
      description
      is_active
      created_at
      steps(order_by: { position: asc }) { id step_type name position }
      triggers { id trigger_type name is_active }
      runs(order_by: { started_at: desc }, limit: 1) { id status started_at finished_at error }
    }
  }
`;

export interface DashboardData {
  organizations: Array<{ id: string; name: string; calls_used: number; calls_allowed: number; monthly_usage: MonthlyUsage }>;
  workflows: Array<{
    id: string;
    name: string;
    description: string | null;
    is_active: boolean;
    created_at: string;
    steps: Array<{ id: string; step_type: string; name: string; position: number }>;
    triggers: Array<{ id: string; trigger_type: string; name: string; is_active: boolean }>;
    runs: Array<{ id: string; status: string; started_at: string; finished_at: string | null; error: string | null }>;
  }>;
}

export const WORKFLOW_DETAIL = `
  query WorkflowDetail($id: uuid!) {
    workflows_by_pk(id: $id) {
      id
      org_id
      name
      description
      is_active
      created_at
      steps(order_by: { position: asc }) { id step_type name position config }
      triggers { id trigger_type name config is_active last_fired_at }
    }
  }
`;

export const RUN_HISTORY = `
  query RunHistory($workflowId: uuid!) {
    workflow_runs(where: { workflow_id: { _eq: $workflowId } }, order_by: { started_at: desc }, limit: 20) {
      id
      status
      trigger_type
      triggered_by
      input
      error
      started_at
      finished_at
    }
  }
`;

// ---------------------------------------------------------------------------
// Mutations (subject to Hasura role/org permissions)
// ---------------------------------------------------------------------------

export const INSERT_WORKFLOW = `
  mutation InsertWorkflow($orgId: uuid!, $name: String!, $description: String) {
    insert_workflows_one(object: { org_id: $orgId, name: $name, description: $description }) {
      id
    }
  }
`;

export const UPDATE_WORKFLOW = `
  mutation UpdateWorkflow($id: uuid!, $name: String, $description: String, $is_active: Boolean) {
    update_workflows_by_pk(pk_columns: { id: $id }, _set: { name: $name, description: $description, is_active: $is_active }) {
      id
    }
  }
`;

export const DELETE_WORKFLOW = `
  mutation DeleteWorkflow($id: uuid!) {
    delete_workflows_by_pk(id: $id) { id }
  }
`;

export const INSERT_STEP = `
  mutation InsertStep($workflowId: uuid!, $stepType: String!, $name: String!, $position: Int!, $config: jsonb) {
    insert_workflow_steps_one(object: {
      workflow_id: $workflowId
      step_type: $stepType
      name: $name
      position: $position
      config: $config
    }) { id }
  }
`;

export const UPDATE_STEP = `
  mutation UpdateStep($id: uuid!, $name: String, $config: jsonb, $position: Int) {
    update_workflow_steps_by_pk(pk_columns: { id: $id }, _set: { name: $name, config: $config, position: $position }) {
      id
    }
  }
`;

export const DELETE_STEP = `
  mutation DeleteStep($id: uuid!) {
    delete_workflow_steps_by_pk(id: $id) { id }
  }
`;

export const INSERT_TRIGGER = `
  mutation InsertTrigger($workflowId: uuid!, $triggerType: String!, $name: String!, $config: jsonb) {
    insert_workflow_triggers_one(object: {
      workflow_id: $workflowId
      trigger_type: $triggerType
      name: $name
      config: $config
    }) { id }
  }
`;

export const UPDATE_TRIGGER = `
  mutation UpdateTrigger($id: uuid!, $name: String, $config: jsonb, $is_active: Boolean) {
    update_workflow_triggers_by_pk(pk_columns: { id: $id }, _set: { name: $name, config: $config, is_active: $is_active }) {
      id
    }
  }
`;

export const DELETE_TRIGGER = `
  mutation DeleteTrigger($id: uuid!) {
    delete_workflow_triggers_by_pk(id: $id) { id }
  }
`;

export const INSERT_DEMO_EVENT = `
  mutation InsertDemoEvent($orgId: uuid!, $message: String!) {
    insert_demo_events_one(object: { org_id: $orgId, message: $message }) { id }
  }
`;

// ---------------------------------------------------------------------------
// Hasura Actions (handler functions re-verify permissions)
// ---------------------------------------------------------------------------

export const TRIGGER_WORKFLOW_RUN = `
  mutation TriggerWorkflowRun($workflowId: uuid!, $input: jsonb) {
    triggerWorkflowRun(workflow_id: $workflowId, input: $input) {
      run_id
      status
      message
    }
  }
`;

export const APPROVE_STEP = `
  mutation ApproveStep($stepRunId: uuid!) {
    approveStep(step_run_id: $stepRunId) {
      run_id
      status
      message
    }
  }
`;

export const WEBHOOK_START_RUN = `
  mutation WebhookStartRun($token: String!, $payload: jsonb) {
    webhookStartRun(token: $token, payload: $payload) {
      run_id
      status
      message
    }
  }
`;

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export const LATEST_RUN = `
  subscription LatestRun($workflowId: uuid!) {
    workflow_runs(where: { workflow_id: { _eq: $workflowId } }, order_by: { started_at: desc }, limit: 1) {
      id
      status
    }
  }
`;

export const RUN_PROGRESS = `
  subscription RunProgress($runId: uuid!) {
    workflow_runs_by_pk(id: $runId) {
      id
      status
      current_step_id
      error
      started_at
      finished_at
      trigger_type
      input
    }
    step_runs(where: { workflow_run_id: { _eq: $runId } }, order_by: { position: asc }) {
      id
      position
      step_type
      status
      input
      output
      error
      attempt_count
      approved_by
      approved_at
      started_at
      finished_at
      workflow_step { name }
    }
  }
`;

export interface RunProgressData {
  workflow_runs_by_pk: Pick<WorkflowRun, 'id' | 'status' | 'current_step_id' | 'error' | 'started_at' | 'finished_at' | 'trigger_type' | 'input'> | null;
  step_runs: StepRun[];
}
