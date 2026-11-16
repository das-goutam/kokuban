/**
 * Offline demo provider: a scripted mini-lesson on Fourier series.
 *
 * It answers the same five kinds of request the engine sends to a real model
 * (diagnostic, plan, module, grade, answer), so every stage of the state
 * machine, the chalkboard and the voice can be tried without an API key.
 * Grading is keyword-based and the lesson is fixed: connect a model in
 * Settings to learn any topic with real adaptivity.
 */

const CLEAR = { type: 'clear' };
const T = (content, x, y, extra = {}) => ({ type: 'write_text', content, x, y, ...extra });
const B = (content, x, y, w, h, extra = {}) => ({ type: 'draw_box', content, x, y, w, h, ...extra });
const A = (x, y, x2, y2, extra = {}) => ({ type: 'draw_arrow', content: '', x, y, x2, y2, ...extra });
const H = (content, extra = {}) => ({ type: 'highlight', content, ...extra });
const TITLE = (content) => T(content, 6, 6, { size: 'large', color: 'yellow' });

const say = (spoken_text, chalkboard_actions, pause_type = 'ask_if_following') => ({
  spoken_text,
  chalkboard_actions,
  pause_type,
  quiz_question: '',
  expected_concept: '',
});
const ask = (spoken_text, chalkboard_actions, quiz_question, expected_concept) => ({
  spoken_text,
  chalkboard_actions,
  pause_type: 'comprehension_quiz',
  quiz_question,
  expected_concept,
});

const has = (pattern) => (answer) => pattern.test(answer);
const ZERO = /\bzero\b|\b0\b(?![.\d])|\bnothing\b|\bcancels?\b/i;

/* ------------------------------------------------------------------ */
/* Warm-up                                                            */
/* ------------------------------------------------------------------ */

const WARM_UP = [
  {
    spoken_text: 'First one. A wave is given by sine of four pi t, with t in seconds. What is its period?',
    question: 'What is the period of sin(4πt), with t in seconds?',
    choices: ['2 seconds', '1/2 second', '4π seconds', '1/4 second'],
    prerequisite: 'period and frequency of a sine wave',
    knows: has(/1\s*\/\s*2|0?\.5\b|\bhalf\b/i),
  },
  {
    spoken_text: 'Thanks. Next: how many full cycles does sine of three t complete between t equals zero and two pi?',
    question: 'How many full cycles does sin(3t) complete from t = 0 to t = 2π?',
    choices: ['3', '6', '1.5', '2π'],
    prerequisite: 'counting the cycles of sin(nt) in one period',
    knows: has(/\b3\b|\bthree\b/i),
  },
  {
    spoken_text: 'Okay. Last one. What do you get if you integrate sine two t times sine three t, from minus pi to pi?',
    question: '∫_{-π}^{π} sin 2t · sin 3t dt = ?',
    choices: ['π', '2π', '0', '1'],
    prerequisite: 'integrating a product of two sines',
    knows: has(ZERO),
  },
];

/* ------------------------------------------------------------------ */
/* Micro-modules. Each has two scripts with different analogies:      */
/* variant 0 is taught first, variant 1 is the re-teach.              */
/* ------------------------------------------------------------------ */

const MODULES = {
  period: {
    title: 'Period and frequency',
    objective: 'You can read the period and the frequency off a wave written as sin(ωt).',
    key_points: ['The period T is the time for one full cycle', 'Frequency is f = 1/T', 'For sin(ωt), T = 2π/ω'],
    variants: [
      {
        analogy: 'a playground swing',
        turns: [
          say(
            "Let's start with the rhythm of a sine wave. Picture a playground swing. The time for one full back-and-forth is called its period.",
            [CLEAR, TITLE('Period and frequency'), T('period T = time for one full cycle', 8, 26, { cue: 'period' })],
            'continue',
          ),
          say(
            'Frequency is the flip side: how many full swings fit into one second. So frequency is one over the period.',
            [
              T('frequency f = 1 / T', 8, 40, { cue: 'one over' }),
              T('cycles per second', 48, 41.5, { size: 'small', color: 'blue' }),
            ],
          ),
          say(
            'Now the formula. Sine of omega t finishes one cycle when omega t reaches two pi. So the period is two pi over omega.',
            [
              T('sin(ωt)', 8, 58, { size: 'large', color: 'yellow', cue: 'omega t' }),
              A(30, 63, 44, 63, { cue: 'two pi' }),
              T('T = 2π / ω', 48, 58, { size: 'large', cue: 'period is' }),
            ],
          ),
          ask(
            'Quick check. A wave is given by sine of six pi t. What is its period, and what is its frequency?',
            [T('sin(6πt):   T = ?    f = ?', 8, 80, { color: 'pink' })],
            'For sin(6πt), what is the period T and what is the frequency f?',
            'ω = 6π, so T = 2π / 6π = 1/3 second and f = 1/T = 3 cycles per second.',
          ),
        ],
        grade: (a) => (/1\s*\/\s*3|0?\.33|\bthird\b/i.test(a) ? 'correct' : /\b3\b|\bthree\b/i.test(a) ? 'partial' : 'incorrect'),
        praise: say('Exactly. You divided two pi by omega, and the frequency is just the flip of that.', [H('T = 2π / ω')], 'continue'),
      },
      {
        analogy: 'a spinning wheel',
        turns: [
          say(
            "Here's another way to see it. Picture a wheel spinning. Omega is how fast its angle grows, and one full turn is an angle of two pi.",
            [CLEAR, TITLE('A spinning wheel'), B('angle = ωt', 8, 26, 30, 13, { cue: 'Omega' }), T('one full turn = 2π', 46, 29, { cue: 'two pi' })],
            'continue',
          ),
          say(
            'So the time for one turn is the full angle divided by the speed: two pi over omega. If omega is four pi, one turn takes half a second.',
            [
              T('time for one turn:  T = 2π / ω', 8, 50, { color: 'yellow', cue: 'two pi over' }),
              T('ω = 4π   →   T = 2π / 4π = 1/2', 8, 64, { cue: 'four pi' }),
            ],
          ),
          ask(
            'Your turn. For sine of ten pi t, how long does one full cycle take?',
            [T('sin(10πt):   T = ?', 8, 82, { color: 'pink' })],
            'For sin(10πt), how long is one full cycle (the period T)?',
            'T = 2π / 10π = 1/5 second (0.2 s).',
          ),
        ],
        grade: (a) => (/1\s*\/\s*5|0?\.2\b|\bfifth\b/i.test(a) ? 'correct' : 'incorrect'),
        praise: say("That's it: two pi divided by ten pi, a fifth of a second.", [H('T = 2π / ω')], 'continue'),
      },
    ],
  },

  ingredients: {
    title: 'Waves as ingredients',
    objective: 'You can describe a repeating signal as a sum of sine waves at whole-number multiples of one base frequency.',
    key_points: [
      'Any repeating signal is a sum of sine waves',
      'The ingredients are the harmonics sin t, sin 2t, sin 3t, …',
      'Each harmonic has its own coefficient',
    ],
    variants: [
      {
        analogy: 'a musical chord',
        turns: [
          say(
            'Here is the big idea of Fourier series. Any repeating signal, however jagged, can be built by adding plain sine waves, like a chord built from single notes.',
            [CLEAR, TITLE('Waves as ingredients'), T('repeating signal = sum of sine waves', 8, 25, { cue: 'adding' })],
          ),
          say(
            'The ingredients are not random. They are sine t, sine two t, sine three t and so on: whole-number multiples of one base frequency. We call them harmonics.',
            [
              B('sin t', 8, 40, 17, 12, { cue: 'sine t' }),
              B('sin 2t', 29, 40, 17, 12, { cue: 'sine two t' }),
              B('sin 3t', 50, 40, 17, 12, { cue: 'sine three t' }),
              T('…', 71, 42, { cue: 'so on' }),
              T('harmonics: n = 1, 2, 3, …', 8, 57, { size: 'small', color: 'blue', cue: 'harmonics' }),
            ],
          ),
          say(
            'Each harmonic gets its own volume knob, a number called a coefficient. A square wave, for instance, uses only the odd harmonics, each one quieter than the last.',
            [
              T('f(t) = b_1 sin t + b_2 sin 2t + b_3 sin 3t + …', 8, 68, { color: 'yellow', cue: 'volume' }),
              T('b_n = how much of harmonic n', 8, 80, { size: 'small', color: 'blue', cue: 'coefficient' }),
            ],
            'continue',
          ),
          ask(
            'Quick check. A signal repeats every two pi seconds, and it contains sine five t. Which harmonic is that, and how many cycles does it complete while the signal repeats once?',
            [T('sin 5t :  which harmonic?  how many cycles?', 8, 89, { size: 'small', color: 'pink' })],
            'A signal repeats every 2π seconds and contains sin 5t. Which harmonic is that, and how many cycles does it complete in one period of the signal?',
            'It is the 5th harmonic (n = 5), and it completes 5 full cycles in one period of the signal.',
          ),
        ],
        grade: (a) => (/\b5\b|\bfive\b|5th|\bfifth\b/i.test(a) ? 'correct' : 'incorrect'),
        praise: say(
          'Exactly right. The number in front of t is the harmonic number, and it counts the cycles per period.',
          [H('harmonics: n')],
          'continue',
        ),
      },
      {
        analogy: 'a recipe',
        turns: [
          say(
            "Try it as a recipe. The harmonics are the ingredients on the shelf, and they are always the same ones: sine t, sine two t, sine three t.",
            [CLEAR, TITLE('A recipe'), T('on the shelf:  sin t,  sin 2t,  sin 3t,  …', 8, 26, { cue: 'shelf' })],
            'continue',
          ),
          say(
            'The number in front of t tells you how often that wave repeats while the whole signal repeats once. Sine two t fits in twice. Sine three t fits in three times.',
            [
              T('sin 2t  →  2 cycles per period', 8, 44, { cue: 'twice' }),
              T('sin 3t  →  3 cycles per period', 8, 57, { cue: 'three times' }),
              T('number in front of t = harmonic number', 8, 71, { size: 'small', color: 'blue' }),
            ],
          ),
          ask(
            'So, sine four t. How many cycles does it fit into one period of the signal, and which harmonic is it?',
            [T('sin 4t  →  ? cycles per period', 8, 85, { color: 'pink' })],
            'How many cycles does sin 4t complete in one period of the signal, and which harmonic is it?',
            'Four cycles; it is the 4th harmonic.',
          ),
        ],
        grade: (a) => (/\b4\b|\bfour\b|4th|\bfourth\b/i.test(a) ? 'correct' : 'incorrect'),
        praise: say('Yes. Four cycles per period, so it is the fourth harmonic.', [H('number in front of t')], 'continue'),
      },
    ],
  },

  cancel: {
    title: 'Sines that cancel',
    objective: 'You can say why two different sine waves multiply and integrate to zero over a period, while a sine wave times itself gives π.',
    key_points: [
      'Two different whole-number sine waves integrate to zero over a full period',
      'A sine wave times itself integrates to π',
      'This property is called orthogonality',
    ],
    variants: [
      {
        analogy: 'pushing a swing out of rhythm',
        turns: [
          say(
            'Here is the trick that makes Fourier series workable. Multiply two different sine waves, say sine two t and sine three t, and add up the result over one full period. The positive and negative parts cancel exactly.',
            [CLEAR, TITLE('Sines that cancel'), T('∫_{-π}^{π} sin 2t · sin 3t dt = 0', 8, 26, { cue: 'cancel' })],
            'continue',
          ),
          say(
            "It's like pushing a swing out of rhythm. Half the time you help it, half the time you fight it, and over a full cycle you achieve nothing.",
            [T('different waves → the pushes cancel', 8, 39, { size: 'small', color: 'blue', cue: 'rhythm' })],
          ),
          say(
            "But multiply a sine wave by itself, and every piece is positive: it's a square. Nothing cancels. Over one period that integral always comes out as pi.",
            [T('∫_{-π}^{π} sin 3t · sin 3t dt = π', 8, 52, { cue: 'itself' }), H('sin 3t · sin 3t', { cue: 'pi' })],
          ),
          say(
            'So here is the rule. Same wave, you get pi. Different waves, you get zero. Mathematicians call this orthogonality.',
            [B('same wave → π     different → 0', 8, 68, 66, 13, { color: 'yellow', cue: 'rule' })],
            'continue',
          ),
          ask(
            'Your turn. What is the integral, from minus pi to pi, of sine four t times sine seven t? And tell me why.',
            [T('∫_{-π}^{π} sin 4t · sin 7t dt = ?', 8, 87, { color: 'pink' })],
            'What is ∫_{-π}^{π} sin 4t · sin 7t dt, and why?',
            'Zero: they are different sine waves, so the positive and negative parts cancel over a full period (orthogonality).',
          ),
        ],
        grade: (a) => (ZERO.test(a) ? 'correct' : 'incorrect'),
        praise: say(
          'Exactly. Different waves, so everything cancels to zero. That is orthogonality at work.',
          [H('different → 0')],
          'continue',
        ),
      },
      {
        analogy: 'a bank balance',
        turns: [
          say(
            'Here is a different picture: a bank account. Multiply two different sine waves and you get deposits and withdrawals in exactly equal amounts.',
            [CLEAR, TITLE('Deposits and withdrawals'), T('sin 2t · sin 3t :  + and − in equal amounts', 8, 26, { cue: 'equal' })],
            'continue',
          ),
          say(
            'After one full period the balance is back at zero. Only when a wave meets itself is every entry a deposit, and then the balance ends at pi.',
            [
              T('different waves → balance ends at 0', 8, 44, { cue: 'zero' }),
              T('same wave → every entry a deposit → π', 8, 58, { color: 'yellow', cue: 'itself' }),
            ],
          ),
          ask(
            'So what is the integral over one period of sine two t times sine five t?',
            [T('∫_{-π}^{π} sin 2t · sin 5t dt = ?', 8, 78, { color: 'pink' })],
            'What is ∫_{-π}^{π} sin 2t · sin 5t dt?',
            'Zero, because the two sine waves are different.',
          ),
        ],
        grade: (a) => (ZERO.test(a) ? 'correct' : 'incorrect'),
        praise: say('Right. Two different waves, so the balance ends at zero.', [H('balance ends at 0')], 'continue'),
      },
    ],
  },

  coefficient: {
    title: 'Finding one coefficient',
    objective: 'You can find a Fourier coefficient by multiplying by sin nt and integrating over one period.',
    key_points: [
      'Multiply by sin nt and integrate: every other harmonic drops out',
      'b_n = (1/π) ∫ f(t) sin nt dt over one period',
      'Square wave: b_n = 4/(nπ) for odd n and 0 for even n',
    ],
    variants: [
      {
        analogy: 'tuning a radio',
        turns: [
          say(
            'Now we put that rule to work. Say a signal is a mix of harmonics, and we want just one volume knob: b three. How do we isolate it?',
            [CLEAR, TITLE('Finding one coefficient'), T('f(t) = b_1 sin t + b_2 sin 2t + b_3 sin 3t + …', 6, 24, { cue: 'mix' })],
            'continue',
          ),
          say(
            'Multiply everything by sine three t and integrate over one period. Every other harmonic cancels to zero. Only the b three term survives, and it leaves b three times pi.',
            [
              T('× sin 3t,  then ∫ over one period', 6, 37, { size: 'small', color: 'blue', cue: 'Multiply' }),
              T('0  +  0  +  b_3 · π  +  0  +  …', 6, 47, { cue: 'survives' }),
            ],
          ),
          say(
            'It works like tuning a radio. Multiplying by sine three t tunes in that one station and silences the rest. Divide by pi and you have the coefficient.',
            [B('b_n = (1/π) ∫_{-π}^{π} f(t) sin nt dt', 6, 60, 70, 14, { color: 'yellow', cue: 'Divide' })],
          ),
          say(
            'For a square wave that jumps between minus one and plus one, this recipe gives four over n pi when n is odd, and zero when n is even.',
            [T('square wave:  b_n = 4/(nπ) for odd n,  0 for even n', 6, 79, { size: 'small', color: 'green', cue: 'four over' })],
            'continue',
          ),
          ask(
            'Last check. Using that result, what is b three for the square wave? And what is b two?',
            [T('b_3 = ?     b_2 = ?', 6, 88, { color: 'pink' })],
            'For the square wave, what is b_3, and what is b_2?',
            'b_3 = 4/(3π) ≈ 0.42, and b_2 = 0 because the even harmonics drop out.',
          ),
        ],
        grade: (a) => {
          const b3 = /4\s*\/\s*\(?\s*3\s*\*?\s*(π|pi)|(4|four)\s*over\s*(3|three)\s*pi|0?\.42/i.test(a);
          const b2 = ZERO.test(a);
          return b3 && b2 ? 'correct' : b3 || b2 ? 'partial' : 'incorrect';
        },
        praise: say(
          'Exactly: four over three pi, and zero for the even one. You just computed Fourier coefficients.',
          [H('b_n = (1/π)')],
          'continue',
        ),
      },
      {
        analogy: 'a coin sorter',
        turns: [
          say(
            "Slower this time, with a different picture: a coin sorter. Multiplying by sine n t and integrating is a slot that only one harmonic fits through.",
            [CLEAR, TITLE('A coin sorter'), T('slot n :  only sin nt gets through', 8, 26, { cue: 'slot' })],
            'continue',
          ),
          say(
            'For the square wave, what falls through slot n is four over n pi when n is odd. So slot one gives four over pi. Even slots give nothing.',
            [
              T('square wave:  b_n = 4/(nπ) for odd n', 8, 43, { cue: 'four over' }),
              T('b_1 = 4/π', 8, 57, { color: 'yellow', cue: 'slot one' }),
              T('b_2 = 0', 40, 57, { color: 'yellow', cue: 'Even' }),
            ],
          ),
          ask(
            'So what comes through slot five? What is b five for the square wave?',
            [T('b_5 = ?', 8, 74, { color: 'pink' })],
            'For the square wave, what is b_5?',
            'b_5 = 4/(5π) ≈ 0.25.',
          ),
        ],
        grade: (a) => (/4\s*\/\s*\(?\s*5\s*\*?\s*(π|pi)|(4|four)\s*over\s*(5|five)\s*pi|0?\.25\b/i.test(a) ? 'correct' : 'incorrect'),
        praise: say("That's it: four over five pi. The same slot idea works for every harmonic.", [H('b_n = 4/(nπ)')], 'continue'),
      },
    ],
  },
};

const BY_TITLE = Object.fromEntries(Object.values(MODULES).map((m) => [m.title, m]));

/* ------------------------------------------------------------------ */
/* Prepared answers for interruptions                                 */
/* ------------------------------------------------------------------ */

const ANSWERS = [
  {
    when: /orthogonal|cancel|zero|disappear|vanish/i,
    turn: say(
      'Over a full period, the product of two different sine waves is positive exactly as often as it is negative, with equal area. So the total comes to zero.',
      [
        CLEAR,
        T('product of two different sine waves', 8, 14, { size: 'small', color: 'blue' }),
        T('area above  =  area below', 8, 30, { cue: 'equal' }),
        T('total over one period = 0', 8, 46, { color: 'yellow', cue: 'zero' }),
      ],
    ),
  },
  {
    when: /harmonic|multiple|frequenc|period/i,
    turn: say(
      'A harmonic is a sine wave whose frequency is a whole-number multiple of the base frequency. The second harmonic wiggles twice as fast, the third three times as fast.',
      [
        CLEAR,
        T('harmonic n  =  sin nt', 8, 16, { color: 'yellow' }),
        T('n = 2 :  twice as fast', 8, 32, { cue: 'second' }),
        T('n = 3 :  three times as fast', 8, 46, { cue: 'third' }),
      ],
    ),
  },
  {
    when: /gibbs|overshoot|jump|square/i,
    turn: say(
      'Near a jump, the sum of sines overshoots by about nine percent, however many terms you add. That is the Gibbs phenomenon. It goes beyond this short demo, but it is a good thing to be curious about.',
      [
        CLEAR,
        T('Gibbs phenomenon', 8, 16, { color: 'yellow' }),
        T('overshoot ≈ 9% of the jump', 8, 32, { cue: 'nine' }),
        T('it gets narrower, never smaller', 8, 46, { size: 'small', color: 'blue' }),
      ],
    ),
  },
];

const FALLBACK_ANSWER = say(
  "This offline demo only has a handful of prepared answers, though. Connect a language model in Settings and I can answer anything you ask.",
  [
    CLEAR,
    T('demo mode: prepared answers only', 8, 20, { size: 'small', color: 'blue' }),
    T('Settings → connect a model', 8, 34, { color: 'yellow', cue: 'Connect' }),
  ],
);

/* ------------------------------------------------------------------ */
/* Entry point                                                        */
/* ------------------------------------------------------------------ */

function plan(answers) {
  const known = WARM_UP.map((item, i) => item.knows(answers[i]?.answer ?? ''));
  const [period, cycles, product] = known;
  const score = known.filter(Boolean).length;
  const pick = (m, isPrerequisite) => ({
    title: m.title,
    objective: m.objective,
    key_points: m.key_points,
    is_prerequisite: isPrerequisite,
  });
  return {
    student_profile: {
      level_summary:
        score === 3
          ? 'Comfortable with sine waves and their integrals; ready for Fourier series proper.'
          : `Has ${score} of the 3 prerequisites checked; the rest will be repaired first.`,
      strengths: WARM_UP.filter((_, i) => known[i]).map((item) => item.prerequisite),
      missing_prerequisites: WARM_UP.filter((_, i) => !known[i]).map((item) => item.prerequisite),
      target_pacing: score === 3 ? 'brisk' : score === 2 ? 'moderate' : 'slow',
      analogy_domains: ['music', 'playground physics', 'everyday money'],
    },
    curriculum: [
      ...(period ? [] : [pick(MODULES.period, true)]),
      pick(MODULES.ingredients, !cycles),
      pick(MODULES.cancel, !product),
      pick(MODULES.coefficient, false),
    ],
    spoken_text:
      score === 3
        ? "Nice, your basics are solid. We'll go straight to the heart of Fourier series and build up to computing a coefficient."
        : "Thanks, that tells me where to start. We'll shore up a basic or two first, then build up to Fourier coefficients step by step.",
  };
}

export function demoRespond(kind, context = {}) {
  switch (kind) {
    case 'ping':
      return { ok: true };

    case 'diagnostic': {
      const next = WARM_UP[context.asked?.length ?? 0];
      if (!next) return { spoken_text: '', question: '', choices: [], prerequisite: '', enough_information: true };
      return {
        spoken_text: next.spoken_text,
        question: next.question,
        choices: next.choices,
        prerequisite: next.prerequisite,
        enough_information: false,
      };
    }

    case 'plan':
      return plan(context.answers ?? []);

    case 'module': {
      const variant = BY_TITLE[context.module?.title]?.variants[0];
      if (!variant) throw new Error(`The demo has no script for "${context.module?.title}".`);
      return { analogy: variant.analogy, turns: variant.turns };
    }

    case 'grade': {
      const variants = BY_TITLE[context.module?.title]?.variants;
      if (!variants) throw new Error(`The demo has no script for "${context.module?.title}".`);
      const attempt = context.attempt ?? 1;
      const asked = variants[(attempt - 1) % variants.length];
      const verdict = context.hesitated ? 'incorrect' : asked.grade(context.answer ?? '');
      if (verdict === 'correct') {
        return { assessment: { verdict, misconception: '' }, analogy: '', turns: [asked.praise] };
      }
      const reteach = variants[attempt % variants.length];
      return {
        assessment: { verdict, misconception: context.hesitated ? 'hesitated' : 'answer did not show the key idea' },
        analogy: reteach.analogy,
        turns: reteach.turns,
      };
    }

    case 'answer':
      return (ANSWERS.find((entry) => entry.when.test(context.question ?? '')) ?? { turn: FALLBACK_ANSWER }).turn;

    case 'reply': {
      // A prepared answer if the reply is a question the demo knows; otherwise acknowledge and move on.
      const known = /\?/.test(context.reply ?? '') && ANSWERS.find((entry) => entry.when.test(context.reply));
      if (known) return { ...known.turn, chalkboard_actions: [], pause_type: 'ask_if_following' };
      return say("Okay. The scripted demo can't weigh a reply the way a real model would, so I'll carry on from here.", [], 'continue');
    }

    default:
      throw new Error(`The demo cannot handle a "${kind}" request.`);
  }
}
