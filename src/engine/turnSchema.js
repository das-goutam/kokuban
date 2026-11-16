/**
 * The structured-output contract between the language model and the app.
 *
 *  - JSON Schemas are sent to providers that can enforce them.
 *  - The normalisers below are applied to EVERY reply regardless, because
 *    not every provider enforces a schema. They coerce, clamp and repair what
 *    is safe to repair, and throw ValidationError for what is not (the LLM
 *    service then asks the model for a corrected reply).
 */
import { countWords, splitSentences } from '../lib/text.js';

export class ValidationError extends Error {}

export const ACTION_TYPES = ['clear', 'write_text', 'draw_arrow', 'draw_box', 'highlight'];
export const PAUSE_TYPES = ['continue', 'ask_if_following', 'comprehension_quiz'];
export const TEXT_SIZES = ['small', 'normal', 'large'];
export const CHALK_COLORS = ['white', 'yellow', 'blue', 'pink', 'green'];
export const VERDICTS = ['correct', 'partial', 'incorrect'];
export const PACINGS = ['slow', 'moderate', 'brisk'];

export const LIMITS = {
  spokenWords: 40, // what the prompt asks for
  spokenWordsHard: 60, // what the app tolerates before trimming
  actionsPerTurn: 5,
  scriptTurns: 7,
};

/* ------------------------------------------------------------------ */
/* JSON Schemas (kept to the subset every provider accepts: no        */
/* nullable types, no numeric or length constraints, all keys         */
/* required, additionalProperties false).                             */
/* ------------------------------------------------------------------ */

const object = (properties) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});
const string = (description) => ({ type: 'string', ...(description ? { description } : {}) });
const number = (description) => ({ type: 'number', ...(description ? { description } : {}) });
const list = (items) => ({ type: 'array', items });
const oneOf = (values) => ({ type: 'string', enum: values });

const ACTION_SCHEMA = object({
  type: oneOf(ACTION_TYPES),
  content: string('Text to write, box or arrow label, or the board text to highlight. "" for clear.'),
  x: number('0-100, left to right'),
  y: number('0-100, top to bottom'),
  x2: number('Arrow end x. 0 when not an arrow.'),
  y2: number('Arrow end y. 0 when not an arrow.'),
  w: number('Box width. 0 when not a box.'),
  h: number('Box height. 0 when not a box.'),
  size: oneOf(TEXT_SIZES),
  color: oneOf(CHALK_COLORS),
  cue: string('Word or short phrase from spoken_text at which to draw this. "" for automatic timing.'),
});

export const TURN_SCHEMA = object({
  spoken_text: string('Short, conversational, patient teacher dialogue (max 40 words).'),
  chalkboard_actions: list(ACTION_SCHEMA),
  pause_type: oneOf(PAUSE_TYPES),
  quiz_question: string('The question, if pause_type is comprehension_quiz. Otherwise "".'),
  expected_concept: string("Key idea the student's answer must demonstrate. Otherwise \"\"."),
});

export const SCRIPT_SCHEMA = object({
  analogy: string('Name of the analogy this script uses.'),
  turns: list(TURN_SCHEMA),
});

export const GRADE_SCHEMA = object({
  assessment: object({
    verdict: oneOf(VERDICTS),
    misconception: string('What is missing or wrong, in a few words. "" if correct.'),
  }),
  analogy: string('Name of the new analogy if re-teaching. "" if correct.'),
  turns: list(TURN_SCHEMA),
});

export const DIAGNOSTIC_SCHEMA = object({
  spoken_text: string(),
  question: string(),
  choices: list(string()),
  prerequisite: string(),
  enough_information: { type: 'boolean' },
});

export const PLAN_SCHEMA = object({
  student_profile: object({
    level_summary: string(),
    strengths: list(string()),
    missing_prerequisites: list(string()),
    target_pacing: oneOf(PACINGS),
    analogy_domains: list(string()),
  }),
  curriculum: list(
    object({
      title: string(),
      objective: string(),
      is_prerequisite: { type: 'boolean' },
      key_points: list(string()),
      sections: list(number('Section numbers of the source document this module draws on. [] without a document.')),
    }),
  ),
  spoken_text: string(),
});

/* ------------------------------------------------------------------ */
/* Normalisers                                                        */
/* ------------------------------------------------------------------ */

const TYPE_ALIASES = {
  text: 'write_text',
  write: 'write_text',
  writetext: 'write_text',
  label: 'write_text',
  box: 'draw_box',
  drawbox: 'draw_box',
  rect: 'draw_box',
  rectangle: 'draw_box',
  arrow: 'draw_arrow',
  drawarrow: 'draw_arrow',
  line: 'draw_arrow',
  erase: 'clear',
  wipe: 'clear',
  underline: 'highlight',
  circle: 'highlight',
  emphasize: 'highlight',
};

const text = (value, max = 600) =>
  (typeof value === 'string' ? value : value == null ? '' : String(value)).trim().slice(0, max);

const coordinate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
};

const choice = (value, allowed, fallback) => {
  const key = String(value ?? '').toLowerCase().trim();
  return allowed.includes(key) ? key : fallback;
};

const strings = (value, max = 6) =>
  (Array.isArray(value) ? value : value ? [value] : []).map((v) => text(v, 160)).filter(Boolean).slice(0, max);

const SPOKEN_SYMBOLS = [
  [/π/g, ' pi '],
  [/∫/g, ' the integral of '],
  [/[Σ∑]/g, ' the sum of '],
  [/√/g, ' the square root of '],
  [/≈/g, ' is about '],
  [/≤/g, ' is at most '],
  [/≥/g, ' is at least '],
  [/≠/g, ' is not equal to '],
  [/[×·]/g, ' times '],
  [/∞/g, ' infinity '],
  [/ω/g, ' omega '],
  [/θ/g, ' theta '],
  [/→/g, ' gives '],
  [/²/g, ' squared'],
  [/³/g, ' cubed'],
];

/** Make text safe to hand to a speech synthesiser: no Markdown, LaTeX or bare symbols. */
export function cleanSpeech(value) {
  let s = text(value, 1200)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(\d)\s*\*\s*(\w)/g, '$1 times $2')
    .replace(/\\[()[\]]/g, ' ')
    .replace(/\\([a-zA-Z]+)/g, ' $1 ')
    .replace(/\^/g, ' to the power ')
    .replace(/[*`#$_{}]+/g, ' ');
  for (const [symbol, words] of SPOKEN_SYMBOLS) s = s.replace(symbol, words);
  return s
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .trim();
}

/** Keep whole sentences up to `maxWords`; never cut mid-sentence unless the first one is too long. */
export function trimToWords(value, maxWords) {
  if (countWords(value) <= maxWords) return value;
  let kept = '';
  for (const sentence of splitSentences(value)) {
    if (countWords(kept + sentence.text) > maxWords) break;
    kept += sentence.text;
  }
  if (kept.trim()) return kept.trim();
  return `${value.split(/\s+/).slice(0, maxWords).join(' ')}…`;
}

export function normalizeAction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = String(raw.type ?? raw.action ?? '').toLowerCase().replace(/[^a-z_]/g, '');
  const type = ACTION_TYPES.includes(key) ? key : TYPE_ALIASES[key.replace(/_/g, '')];
  if (!type) return null;
  if (type === 'clear') return { type };

  const action = {
    type,
    content: text(raw.content ?? raw.text ?? raw.label, 160),
    x: coordinate(raw.x),
    y: coordinate(raw.y),
    color: choice(raw.color, CHALK_COLORS, type === 'highlight' ? 'yellow' : 'white'),
  };
  if (type === 'write_text') {
    if (!action.content) return null;
    action.size = choice(raw.size, TEXT_SIZES, 'normal');
  }
  if (type === 'draw_box') {
    action.w = coordinate(raw.w ?? raw.width) || null;
    action.h = coordinate(raw.h ?? raw.height) || null;
  }
  if (type === 'draw_arrow') {
    const x2 = coordinate(raw.x2 ?? raw.to_x);
    const y2 = coordinate(raw.y2 ?? raw.to_y);
    const given = (x2 || y2) && x2 !== null && y2 !== null;
    action.x2 = given ? x2 : null;
    action.y2 = given ? y2 : null;
  }
  if (type === 'highlight' && !action.content && action.x === null) return null;
  const cue = text(raw.cue, 60);
  if (cue) action.cue = cue;
  return action;
}

/**
 * "With me so far?" after every step is what makes a tutor sound scripted.
 * The interface already shows that it is the student's turn, so a turn that
 * ends on a stock check-in loses it. A real question is left alone.
 */
const STOCK_CHECK_IN =
  /^(?:so,?\s+|and\s+)?(?:are you |you |still )*(?:with me|following(?: along)?|(?:does|did) (?:that|this|it) (?:all )?(?:sit right|make sense|sound right|track|click)|(?:that )?makes? sense|sounds? good|okay|ok|all good|all clear|clear|got it|good)(?: so far| to you| now)?\s*\?$/i;

export function dropStockCheckIn(spoken) {
  const sentences = splitSentences(spoken);
  if (sentences.length < 2) return spoken;
  const last = sentences[sentences.length - 1];
  return STOCK_CHECK_IN.test(last.text.trim()) ? spoken.slice(0, last.start).trim() : spoken;
}

function lastQuestionIn(value) {
  const questions = splitSentences(value).filter((s) => s.text.includes('?'));
  return questions.length ? questions[questions.length - 1].text.trim() : '';
}

/** One teaching turn in the mandated schema. */
export function normalizeTurn(raw, index = 0) {
  if (!raw || typeof raw !== 'object') throw new ValidationError(`turn ${index + 1} is not an object`);
  const pause = choice(raw.pause_type, PAUSE_TYPES, 'ask_if_following');
  const isQuiz = pause === 'comprehension_quiz';

  const cleaned = trimToWords(cleanSpeech(raw.spoken_text ?? raw.speech), isQuiz ? 90 : LIMITS.spokenWordsHard);
  const spoken = isQuiz ? cleaned : dropStockCheckIn(cleaned);
  if (!spoken) throw new ValidationError(`turn ${index + 1} has an empty spoken_text`);

  const quiz = isQuiz ? text(raw.quiz_question, 400) || lastQuestionIn(spoken) : '';
  if (isQuiz && !quiz) {
    throw new ValidationError('the comprehension_quiz turn has no quiz_question');
  }

  const actions = (Array.isArray(raw.chalkboard_actions) ? raw.chalkboard_actions : [])
    .map(normalizeAction)
    .filter(Boolean)
    .slice(0, LIMITS.actionsPerTurn);

  return {
    spoken_text: spoken,
    chalkboard_actions: actions,
    pause_type: pause,
    quiz_question: quiz,
    expected_concept: isQuiz ? text(raw.expected_concept, 500) : '',
  };
}

/**
 * A lesson script: micro-chunks that end at the comprehension gate.
 * Enforces the pacing rules in code so they hold whatever the model returns:
 *  - the script stops at the first quiz turn, and must contain one;
 *  - never two "continue" turns in a row (a mandatory pause after each step);
 *  - the script opens on a clean board.
 */
export function normalizeScript(raw) {
  const rawTurns = Array.isArray(raw) ? raw : raw?.turns;
  if (!Array.isArray(rawTurns) || !rawTurns.length) throw new ValidationError('"turns" must be a non-empty array');

  let turns = rawTurns.map(normalizeTurn);
  const quizAt = turns.findIndex((t) => t.pause_type === 'comprehension_quiz');
  if (quizAt === -1) {
    throw new ValidationError('the last turn must have pause_type "comprehension_quiz" and a quiz_question');
  }
  if (quizAt === 0) {
    throw new ValidationError('explain the idea in at least one turn before the comprehension_quiz turn');
  }
  turns = turns.slice(0, quizAt + 1);
  if (turns.length > LIMITS.scriptTurns) {
    turns = [...turns.slice(0, LIMITS.scriptTurns - 1), turns[turns.length - 1]];
  }

  let flowing = 0;
  for (const turn of turns) {
    if (turn.pause_type !== 'continue') flowing = 0;
    else if (++flowing >= 2) {
      turn.pause_type = 'ask_if_following';
      flowing = 0;
    }
  }

  if (turns[0].chalkboard_actions[0]?.type !== 'clear') {
    turns[0].chalkboard_actions = [{ type: 'clear' }, ...turns[0].chalkboard_actions];
  }
  return { analogy: text(raw?.analogy, 80), turns };
}

/** The reply to an interruption: exactly one turn, never a quiz, on a fresh board. */
export function normalizeAnswer(raw) {
  const turn = normalizeTurn(raw?.turns?.[0] ?? raw?.turn ?? raw);
  const actions = turn.chalkboard_actions.filter((a, i) => a.type !== 'clear' || i === 0);
  return {
    ...turn,
    chalkboard_actions: actions[0]?.type === 'clear' ? actions : [{ type: 'clear' }, ...actions],
    pause_type: 'continue',
    quiz_question: '',
    expected_concept: '',
  };
}

/** The reply to something the student said at a pause: one turn, added to the board as it is. */
export function normalizeReply(raw) {
  const turn = normalizeTurn(raw?.turns?.[0] ?? raw?.turn ?? raw);
  return {
    ...turn,
    chalkboard_actions: turn.chalkboard_actions.filter((a) => a.type !== 'clear').slice(0, 3),
    pause_type: turn.pause_type === 'continue' ? 'continue' : 'ask_if_following',
    quiz_question: '',
    expected_concept: '',
  };
}

/** Grading result plus what the teacher does next (praise, or a re-teach script). */
export function normalizeGrade(raw, { hesitated = false } = {}) {
  const verdict = hesitated ? 'incorrect' : choice(raw?.assessment?.verdict ?? raw?.verdict, VERDICTS, null);
  if (!verdict) throw new ValidationError('assessment.verdict must be "correct", "partial" or "incorrect"');
  const assessment = {
    verdict,
    misconception: hesitated ? 'hesitated' : text(raw?.assessment?.misconception ?? raw?.misconception, 200),
  };

  if (verdict === 'correct') {
    let praise;
    try {
      praise = normalizeTurn(raw?.turns?.[0]);
    } catch {
      praise = { spoken_text: 'Exactly right. Nicely reasoned.', chalkboard_actions: [] };
    }
    return {
      assessment,
      analogy: '',
      turns: [{ ...praise, pause_type: 'continue', quiz_question: '', expected_concept: '' }],
    };
  }
  const script = normalizeScript(raw);
  return { assessment, analogy: script.analogy, turns: script.turns };
}

export function normalizeDiagnostic(raw, { mustAsk = true } = {}) {
  const enough = raw?.enough_information === true && !mustAsk;
  const question = text(raw?.question, 220);
  if (!enough && !question) throw new ValidationError('"question" is empty');
  const spoken = trimToWords(cleanSpeech(raw?.spoken_text || question), LIMITS.spokenWordsHard);
  const choices = [...new Set(strings(raw?.choices, 5).map((c) => c.slice(0, 80)))];
  return {
    enough_information: enough,
    question,
    choices: choices.length >= 2 ? choices : [],
    prerequisite: text(raw?.prerequisite, 80),
    spoken_text: spoken,
  };
}

export function normalizePlan(raw, { minModules = 3, maxModules = 5 } = {}) {
  const profile = raw?.student_profile ?? {};
  const modules = (Array.isArray(raw?.curriculum) ? raw.curriculum : raw?.curriculum?.modules ?? [])
    .map((m) => ({
      title: text(m?.title, 60),
      objective: text(m?.objective, 240),
      is_prerequisite: m?.is_prerequisite === true,
      key_points: strings(m?.key_points, 4),
      sections: (Array.isArray(m?.sections) ? m.sections : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 6),
    }))
    .filter((m) => m.title);
  if (modules.length < minModules) {
    throw new ValidationError(`"curriculum" needs ${minModules} to ${maxModules} micro-modules, got ${modules.length}`);
  }
  // Missing prerequisites are taught first, whatever order the model listed them in.
  const ordered = [...modules.filter((m) => m.is_prerequisite), ...modules.filter((m) => !m.is_prerequisite)];
  return {
    student_profile: {
      level_summary: text(profile.level_summary, 300),
      strengths: strings(profile.strengths),
      missing_prerequisites: strings(profile.missing_prerequisites),
      target_pacing: choice(profile.target_pacing, PACINGS, 'moderate'),
      analogy_domains: strings(profile.analogy_domains, 4),
    },
    curriculum: ordered.slice(0, maxModules),
    spoken_text: trimToWords(cleanSpeech(raw?.spoken_text) || "I know where to start now. Here's the plan.", 60),
  };
}
