/**
 * Template rendering for step configs.
 * `{{ input.ticket }}`, `{{ last.output.text }}`, `{{ steps.0.output.parsed.category }}`
 * are resolved against a context map.
 */

export type TemplateContext = object;

export function resolvePath(ctx: TemplateContext, path: string): unknown {
  const parts = path.split('.').filter((p) => p.length > 0);
  let cur: unknown = ctx as Record<string, unknown>;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(part);
      cur = Number.isInteger(idx) ? (cur as unknown[])[idx] : undefined;
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

export function renderTemplate(input: unknown, ctx: TemplateContext): unknown {
  if (typeof input === 'string') {
    return input.replace(/\{\{\s*([\w.[\]$_-]+)\s*\}\}/g, (_m, path: string) => {
      const value = resolvePath(ctx, path);
      if (value === undefined || value === null) return '';
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    });
  }
  if (Array.isArray(input)) {
    return input.map((item) => renderTemplate(item, ctx));
  }
  if (input !== null && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      out[key] = renderTemplate(value, ctx);
    }
    return out;
  }
  return input;
}
