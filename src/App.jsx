/**
 * Application shell: the chalkboard, the desk under it (captions and the
 * controls for whatever the lesson is waiting for), the notebook beside it,
 * and the settings drawer.
 *
 * All lesson logic lives in engine/tutorEngine.js. This file only renders
 * the engine's view and forwards what the student does.
 */
import { FileText, Hand, Mic, Play, RotateCcw, SendHorizontal, Settings, Volume2, VolumeX, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import ChalkboardCanvas from './components/ChalkboardCanvas.jsx';
import Notebook, { MathText } from './components/Notebook.jsx';
import SettingsDrawer from './components/SettingsDrawer.jsx';
import { STAGES, STATES } from './engine/tutorEngine.js';
import { useTutor } from './hooks/useTutor.js';
import { useSettings } from './lib/settings.js';
import { readDocument } from './services/documentReader.js';
import { resolveConfig } from './services/llmService.js';

/** ?speed=8 runs the silent mode and the chalk faster (demos, automated tests). */
const TIME_SCALE = Math.min(40, Math.max(0.25, Number(new URLSearchParams(window.location.search).get('speed')) || 1));

const STAGE_LABELS = {
  [STATES.INTAKE]: 'About you',
  [STATES.DIAGNOSTIC]: 'Warm-up',
  [STATES.CURRICULUM]: 'Roadmap',
  [STATES.TEACHING]: 'Lesson',
  [STATES.CHECK]: 'Check',
};

const primaryButton =
  'inline-flex items-center justify-center gap-2 rounded-md bg-slate px-5 py-3 font-semibold text-chalk hover:bg-slate-deep disabled:opacity-40';
const quietButton =
  'inline-flex items-center justify-center gap-2 rounded-md border border-line bg-white px-4 py-3 font-semibold hover:bg-wall disabled:opacity-40';
const inputClass =
  'min-w-0 flex-1 rounded-md border border-line bg-white px-4 py-3 text-ink placeholder:text-ink-soft/70 disabled:bg-wall';

/* ------------------------------------------------------------------ */

function Stepper({ state }) {
  const done = state === STATES.COMPLETE;
  const position = STAGES.indexOf(state);
  return (
    <ol className="flex flex-wrap items-center gap-x-0.5 gap-y-1 text-[0.82rem]" aria-label="Lesson stages" data-state={state}>
      {STAGES.map((stage, i) => {
        const current = stage === state;
        const passed = done || i < position;
        return (
          <li key={stage} className="flex items-center gap-1" aria-current={current ? 'step' : undefined} title={stage}>
            {i > 0 && <span aria-hidden="true" className={`h-px w-2.5 ${passed || current ? 'bg-slate' : 'bg-line'}`} />}
            <span
              className={`flex items-center gap-1.5 rounded-full py-1 pl-1 pr-2.5 ${
                current ? 'bg-slate text-chalk' : passed ? 'text-ink' : 'text-ink-soft'
              }`}
            >
              <span
                className={`grid size-5 place-items-center rounded-full text-xs font-semibold ${
                  current ? 'bg-chalk text-slate' : passed ? 'bg-slate text-chalk' : 'border border-line'
                }`}
              >
                {i + 1}
              </span>
              {STAGE_LABELS[stage]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Caption({ caption, view }) {
  if (view.activity === 'thinking') {
    return (
      <p className="text-ink-soft">
        {view.note || 'Thinking'}
        <span className="thinking-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </p>
    );
  }
  if (view.check && view.awaiting === 'check_answer' && view.activity === 'waiting') {
    return (
      <p>
        <span className="block text-sm font-semibold text-ink-soft">
          Check question{view.check.attempt > 1 ? `, attempt ${view.check.attempt}` : ''}
        </span>
        <span className="font-hand text-[1.15rem]">
          <MathText text={view.check.question} />
        </span>
      </p>
    );
  }
  if (!caption?.text) return <p className="text-ink-soft">The teacher's words appear here as they are spoken.</p>;
  const { text, charIndex, charLength, speaking } = caption;
  if (!speaking) return <p>{text}</p>;
  return (
    <p aria-hidden="true">
      <span>{text.slice(0, charIndex)}</span>
      {charLength > 0 && (
        <span className="-mx-0.5 rounded-sm bg-signal/70 px-0.5">{text.slice(charIndex, charIndex + charLength)}</span>
      )}
      <span className="text-ink-soft/70">{text.slice(charIndex + charLength)}</span>
    </p>
  );
}

const ACTIVITY = {
  speaking: { label: 'Teaching', dot: 'bg-slate' },
  waiting: { label: 'Your turn', dot: 'bg-signal-deep' },
  thinking: { label: 'Thinking', dot: 'bg-ink-soft' },
  listening: { label: 'Listening to you', dot: 'bg-alarm' },
  idle: { label: 'Ready', dot: 'bg-line' },
};

const OTHER = '__other__';
const TOPICS = [
  'Fourier series',
  "Bayes' rule",
  'Derivatives and rates of change',
  'Eigenvalues and eigenvectors',
  'How neural networks learn',
  'Recursion in programming',
  'Supply and demand',
  'Photosynthesis',
];
const AGES = ['Under 13', '13 to 15', '16 to 18', '19 to 22', '23 to 30', '31 to 45', '46 or older'];
const BACKGROUNDS = [
  'Middle school',
  'High school',
  'Undergraduate, first or second year',
  'Undergraduate, third or fourth year',
  'Graduate student',
  'Working in a technical field',
  'Working in a non-technical field',
];

/** A dropdown of common answers, with "something else" opening a text field. */
function PickOrType({ label, options, value, onChange, otherLabel, placeholder, disabled }) {
  const listed = options.includes(value);
  const [typing, setTyping] = useState(false);
  const other = typing || (value !== '' && !listed);
  return (
    <div className="min-w-0 space-y-2">
      <select
        className={`${inputClass} w-full`}
        aria-label={label}
        value={other ? OTHER : value}
        disabled={disabled}
        required
        onChange={(event) => {
          const picked = event.target.value;
          setTyping(picked === OTHER);
          onChange(picked === OTHER ? '' : picked);
        }}
      >
        <option value="" disabled>
          Choose
        </option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
        <option value={OTHER}>{otherLabel}</option>
      </select>
      {other && (
        <input
          className={`${inputClass} w-full`}
          aria-label={`${label}: your own`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          required
          autoFocus
        />
      )}
    </div>
  );
}

function IntakeForm({ demo, providerLabel, onSubmit }) {
  const [topic, setTopic] = useState('');
  const [age, setAge] = useState('');
  const [background, setBackground] = useState('');
  const [file, setFile] = useState(null); // { name, text, detail } once read
  const [fileStatus, setFileStatus] = useState(null); // { tone, text }
  const fileInput = useRef(null);

  const pickFile = async (event) => {
    const picked = event.target.files?.[0];
    event.target.value = '';
    if (!picked) return;
    setFileStatus({ tone: 'busy', text: `Reading ${picked.name}` });
    try {
      const read = await readDocument(picked);
      setFile(read);
      setTopic('');
      setFileStatus(null);
    } catch (error) {
      setFile(null);
      setFileStatus({ tone: 'bad', text: error.message || 'That file could not be read.' });
    }
  };
  const submit = (event) => {
    event.preventDefault();
    onSubmit({ topic: demo ? 'Fourier series' : topic, age, background, document: demo ? null : file });
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 md:grid-cols-[minmax(0,1.1fr)_minmax(0,0.6fr)_minmax(0,1.1fr)]">
        <div className="min-w-0">
          <span className="mb-1 block font-semibold">{file && !demo ? 'What should the class focus on?' : 'What do you want to learn?'}</span>
          {file && !demo ? (
            <input
              className={`${inputClass} w-full`}
              aria-label="Focus"
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              placeholder="Optional: a chapter, a method, a result"
            />
          ) : demo ? (
            <select className={`${inputClass} w-full`} aria-label="Topic" disabled value="demo">
              <option value="demo">Fourier series (demo lesson)</option>
            </select>
          ) : (
            <PickOrType
              label="Topic"
              options={TOPICS}
              value={topic}
              onChange={setTopic}
              otherLabel="Something else (type it)"
              placeholder="One topic or concept, as exact as you can"
            />
          )}
        </div>
        <div className="min-w-0">
          <span className="mb-1 block font-semibold">Your age</span>
          <PickOrType label="Your age" options={AGES} value={age} onChange={setAge} otherLabel="Type it" placeholder="Age" />
        </div>
        <div className="min-w-0">
          <span className="mb-1 block font-semibold">Your background</span>
          <PickOrType
            label="Your education or background"
            options={BACKGROUNDS}
            value={background}
            onChange={setBackground}
            otherLabel="Something else (type it)"
            placeholder="e.g. self-taught programmer, nurse, retired engineer"
          />
        </div>
      </div>
      {!demo && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <input ref={fileInput} type="file" className="sr-only" tabIndex={-1} aria-label="Study file" accept=".pdf,.docx,.txt,.md,.tex,text/*,application/pdf" onChange={pickFile} />
          {file ? (
            <>
              <span className="inline-flex min-w-0 items-center gap-2 rounded-md bg-wall px-3 py-2 font-semibold">
                <FileText className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{file.name}</span>
                <span className="shrink-0 font-normal text-ink-soft">
                  {file.detail}, {Math.round(file.text.length / 1000)}k characters
                </span>
                <button type="button" className="rounded p-0.5 hover:bg-wall-deep" onClick={() => setFile(null)} aria-label="Remove the file">
                  <X className="size-4" />
                </button>
              </span>
              <span className="text-ink-soft">The class will be taught from this file. Its text is read here in your browser and sent in parts to {providerLabel}.</span>
            </>
          ) : (
            <>
              <button type="button" className={`${quietButton} py-2`} onClick={() => fileInput.current?.click()} disabled={fileStatus?.tone === 'busy'}>
                <FileText className="size-4" aria-hidden="true" />
                Study from your own file
              </button>
              <span className={fileStatus?.tone === 'bad' ? 'text-alarm' : 'text-ink-soft'} role="status">
                {fileStatus?.text ?? 'Optional. A PDF, Word (.docx) or text file: a paper, a report, lecture notes.'}
              </span>
            </>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <button type="submit" className={primaryButton} disabled={fileStatus?.tone === 'busy'}>
          <Play className="size-4" aria-hidden="true" />
          Begin with a few warm-up questions
        </button>
        {demo && (
          <p className="min-w-0 flex-1 text-sm text-ink-soft">
            Demo mode teaches one prepared topic. Choose another option in Settings to learn anything.
          </p>
        )}
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */

export default function App() {
  const [settings, update] = useSettings();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { view, engine, llm, speech, boardRef, caption, setCaption } = useTutor(settings, { timeScale: TIME_SCALE });
  const [draft, setDraft] = useState('');
  const [listening, setListening] = useState(false);
  const [micError, setMicError] = useState('');
  const micRef = useRef(null);
  const inputRef = useRef(null);
  // Which voice engines this view has. On a hosted page they resolve a moment after load.
  const [voiceInfo, setVoiceInfo] = useState(() => speech.info());
  useEffect(() => {
    let alive = true;
    speech.ready.then(() => alive && setVoiceInfo(speech.info()));
    return () => {
      alive = false;
    };
  }, [speech]);

  const provider = resolveConfig(settings);
  const demo = provider.kind === 'demo';
  const { state, activity, awaiting } = view;
  const inLesson = state === STATES.TEACHING || state === STATES.CHECK;
  const atPause = awaiting === 'continue' && activity === 'waiting';
  const wantsText = awaiting === 'diagnostic_answer' || awaiting === 'check_answer' || awaiting === 'question' || atPause;

  /* ---- what the student can do ---- */

  const send = useCallback(
    (text) => {
      const value = String(text ?? '').trim();
      const now = engine.getView().awaiting;
      if (now === 'diagnostic_answer') engine.submitDiagnosticAnswer(value);
      else if (now === 'check_answer' && value) engine.submitCheckAnswer(value);
      else if (now === 'question' && value) engine.askQuestion(value);
      else if (now === 'continue' && value) engine.reply(value);
      else return;
      setDraft('');
    },
    [engine],
  );

  const stopDictation = () => micRef.current?.stop();

  /** Speech to text into the answer box. A spoken question is sent at once; a graded answer waits for Enter. */
  const dictate = useCallback(() => {
    if (micRef.current) return;
    setMicError('');
    setListening(true);
    const session = speech.listen({ onInterim: setDraft });
    micRef.current = session;
    session.result
      .then((text) => {
        if (!text) return;
        setDraft(text);
        if (engine.getView().awaiting === 'question') send(text);
      })
      .catch((error) => setMicError(error.message))
      .finally(() => {
        micRef.current = null;
        setListening(false);
      });
  }, [engine, send, speech]);

  const interrupt = useCallback(
    ({ byVoice = false } = {}) => {
      if (!engine.interrupt()) return;
      setDraft('');
      if (byVoice) dictate();
    },
    [dictate, engine],
  );

  const restart = () => {
    stopDictation();
    setDraft('');
    engine.reset();
  };

  /* ---- effects ---- */

  // Escape raises a hand, from anywhere outside a text field.
  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape' || drawerOpen) return;
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select')) return;
      if (!engine.getView().canInterrupt) return;
      event.preventDefault(); // this Escape is ours: on a hosted page it must not also count as "stop reading"
      interrupt();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen, engine, interrupt]);

  // Put the cursor where the student is expected to type.
  useEffect(() => {
    if (wantsText) inputRef.current?.focus();
  }, [wantsText, awaiting]);

  // Hesitation: silence on a check question is treated as "not yet understood".
  const hesitationSeconds = settings.pacing.hesitationSeconds;
  useEffect(() => {
    const armed = state === STATES.CHECK && awaiting === 'check_answer' && activity === 'waiting';
    if (!armed || !hesitationSeconds || listening || drawerOpen) return undefined;
    const timer = setTimeout(() => engine.hesitate(), hesitationSeconds * 1000);
    return () => clearTimeout(timer);
  }, [state, awaiting, activity, hesitationSeconds, listening, drawerOpen, draft, engine]);

  /* ---- render ---- */

  const status = ACTIVITY[activity] ?? ACTIVITY.idle;
  const choices = awaiting === 'diagnostic_answer' ? view.diagnostic.choices : [];
  const placeholder =
    awaiting === 'question'
      ? 'Ask your question'
      : awaiting === 'check_answer'
        ? 'Your answer, in your own words'
        : atPause
          ? 'Answer, or ask something (optional)'
          : choices.length
            ? 'Or type your own answer'
            : 'Your answer';
  const setRate = (step) => update('voice.rate', Math.min(1.3, Math.max(0.7, Math.round((settings.voice.rate + step) * 20) / 20)));

  return (
    <div className="min-h-dvh bg-wall px-5 lg:px-8">
      <header className="app-shell flex flex-wrap items-center gap-x-5 gap-y-3 pt-4">
        <h1 className="font-hand text-2xl font-semibold leading-none" title="Kokuban is Japanese for blackboard. Proof of concept.">
          Kokuban
        </h1>
        <Stepper state={state} />
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className="rounded-md border border-line bg-paper px-3 py-2 text-sm hover:bg-white"
            onClick={() => setDrawerOpen(true)}
            title="Change the language model"
          >
            <span className="sr-only">Language model: </span>
            <span className="block max-w-44 truncate font-semibold">
              {demo ? 'Demo lesson' : provider.kind === 'claude' ? 'Claude' : provider.model || 'No model set'}
            </span>
          </button>
          <button
            type="button"
            className="rounded-md border border-line bg-paper p-2 hover:bg-white"
            onClick={() => {
              if (settings.voice.enabled) speech.hush(); // cut the sound now; captions carry on
              update('voice.enabled', !settings.voice.enabled);
            }}
            aria-pressed={settings.voice.enabled}
            aria-label={settings.voice.enabled ? 'Turn the voice off' : 'Turn the voice on'}
            title={settings.voice.enabled ? 'Voice is on' : 'Voice is off (captions only)'}
          >
            {settings.voice.enabled ? <Volume2 className="size-5" /> : <VolumeX className="size-5" />}
          </button>
          {state !== STATES.INTAKE && (
            <button type="button" className="rounded-md border border-line bg-paper p-2 hover:bg-white" onClick={restart} aria-label="Start over" title="Start over">
              <RotateCcw className="size-5" />
            </button>
          )}
          <button type="button" className="rounded-md border border-line bg-paper p-2 hover:bg-white" onClick={() => setDrawerOpen(true)} aria-label="Settings" title="Settings">
            <Settings className="size-5" />
          </button>
        </div>
      </header>

      <main className="app-shell grid items-start gap-7 pb-12 pt-4 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="min-w-0">
          <div className="board-frame">
            <ChalkboardCanvas ref={boardRef} speech={speech} voice={settings.voice} timeScale={TIME_SCALE} onCaption={setCaption} />
          </div>
          <div className="board-tray" aria-hidden="true">
            <i style={{ left: '9%', width: 46, background: '#f4f1e6' }} />
            <i style={{ left: '17%', width: 30, background: '#f7d96b' }} />
            <i style={{ right: '11%', width: 38, background: '#a5d3f2' }} />
          </div>

          {/* The desk: what the teacher is saying, and what the lesson is waiting for. */}
          <section className="mt-5 rounded-lg border border-line bg-paper" aria-label="Lesson controls">
            <div className="flex min-h-[5.25rem] items-start gap-4 px-5 py-4">
              <span className="mt-1 flex w-28 shrink-0 items-center gap-2 text-sm font-semibold" data-activity={activity}>
                <span className={`size-2.5 rounded-full ${status.dot}`} aria-hidden="true" />
                {status.label}
              </span>
              <div className="min-w-0 flex-1 text-[1.02rem] leading-relaxed">
                <Caption caption={caption} view={view} />
                <p className="sr-only" aria-live="polite">
                  {caption?.text}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1 text-sm" role="group" aria-label="Speaking speed">
                <button type="button" className="rounded-md border border-line bg-white px-2 py-1 hover:bg-wall" onClick={() => setRate(-0.05)} aria-label="Speak slower" title="Speak slower">
                  Slower
                </button>
                <span className="w-11 text-center tabular-nums text-ink-soft">{settings.voice.rate.toFixed(2)}×</span>
                <button type="button" className="rounded-md border border-line bg-white px-2 py-1 hover:bg-wall" onClick={() => setRate(0.05)} aria-label="Speak faster" title="Speak faster">
                  Faster
                </button>
              </div>
            </div>

            <div className="space-y-4 border-t border-line px-5 py-4 empty:hidden">
              {view.error && (
                <div role="alert" className="rounded-md border border-alarm/40 bg-alarm/5 px-4 py-3">
                  <p className="font-semibold text-alarm">{view.error.message}</p>
                  {view.error.hint && <p className="mt-1 text-sm">{view.error.hint}</p>}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {view.canRetry && (
                      <button type="button" className={primaryButton} onClick={() => engine.retry()}>
                        Try again
                      </button>
                    )}
                    <button type="button" className={quietButton} onClick={() => setDrawerOpen(true)}>
                      Open settings
                    </button>
                  </div>
                </div>
              )}

              {awaiting === 'intake' && <IntakeForm demo={demo} providerLabel={provider.kind === 'claude' ? 'Claude' : provider.label} onSubmit={engine.submitIntake} />}

              {awaiting === 'start' && (
                <button type="button" className={`${primaryButton} px-7 text-lg`} onClick={() => engine.startLesson()}>
                  <Play className="size-5" aria-hidden="true" />
                  Start lesson
                </button>
              )}

              {awaiting === 'restart' && (
                <button type="button" className={primaryButton} onClick={restart}>
                  <RotateCcw className="size-4" aria-hidden="true" />
                  Learn something else
                </button>
              )}

              {choices.length > 0 && (
                <div className="flex flex-wrap gap-2" role="group" aria-label="Pick an answer">
                  {choices.map((choice) => (
                    <button key={choice} type="button" className={`${quietButton} font-hand text-[1.05rem] font-normal`} onClick={() => send(choice)}>
                      <MathText text={choice} />
                    </button>
                  ))}
                  <button type="button" className={quietButton} onClick={() => send('')}>
                    I don't know
                  </button>
                </div>
              )}

              {wantsText && (
                <form
                  className="flex flex-wrap gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    send(draft);
                  }}
                >
                  <input
                    ref={inputRef}
                    className={inputClass}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(event) => {
                      // At a pause, Enter on an empty box means "go on".
                      if (event.key === 'Enter' && atPause && !draft.trim()) {
                        event.preventDefault();
                        engine.continueLesson();
                      }
                    }}
                    placeholder={listening ? 'Listening…' : placeholder}
                    aria-label={placeholder}
                    autoComplete="off"
                  />
                  {voiceInfo.canListen && (
                    <button
                      type="button"
                      className={`${quietButton} px-3 ${listening ? 'is-listening border-alarm text-alarm' : ''}`}
                      onClick={listening ? stopDictation : dictate}
                      aria-pressed={listening}
                      aria-label={listening ? 'Stop listening' : 'Speak instead of typing'}
                      title={listening ? 'Stop listening' : 'Speak instead of typing'}
                    >
                      <Mic className="size-5" />
                    </button>
                  )}
                  <button type="submit" className={atPause ? quietButton : primaryButton} disabled={!draft.trim() && (awaiting !== 'diagnostic_answer' || choices.length > 0)}>
                    <SendHorizontal className="size-4" aria-hidden="true" />
                    {awaiting === 'question' ? 'Ask' : atPause ? 'Reply' : 'Answer'}
                  </button>
                </form>
              )}
              {micError && <p className="text-sm text-alarm">{micError}</p>}

              {(inLesson || awaiting === 'diagnostic_answer') && (
                <div className="flex flex-wrap items-center gap-3">
                  {inLesson && awaiting !== 'question' && !atPause && (
                    <>
                      <button
                        type="button"
                        className="inline-flex items-center gap-2.5 rounded-md bg-signal px-5 py-3 text-lg font-semibold text-ink shadow-[0_3px_0_var(--color-signal-deep)] hover:brightness-105 active:translate-y-px active:shadow-[0_2px_0_var(--color-signal-deep)] disabled:opacity-45 disabled:shadow-none"
                        onClick={() => interrupt()}
                        disabled={!view.canInterrupt}
                        title="Stops the teacher at once (Esc)"
                      >
                        <Hand className="size-5" aria-hidden="true" />
                        {awaiting === 'check_answer' ? 'Ask about this first' : 'Interrupt / ask a question'}
                      </button>
                      {voiceInfo.canListen && (
                        <button
                          type="button"
                          className="inline-flex items-center justify-center rounded-md bg-signal p-3.5 text-ink shadow-[0_3px_0_var(--color-signal-deep)] hover:brightness-105 disabled:opacity-45 disabled:shadow-none"
                          onClick={() => interrupt({ byVoice: true })}
                          disabled={!view.canInterrupt}
                          aria-label="Interrupt and ask out loud"
                          title="Interrupt and ask out loud"
                        >
                          <Mic className="size-5" />
                        </button>
                      )}
                    </>
                  )}

                  {awaiting === 'question' && (
                    <button type="button" className={quietButton} onClick={() => engine.resumeLesson()}>
                      Never mind, carry on
                    </button>
                  )}
                  {awaiting === 'check_answer' && (
                    <button type="button" className={quietButton} onClick={() => engine.hesitate()}>
                      I'm not sure
                    </button>
                  )}
                  {awaiting === 'diagnostic_answer' && choices.length === 0 && (
                    <button type="button" className={quietButton} onClick={() => send('')}>
                      I don't know
                    </button>
                  )}
                  {view.canRepeat && (awaiting === 'continue' || awaiting === 'check_answer' || awaiting === 'diagnostic_answer') && (
                    <button type="button" className={quietButton} onClick={() => engine.repeat()}>
                      <RotateCcw className="size-4" aria-hidden="true" />
                      Say that again
                    </button>
                  )}

                  {awaiting === 'continue' && (
                    <button type="button" className={`${primaryButton} ml-auto px-7 text-lg`} onClick={() => engine.continueLesson()} disabled={activity !== 'waiting'}>
                      Go on
                    </button>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>

        <Notebook view={view} />
      </main>

      <SettingsDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} settings={settings} update={update} llm={llm} speech={speech} />
    </div>
  );
}
