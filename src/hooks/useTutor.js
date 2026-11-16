/** Wires the tutor engine to React: live settings in, an immutable view out. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createTutorEngine } from '../engine/tutorEngine.js';
import { createLlmService } from '../services/llmService.js';
import { createSpeechService } from '../services/speechService.js';

const WELCOME_BOARD = [
  { type: 'write_text', content: 'Welcome!', x: 8, y: 14, size: 'large', color: 'yellow' },
  { type: 'write_text', content: 'What would you like to learn today?', x: 8, y: 36 },
  { type: 'write_text', content: "tell me below, and I'll take it from there", x: 8, y: 52, size: 'small', color: 'blue' },
];

const NOT_SPEAKING = { wasSpeaking: false, charIndex: 0, actionsStarted: 0 };

export function useTutor(settings, { timeScale = 1 } = {}) {
  const boardRef = useRef(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const speech = useMemo(() => createSpeechService(), []);
  const [caption, setCaption] = useState(null);

  const [{ engine, llm }] = useState(() => {
    const service = createLlmService(() => settingsRef.current);
    const board = () => boardRef.current;
    // The engine's stage is the chalkboard component (voice + board in sync).
    const stage = {
      perform: (turn, options) => board()?.perform(turn, options) ?? Promise.resolve({ completed: false }),
      stop: () => board()?.stop() ?? NOT_SPEAKING,
      snapshot: () => board()?.snapshot() ?? { items: [] },
      restore: (snapshot) => board()?.restore(snapshot) ?? Promise.resolve(),
      describe: () => board()?.describe() ?? [],
      reset: () => {
        board()?.reset();
        board()?.draw(WELCOME_BOARD);
        setCaption(null);
      },
    };
    return { llm: service, engine: createTutorEngine({ llm: service, stage, config: { timeScale } }) };
  });

  const view = useSyncExternalStore(engine.subscribe, engine.getView);

  useEffect(() => {
    boardRef.current?.draw(WELCOME_BOARD);
  }, []);

  return { view, engine, llm, speech, boardRef, caption, setCaption };
}
