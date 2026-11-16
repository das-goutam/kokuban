/**
 * ChalkboardCanvas: the animated chalkboard and its speech sync.
 *
 * It is the "stage" the tutor engine performs on. Its imperative handle is
 * exactly the interface the engine expects:
 *
 *   perform(turn, { rate }) → Promise<{ completed }>
 *       Speaks turn.spoken_text and draws turn.chalkboard_actions while it is
 *       being said. Each action starts when the speech reaches its cue
 *       (SpeechSynthesis "boundary" events), is drawn stroke by stroke over
 *       the time until the next cue, and glows while it is the one being
 *       talked about.
 *   stop() → { wasSpeaking, charIndex, actionsStarted }
 *       Halts audio at once and reports where the teacher was cut off.
 *   draw(actions)   draw without speaking (welcome board)
 *   snapshot() / restore(snapshot) / reset() / describe()
 */
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { BOARD, ChalkScene } from '../board/chalkScene.js';
import { chalkFont } from '../board/chalkText.js';
import { planCues } from '../board/cues.js';

const CHARS_PER_SECOND = 14;
const NOT_SPEAKING = { wasSpeaking: false, charIndex: 0, actionsStarted: 0 };
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
/** Reduced motion: items appear at their cue instead of being drawn stroke by stroke. */
const STILL = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** How long an action would take to draw by hand, in ms. */
function naturalDuration(action) {
  if (action.type === 'write_text') return 300 + (action.content?.length ?? 0) * 48;
  if (action.type === 'highlight') return 650;
  if (action.type === 'draw_box') return 900 + (action.content?.length ?? 0) * 30;
  return 700;
}

export default function ChalkboardCanvas({ ref, speech, voice, timeScale = 1, onCaption }) {
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  const fontsRef = useRef(Promise.resolve());
  const currentRef = useRef(null); // the performance in progress, if any
  const drawRef = useRef(0); // cancels an older draw() when a newer one starts
  const liveRef = useRef({ voice, onCaption, timeScale });
  liveRef.current = { voice, onCaption, timeScale };
  const [written, setWritten] = useState(''); // board contents for screen readers

  useEffect(() => {
    const canvas = canvasRef.current;
    const scene = new ChalkScene(canvas);
    scene.speed = liveRef.current.timeScale;
    sceneRef.current = scene;

    const fit = () => scene.resize(canvas.clientWidth);
    const observer = new ResizeObserver(fit);
    observer.observe(canvas);
    fit();

    // Text is measured when it is placed, so the chalk font must be in before the first stroke.
    // On the hosted page the font stylesheet is a late <link>, so wait for stylesheets first.
    const sheets = [...document.querySelectorAll('link[rel="stylesheet"]')].map(
      (link) => link.sheet || new Promise((resolve) => ['load', 'error'].forEach((type) => link.addEventListener(type, resolve, { once: true }))),
    );
    fontsRef.current = Promise.race([
      Promise.all(sheets).then(() =>
        Promise.all([document.fonts.load(chalkFont(32), 'Aa πΣ∫√≈'), document.fonts.load(chalkFont(32), 'ωθ ≤≥')]),
      ),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]).catch(() => {});

    return () => {
      observer.disconnect();
      scene.destroy();
      speech.cancel();
    };
  }, [speech]);

  const stop = useCallback(() => {
    const performance = currentRef.current;
    currentRef.current = null;
    speech.cancel();
    const scene = sceneRef.current;
    scene?.finishAll();
    scene?.setActive(null);
    if (!performance) return NOT_SPEAKING;
    liveRef.current.onCaption?.({ text: performance.text, charIndex: performance.charIndex, charLength: 0, speaking: false });
    return { wasSpeaking: !performance.spoken, charIndex: performance.charIndex, actionsStarted: performance.started };
  }, [speech]);

  const perform = useCallback(
    async (turn, { rate = 1 } = {}) => {
      stop();
      drawRef.current += 1;
      const performance = { text: turn.spoken_text ?? '', charIndex: 0, started: 0, spoken: false };
      currentRef.current = performance;
      await fontsRef.current;
      const scene = sceneRef.current;
      if (!scene || currentRef.current !== performance) return { completed: false };

      const { voice: v, timeScale: scale } = liveRef.current;
      const speechRate = clamp((v?.rate ?? 1) * rate, 0.5, 2);
      const actions = turn.chalkboard_actions ?? [];
      const cues = planCues(performance.text, actions);
      const caption = (extra) => liveRef.current.onCaption?.({ text: performance.text, charIndex: performance.charIndex, charLength: 0, speaking: true, ...extra });

      const start = (i) => {
        const action = actions[i];
        const until = i + 1 < cues.length ? cues[i + 1] : performance.text.length;
        const spokenFor = ((until - cues[i]) / (CHARS_PER_SECOND * speechRate)) * 1000;
        const natural = naturalDuration(action);
        const duration = STILL ? 0 : clamp(spokenFor * 0.9, Math.min(450, natural), natural * 1.5);
        const id = scene.add(action, { duration });
        if (id) scene.setActive(id);
      };
      const reach = (charIndex) => {
        while (performance.started < actions.length && cues[performance.started] <= charIndex) start(performance.started++);
      };

      caption();
      reach(0);
      const speaking = speech.speak(performance.text, {
        voiceURI: v?.voiceURI,
        muted: v?.enabled === false,
        rate: speechRate,
        timeScale: scale,
        onBoundary: ({ charIndex, charLength }) => {
          if (currentRef.current !== performance) return;
          performance.charIndex = charIndex;
          reach(charIndex);
          caption({ charLength });
        },
      });
      await speaking.done;
      if (currentRef.current !== performance) return { completed: false };

      // The words are out. Draw whatever is left and let the chalk catch up.
      performance.spoken = true;
      performance.charIndex = performance.text.length;
      reach(Infinity);
      await scene.settle(1400);
      if (currentRef.current !== performance) return { completed: false };

      currentRef.current = null;
      scene.setActive(null);
      caption({ speaking: false });
      setWritten(scene.describe().join('. '));
      return { completed: true };
    },
    [speech, stop],
  );

  /** Replace the board with `actions`, written one after another, without speech. */
  const draw = useCallback(async (actions) => {
    const mine = ++drawRef.current;
    await fontsRef.current;
    const scene = sceneRef.current;
    const superseded = () => drawRef.current !== mine || sceneRef.current !== scene || currentRef.current;
    if (!scene || superseded()) return;
    scene.reset();
    for (const action of actions) {
      const duration = STILL ? 0 : naturalDuration(action);
      scene.add(action, { duration });
      await scene.sleep(duration * 0.85);
      if (superseded()) return;
    }
    setWritten(scene.describe().join('. '));
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      perform,
      stop,
      draw,
      snapshot: () => sceneRef.current.snapshot(),
      restore: (snapshot) => sceneRef.current.restore(snapshot),
      describe: () => sceneRef.current?.describe() ?? [],
      reset() {
        stop();
        sceneRef.current?.reset();
        setWritten('');
      },
    }),
    [perform, stop, draw],
  );

  return (
    <>
      <canvas
        ref={canvasRef}
        className="block w-full rounded-[3px]"
        style={{ aspectRatio: `${BOARD.width} / ${BOARD.height}` }}
        role="img"
        aria-label="Chalkboard"
        aria-describedby="chalkboard-contents"
      />
      <p id="chalkboard-contents" className="sr-only">
        {written ? `On the board: ${written}` : 'The board is empty.'}
      </p>
    </>
  );
}
