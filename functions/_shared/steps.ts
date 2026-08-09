import { gql } from './gql';
import { renderTemplate, resolvePath, TemplateContext } from './templates';
import { AppError } from './errors';

export interface HttpResult {
  status: number;
  statusText: string;
  body: unknown;
  durationMs: number;
}

export async function callHttp(config: Record<string, unknown>, ctx: TemplateContext): Promise<HttpResult> {
  const method = String(config.method ?? 'GET').toUpperCase();
  const url = String(renderTemplate(config.url ?? '', ctx) ?? '');
  if (!url) throw new AppError(400, 'http_request step requires a url');
  if (!/^https?:\/\//.test(url)) throw new AppError(400, `Unsafe http_request url: ${url}`);

  const headersRaw = renderTemplate(config.headers ?? {}, ctx) as Record<string, string>;
  const bodyValue = config.body !== undefined && config.body !== null ? renderTemplate(config.body, ctx) : undefined;
  const timeoutMs = typeof config.timeoutMs === 'number' ? (config.timeoutMs as number) : 15000;

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(headersRaw ?? {})) {
    headers[k] = v === null || v === undefined ? '' : String(v);
  }
  if (bodyValue !== undefined && !headers['content-type']) {
    headers['content-type'] = 'application/json';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: bodyValue !== undefined ? (typeof bodyValue === 'string' ? bodyValue : JSON.stringify(bodyValue)) : undefined,
      signal: controller.signal,
    });
    if (res.status >= 500) {
      throw new AppError(500, `http_request ${method} ${url} returned HTTP ${res.status} ${res.statusText}`);
    }
    const raw = await res.text();
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    return { status: res.status, statusText: res.statusText, body, durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

export interface DbWriteContext {
  orgId: string;
  workflowId: string;
  runId: string;
  stepRunId: string;
}

/**
 * Only tables listed here may be written by a db_write step. The runner also
 * injects org/run identifiers server-side, so a step can never write to a
 * different org's rows even if its config tries to.
 */
const DB_WRITE_TABLES: Record<string, { graphql: string; allowedColumns: string[] }> = {
  step_outputs: {
    graphql: 'step_outputs',
    allowedColumns: ['label', 'payload'],
  },
};

export async function execDbWrite(config: Record<string, unknown>, ctx: DbWriteContext, renderCtx: TemplateContext): Promise<void> {
  const table = String(config.table ?? '');
  const target = DB_WRITE_TABLES[table];
  if (!target) {
    throw new AppError(400, `db_write target table "${table}" is not allowed`);
  }
  const data = (renderTemplate(config.data ?? {}, renderCtx) ?? {}) as Record<string, unknown>;
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!target.allowedColumns.includes(key)) {
      throw new AppError(400, `Column "${key}" is not allowed on table "${table}"`);
    }
    row[key] = value;
  }
  row.org_id = ctx.orgId;
  row.workflow_id = ctx.workflowId;
  row.workflow_run_id = ctx.runId;
  row.step_run_id = ctx.stepRunId;

  await gql(
    `mutation InsertOutput($objects: [${target.graphql}_insert_input!]!) {
       insert_${target.graphql}(objects: $objects) { affected_rows }
     }`,
    { objects: [row] },
  );
}

export interface NotifyContext {
  orgId: string;
  runId: string;
  stepRunId: string;
}

export async function execNotify(config: Record<string, unknown>, ctx: NotifyContext, renderCtx: TemplateContext): Promise<void> {
  const channel = String(renderTemplate(config.channel ?? 'slack', renderCtx) ?? 'slack');
  const toRaw = renderTemplate(config.to, renderCtx);
  const to = toRaw === undefined || toRaw === null || toRaw === '' ? null : String(toRaw);
  const titleRaw = renderTemplate(config.title, renderCtx);
  const title = titleRaw === undefined || titleRaw === null || titleRaw === '' ? 'Workflow alert' : String(titleRaw);
  const messageRaw = renderTemplate(config.message, renderCtx);
  const message = messageRaw === undefined || messageRaw === null || messageRaw === '' ? null : String(messageRaw);

  await gql(
    `mutation QueueNotification($objects: [notifications_insert_input!]!) {
       insert_notifications(objects: $objects) { affected_rows }
     }`,
    {
      objects: [
        {
          org_id: ctx.orgId,
          workflow_run_id: ctx.runId,
          step_run_id: ctx.stepRunId,
          channel,
          to_address: to,
          title,
          message,
          status: 'pending',
        },
      ],
    },
  );
}

export interface Condition {
  source?: string;
  operator?: string;
  value?: unknown;
}

export function evaluateCondition(actual: unknown, condition: Condition): boolean {
  const operator = condition.operator ?? 'truthy';
  const target = condition.value;
  switch (operator) {
    case 'truthy':
      return !!actual;
    case 'not_empty':
      return actual !== undefined && actual !== null && actual !== '';
    case 'eq':
      return String(actual ?? '') === String(target ?? '');
    case 'neq':
      return String(actual ?? '') !== String(target ?? '');
    case 'contains':
      return String(actual ?? '').toLowerCase().includes(String(target ?? '').toLowerCase());
    case 'starts_with':
      return String(actual ?? '').startsWith(String(target ?? ''));
    case 'ends_with':
      return String(actual ?? '').endsWith(String(target ?? ''));
    case 'gt':
      return Number(actual) > Number(target);
    case 'lt':
      return Number(actual) < Number(target);
    case 'exists':
      return actual !== undefined && actual !== null;
    default:
      return false;
  }
}

export { resolvePath };
