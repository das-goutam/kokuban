/**
 * Walks the whole lesson through the state machine with the offline demo
 * provider and a fake stage (no browser, no audio, no network).
 *
 *   npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { demoRespond } from '../src/engine/demoLesson.js';
import { bktUpdate } from '../src/engine/learnerModel.js';
import { STATES, TRANSITIONS, createTutorEngine } from '../src/engine/tutorEngine.js';
import { dropStockCheckIn, normalizeScript, normalizeTurn } from '../src/engine/turnSchema.js';
import { countWords } from '../src/lib/text.js';
import { createLlmService } from '../src/services/llmService.js';

/** A stage that "speaks" instantly, or holds a turn open so a test can interrupt it. */
function fakeStage() {
  const stage = {
    performed: [],
    hold: false,
    open: null,
    restored: 0,
    perform(turn) {
      stage.performed.push(turn);
      return new Promise((resolve) => {
        stage.open = { turn, resolve };
        if (!stage.hold) stage.finish();
      });
    },
    finish() {
      const open = stage.open;
      stage.open = null;
      open?.resolve({ completed: true });
    },
    stop() {
      const open = stage.open;
      stage.open = null;
      if (!open) return { wasSpeaking: false, charIndex: 0, actionsStarted: 0 };
      open.resolve({ completed: false });
      // Pretend the teacher was cut off two thirds of the way through.
      return { wasSpeaking: true, charIndex: Math.floor(open.turn.spoken_text.length * 0.66), actionsStarted: 1 };
    },
    snapshot: () => ({ at: stage.performed.length }),
    restore: async () => {
      stage.restored += 1;
    },
    reset() {},
    describe: () => [],
  };
  return stage;
}

function setup(overrides = {}) {
  const stage = fakeStage();
  const llm = createLlmService(() => ({ provider: 'demo', demoDelayMs: 0 }));
  const engine = createTutorEngine({ llm, stage, config: { sleep: async () => {}, ...overrides } });
  return { engine, stage, view: () => engine.getView() };
}

const INTAKE = { topic: 'Fourier series', age: '20', background: 'second-year engineering, finished calculus' };
const lastSpoken = (stage) => stage.performed.at(-1).spoken_text;

/** Click "continue" through the pauses until the comprehension gate opens. */
async function listenUntilCheck(engine) {
  for (let guard = 0; guard < 20 && engine.getView().state !== STATES.CHECK; guard += 1) {
    assert.equal(engine.getView().awaiting, 'continue', 'the teacher must stop and wait between steps');
    await engine.continueLesson();
  }
  assert.equal(engine.getView().state, STATES.CHECK);
  assert.equal(engine.getView().awaiting, 'check_answer');
}

async function toRoadmap(engine, answers) {
  await engine.submitIntake(INTAKE);
  for (const answer of answers) await engine.submitDiagnosticAnswer(answer);
}

test('the five stages run in order and cannot be skipped', async () => {
  const { engine, view } = setup();
  assert.equal(view().state, STATES.INTAKE);

  // Actions that belong to later stages are ignored.
  assert.equal(await engine.startLesson(), undefined);
  assert.equal(await engine.submitCheckAnswer('zero'), undefined);
  assert.equal(engine.interrupt(), false);
  assert.equal(view().state, STATES.INTAKE);

  // The transition table itself has no shortcuts.
  assert.deepEqual(TRANSITIONS[STATES.INTAKE], [STATES.DIAGNOSTIC]);
  assert.deepEqual(TRANSITIONS[STATES.DIAGNOSTIC], [STATES.CURRICULUM]);
  assert.deepEqual(TRANSITIONS[STATES.CURRICULUM], [STATES.TEACHING]);
  assert.deepEqual(TRANSITIONS[STATES.TEACHING], [STATES.CHECK]);

  await engine.submitIntake(INTAKE);
  assert.equal(view().state, STATES.DIAGNOSTIC);
  assert.equal(view().awaiting, 'diagnostic_answer');
});

test('diagnostic asks one question at a time, three to five in total', async () => {
  const { engine, view } = setup();
  await engine.submitIntake(INTAKE);
  assert.equal(view().diagnostic.asked, 1);
  assert.ok(view().diagnostic.question.includes('sin(4πt)'));
  assert.ok(view().diagnostic.choices.includes('1/2 second'), 'each warm-up question offers answers to pick from');

  await engine.submitDiagnosticAnswer('1/2 second');
  assert.equal(view().diagnostic.asked, 2);
  assert.equal(view().state, STATES.DIAGNOSTIC);

  await engine.submitDiagnosticAnswer('3');
  assert.equal(view().diagnostic.asked, 3);

  await engine.submitDiagnosticAnswer('zero');
  assert.equal(view().state, STATES.CURRICULUM, 'after the last answer the roadmap is built');
  assert.equal(view().awaiting, 'start');
});

test('a strong student gets three modules and no prerequisite repair', async () => {
  const { engine, view } = setup();
  await toRoadmap(engine, ['half a second', 'three', '0']);
  const { profile, modules } = view();
  assert.equal(profile.missing_prerequisites.length, 0);
  assert.equal(profile.target_pacing, 'brisk');
  assert.equal(modules.length, 3);
  assert.ok(modules.every((m) => !m.is_prerequisite));
});

test('missing prerequisites become the first modules of the roadmap', async () => {
  const { engine, view } = setup();
  await toRoadmap(engine, ["I don't know", '3', 'pi']);
  const { profile, modules } = view();
  assert.equal(profile.missing_prerequisites.length, 2);
  assert.equal(profile.target_pacing, 'slow');
  assert.ok(modules.length >= 3 && modules.length <= 5);
  assert.deepEqual(modules.map((m) => m.is_prerequisite), [true, true, false, false]);
  assert.equal(modules[0].title, 'Period and frequency');
});

test('teaching pauses after each step, then gates on an applied question', async () => {
  const { engine, stage, view } = setup();
  await toRoadmap(engine, ['1/2', '3', '0']);
  await engine.startLesson();
  assert.equal(view().state, STATES.TEACHING);
  assert.equal(view().moduleIndex, 0);

  // The teacher has stopped by itself and is waiting.
  assert.equal(view().activity, 'waiting');
  assert.equal(view().awaiting, 'continue');
  const spokenBefore = stage.performed.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stage.performed.length, spokenBefore, 'nothing more is said until the student continues');

  await listenUntilCheck(engine);
  assert.ok(view().check.question.includes('sin 5t'));

  await engine.submitCheckAnswer('It is the fifth harmonic, so five cycles.');
  assert.equal(view().modules[0].status, 'passed');
  assert.equal(view().moduleIndex, 1, 'a correct answer opens the next module');
  assert.equal(view().state, STATES.TEACHING);
});

test('a wrong answer re-teaches with a different analogy and a new question before progressing', async () => {
  const { engine, stage, view } = setup();
  await toRoadmap(engine, ['1/2', '3', '0']);
  await engine.startLesson();
  await listenUntilCheck(engine);
  const firstQuestion = view().check.question;

  await engine.submitCheckAnswer('seven');
  assert.equal(view().state, STATES.TEACHING, 'back to teaching, not forward');
  assert.equal(view().moduleIndex, 0);
  assert.equal(view().modules[0].status, 'current');
  assert.ok(lastSpoken(stage).includes('recipe') || stage.performed.some((t) => t.spoken_text.includes('recipe')));
  const reteach = stage.performed.findLast((t) => t.chalkboard_actions[0]?.type === 'clear');
  assert.ok(reteach.chalkboard_actions.some((a) => a.content === 'A recipe'), 'a new drawing on a clean board');

  await listenUntilCheck(engine);
  assert.notEqual(view().check.question, firstQuestion, 'the second check is a fresh item');
  assert.equal(view().check.attempt, 2);

  await engine.submitCheckAnswer('four');
  assert.equal(view().modules[0].status, 'passed');
  assert.equal(view().modules[0].attempts, 2);
  assert.equal(view().moduleIndex, 1);
});

test('hesitation counts as not yet understood', async () => {
  const { engine, view } = setup();
  await toRoadmap(engine, ['1/2', '3', '0']);
  await engine.startLesson();
  await listenUntilCheck(engine);
  await engine.hesitate();
  assert.equal(view().state, STATES.TEACHING);
  assert.equal(view().modules[0].status, 'current');
  assert.equal(view().modules[0].attempts, 1);
});

test('an interruption halts speech, answers on the board, and resumes mid-chunk', async () => {
  const { engine, stage, view } = setup();
  await toRoadmap(engine, ['1/2', '3', '0']);
  await engine.startLesson();

  stage.hold = true; // the next chunk stays "being spoken"
  const speaking = engine.continueLesson();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(view().activity, 'speaking');
  const interrupted = stage.open.turn;

  assert.equal(engine.interrupt(), true);
  assert.equal(stage.open, null, 'audio stopped synchronously');
  assert.equal(view().activity, 'listening');
  assert.equal(view().awaiting, 'question');
  await speaking;

  stage.hold = false;
  await engine.askQuestion('Why do the other terms cancel to zero?');
  const spoken = stage.performed.map((t) => t.spoken_text);
  const answerAt = spoken.findIndex((s) => s.startsWith('Over a full period'));
  assert.ok(answerAt > 0, 'the question was answered');
  assert.equal(stage.performed[answerAt].chalkboard_actions[0].type, 'clear', 'the answer uses a fresh board');
  assert.equal(stage.restored, 1, 'the lesson board came back');

  const resumed = stage.performed[answerAt + 1];
  assert.match(resumed.spoken_text, /^(Okay, where were we\.|Right, back to it\.|So, picking that up again\.)/);
  const tail = resumed.spoken_text.replace(/^[^.]*\.\s/, '');
  assert.ok(interrupted.spoken_text.endsWith(tail), 'resumes from a sentence boundary of the interrupted chunk');
  assert.ok(tail.length < interrupted.spoken_text.length, 'does not start the chunk over');
  assert.equal(resumed.chalkboard_actions.length, interrupted.chalkboard_actions.length - 1, 'only undrawn actions remain');

  assert.equal(view().state, STATES.TEACHING);
  assert.equal(view().awaiting, 'continue', 'and the lesson carries on from there');
  assert.equal(view().interrupted, false);
});

test('at a pause the student can reply instead of just pressing go on', async () => {
  const { engine, stage, view } = setup();
  await toRoadmap(engine, ['1/2', '3', '0']);
  await engine.startLesson();
  assert.equal(view().awaiting, 'continue');
  const cursorTurn = stage.performed.at(-1).spoken_text;

  // A question keeps the lesson at the same pause after it is answered, on the same board.
  await engine.reply('Wait, what is a harmonic?');
  assert.match(lastSpoken(stage), /^A harmonic is/);
  assert.ok(stage.performed.at(-1).chalkboard_actions.every((a) => a.type !== 'clear'), 'the lesson board is kept');
  assert.equal(view().awaiting, 'continue');
  assert.equal(stage.restored, 0);

  // "Say that again" repeats the last thing said without redrawing, then waits as before.
  assert.equal(view().canRepeat, true);
  const before = stage.performed.length;
  await engine.repeat();
  assert.equal(stage.performed.length, before + 1);
  assert.match(lastSpoken(stage), /^A harmonic is/);
  assert.deepEqual(stage.performed.at(-1).chalkboard_actions, []);
  assert.equal(view().awaiting, 'continue');

  // A plain remark is acknowledged and the lesson moves to the next chunk by itself.
  await engine.reply('okay, like notes in a chord');
  const spoken = stage.performed.map((t) => t.spoken_text);
  assert.ok(spoken.some((s) => s.startsWith('Okay. The scripted demo')));
  assert.notEqual(lastSpoken(stage), cursorTurn);
  assert.match(lastSpoken(stage), /^The ingredients are not random/);
  assert.equal(view().awaiting, 'continue');
});

test('stock check-ins are dropped, real questions are kept', () => {
  assert.equal(dropStockCheckIn('So the period is two pi over omega. With me so far?'), 'So the period is two pi over omega.');
  assert.equal(dropStockCheckIn('That integral is pi. Does that make sense?'), 'That integral is pi.');
  assert.equal(dropStockCheckIn('It drains forty percent in two hours. How fast is that per hour?'), 'It drains forty percent in two hours. How fast is that per hour?');
  assert.equal(dropStockCheckIn('With me so far?'), 'With me so far?', 'a turn is never emptied');
  const turn = normalizeTurn({ spoken_text: 'How fast did it drain per hour, on average? With me so far?', pause_type: 'ask_if_following' });
  assert.equal(turn.spoken_text, 'How fast did it drain per hour, on average?', 'a real question is never followed by a check-in');
});

test('interrupting during a pause returns to the same pause', async () => {
  const { engine, stage, view } = setup();
  await toRoadmap(engine, ['1/2', '3', '0']);
  await engine.startLesson();
  await listenUntilCheck(engine);

  assert.equal(engine.interrupt(), true);
  await engine.askQuestion('What is a harmonic again?');
  assert.equal(view().state, STATES.CHECK);
  assert.equal(view().awaiting, 'check_answer', 'the pending check question is still pending');

  assert.equal(engine.interrupt(), true);
  await engine.resumeLesson(); // "never mind"
  assert.equal(view().awaiting, 'check_answer');
  assert.equal(stage.restored, 2);
});

test('the whole roadmap can be completed', async () => {
  const { engine, stage, view } = setup();
  await toRoadmap(engine, ['no idea', 'no idea', 'no idea']);
  assert.equal(view().modules.length, 4);
  await engine.startLesson();

  const answers = ['T is 1/3 and f is 3', 'five', 'zero, they cancel', 'b3 = 4/(3 pi) and b2 = 0'];
  for (const [i, answer] of answers.entries()) {
    assert.equal(view().moduleIndex, i);
    await listenUntilCheck(engine);
    await engine.submitCheckAnswer(answer);
  }
  assert.equal(view().state, STATES.COMPLETE);
  assert.ok(view().modules.every((m) => m.status === 'passed'));
  assert.match(lastSpoken(stage), /whole roadmap/);

  engine.reset();
  assert.equal(view().state, STATES.INTAKE);
  assert.equal(view().modules.length, 0);
});

test('a failed model call surfaces an error and can be retried', async () => {
  const stage = fakeStage();
  let failures = 1;
  const real = createLlmService(() => ({ provider: 'demo', demoDelayMs: 0 }));
  const llm = {
    generateJSON: async (args) => {
      if (args.kind === 'plan' && failures-- > 0) throw Object.assign(new Error('Rate limit reached.'), { hint: 'Wait a few seconds.' });
      return real.generateJSON(args);
    },
  };
  const engine = createTutorEngine({ llm, stage, config: { sleep: async () => {} } });
  await toRoadmap(engine, ['1/2', '3', '0']);
  assert.equal(engine.getView().state, STATES.DIAGNOSTIC, 'the stage does not advance on failure');
  assert.equal(engine.getView().error.message, 'Rate limit reached.');
  assert.equal(engine.getView().canRetry, true);

  await engine.retry();
  assert.equal(engine.getView().error, null);
  assert.equal(engine.getView().state, STATES.CURRICULUM);
});

test('pacing rules are enforced in code, whatever the model returns', () => {
  const chunk = (pause_type, extra = {}) => ({ spoken_text: 'One small step.', chalkboard_actions: [], pause_type, ...extra });
  const script = normalizeScript({
    turns: [
      chunk('continue'),
      chunk('continue'),
      chunk('continue'),
      chunk('comprehension_quiz', { quiz_question: 'Apply it: what happens if n doubles?' }),
      chunk('ask_if_following'),
    ],
  });
  assert.deepEqual(
    script.turns.map((t) => t.pause_type),
    ['continue', 'ask_if_following', 'continue', 'comprehension_quiz'],
    'never two chunks in a row without a pause, and nothing after the gate',
  );
  assert.equal(script.turns[0].chalkboard_actions[0].type, 'clear');
  assert.throws(() => normalizeScript({ turns: [chunk('ask_if_following')] }), /comprehension_quiz/);

  const long = normalizeTurn({ spoken_text: `${'This sentence has exactly six words. '.repeat(15)}`, pause_type: 'continue' });
  assert.ok(countWords(long.spoken_text) <= 60, 'walls of text are trimmed to whole sentences');

  const messy = normalizeTurn({
    spoken_text: 'So **x^2** is $\\pi$ times 2.',
    pause_type: 'nonsense',
    chalkboard_actions: [{ type: 'text', text: 'x^2', x: 140, y: -3 }, { type: 'fly' }, { type: 'Draw_Box', content: 'a', x: 1, y: 2, w: 0, h: 0 }],
  });
  assert.equal(messy.pause_type, 'ask_if_following', 'an unknown pause type becomes a pause');
  assert.ok(!/[*$\\^]/.test(messy.spoken_text), 'speech is free of markup');
  assert.deepEqual(messy.chalkboard_actions.map((a) => a.type), ['write_text', 'draw_box']);
  assert.deepEqual([messy.chalkboard_actions[0].x, messy.chalkboard_actions[0].y], [100, 0]);
});

test('every scripted demo chunk respects the 40-word limit', () => {
  for (const title of ['Period and frequency', 'Waves as ingredients', 'Sines that cancel', 'Finding one coefficient']) {
    const first = demoRespond('module', { module: { title } });
    const second = demoRespond('grade', { module: { title }, answer: '', hesitated: true, attempt: 1 });
    for (const turn of [...first.turns, ...second.turns]) {
      assert.ok(countWords(turn.spoken_text) <= 40, `${title}: "${turn.spoken_text}"`);
      assert.ok(turn.chalkboard_actions.length <= 5);
    }
    assert.notEqual(first.analogy, second.analogy, 'the re-teach uses a different analogy');
  }
});

test('the learner model follows the BKT update', () => {
  const up = bktUpdate(0.3, true);
  const down = bktUpdate(0.3, false);
  // P(L|c) = .3*.9 / (.3*.9 + .7*.2) = .6585..., then + (1 - .6585)*.3
  assert.ok(Math.abs(up - (0.27 / 0.41 + (1 - 0.27 / 0.41) * 0.3)) < 1e-12);
  assert.ok(up > 0.3 && down < up);
  assert.ok(down > 0 && up < 1);
});
