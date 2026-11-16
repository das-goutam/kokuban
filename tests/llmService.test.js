/**
 * Checks the request each provider adapter sends, and the fallbacks, against
 * a stubbed fetch. These are shape tests: they do not call the real APIs.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { LlmError, createLlmService, extractJson } from '../src/services/llmService.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replace fetch with a queue of canned responses and record every call. */
function stubFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null, method: init.method });
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra request');
    const [status, json] = next;
    return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

const geminiReply = (text) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
const openaiReply = (content) => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const SCHEMA = { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] };
const ask = (llm, extra = {}) => llm.generateJSON({ kind: 'ping', system: 'SYS', user: 'USER', schema: SCHEMA, schemaName: 'ping', ...extra });

test('Gemini: generateContent request with a system instruction and a JSON schema', async () => {
  const calls = stubFetch([[200, geminiReply('{"ok": true}')]]);
  const llm = createLlmService(() => ({ provider: 'gemini', providers: { gemini: { apiKey: 'KEY', model: 'models/gemini-3.8-flash' } } }));
  assert.deepEqual(await ask(llm), { ok: true });

  const [call] = calls;
  assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(call.headers['x-goog-api-key'], 'KEY');
  assert.deepEqual(call.body.systemInstruction, { parts: [{ text: 'SYS' }] });
  assert.deepEqual(call.body.contents, [{ role: 'user', parts: [{ text: 'USER' }] }]);
  assert.deepEqual(call.body.generationConfig, { responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: SCHEMA } } });
  assert.ok(!('temperature' in call.body.generationConfig), 'no deprecated sampling parameters');
});

test('Gemini: falls back to plainer JSON settings when a field is rejected, and remembers', async () => {
  const calls = stubFetch([
    [400, { error: { message: 'Unknown name "responseFormat"' } }],
    [200, geminiReply('{"ok": true}')],
    [200, geminiReply('{"ok": true}')],
  ]);
  const llm = createLlmService(() => ({ provider: 'gemini', providers: { gemini: { apiKey: 'KEY', model: 'gemini-fallback-test' } } }));
  await ask(llm);
  assert.deepEqual(calls[1].body.generationConfig, { responseMimeType: 'application/json', responseJsonSchema: SCHEMA });
  await ask(llm);
  assert.equal(calls.length, 3, 'the second call goes straight to the variant that worked');
  assert.ok('responseJsonSchema' in calls[2].body.generationConfig);
});

test('Gemini: a bad API key is reported at once, with no fallback attempts', async () => {
  const calls = stubFetch([[400, { error: { message: 'API key not valid. Please pass a valid API key.' } }]]);
  const llm = createLlmService(() => ({ provider: 'gemini', providers: { gemini: { apiKey: 'BAD', model: 'gemini-key-test' } } }));
  await assert.rejects(ask(llm), (error) => error instanceof LlmError && /rejected the API key/.test(error.message));
  assert.equal(calls.length, 1);
});

test('a provider that needs a key refuses to call without one', async () => {
  const calls = stubFetch([]);
  const llm = createLlmService(() => ({ provider: 'groq', providers: { groq: { apiKey: '' } } }));
  await assert.rejects(ask(llm), /needs an API key/);
  assert.equal(calls.length, 0);
});

test('OpenAI-compatible: chat completions with bearer key, strict schema first', async () => {
  const calls = stubFetch([[200, openaiReply('{"ok": true}')]]);
  const llm = createLlmService(() => ({ provider: 'groq', providers: { groq: { apiKey: 'gsk_x' } } }));
  await ask(llm);
  const [call] = calls;
  assert.equal(call.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(call.headers.Authorization, 'Bearer gsk_x');
  assert.equal(call.body.model, 'openai/gpt-oss-120b');
  assert.deepEqual(call.body.messages, [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'USER' },
  ]);
  assert.deepEqual(call.body.response_format, { type: 'json_schema', json_schema: { name: 'ping', strict: true, schema: SCHEMA } });
  assert.ok(!('temperature' in call.body));
});

test('OpenAI-compatible: degrades json_schema → json_object → no response_format → bare request', async () => {
  const calls = stubFetch([
    [400, { error: { message: 'response_format json_schema is not supported' } }],
    [400, { error: { message: 'response_format json_object is not supported' } }],
    [422, { error: 'max_tokens is not allowed' }],
    [200, openaiReply('Sure! ```json\n{"ok": true}\n```')],
  ]);
  const llm = createLlmService(() => ({
    provider: 'custom',
    providers: { custom: { baseUrl: 'http://localhost:9999/v1/', model: 'local-model', headers: '{"x-extra": "1"}', extraBody: '{"seed": 7}' } },
  }));
  assert.deepEqual(await ask(llm), { ok: true });
  assert.equal(calls[0].url, 'http://localhost:9999/v1/chat/completions');
  assert.equal(calls[0].headers['x-extra'], '1');
  assert.ok(!('Authorization' in calls[0].headers), 'no key, no Authorization header');
  assert.deepEqual(calls.map((c) => c.body.response_format?.type ?? null), ['json_schema', 'json_object', null, null]);
  assert.deepEqual(calls.map((c) => 'max_tokens' in c.body), [true, true, true, false]);
  assert.ok(calls.every((c) => c.body.seed === 7), 'extra request fields are merged into every variant');
});

test('an unusable reply gets one corrective retry, then a clear error', async () => {
  const calls = stubFetch([
    [200, openaiReply('I think the answer is yes.')],
    [200, openaiReply('{"ok": true}')],
  ]);
  const settings = { provider: 'custom', providers: { custom: { baseUrl: 'http://localhost:9998/v1', model: 'm', jsonMode: 'off' } } };
  const llm = createLlmService(() => settings);
  assert.deepEqual(await ask(llm), { ok: true });
  assert.equal(calls[1].body.messages.length, 4, 'the bad reply and a correction request are appended');
  assert.equal(calls[1].body.messages[2].role, 'assistant');
  assert.match(calls[1].body.messages[3].content, /could not be used/);

  stubFetch([
    [200, openaiReply('{"ok": false}')],
    [200, openaiReply('{"ok": false}')],
  ]);
  const strict = (value) => {
    if (value.ok !== true) throw new Error('ok must be true');
    return value;
  };
  await assert.rejects(ask(llm, { validate: strict }), (error) => /did not follow the lesson format/.test(error.message) && /ok must be true/.test(error.hint));
});

test('model lists are read from both API styles', async () => {
  stubFetch([[200, { models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding-1', supportedGenerationMethods: ['embedContent'] }] }]]);
  const g = createLlmService(() => ({ provider: 'gemini', providers: { gemini: { apiKey: 'KEY' } } }));
  assert.deepEqual(await g.listModels(), ['gemini-3.8-flash']);

  const calls = stubFetch([[200, { data: [{ id: 'b-model' }, { id: 'a-model' }] }]]);
  const o = createLlmService(() => ({ provider: 'groq', providers: { groq: { apiKey: 'gsk_x' } } }));
  assert.deepEqual(await o.listModels(), ['a-model', 'b-model']);
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/models');
  assert.equal(calls[0].method, 'GET');
});

test('built-in Claude: only on a hosted page, system prompt as a leading user turn, tier by kind', async () => {
  const seen = [];
  let fail = null;
  const sample = async (input, options) => {
    seen.push({ input, options });
    if (fail) throw { code: fail, message: 'scripted' };
    return { text: 'Here you go: {"ok": true}', truncated: false };
  };
  assert.equal(createLlmService(() => ({ provider: 'claude' })).describe().id, 'demo', 'not offered outside a hosted page');

  globalThis.window = { claude: { use: async (name) => (name === 'sample' ? sample : null) } };
  try {
    const llm = createLlmService(() => ({ provider: 'gemini' }));
    assert.equal(llm.describe().id, 'claude', 'a hosted page cannot call other hosts, so it falls back to Claude');
    assert.deepEqual(await ask(llm, { kind: 'diagnostic' }), { ok: true });
    assert.deepEqual(seen[0].input, [
      { role: 'user', content: 'SYS' },
      { role: 'user', content: 'USER' },
    ]);
    assert.deepEqual(seen[0].options, { cache: false, modelTier: 'quick' });
    await ask(llm, { kind: 'grade' });
    assert.deepEqual(seen[1].options, { cache: false, modelTier: 'default', effort: 'low' });

    fail = 'not_granted';
    await assert.rejects(ask(llm), (error) => error instanceof LlmError && /not been allowed/.test(error.message));
    assert.equal(seen.length, 3, 'a refusal is never retried');
  } finally {
    delete globalThis.window;
  }
});

test('extractJson tolerates fences, preambles, reasoning tags and nested braces', () => {
  assert.deepEqual(extractJson('{"a": 1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('<think>hmm {not json}</think>Here you go: {"a": {"b": "}"}} Hope that helps.'), { a: { b: '}' } });
  assert.throws(() => extractJson('no object here'), /no JSON object/);
  assert.throws(() => extractJson('{"a": [1, 2'), /not valid JSON/);
});

test('the demo provider needs no network at all', async () => {
  const calls = stubFetch([]);
  const llm = createLlmService(() => ({ provider: 'demo', demoDelayMs: 0 }));
  const result = await llm.testConnection();
  assert.equal(result.model, 'scripted');
  assert.equal(calls.length, 0);
});
