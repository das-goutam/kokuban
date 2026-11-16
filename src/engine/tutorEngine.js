/**
 * Pedagogy engine: the strict five-stage state machine and the system prompts.
 *
 *   STATE_INTAKE → STATE_DIAGNOSTIC → STATE_CURRICULUM → STATE_TEACHING ⇄ STATE_CHECK → (complete)
 *
 * The engine decides WHAT happens next. The language model only decides how
 * to say it and what to draw; the stage (voice + chalkboard) delivers it.
 * Nothing in here touches the DOM, so the whole lesson flow runs under Node
 * in tests/engine.test.js with a fake stage.
 *
 * Collaborators (injected):
 *   llm.generateJSON({ kind, system, user, schema, schemaName, validate, context }) → Promise<object>
 *   stage.perform(turn, { rate }) → Promise<{ completed }>   speak + draw one turn
 *   stage.stop() → { wasSpeaking, charIndex, actionsStarted } halt audio now
 *   stage.snapshot() / stage.restore(snapshot) / stage.reset() / stage.describe()
 */
import { sentenceStartBefore } from '../lib/text.js';
import { bktUpdate, initialMastery } from './learnerModel.js';
import { BUDGET, excerpt, overview, prepareDocument, relevantSections } from './sourceDocument.js';
import {
  DIAGNOSTIC_SCHEMA,
  GRADE_SCHEMA,
  PLAN_SCHEMA,
  SCRIPT_SCHEMA,
  TURN_SCHEMA,
  normalizeAnswer,
  normalizeDiagnostic,
  normalizeGrade,
  normalizePlan,
  normalizeReply,
  normalizeScript,
} from './turnSchema.js';

export const STATES = Object.freeze({
  INTAKE: 'STATE_INTAKE',
  DIAGNOSTIC: 'STATE_DIAGNOSTIC',
  CURRICULUM: 'STATE_CURRICULUM',
  TEACHING: 'STATE_TEACHING',
  CHECK: 'STATE_CHECK',
  COMPLETE: 'STATE_COMPLETE',
});

/** The five stages, in the only order they can be entered. */
export const STAGES = [STATES.INTAKE, STATES.DIAGNOSTIC, STATES.CURRICULUM, STATES.TEACHING, STATES.CHECK];

/** Legal transitions. Anything else throws, so a stage can never be skipped. */
export const TRANSITIONS = Object.freeze({
  [STATES.INTAKE]: [STATES.DIAGNOSTIC],
  [STATES.DIAGNOSTIC]: [STATES.CURRICULUM],
  [STATES.CURRICULUM]: [STATES.TEACHING],
  [STATES.TEACHING]: [STATES.CHECK],
  [STATES.CHECK]: [STATES.TEACHING, STATES.COMPLETE], // re-teach or next module, or done
  [STATES.COMPLETE]: [],
});

const DEFAULTS = {
  minDiagnostic: 3,
  maxDiagnostic: 5,
  minModules: 3,
  maxModules: 5,
  beatMs: 450, // breath between two chunks that flow into each other
  timeScale: 1,
};

/** Speech-rate multiplier for the pacing the diagnostic chose. */
const PACE_RATE = { slow: 0.9, moderate: 1, brisk: 1.08 };

const BRIDGES = ['Okay, where were we.', 'Right, back to it.', 'So, picking that up again.'];

/* ================================================================== */
/* System prompts                                                     */
/* ================================================================== */

export const SYSTEM_PROMPT = `You are a patient, warm human tutor teaching ONE student, live, at a chalkboard. You talk out loud and you draw while you talk. You are not a chatbot and you never produce walls of text.

HOW YOU SPEAK ("spoken_text")
- At most 40 words: two or three short, conversational sentences. One idea per turn.
- It is read aloud by a speech synthesiser, so write it the way it should be heard: no Markdown, no LaTeX, no symbols. Say maths in words ("e to the i pi", "the integral from zero to pi of sine t").
- Pitch vocabulary, examples and analogies at the student's age and background. Encourage; never talk down, never blame.
- Sound like a person thinking aloud next to the student, not a script. Use contractions and plain words, vary how sentences start, and get to the point. No stock phrases ("Great question", "Let's dive in", "No worries", "With me so far?", "Does that make sense?", "Let's try a fresh angle"), no announcing what you are about to do, no praise by reflex. When the student has said something, respond to what they actually said.
- A question to the student always ends the turn, and there is only one. Never ask something and then keep talking, and never follow a real question with a check-in.

HOW YOU USE THE BOARD ("chalkboard_actions")
- The board carries the notation: say it in words, write it in symbols. Never copy whole sentences of spoken_text onto the board.
- The board is a 100 by 100 grid. x runs from 0 (left) to 100 (right), y from 0 (top) to 100 (bottom). Keep everything inside x 4..96 and y 6..92.
- Actions are drawn one after another, in the order given, while you speak:
  {"type":"clear"} wipes the board.
  {"type":"write_text","content":TEXT,"x":X,"y":Y,"size":"small|normal|large","color":"white|yellow|blue|pink|green"} writes TEXT with its top-left corner at (X,Y). One character is about 1.8 units wide at normal size (2.5 large, 1.35 small), so check that x + width stays under 96. Consecutive lines need at least 11 units between their y values (15 large, 8 small).
  {"type":"draw_box","content":LABEL,"x":X,"y":Y,"w":W,"h":H} draws a box with top-left corner (X,Y), width W and height H, and LABEL centred inside. LABEL may be "".
  {"type":"draw_arrow","content":LABEL,"x":X,"y":Y,"x2":X2,"y2":Y2} draws an arrow from (X,Y) to (X2,Y2) with an optional short LABEL beside it.
  {"type":"highlight","content":TEXT} circles the item already on the board whose text contains TEXT.
- Optional "cue" on any action: a word or short phrase copied exactly from spoken_text. The action is drawn at the moment you say it.
- Board text is plain text, not LaTeX or Markdown. Unicode maths symbols are fine (π ∫ Σ √ ≈ ≤ ω θ). Use ^ and _ for exponents and subscripts, with braces around more than one character: x^2, b_3, e^{iπt}.
- Colour carries meaning: white for normal writing, yellow for the key term or result, blue or green for secondary labels, pink for the question being asked or a common mistake.
- Build the board up step by step across turns. Do not redraw what is already there and do not overlap items. Use "clear" before a new sub-topic or once about nine items are on the board.
- Fields that do not apply to an action may be omitted, or set to 0 or "".

OUTPUT
Reply with exactly one JSON object in the format the task asks for. Nothing before or after it, no code fences.`;

const TURN_FORMAT = `{"spoken_text": string, "chalkboard_actions": [ACTION, ...], "pause_type": "continue" | "ask_if_following" | "comprehension_quiz", "quiz_question": string, "expected_concept": string}`;

const PACING_RULES = `- After every completed step, stop and wait for the student: pause_type "ask_if_following". Just stop talking. The student sees that it is their turn and can answer, ask something, or tell you to go on, so do not end with "With me so far?" or any other check-in. In at most one turn of a script you may instead end on a short, real question about that step which the student can answer in a few words; it must be the last sentence of the turn.
- pause_type "continue" is only for a single step that needs two turns. Never use it twice in a row.
- The LAST turn is the comprehension gate: pause_type "comprehension_quiz". Ask ONE applied question that makes the student use the idea on a case you have not shown. Never "do you understand?", never a yes-or-no question, never something that can be read straight off the board. Say the question in spoken_text, write it in quiz_question (board text rules apply), and put what a correct answer must contain (the key idea and the answer itself) in expected_concept. Its chalkboard_actions may add a small prompt for the question in pink but must not show the answer.
- In every turn except the last, quiz_question and expected_concept are "".`;

/** `source` is text from the student's own document, when the class is built on one. */
const state = (lesson, source) =>
  `${source ? `SOURCE DOCUMENT ${JSON.stringify(source.name)} (${source.what})\n<<<\n${source.text}\n>>>\n\n` : ''}LESSON STATE\n${JSON.stringify(lesson, null, 1)}`;

const FROM_SOURCE = `- This class is built on the student's own document. Teach what the source text above says, with its terms, notation and examples, and do not contradict it. Explain it; do not read it out. If the excerpt does not cover something you need, say so plainly instead of inventing details about the document.`;

function diagnosticPrompt({ lesson, source, number, max, mayStop }) {
  return `STAGE: DIAGNOSTIC. Ask the student ONE warm-up question that shows whether they have a prerequisite the topic needs.

Rules${source ? '\n- The class will be taught from the source document below. Probe the background a reader needs in order to follow it, not whether they have already read it.' : ''}
- This is question ${number} of at most ${max}. Probe a different prerequisite from the earlier questions. If the last answer was wrong or "I don't know", go more basic; if it was right, go one step harder.
- The question must be answerable in one sentence or a short calculation. One question only, never several parts.
- Do not teach, hint, or say whether earlier answers were right. A neutral "Okay, thanks." is fine.
- spoken_text (at most 40 words) asks the question in spoken words. "question" is the same question as it should be written on the board (board text rules apply, at most 110 characters).
- "choices": 3 or 4 short answers the student can pick from, written as board text. Exactly one is correct; each of the others is a mistake a real student makes. Shuffle the position of the correct one. Do not include "I don't know".
- ${
    mayStop
      ? 'If the answers so far already make the student\'s level clear, set "enough_information" to true and leave the other fields as "".'
      : 'Set "enough_information" to false.'
  }

FORMAT
{"spoken_text": string, "question": string, "choices": [string], "prerequisite": string (the prerequisite this probes), "enough_information": boolean}

${state(lesson, source)}`;
}

function planPrompt({ lesson, source, min, max }) {
  return `STAGE: CURRICULUM. The warm-up is over. Analyse the answers silently and plan the lesson.

Rules
- student_profile: level_summary (one sentence), strengths (prerequisites the answers show the student has), missing_prerequisites (those they got wrong or did not know), target_pacing ("slow", "moderate" or "brisk"), analogy_domains (two to four everyday areas this student will find familiar given their age and background; analogies will be drawn from them).
- curriculum: ${min} to ${max} micro-modules that end with the student understanding the core of the topic at a depth that fits their age and background. Each micro-module teaches exactly ONE idea in two to four minutes.
- Every missing prerequisite gets its own micro-module at the START of the roadmap, in dependency order, with "is_prerequisite": true. Spend no module on a prerequisite the student already has.
- title: at most 6 words. objective: one sentence starting "You can". key_points: two or three short facts the module must get across.${
    source
      ? `\n- The roadmap teaches the source document below (shown condensed, every section numbered): its main ideas, in an order that builds, with the student's stated focus first. For each micro-module list in "sections" the one to three section numbers it draws on. A prerequisite module that the document does not cover has "sections": [].`
      : '\n- "sections" is [].'
  }
- spoken_text (at most 40 words): tell the student warmly where you will start and why. Do not grade them and do not read out the roadmap.

FORMAT
{"student_profile": {"level_summary": string, "strengths": [string], "missing_prerequisites": [string], "target_pacing": "slow" | "moderate" | "brisk", "analogy_domains": [string]}, "curriculum": [{"title": string, "objective": string, "is_prerequisite": boolean, "key_points": [string], "sections": [number]}], "spoken_text": string}

${state(lesson, source)}`;
}

function modulePrompt({ lesson, source, module, number, total }) {
  return `STAGE: TEACHING. Write the script for micro-module ${number} of ${total}: "${module.title}".
Objective: ${module.objective}
Key points: ${module.key_points.join('; ') || '(your choice)'}

A script is a list of 4 to 6 turns. Each turn is one micro-chunk: a spoken_text of at most 40 words plus 1 to 4 chalkboard_actions drawn while you say it.

Rules
- Turn 1 starts with a "clear" action and then writes a short yellow title for this micro-module near the top of the board.
- Explain ONE step per turn and build the board up as you go, so that by the last turn it is a tidy summary of the module.
${source ? `${FROM_SOURCE}\n` : ''}- Anchor the central idea in one analogy from the student's world (see analogy_domains) and name it in "analogy".${
    lesson.analogies_already_used?.length ? ' Do not reuse an analogy from an earlier module.' : ''
  }
${PACING_RULES}
- Pacing for this student is "${lesson.student_profile?.target_pacing ?? 'moderate'}": for "slow" use smaller steps and simpler words; for "brisk" you may cover a little more per step.

FORMAT
{"analogy": string, "turns": [TURN, ...]} where TURN is ${TURN_FORMAT}

${state(lesson, source)}`;
}

function gradePrompt({ lesson, source, module, check, answer, hesitated, attempt, analogies }) {
  const outcome = hesitated
    ? `The student did not answer: they hesitated for a while or said they were not sure.

Step 1. Set assessment.verdict to "incorrect" and assessment.misconception to "hesitated".

Step 2. Write "turns" for the NOT YET case below. Do not remark on the silence; start straight in from a simpler angle.`
    : `Student's answer: ${JSON.stringify(answer)}

Step 1. Judge the answer in "assessment". verdict is "correct" if the answer shows the expected idea, even when it is informal, brief, or phrased differently; "partial" if it is on the right track but misses an essential part; "incorrect" otherwise. Be fair, not pedantic. In "misconception" name what is missing or wrong in a few words ("" if correct).

Step 2. Write "turns".
- CORRECT: exactly ONE turn. Specific praise that names what the student got right, at most 30 words, pause_type "continue", zero to two chalkboard_actions (a highlight, for example). quiz_question and expected_concept are "". "analogy" is "".`;

  return `STAGE: CHECK. The comprehension question for micro-module "${module.title}" has been asked.
Question: ${check.question}
A correct answer must show: ${check.expected || '(the objective of the module)'}
This was attempt ${attempt}. Analogies already used for this module: ${analogies.join(', ') || 'none recorded'}.

${outcome}
- NOT YET (partial or incorrect): do not give away the answer to that question. Re-teach the idea in 3 or 4 turns with a DIFFERENT analogy from the ones already used and a NEW drawing. Turn 1 starts with "clear" and comes at the idea from the new angle, with at most one plain sentence about what was missing and no soothing phrases. Name the new analogy in "analogy".${
    attempt >= 3 ? ' Include one fully worked example before the question.' : ''
  }
Rules for the re-teach script
${PACING_RULES.replace(
  'Ask ONE applied question',
  `Ask ONE NEW applied question, on the same idea but a different case${attempt >= 2 ? ' and easier than the last one' : ''},`,
)}

FORMAT
{"assessment": {"verdict": "correct" | "partial" | "incorrect", "misconception": string}, "analogy": string, "turns": [TURN, ...]} where TURN is ${TURN_FORMAT}

${state(lesson, source)}`;
}

function answerPrompt({ lesson, source, question, situation }) {
  return `The student has interrupted you with a question.
${situation}
Student's question: ${JSON.stringify(question)}

Answer it now in ONE turn on a fresh board. The lesson board has been saved and comes back by itself afterwards.

Rules
- spoken_text: at most 45 words that answer exactly what was asked, at the student's level.
- chalkboard_actions: start with "clear", then 1 to 3 actions that support the answer.
- If the question is about something a later micro-module covers, give a one-sentence preview and say which part of the roadmap covers it. If it has nothing to do with the lesson, say so kindly in one sentence and offer to come back to it afterwards.
- If a comprehension question is pending, clarify what it is asking but do not reveal or hint at its answer.
- Do not continue the lesson and do not add a "back to the lesson" phrase; that happens automatically.
- pause_type is "continue". quiz_question and expected_concept are "".${source ? `\n${FROM_SOURCE}` : ''}

FORMAT
${TURN_FORMAT}

${state(lesson, source)}`;
}

function replyPrompt({ lesson, source, said, reply }) {
  return `The student said something at a pause in the lesson.
You had just said: ${JSON.stringify(said)}
Student: ${JSON.stringify(reply)}

Respond in ONE turn, the way a person would.

Rules
- spoken_text: at most 40 words.
- If they answered a question you asked, say plainly whether it is right, and why, in a sentence. This is not the comprehension gate, so you may give the answer.
- If they asked something, answer it. If they sound unsure, explain that one step again more simply, with a different example.
- chalkboard_actions: 0 to 2 additions to the board as it is now (see lesson_board_right_now). Do not use "clear".
- pause_type "continue" if the lesson can simply move on now. "ask_if_following" if you have asked them something, or they need a moment with what you just said.
- Do not start the next step of the lesson yourself. quiz_question and expected_concept are "".${source ? `\n${FROM_SOURCE}` : ''}

FORMAT
${TURN_FORMAT}

${state(lesson, source)}`;
}

/* ================================================================== */
/* Turns the engine writes itself (no model call, no latency)          */
/* ================================================================== */

const write = (content, x, y, extra = {}) => ({ type: 'write_text', content, x, y, size: 'normal', color: 'white', ...extra });

const greetingTurn = () => ({
  spoken_text: "Before we start, a few quick questions so I know where to begin. Guessing is fine, and so is saying you don't know.",
  chalkboard_actions: [
    { type: 'clear' },
    write('Warm-up', 6, 8, { size: 'large', color: 'yellow' }),
    write('a few quick questions, guessing is fine', 6, 26, { size: 'small', color: 'blue', cue: 'quick' }),
  ],
});

const diagnosticTurn = (question, number) => ({
  spoken_text: question.spoken_text,
  chalkboard_actions: [
    { type: 'clear' },
    write(`Warm-up question ${number}`, 6, 8, { size: 'small', color: 'yellow' }),
    write(question.question, 6, 24),
  ],
});

function roadmapTurn(spoken, modules) {
  const actions = [{ type: 'clear' }, write('Your roadmap', 6, 6, { size: 'large', color: 'yellow' })];
  modules.forEach((module, i) => {
    const y = 23 + i * 14;
    if (i > 0) actions.push({ type: 'draw_arrow', content: '', x: 36, y: y - 4, x2: 36, y2: y - 0.5, color: 'blue' });
    actions.push({ type: 'draw_box', content: `${i + 1}. ${module.title}`, x: 6, y, w: 60, h: 10, color: 'white' });
    if (module.is_prerequisite) actions.push(write('fills a gap first', 69, y + 2, { size: 'small', color: 'pink' }));
  });
  return { spoken_text: `${spoken} Start whenever you're ready.`, chalkboard_actions: actions };
}

const introTurn = (module, index) => ({
  spoken_text: index === 0 ? `We'll start with ${module.title}.` : `Next, ${module.title}.`,
  chalkboard_actions: index === 0 ? [{ type: 'highlight', content: `1. ${module.title}` }] : [],
});

function closingTurn(modules) {
  const actions = [{ type: 'clear' }, write('Well done!', 6, 8, { size: 'large', color: 'yellow' })];
  modules.forEach((module, i) => actions.push(write(`✓ ${module.title}`, 8, 28 + i * 12, { color: 'green' })));
  const n = modules.length;
  return {
    spoken_text: `That's the whole roadmap: ${n} ideas, and you showed you can use each of them.`,
    chalkboard_actions: actions,
  };
}

/* ================================================================== */
/* The engine                                                         */
/* ================================================================== */

export function createTutorEngine({ llm, stage, config = {} }) {
  const cfg = { ...DEFAULTS, ...config };
  const sleep = cfg.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms / cfg.timeScale)));
  const listeners = new Set();

  let current; // one of STATES
  let ctx; // everything the lesson knows
  let ui; // what the interface is waiting for
  let view; // immutable snapshot handed to subscribers
  let epoch = 0; // bumped to abandon in-flight async work (interruptions, new input)
  let retryStep = null;
  let seq = 0;

  function fresh() {
    current = STATES.INTAKE;
    ctx = {
      intake: null,
      document: null, // { name, characters, sections } when the class is built on an uploaded file
      greeted: false,
      diagnostic: [], // [{ question, prerequisite, answer }]
      profile: null, // the StudentProfile JSON
      modules: [], // roadmap + learner model per module
      moduleIndex: -1,
      introduced: -1,
      script: [], // turns of the micro-module (or re-teach) being delivered
      cursor: 0,
      analogies: [],
      check: null, // { question, expected } while the gate is open
      pendingAnswer: null,
      pendingQuestion: '',
      pendingReply: '',
      lastTurn: null, // what "say that again" repeats
      phase: { type: 'idle' }, // what a resumed lesson has to go back to
      interruption: null,
      prefetch: null,
      bridges: 0,
      log: [],
    };
    ui = { activity: 'idle', awaiting: 'intake', note: '', error: null };
  }

  /* ---------- plumbing ---------- */

  const module = () => ctx.modules[ctx.moduleIndex];

  function canInterrupt() {
    return (
      (current === STATES.TEACHING || current === STATES.CHECK) &&
      (ui.activity === 'speaking' || ui.activity === 'waiting') &&
      ['script', 'wait', 'praise', 'answer'].includes(ctx.phase.type)
    );
  }

  function buildView() {
    return Object.freeze({
      state: current,
      ...ui,
      intake: ctx.intake,
      document: ctx.document ? { name: ctx.document.name, sections: ctx.document.sections.length } : null,
      diagnostic: {
        asked: ctx.diagnostic.length,
        min: cfg.minDiagnostic,
        max: cfg.maxDiagnostic,
        question: ctx.diagnostic.at(-1)?.question ?? '',
        choices: ctx.diagnostic.at(-1)?.choices ?? [],
      },
      profile: ctx.profile,
      modules: ctx.modules.map((m, i) => ({
        title: m.title,
        objective: m.objective,
        is_prerequisite: m.is_prerequisite,
        attempts: m.attempts,
        mastery: m.mastery,
        status: m.passed ? 'passed' : i === ctx.moduleIndex ? 'current' : 'upcoming',
      })),
      moduleIndex: ctx.moduleIndex,
      check: current === STATES.CHECK && ctx.check ? { question: ctx.check.question, attempt: module().attempts + 1 } : null,
      interrupted: Boolean(ctx.interruption),
      canInterrupt: canInterrupt(),
      canRepeat: ui.activity === 'waiting' && Boolean(ctx.lastTurn),
      canRetry: Boolean(retryStep),
      log: ctx.log,
    });
  }

  function publish(patch) {
    if (patch) Object.assign(ui, patch);
    view = buildView();
    for (const listener of listeners) listener(view);
  }

  function transition(to) {
    if (!TRANSITIONS[current].includes(to)) throw new Error(`Illegal transition: ${current} → ${to}`);
    current = to;
  }

  function log(role, text) {
    ctx.log = [...ctx.log, { id: ++seq, role, text, state: current }];
  }

  /**
   * Run one retriable step. Bumping the epoch makes every older step stale, so
   * a reply that arrives after an interruption is dropped instead of acted on.
   */
  function run(step) {
    const mine = ++epoch;
    const stale = () => mine !== epoch;
    retryStep = null;
    publish({ error: null });
    return Promise.resolve()
      .then(() => step(stale))
      .catch((error) => {
        if (stale()) return;
        stage.stop();
        retryStep = step;
        publish({ activity: 'idle', error: { message: error?.message || 'Something went wrong.', hint: error?.hint || '' } });
      });
  }

  /** Speak and draw one turn. Resolves when the stage is done or was stopped. */
  function say(turn, patch) {
    ctx.lastTurn = turn;
    log('teacher', turn.spoken_text);
    publish({ activity: 'speaking', ...patch });
    return stage.perform(turn, { rate: PACE_RATE[ctx.profile?.target_pacing] ?? 1 });
  }

  /** Say something the engine already knows while the model works, to hide latency. */
  async function sayWhile(turn, pending, stale) {
    const spoken = say(turn).then(() => {
      if (!stale() && !ui.error) publish({ activity: 'thinking' });
    });
    const [value] = await Promise.all([pending, spoken]);
    return value;
  }

  /** Text of the student's document to send with a request: condensed, or the sections one module uses. */
  function source(kind, target) {
    const doc = ctx.document;
    if (!doc) return null;
    if (kind === 'warmUp' || kind === 'plan') {
      return { name: doc.name, what: 'condensed; every section is numbered', text: overview(doc, BUDGET[kind]) };
    }
    const named = target?.sections?.length ? target.sections : relevantSections(doc, `${target?.title} ${target?.objective} ${target?.key_points?.join(' ')}`);
    const text = excerpt(doc, named, BUDGET.lesson);
    return text ? { name: doc.name, what: 'the sections this micro-module draws on', text } : null;
  }

  function lessonState(extra) {
    return {
      topic: ctx.intake.topic,
      student: { age: ctx.intake.age, background: ctx.intake.background },
      ...(ctx.profile ? { student_profile: ctx.profile } : {}),
      ...(ctx.modules.length
        ? {
            roadmap: ctx.modules.map((m, i) => ({
              n: i + 1,
              title: m.title,
              status: m.passed ? 'passed' : i === ctx.moduleIndex ? 'current' : 'upcoming',
            })),
          }
        : {}),
      ...extra,
    };
  }

  /* ---------- 1 → 2: intake, then the diagnostic ---------- */

  function submitIntake({ topic, age, background, document }) {
    if (current !== STATES.INTAKE) return undefined;
    const doc = document?.text ? prepareDocument(document) : null;
    const intake = {
      topic: String(topic ?? '').trim() || (doc ? `The main ideas of "${doc.name}"` : ''),
      age: String(age ?? '').trim(),
      background: String(background ?? '').trim(),
    };
    if (!intake.topic || !intake.age || !intake.background) {
      publish({ error: { message: 'Fill in the topic, your age and your background so the lesson can be pitched at you.', hint: '' } });
      return undefined;
    }
    ctx.intake = intake;
    ctx.document = doc?.sections.length ? doc : null;
    transition(STATES.DIAGNOSTIC);
    log('student', `I want to learn: ${intake.topic}. Age ${intake.age}. Background: ${intake.background}.`);
    return run(diagnosticStep);
  }

  async function diagnosticStep(stale) {
    const asked = ctx.diagnostic.length;
    if (asked >= cfg.maxDiagnostic) return planStep(stale);
    const mayStop = asked >= cfg.minDiagnostic;
    publish({ activity: 'thinking', awaiting: null, note: asked ? 'Choosing the next question' : 'Preparing a warm-up question' });

    const request = llm.generateJSON({
      kind: 'diagnostic',
      system: SYSTEM_PROMPT,
      user: diagnosticPrompt({
        lesson: lessonState({ warm_up_so_far: ctx.diagnostic.map(({ question: q, prerequisite, answer }) => ({ question: q, prerequisite, answer })) }),
        source: source('warmUp'),
        number: asked + 1,
        max: cfg.maxDiagnostic,
        mayStop,
      }),
      schema: DIAGNOSTIC_SCHEMA,
      schemaName: 'diagnostic_question',
      validate: (raw) => normalizeDiagnostic(raw, { mustAsk: !mayStop }),
      context: { asked: ctx.diagnostic },
    });
    let question;
    if (ctx.greeted) question = await request;
    else {
      ctx.greeted = true;
      question = await sayWhile(greetingTurn(), request, stale);
    }
    if (stale()) return undefined;
    if (question.enough_information) return planStep(stale);

    ctx.diagnostic = [
      ...ctx.diagnostic,
      { question: question.question, choices: question.choices, prerequisite: question.prerequisite, answer: null },
    ];
    ctx.phase = { type: 'diagnostic' };
    await say(diagnosticTurn(question, asked + 1), { awaiting: 'diagnostic_answer' });
    if (!stale()) publish({ activity: 'waiting' });
    return undefined;
  }

  function submitDiagnosticAnswer(text) {
    if (current !== STATES.DIAGNOSTIC || ui.awaiting !== 'diagnostic_answer') return undefined;
    const answer = String(text ?? '').trim() || "I don't know";
    stage.stop();
    ctx.diagnostic = [...ctx.diagnostic.slice(0, -1), { ...ctx.diagnostic.at(-1), answer }];
    log('student', answer);
    return run(diagnosticStep);
  }

  /* ---------- 2 → 3: silent analysis, StudentProfile and roadmap ---------- */

  async function planStep(stale) {
    publish({ activity: 'thinking', awaiting: null, note: 'Planning your roadmap' });
    const plan = await llm.generateJSON({
      kind: 'plan',
      system: SYSTEM_PROMPT,
      user: planPrompt({
        lesson: lessonState({ warm_up: ctx.diagnostic.map(({ question: q, prerequisite, answer }) => ({ question: q, prerequisite, answer })) }),
        source: source('plan'),
        min: cfg.minModules,
        max: cfg.maxModules,
      }),
      schema: PLAN_SCHEMA,
      schemaName: 'lesson_plan',
      validate: (raw) => normalizePlan(raw, cfg),
      context: { answers: ctx.diagnostic },
    });
    if (stale()) return;

    ctx.profile = plan.student_profile;
    ctx.modules = plan.curriculum.map((m) => ({
      ...m,
      passed: false,
      attempts: 0,
      analogy: '',
      mastery: initialMastery(m.is_prerequisite),
    }));
    transition(STATES.CURRICULUM);
    ctx.phase = { type: 'roadmap' };
    await say(roadmapTurn(plan.spoken_text, ctx.modules), { awaiting: 'start' });
    if (!stale()) publish({ activity: 'waiting' });
  }

  /* ---------- 3 → 4: the live teaching loop ---------- */

  function startLesson() {
    if (current !== STATES.CURRICULUM) return undefined;
    stage.stop();
    transition(STATES.TEACHING);
    ctx.moduleIndex = 0;
    return run(teachStep);
  }

  function fetchScript(index) {
    const target = ctx.modules[index];
    const covered = ctx.modules.slice(0, index).map((m) => ({ title: m.title, key_points: m.key_points, analogy: m.analogy }));
    return llm.generateJSON({
      kind: 'module',
      system: SYSTEM_PROMPT,
      user: modulePrompt({
        lesson: lessonState({ covered_so_far: covered, analogies_already_used: covered.map((c) => c.analogy).filter(Boolean) }),
        source: source('lesson', target),
        module: target,
        number: index + 1,
        total: ctx.modules.length,
      }),
      schema: SCRIPT_SCHEMA,
      schemaName: 'lesson_script',
      validate: normalizeScript,
      context: { module: target },
    });
  }

  /** While the student thinks about a check question, get the next module ready. */
  function prefetchNext() {
    const next = ctx.moduleIndex + 1;
    if (next >= ctx.modules.length || ctx.prefetch?.index === next) return;
    ctx.prefetch = { index: next, promise: fetchScript(next).catch(() => null) };
  }

  async function teachStep(stale) {
    const index = ctx.moduleIndex;
    const target = ctx.modules[index];
    publish({ activity: 'thinking', awaiting: null, note: `Preparing “${target.title}”` });
    ctx.phase = { type: 'loading' };
    ctx.check = null;

    const prefetched = ctx.prefetch?.index === index ? ctx.prefetch.promise : null;
    ctx.prefetch = null;
    const request = prefetched ? prefetched.then((script) => script ?? fetchScript(index)) : fetchScript(index);

    let script;
    if (ctx.introduced === index) script = await request;
    else {
      ctx.introduced = index;
      script = await sayWhile(introTurn(target, index), request, stale);
    }
    if (stale()) return undefined;

    target.analogy = script.analogy;
    ctx.analogies = script.analogy ? [script.analogy] : [];
    ctx.script = script.turns;
    ctx.cursor = 0;
    return playStep(stale);
  }

  /**
   * Deliver the script from the cursor, one micro-chunk at a time.
   * Stops (and waits for the student) at every pause; opens the comprehension
   * gate when it reaches the quiz turn. `cut` resumes an interrupted chunk.
   */
  async function playStep(stale, cut = null) {
    let resume = cut;
    for (;;) {
      const turn = ctx.script[ctx.cursor];
      if (!turn) return;
      const isQuiz = turn.pause_type === 'comprehension_quiz';
      if (isQuiz && current === STATES.TEACHING) {
        transition(STATES.CHECK);
        ctx.check = { question: turn.quiz_question, expected: turn.expected_concept };
        prefetchNext();
      }

      let playing = turn;
      ctx.phase = { type: 'script', textOffset: 0, actionOffset: 0 };
      if (resume) {
        // Restart at the last sentence boundary before the cut, with a short bridge.
        const from = sentenceStartBefore(turn.spoken_text, resume.charIndex);
        const bridge = BRIDGES[ctx.bridges++ % BRIDGES.length];
        playing = {
          ...turn,
          spoken_text: `${bridge} ${turn.spoken_text.slice(from)}`,
          chalkboard_actions: turn.chalkboard_actions.slice(resume.actionsStarted),
        };
        ctx.phase = { type: 'script', textOffset: from - bridge.length - 1, actionOffset: resume.actionsStarted };
        resume = null;
      }

      await say(playing, { awaiting: isQuiz ? 'check_answer' : null });
      if (stale()) return;

      if (isQuiz) {
        ctx.phase = { type: 'wait', awaiting: 'check_answer' };
        publish({ activity: 'waiting', awaiting: 'check_answer' });
        return;
      }
      if (turn.pause_type === 'ask_if_following') {
        // Mandatory pause: the teacher has stopped and will not go on alone.
        ctx.phase = { type: 'wait', awaiting: 'continue' };
        publish({ activity: 'waiting', awaiting: 'continue' });
        return;
      }
      ctx.cursor += 1;
      ctx.phase = { type: 'script', textOffset: 0, actionOffset: 0 };
      await sleep(cfg.beatMs);
      if (stale()) return;
    }
  }

  function continueLesson() {
    if (ui.awaiting !== 'continue' || ui.activity !== 'waiting') return undefined;
    ctx.cursor += 1;
    return run(playStep);
  }

  /**
   * The student typed or said something at a pause: an answer to a question
   * the teacher asked along the way, a question of their own, or "I'm lost".
   * The teacher responds on the board as it is, then either moves on or waits.
   */
  function reply(text) {
    const said = String(text ?? '').trim();
    if (ui.awaiting !== 'continue' || ui.activity !== 'waiting' || !said) return undefined;
    log('student', said);
    ctx.pendingReply = said;
    return run(replyStep);
  }

  async function replyStep(stale) {
    publish({ activity: 'thinking', awaiting: null, note: 'Thinking about what you said' });
    const turn = await llm.generateJSON({
      kind: 'reply',
      system: SYSTEM_PROMPT,
      user: replyPrompt({
        lesson: lessonState({ current_module: module()?.title, lesson_board_right_now: stage.describe() }),
        source: source('lesson', module()),
        said: ctx.script[ctx.cursor]?.spoken_text ?? '',
        reply: ctx.pendingReply,
      }),
      schema: TURN_SCHEMA,
      schemaName: 'teaching_turn',
      validate: normalizeReply,
      context: { reply: ctx.pendingReply, module: module() },
    });
    if (stale()) return undefined;

    ctx.phase = { type: 'wait', awaiting: 'continue' }; // an interruption here comes back to this pause
    await say(turn);
    if (stale()) return undefined;
    if (turn.pause_type === 'continue') {
      ctx.cursor += 1;
      ctx.phase = { type: 'script', textOffset: 0, actionOffset: 0 };
      await sleep(cfg.beatMs);
      if (stale()) return undefined;
      return playStep(stale);
    }
    publish({ activity: 'waiting', awaiting: 'continue' });
    return undefined;
  }

  /** "Say that again": repeat the last thing said, without redrawing, then wait as before. */
  function repeat() {
    if (ui.activity !== 'waiting' || !ctx.lastTurn) return undefined;
    const { awaiting } = ui;
    const phase = ctx.phase;
    const turn = { ...ctx.lastTurn, chalkboard_actions: [] };
    return run(async (stale) => {
      ctx.phase = { type: 'repeat' };
      publish({ activity: 'speaking' });
      await stage.perform(turn, { rate: PACE_RATE[ctx.profile?.target_pacing] ?? 1 });
      if (stale()) return;
      ctx.phase = phase;
      publish({ activity: 'waiting', awaiting });
    });
  }

  /* ---------- student interruption ---------- */

  /** Halt the teacher mid-word and open the floor. Synchronous on purpose. */
  function interrupt() {
    if (!canInterrupt()) return false;
    const cut = stage.stop();
    epoch += 1;
    if (!ctx.interruption) {
      const phase = ctx.phase;
      ctx.interruption = {
        phase,
        cursor: ctx.cursor,
        board: stage.snapshot(),
        cut: {
          wasSpeaking: cut.wasSpeaking,
          charIndex: Math.max(0, cut.charIndex + (phase.textOffset ?? 0)),
          actionsStarted: cut.actionsStarted + (phase.actionOffset ?? 0),
          saidSoFar: cut.charIndex,
        },
      };
    }
    ctx.phase = { type: 'question' };
    publish({ activity: 'listening', awaiting: 'question', error: null });
    return true;
  }

  function askQuestion(text) {
    const question = String(text ?? '').trim();
    if (ui.awaiting !== 'question' || !question) return undefined;
    log('student', question);
    ctx.pendingQuestion = question;
    return run(answerStep);
  }

  function describeSituation() {
    const it = ctx.interruption;
    const lines = [];
    const turn = ctx.script[it.cursor];
    if (it.phase.type === 'script' && it.cut.wasSpeaking && turn) {
      lines.push(`You were in the middle of saying: ${JSON.stringify(turn.spoken_text)}`);
      lines.push(`You had got as far as: ${JSON.stringify(turn.spoken_text.slice(0, it.cut.charIndex))}`);
    } else {
      lines.push('You had paused and were waiting for the student.');
    }
    if (ctx.check) lines.push(`A comprehension question is pending: ${JSON.stringify(ctx.check.question)}`);
    return lines.join('\n');
  }

  async function answerStep(stale) {
    publish({ activity: 'thinking', awaiting: null, note: 'Thinking about your question' });
    const turn = await llm.generateJSON({
      kind: 'answer',
      system: SYSTEM_PROMPT,
      user: answerPrompt({
        lesson: lessonState({
          current_module: module()?.title,
          said_in_this_module: ctx.script.slice(0, ctx.interruption.cursor + 1).map((t) => t.spoken_text),
          lesson_board_right_now: stage.describe(),
        }),
        source: source('lesson', module()),
        question: ctx.pendingQuestion,
        situation: describeSituation(),
      }),
      schema: TURN_SCHEMA,
      schemaName: 'teaching_turn',
      validate: normalizeAnswer,
      context: { question: ctx.pendingQuestion },
    });
    if (stale()) return undefined;
    ctx.phase = { type: 'answer' };
    await say(turn);
    if (stale()) return undefined;
    await sleep(cfg.beatMs);
    if (stale()) return undefined;
    return resumeStep(stale);
  }

  /** "Never mind": go straight back to the lesson. */
  function resumeLesson() {
    if (ui.awaiting !== 'question' || !ctx.interruption) return undefined;
    return run(resumeStep);
  }

  async function resumeStep(stale) {
    const it = ctx.interruption;
    if (!it) return undefined;
    publish({ activity: 'thinking', awaiting: null, note: 'Back to the lesson' });
    await stage.restore(it.board);
    if (stale()) return undefined;

    ctx.interruption = null;
    ctx.cursor = it.cursor;
    ctx.phase = it.phase;
    if (it.phase.type === 'praise') return afterPass();
    if (it.phase.type === 'wait') {
      publish({ activity: 'waiting', awaiting: it.phase.awaiting });
      return undefined;
    }
    return playStep(stale, it.cut.wasSpeaking ? it.cut : null);
  }

  /* ---------- 4 → 5: the active comprehension gate ---------- */

  function submitCheckAnswer(text) {
    const answer = String(text ?? '').trim();
    if (current !== STATES.CHECK || ui.awaiting !== 'check_answer' || !answer) return undefined;
    stage.stop();
    log('student', answer);
    ctx.pendingAnswer = { text: answer, hesitated: false, counted: false };
    return run(gradeStep);
  }

  /** The student said "not sure", or stayed silent past the hesitation window. */
  function hesitate() {
    if (current !== STATES.CHECK || ui.awaiting !== 'check_answer') return undefined;
    stage.stop();
    log('student', '(not sure)');
    ctx.pendingAnswer = { text: '', hesitated: true, counted: false };
    return run(gradeStep);
  }

  async function gradeStep(stale) {
    const target = module();
    const pending = ctx.pendingAnswer;
    const attempt = target.attempts + (pending.counted ? 0 : 1);
    publish({
      activity: 'thinking',
      awaiting: null,
      note: pending.hesitated ? 'Finding another way to explain it' : 'Reading your answer',
    });

    const result = await llm.generateJSON({
      kind: 'grade',
      system: SYSTEM_PROMPT,
      user: gradePrompt({
        lesson: lessonState({ current_module: target.title, said_in_this_module: ctx.script.map((t) => t.spoken_text) }),
        source: source('lesson', target),
        module: target,
        check: ctx.check,
        answer: pending.text,
        hesitated: pending.hesitated,
        attempt,
        analogies: ctx.analogies,
      }),
      schema: GRADE_SCHEMA,
      schemaName: 'check_result',
      validate: (raw) => normalizeGrade(raw, { hesitated: pending.hesitated }),
      context: { module: target, question: ctx.check.question, answer: pending.text, hesitated: pending.hesitated, attempt },
    });
    if (stale()) return undefined;

    const passed = result.assessment.verdict === 'correct';
    if (!pending.counted) {
      pending.counted = true;
      target.attempts += 1;
      target.mastery = bktUpdate(target.mastery, passed);
    }

    if (passed) {
      target.passed = true;
      ctx.check = null;
      ctx.phase = { type: 'praise' };
      await say(result.turns[0]);
      if (stale()) return undefined;
      return afterPass();
    }

    // Not yet. Back to teaching: a different analogy, a new drawing, a fresh check item.
    transition(STATES.TEACHING);
    ctx.check = null;
    if (result.analogy) ctx.analogies = [...ctx.analogies, result.analogy];
    ctx.script = result.turns;
    ctx.cursor = 0;
    return playStep(stale);
  }

  function afterPass() {
    const next = ctx.moduleIndex + 1;
    ctx.check = null;
    if (next < ctx.modules.length) {
      transition(STATES.TEACHING);
      ctx.moduleIndex = next;
      return run(teachStep);
    }
    transition(STATES.COMPLETE);
    ctx.moduleIndex = ctx.modules.length;
    ctx.phase = { type: 'closing' };
    return run(async (stale) => {
      await say(closingTurn(ctx.modules), { awaiting: null });
      if (!stale()) publish({ activity: 'idle', awaiting: 'restart' });
    });
  }

  /* ---------- housekeeping ---------- */

  function retry() {
    return retryStep ? run(retryStep) : undefined;
  }

  function reset() {
    epoch += 1;
    retryStep = null;
    stage.stop();
    stage.reset();
    fresh();
    publish();
  }

  fresh();
  view = buildView();

  return {
    getView: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    submitIntake,
    submitDiagnosticAnswer,
    startLesson,
    continueLesson,
    reply,
    repeat,
    interrupt,
    askQuestion,
    resumeLesson,
    submitCheckAnswer,
    hesitate,
    retry,
    reset,
  };
}
