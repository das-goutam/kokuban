/** Pure parts of the chalkboard: speech-to-board cue planning and maths text runs. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseRuns, plainText, tidyMath } from '../src/board/chalkText.js';
import { findCue, planCues } from '../src/board/cues.js';

const SPOKEN = 'But multiply a sine wave by itself, and every piece is positive. That integral comes out as pi. With me so far?';

test('a cue matches whole words only', () => {
  assert.equal(findCue(SPOKEN, 'pi'), SPOKEN.indexOf(' pi.') + 1, '"pi" must not match inside "piece"');
  assert.equal(findCue(SPOKEN, 'ITSELF'), SPOKEN.indexOf('itself'));
  assert.equal(findCue(SPOKEN, 'absent'), -1);
});

test('actions start at their cue; the rest are spread between their neighbours', () => {
  const write = (cue) => ({ type: 'write_text', ...(cue ? { cue } : {}) });
  assert.deepEqual(planCues(SPOKEN, [write('itself'), write('pi')]), [SPOKEN.indexOf('itself'), SPOKEN.indexOf(' pi.') + 1]);

  const even = planCues(SPOKEN, [write(), write(), write()]);
  assert.equal(even[0], 0, 'the first action starts with the first word');
  assert.ok(even[0] < even[1] && even[1] < even[2] && even[2] < SPOKEN.length);

  const mixed = planCues(SPOKEN, [write(), write('integral'), write()]);
  assert.equal(mixed[1], SPOKEN.indexOf('integral'));
  assert.ok(mixed[0] === 0 && mixed[2] > mixed[1]);
});

test('wiping the board happens together with the next thing drawn', () => {
  const cues = planCues(SPOKEN, [{ type: 'clear' }, { type: 'write_text' }, { type: 'write_text', cue: 'integral' }]);
  assert.deepEqual(cues, [0, 0, SPOKEN.indexOf('integral')]);
  assert.deepEqual(planCues(SPOKEN, []), []);
});

test('board text understands exponents, subscripts and stray LaTeX', () => {
  const runs = (text) => parseRuns(tidyMath(text)).map((run) => [run.text, run.script]);
  assert.deepEqual(runs('b_3 = 4/(3π)'), [['b', 0], ['3', -1], [' = 4/(3π)', 0]]);
  assert.deepEqual(runs('e^{iπt} + x²'), [['e', 0], ['iπt', 1], [' + x', 0], ['2', 1]]);
  assert.deepEqual(runs('∫_{-π}^{π} f(t) dt'), [['∫', 0], ['-π', -1], ['π', 1], [' f(t) dt', 0]]);
  assert.deepEqual(runs('\\frac{1}{\\pi} \\int f'), [['(1)/(π) ∫ f', 0]]);
  assert.equal(plainText('$b_n$ = **4**/(nπ)'), 'bn = 4/(nπ)');
  assert.deepEqual(runs('a ^ b'), [['a ^ b', 0]], 'a caret with spaces around it is left alone');
});
