/**
 * Model-agnostic LLM adapter layer.
 *
 * One entry point, generateJSON(), in front of interchangeable providers:
 *   - Google Gemini        (generateContent REST API)
 *   - Groq, Together AI    (OpenAI-compatible chat completions)
 *   - any OpenAI-compatible endpoint (custom base URL, key and model)
 *   - Claude itself, with no key, when the app runs as a hosted claude.ai page
 *   - an offline demo provider (no key, scripted lesson)
 *
 * Structured output is enforced in three layers:
 *   1. the provider's own JSON/schema mode, where it has one;
 *   2. tolerant extraction of the JSON object from whatever comes back;
 *   3. the caller's validate() function, with one corrective retry.
 *
 * Providers disagree about which request fields they accept, and change
 * their minds between model generations. So each adapter keeps an ordered
 * list of request variants, from strictest to plainest, and falls through
 * to the next one on HTTP 400/422. The variant that works is remembered.
 */
import { demoRespond } from '../engine/demoLesson.js';

/** True when the app runs as a hosted claude.ai page (an artifact). */
export const isHosted = () => typeof window !== 'undefined' && typeof window.claude?.use === 'function';

export const PROVIDERS = {
  claude: {
    id: 'claude',
    label: 'Claude (built in)',
    kind: 'claude',
    blurb: 'No key. Teaches any topic on your own Claude account.',
  },
  demo: {
    id: 'demo',
    label: 'Demo lesson',
    kind: 'demo',
    blurb: 'A scripted Fourier series lesson. No key, works offline.',
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    kind: 'gemini',
    blurb: 'Free tier through Google AI Studio.',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3.8-flash',
    models: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'],
    keyUrl: 'https://aistudio.google.com/app/apikey',
    needsKey: true,
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    kind: 'openai',
    blurb: 'Fast open models on a free tier.',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-120b',
    models: ['openai/gpt-oss-120b', 'meta-models/muse-spark-open', 'qwen/qwen3.8-27b', 'llama-3.3-70b-versatile'],
    keyUrl: 'https://console.groq.com/keys',
    needsKey: true,
  },
  together: {
    id: 'together',
    label: 'Together AI',
    kind: 'openai',
    blurb: 'Open models; some are free.',
    baseUrl: 'https://api.together.ai/v1',
    model: 'Prism-ML/Ternary-Bonsai-27B',
    models: ['Prism-ML/Ternary-Bonsai-27B', 'meta-models/Muse-Spark-Open-816B-A42B', 'meta-models/Muse-Glimmer-30B'],
    needsKey: true,
  },
  custom: {
    id: 'custom',
    label: 'OpenAI-compatible endpoint',
    kind: 'openai',
    blurb: 'Any server that speaks /chat/completions.',
    baseUrl: '',
    model: '',
    models: [],
    needsKey: false,
  },
};

/** How to ask an OpenAI-compatible endpoint for JSON. "auto" tries the strictest first. */
export const JSON_MODES = ['auto', 'json_schema', 'json_object', 'off'];

/** Built-in Claude: trade speed against depth. */
export const DEPTHS = ['balanced', 'fast', 'thorough'];

/**
 * Providers that can work where the app is running. A hosted page may not
 * call other hosts, so there it is Claude or the demo; a local copy has no
 * built-in Claude, so there it is the key-based providers or the demo.
 */
export function availableProviders() {
  const hosted = isHosted();
  return Object.values(PROVIDERS).filter((p) => p.kind === 'demo' || (hosted ? p.kind === 'claude' : p.kind !== 'claude'));
}

export class LlmError extends Error {
  constructor(message, { status = 0, hint = '', retryable = false } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.hint = hint;
    this.retryable = retryable;
  }
}

const REQUEST_TIMEOUT_MS = 90_000;
const BACKOFF_MS = [1500, 4000];
const MAX_TOKENS = 4096;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const trimSlash = (url) => String(url || '').trim().replace(/\/+$/, '');

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Merge provider defaults with what the user typed in Settings. */
export function resolveConfig(settings) {
  const usable = availableProviders();
  const id = usable.some((p) => p.id === settings?.provider) ? settings.provider : isHosted() ? 'claude' : 'demo';
  const preset = PROVIDERS[id];
  const own = settings?.providers?.[id] ?? {};
  return {
    id,
    kind: preset.kind,
    label: preset.label,
    needsKey: Boolean(preset.needsKey),
    apiKey: String(own.apiKey ?? '').trim(),
    model: String(own.model || preset.model || '').trim().replace(/^models\//, ''),
    baseUrl: trimSlash(own.baseUrl || preset.baseUrl),
    jsonMode: JSON_MODES.includes(own.jsonMode) ? own.jsonMode : 'auto',
    depth: DEPTHS.includes(own.depth) ? own.depth : 'balanced',
    headers: own.headers ?? '',
    extraBody: own.extraBody ?? '',
  };
}

function assertUsable(cfg) {
  if (cfg.kind === 'demo' || cfg.kind === 'claude') return;
  if (!cfg.baseUrl) throw new LlmError('No base URL is set for this provider.', { hint: 'Open Settings and enter the endpoint URL.' });
  if (!cfg.model) throw new LlmError('No model is selected.', { hint: 'Open Settings and choose a model.' });
  if (cfg.needsKey && !cfg.apiKey) {
    throw new LlmError(`${cfg.label} needs an API key.`, { hint: 'Open Settings and paste your key.' });
  }
}

/** Parse an optional JSON-object setting such as extra headers. */
function parseObjectSetting(value, name) {
  if (!value || !String(value).trim()) return {};
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    /* fall through */
  }
  throw new LlmError(`"${name}" in Settings is not a valid JSON object.`, { hint: 'Example: {"x-my-header": "value"}' });
}

function deepMerge(target, source) {
  const out = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const both = value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object';
    out[key] = both ? deepMerge(out[key], value) : value;
  }
  return out;
}

/** Pull the first complete JSON object out of a model reply. */
export function extractJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  const textValue = String(raw ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  try {
    return JSON.parse(textValue);
  } catch {
    /* look for an embedded object */
  }
  const start = textValue.indexOf('{');
  if (start === -1) throw new Error('the reply contained no JSON object');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < textValue.length; i += 1) {
    const ch = textValue[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(textValue.slice(start, i + 1));
      } catch {
        break;
      }
    }
  }
  throw new Error('the reply was not valid JSON (it may have been cut off)');
}

async function readError(response) {
  let detail = '';
  try {
    const body = await response.text();
    try {
      const json = JSON.parse(body);
      const error = Array.isArray(json) ? json[0]?.error : json.error;
      detail = (typeof error === 'string' ? error : error?.message) || json.message || body;
    } catch {
      detail = body;
    }
  } catch {
    /* no body */
  }
  return String(detail).replace(/\s+/g, ' ').trim().slice(0, 300);
}

function httpError(status, detail, cfg) {
  const where = cfg.label;
  if (status === 401 || status === 403 || /api.?key/i.test(detail)) {
    return new LlmError(`${where} rejected the API key.`, { status, hint: detail || 'Check the key in Settings.' });
  }
  if (status === 404) {
    return new LlmError(`${where} does not know the model "${cfg.model}".`, {
      status,
      hint: detail || 'Open Settings and pick a model from "Load models".',
    });
  }
  if (status === 429) {
    return new LlmError(`${where} rate limit reached.`, { status, hint: detail || 'Wait a few seconds, then try again.', retryable: true });
  }
  if (status >= 500) {
    return new LlmError(`${where} is having trouble (HTTP ${status}).`, { status, hint: detail, retryable: true });
  }
  return new LlmError(`${where} refused the request (HTTP ${status}).`, { status, hint: detail });
}

/** fetch with a timeout, friendly network errors and backoff on 429/5xx. */
async function request(url, { method = 'POST', headers, body }, cfg) {
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
    } catch (error) {
      const timedOut = error?.name === 'AbortError';
      throw new LlmError(timedOut ? `${cfg.label} took too long to answer.` : `Could not reach ${cfg.label}.`, {
        hint: timedOut
          ? 'Try again, or pick a faster model in Settings.'
          : 'Check your connection and the base URL. If the endpoint blocks browser requests (CORS), use the dev proxy described in the README.',
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) {
      try {
        return await response.json();
      } catch {
        throw new LlmError(`${cfg.label} sent a reply that is not JSON.`, { hint: 'Check that the base URL points at the API, not a web page.' });
      }
    }

    const error = httpError(response.status, await readError(response), cfg);
    if (error.retryable && attempt < BACKOFF_MS.length) {
      const asked = Number(response.headers.get('retry-after')) * 1000;
      await wait(asked > 0 && asked <= 20_000 ? asked : BACKOFF_MS[attempt]);
      continue;
    }
    throw error;
  }
}

/** Remembers which request variant each endpoint + model accepted. */
const acceptedVariant = new Map();

/**
 * Try request variants in order, strictest first. A 400/422 usually means
 * "this endpoint does not know that field", so move on to a plainer variant.
 */
async function firstAccepted(cacheKey, variants, send) {
  const start = Math.min(acceptedVariant.get(cacheKey) ?? 0, variants.length - 1);
  let firstError;
  for (let i = start; i < variants.length; i += 1) {
    try {
      const result = await send(variants[i]);
      acceptedVariant.set(cacheKey, i);
      return result;
    } catch (error) {
      const fieldProblem = error instanceof LlmError && (error.status === 400 || error.status === 422) && !/api.?key/i.test(error.hint);
      if (!fieldProblem) throw error;
      firstError ??= error;
    }
  }
  throw firstError;
}

/* ------------------------------------------------------------------ */
/* Google Gemini                                                      */
/* ------------------------------------------------------------------ */

const gemini = {
  async complete({ cfg, system, messages, schema }) {
    const url = `${cfg.baseUrl}/models/${encodeURIComponent(cfg.model)}:generateContent`;
    const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey, ...parseObjectSetting(cfg.headers, 'Extra headers') };
    const base = {
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    };
    // No sampling parameters: Gemini 3.6+ deprecates temperature/top_p/top_k.
    const variants = [
      { ...base, generationConfig: { responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema } } } },
      { ...base, generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema } },
      { ...base, generationConfig: { responseMimeType: 'application/json' } },
      base,
    ];
    const extra = parseObjectSetting(cfg.extraBody, 'Extra request fields');
    const data = await firstAccepted(`gemini|${cfg.baseUrl}|${cfg.model}`, variants, (body) =>
      request(url, { headers, body: deepMerge(body, extra) }, cfg),
    );

    const candidate = data.candidates?.[0];
    const reply = (candidate?.content?.parts ?? [])
      .filter((part) => !part.thought && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    if (!reply) {
      const reason = data.promptFeedback?.blockReason || candidate?.finishReason || 'no content';
      throw new LlmError(`Gemini returned an empty reply (${reason}).`, { hint: 'Try again, or rephrase the topic.', retryable: true });
    }
    return reply;
  },

  async listModels(cfg) {
    const data = await request(`${cfg.baseUrl}/models?pageSize=200`, { method: 'GET', headers: { 'x-goog-api-key': cfg.apiKey } }, cfg);
    return (data.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? ['generateContent']).includes('generateContent'))
      .map((m) => String(m.name).replace(/^models\//, ''))
      .filter((name) => /gemini/i.test(name));
  },
};

/* ------------------------------------------------------------------ */
/* OpenAI-compatible chat completions (Groq, Together, custom)         */
/* ------------------------------------------------------------------ */

function responseFormats(mode, schema, schemaName) {
  const strict = { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } };
  const loose = { type: 'json_object' };
  if (mode === 'json_schema') return [strict];
  if (mode === 'json_object') return [loose];
  if (mode === 'off') return [];
  return [strict, loose];
}

const openai = {
  async complete({ cfg, system, messages, schema, schemaName }) {
    const url = `${cfg.baseUrl}/chat/completions`;
    const headers = {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      ...parseObjectSetting(cfg.headers, 'Extra headers'),
    };
    const base = { model: cfg.model, messages: [{ role: 'system', content: system }, ...messages] };
    const variants = [
      ...responseFormats(cfg.jsonMode, schema, schemaName).map((format) => ({ ...base, max_tokens: MAX_TOKENS, response_format: format })),
      { ...base, max_tokens: MAX_TOKENS },
      base, // the bare minimum every compatible server accepts
    ];
    const extra = parseObjectSetting(cfg.extraBody, 'Extra request fields');
    const data = await firstAccepted(`openai|${cfg.baseUrl}|${cfg.model}|${cfg.jsonMode}`, variants, (body) =>
      request(url, { headers, body: deepMerge(body, extra) }, cfg),
    );

    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    const reply = Array.isArray(content) ? content.map((part) => part.text ?? '').join('') : content;
    if (!reply) {
      const reason = choice?.message?.refusal || choice?.finish_reason || 'no content';
      throw new LlmError(`${cfg.label} returned an empty reply (${reason}).`, { hint: 'Try again, or pick another model in Settings.', retryable: true });
    }
    return reply;
  },

  async listModels(cfg) {
    const headers = { ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}), ...parseObjectSetting(cfg.headers, 'Extra headers') };
    const data = await request(`${cfg.baseUrl}/models`, { method: 'GET', headers }, cfg);
    const entries = Array.isArray(data) ? data : data.data ?? [];
    return entries
      .filter((m) => !m.type || ['chat', 'language', 'model'].includes(m.type))
      .map((m) => m.id)
      .filter(Boolean)
      .sort();
  },
};

/* ------------------------------------------------------------------ */
/* Built-in Claude (hosted page only)                                  */
/* ------------------------------------------------------------------ */

/**
 * Which model tier answers each kind of request. "quick" starts writing at
 * once; "default" thinks first, so it is kept for the steps where the
 * student is not left staring at a silent teacher (scripts are fetched
 * ahead of time) or where judgement matters (planning, grading).
 */
const TIERS = {
  fast: () => ({ modelTier: 'quick' }),
  balanced: (kind) =>
    ['diagnostic', 'answer', 'reply', 'ping'].includes(kind) ? { modelTier: 'quick' } : { modelTier: 'default', effort: 'low' },
  thorough: (kind) => (kind === 'ping' ? { modelTier: 'quick' } : { modelTier: 'default' }),
};

const NOT_HERE = 'Open this page on claude.ai in a desktop browser, or switch to the demo lesson in Settings.';
const CLAUDE_ERRORS = {
  not_granted: ['This page has not been allowed to use Claude.', 'Allow it when asked (or in the page\'s Permissions menu), or switch to the demo lesson in Settings.'],
  rate_limited: ['Your Claude usage limit has been reached for now.', 'Wait a little, then try again.'],
  session_expired: ['Your Claude session has expired.', 'Sign in again, then try again.'],
  refused: ['Claude declined that request.', 'Try wording the topic or the question differently.'],
  prompt_too_large: ['The lesson context grew too large for one request.', 'Start the lesson over.'],
  sampling_disabled: ['Claude is not available for this account.', NOT_HERE],
  not_declared: ['Claude is not available in this view.', NOT_HERE],
  capability_disabled: ['Claude is not available in this view.', NOT_HERE],
  capability_removed: ['Claude is not available in this view.', NOT_HERE],
};

const claude = {
  async complete({ cfg, system, messages, kind }) {
    const sample = await window.claude.use('sample').catch(() => null);
    if (!sample) throw new LlmError('Claude is not available in this view.', { hint: NOT_HERE });
    try {
      // There is no system role: standing instructions are a leading user turn.
      // cache: false, so that "Try again" really asks again.
      const reply = await sample([{ role: 'user', content: system }, ...messages], { cache: false, ...TIERS[cfg.depth](kind) });
      return reply.text;
    } catch (error) {
      const [message, hint] = CLAUDE_ERRORS[error?.code] ?? ['Claude could not answer just now.', 'Try again in a moment.'];
      throw new LlmError(message, { hint, retryable: !CLAUDE_ERRORS[error?.code] });
    }
  },
  async listModels() {
    return [];
  },
};

const ADAPTERS = { gemini, openai, claude };

/* ------------------------------------------------------------------ */
/* Public service                                                     */
/* ------------------------------------------------------------------ */

/**
 * @param {() => object} getSettings  returns the live settings object, so a
 *   provider or key changed in the Settings drawer applies to the next call.
 */
export function createLlmService(getSettings) {
  /**
   * Ask for one JSON object.
   * @param {object} args
   * @param {string} args.kind        request kind (used by the demo provider)
   * @param {string} args.system      system prompt
   * @param {string} args.user        task prompt
   * @param {object} args.schema      JSON Schema for providers that enforce one
   * @param {string} args.schemaName  name for the schema (OpenAI json_schema mode)
   * @param {(raw: object) => object} [args.validate] normalise or throw
   * @param {object} [args.context]   structured context for the demo provider
   */
  async function generateJSON({ kind, system, user, schema, schemaName = 'reply', validate = (value) => value, context }) {
    const settings = getSettings();
    const cfg = resolveConfig(settings);
    assertUsable(cfg);

    if (cfg.kind === 'demo') {
      const delay = settings?.demoDelayMs ?? 350;
      if (delay > 0) await wait(delay);
      return validate(demoRespond(kind, context));
    }

    const messages = [{ role: 'user', content: user }];
    let problem = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const raw = await ADAPTERS[cfg.kind].complete({ cfg, system, messages, schema, schemaName, kind });
      try {
        return validate(extractJson(raw));
      } catch (error) {
        problem = error?.message || 'invalid reply';
        messages.push(
          { role: 'assistant', content: String(raw).slice(0, 6000) },
          { role: 'user', content: `That reply could not be used: ${problem}. Send the complete, corrected JSON object and nothing else.` },
        );
      }
    }
    throw new LlmError('The model did not follow the lesson format.', {
      hint: `${problem}. Try again, or choose a stronger model in Settings.`,
      retryable: true,
    });
  }

  /** Model IDs the current provider offers for the current key. */
  async function listModels() {
    const cfg = resolveConfig(getSettings());
    if (cfg.kind === 'demo') return [];
    assertUsable({ ...cfg, model: cfg.model || 'any' });
    return ADAPTERS[cfg.kind].listModels(cfg);
  }

  /** One tiny round trip, to check key, model and JSON handling. */
  async function testConnection() {
    const started = Date.now();
    const cfg = resolveConfig(getSettings());
    await generateJSON({
      kind: 'ping',
      system: 'You reply with JSON only.',
      user: 'Reply with exactly this JSON object: {"ok": true}',
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      schemaName: 'ping',
      validate: (value) => {
        if (value?.ok !== true) throw new Error('expected {"ok": true}');
        return value;
      },
    });
    const model = cfg.kind === 'demo' ? 'scripted' : cfg.kind === 'claude' ? `${cfg.depth} mode` : cfg.model;
    return { label: cfg.label, model, ms: Date.now() - started };
  }

  return { generateJSON, listModels, testConnection, describe: () => resolveConfig(getSettings()) };
}
