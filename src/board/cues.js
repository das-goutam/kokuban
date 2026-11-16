/**
 * Speech-to-board timing: decide at which character of the spoken text each
 * chalkboard action starts. Speech boundary events then trigger the actions
 * as the teacher reaches those characters.
 *
 *  - An action with a "cue" (a word or phrase from the spoken text) starts
 *    when that phrase is spoken.
 *  - Actions without a usable cue are spread evenly between their neighbours,
 *    the first one starting with the first word.
 */

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Index of `cue` as a whole word or phrase in `text`, at or after `from`. -1 if absent. */
export function findCue(text, cue, from = 0) {
  const phrase = String(cue ?? '').trim();
  if (!phrase) return -1;
  try {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}])`, 'giu');
    pattern.lastIndex = from;
    const match = pattern.exec(text);
    return match ? match.index : -1;
  } catch {
    return text.toLowerCase().indexOf(phrase.toLowerCase(), from);
  }
}

/** @returns {number[]} one start index into `text` per action, non-decreasing. */
export function planCues(text, actions) {
  // Wiping the board is not a step of the explanation: a "clear" happens
  // together with whatever is drawn next.
  const drawn = actions.map((_, i) => i).filter((i) => actions[i].type !== 'clear');
  const planned = spread(text, drawn.map((i) => actions[i]));
  const cues = new Array(actions.length).fill(null);
  drawn.forEach((index, k) => {
    cues[index] = planned[k];
  });
  for (let i = actions.length - 1; i >= 0; i -= 1) {
    if (cues[i] === null) cues[i] = i + 1 < actions.length ? cues[i + 1] : (planned.at(-1) ?? 0);
  }
  return cues;
}

function spread(text, actions) {
  const n = actions.length;
  const cues = new Array(n).fill(null);

  let from = 0;
  actions.forEach((action, i) => {
    const at = findCue(text, action.cue, from);
    if (at >= 0) {
      cues[i] = at;
      from = at;
    }
  });

  const tail = text.length * 0.85; // leave time to finish drawing before the speech ends
  let i = 0;
  while (i < n) {
    if (cues[i] !== null) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < n && cues[j] === null) j += 1;
    const count = j - i;
    const lo = i === 0 ? 0 : cues[i - 1];
    const hi = j < n ? cues[j] : Math.max(lo, tail);
    for (let k = 0; k < count; k += 1) {
      // A leading gap starts on the first word; an inner gap sits strictly between its anchors.
      const fraction = i === 0 ? k / (j < n ? count : Math.max(1, count)) : (k + 1) / (count + 1);
      cues[i + k] = lo + (hi - lo) * fraction;
    }
    i = j;
  }

  let floor = 0;
  return cues.map((cue) => {
    floor = Math.max(floor, Math.round(cue));
    return floor;
  });
}
