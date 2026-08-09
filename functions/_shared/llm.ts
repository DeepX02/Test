import { renderTemplate, TemplateContext } from './templates';

/**
 * LLM step execution.
 *
 * Real providers (all OpenAI-compatible except Gemini) are used when the
 * matching API key is configured:
 *   LLM_API_KEY_GROQ / LLM_API_KEY_OPENAI / LLM_API_KEY_OPENROUTER / LLM_API_KEY_GEMINI
 *
 * Without a key we fall back to a STUB with a disclosed artificial delay so
 * the whole system can still be demoed offline. The stub produces a
 * deterministic JSON classification (category = refund/billing/tech/other)
 * based on the prompt so conditional branches are meaningful.
 */

export interface LlmResult {
  text: string;
  parsed: Record<string, unknown> | null;
  provider: string;
  model: string;
  stub: boolean;
}

const PROVIDER_ENVS: Record<string, string> = {
  groq: 'LLM_API_KEY_GROQ',
  openai: 'LLM_API_KEY_OPENAI',
  openrouter: 'LLM_API_KEY_OPENROUTER',
  gemini: 'LLM_API_KEY_GEMINI',
};

const PROVIDER_ENDPOINTS: Record<string, string> = {
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
};

const DEFAULT_MODELS: Record<string, string> = {
  groq: 'llama-3.1-8b-instant',
  openai: 'gpt-4o-mini',
  openrouter: 'meta-llama/llama-3.1-8b-instruct:free',
  gemini: 'gemini-1.5-flash',
  stub: 'stub-model',
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function parseJsonText(text: string): Record<string, unknown> | null {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    const value = JSON.parse(cleaned);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Deterministic stub classification so the demo works without an API key. */
function stubResponse(prompt: string): string {
  const p = prompt.toLowerCase();
  const category = p.includes('refund') ? 'refund' : p.includes('bill') || p.includes('charge') ? 'billing' : p.includes('bug') || p.includes('error') ? 'tech' : 'other';
  const sentiment = p.includes('angry') || p.includes('unhappy') ? 'negative' : p.includes('thank') ? 'positive' : 'neutral';
  const summaries: Record<string, string> = {
    refund: 'Customer requested a refund for their recent order.',
    billing: 'Customer has a question about a charge on their bill.',
    tech: 'Customer reported a technical error in the product.',
    other: 'Customer inquiry received.',
  };
  return JSON.stringify({ category, sentiment, summary: summaries[category] });
}

export async function callLlm(config: Record<string, unknown>, ctx: TemplateContext): Promise<LlmResult> {
  const provider = String(config.provider ?? 'stub').toLowerCase();
  const model = String(config.model ?? DEFAULT_MODELS[provider] ?? 'stub-model');
  const system = String(renderTemplate(config.system ?? '', ctx) ?? '');
  const prompt = String(renderTemplate(config.prompt ?? '', ctx) ?? '');
  const temperature = typeof config.temperature === 'number' ? config.temperature : 0.5;

  const apiKey = process.env[PROVIDER_ENVS[provider]];

  if (!apiKey) {
    // Stub: disclosed artificial delay (nobody hides that this is a stub).
    await sleep(typeof config.stubDelayMs === 'number' ? (config.stubDelayMs as number) : 900);
    const text = stubResponse(prompt);
    return { text, parsed: parseJsonText(text), provider: 'stub', model, stub: true };
  }

  if (provider === 'gemini') {
    const text = await callGemini(apiKey, model, system, prompt, temperature);
    return { text, parsed: parseJsonText(text), provider, model, stub: false };
  }

  const endpoint = PROVIDER_ENDPOINTS[provider];
  if (!endpoint) {
    throw new Error(`Unsupported LLM provider: ${provider}`);
  }
  const messages: Array<{ role: string; content: string }> = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      ...(provider === 'openrouter' ? { 'HTTP-Referer': 'https://github.com/nhost/nhost' } : {}),
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens: 1024 }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM provider ${provider} returned ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content ?? '';
  return { text, parsed: parseJsonText(text), provider, model, stub: false };
}

async function callGemini(
  apiKey: string,
  model: string,
  system: string,
  prompt: string,
  temperature: number,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens: 1024 },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini returned ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}
