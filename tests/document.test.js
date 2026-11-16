/** A class built on the student's own document: sectioning, and what reaches the model. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BUDGET, excerpt, overview, prepareDocument, relevantSections } from '../src/engine/sourceDocument.js';
import { STATES, createTutorEngine } from '../src/engine/tutorEngine.js';
import { createLlmService } from '../src/services/llmService.js';

const paragraph = (topic, n) => `${topic} paragraph ${n}. `.concat(`The ${topic} controller keeps the ${topic} error small by feeding back the measured ${topic}. `.repeat(6));
const TEXT = [
  ...[1, 2, 3].map((n) => paragraph('altitude', n)),
  ...[1, 2, 3].map((n) => paragraph('airspeed', n)),
  ...[1, 2, 3].map((n) => paragraph('heading', n)),
].join('\n\n');

test('a document is cut into numbered sections that cover all of it', () => {
  const doc = prepareDocument({ name: 'report.pdf', text: `  ${TEXT}\r\n\r\n\r\n` });
  assert.ok(doc.sections.length >= 3);
  assert.ok(doc.sections.every((s) => s.length <= 1600 * 1.5 + 2));
  assert.equal(doc.sections.join('\n\n').replace(/\s+/g, ' '), TEXT.replace(/\s+/g, ' ').trim());

  const short = overview(doc, 900);
  assert.ok(short.length < 1400, 'the overview respects its budget');
  assert.ok(short.includes(`[section 1 of ${doc.sections.length}]`) && short.includes(`[section ${doc.sections.length} of ${doc.sections.length}]`));

  const found = relevantSections(doc, 'airspeed controller', 1);
  assert.match(doc.sections[found[0] - 1], /airspeed/);
  assert.equal(excerpt(doc, [99, 0, 'x'], 5000), '', 'unknown section numbers are ignored');
  assert.ok(excerpt(doc, [2, 1], 5000).startsWith('[section 1 of'));
  assert.ok(excerpt(doc, [1, 2, 3], 2000).length <= 2100);
});

test('a class on an uploaded document sends the right part of it with each request', async () => {
  const prompts = [];
  const demo = createLlmService(() => ({ provider: 'demo', demoDelayMs: 0 }));
  const llm = {
    generateJSON: async (args) => {
      prompts.push({ kind: args.kind, user: args.user });
      const reply = await demo.generateJSON(args);
      // The demo planner knows nothing of the document; pretend it tied module 1 to section 2.
      if (args.kind === 'plan') reply.curriculum[0].sections = [2];
      return reply;
    },
  };
  const stage = {
    perform: async () => ({ completed: true }),
    stop: () => ({ wasSpeaking: false, charIndex: 0, actionsStarted: 0 }),
    snapshot: () => ({}),
    restore: async () => {},
    reset() {},
    describe: () => [],
  };
  const engine = createTutorEngine({ llm, stage, config: { sleep: async () => {} } });
  await engine.submitIntake({ topic: '', age: '25', background: 'graduate student', document: { name: 'report.pdf', text: TEXT } });
  assert.equal(engine.getView().state, STATES.DIAGNOSTIC, 'with a document, the topic may be left empty');
  assert.equal(engine.getView().intake.topic, 'The main ideas of "report.pdf"');
  assert.equal(engine.getView().document.name, 'report.pdf');

  for (const answer of ['1/2', '3', '0']) await engine.submitDiagnosticAnswer(answer);
  await engine.startLesson();

  const of = (kind) => prompts.find((p) => p.kind === kind).user;
  assert.match(of('diagnostic'), /SOURCE DOCUMENT "report\.pdf" \(condensed/);
  assert.match(of('plan'), /list in "sections" the one to three section numbers/);
  const total = prepareDocument({ name: 'x', text: TEXT }).sections.length;
  assert.ok(of('plan').includes(`[section ${total} of ${total}]`), 'the planner sees every section, condensed');
  assert.ok(of('plan').indexOf('SOURCE DOCUMENT') < of('plan').indexOf('LESSON STATE'));

  const script = of('module');
  assert.match(script, /the sections this micro-module draws on/);
  assert.ok(script.includes(`[section 2 of ${total}]`) && !script.includes(`[section 1 of ${total}]`), 'only the sections the module uses');
  assert.match(script, /Teach what the source text above says/);
  assert.ok(script.length < BUDGET.lesson + 9000);

  // Without a document nothing of the kind is sent.
  prompts.length = 0;
  engine.reset();
  await engine.submitIntake({ topic: 'Fourier series', age: '25', background: 'graduate student' });
  assert.ok(!prompts[0].user.includes('SOURCE DOCUMENT'));
});
