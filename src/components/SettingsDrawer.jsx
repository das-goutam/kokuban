/**
 * Settings drawer: choose the language model (and paste its API key), the
 * voice, and how long the teacher waits before stepping in on a check question.
 */
import { Eye, EyeOff, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { DEPTHS, JSON_MODES, PROVIDERS, availableProviders, isHosted, resolveConfig } from '../services/llmService.js';
import { CLAUDE_VOICES } from '../services/speechService.js';

const DEPTH_LABELS = { balanced: 'Balanced (recommended)', fast: 'Fast', thorough: 'Thorough (slower)' };
const DEPTH_HINTS = {
  balanced: 'Quick replies to your questions; more thought for planning, lesson scripts and grading.',
  fast: 'The quickest replies at every step. Explanations and grading may be less careful.',
  thorough: 'More thought at every step. Expect longer pauses before the teacher answers.',
};

const fieldClass =
  'w-full rounded-md border border-line bg-white px-3 py-2 text-[0.95rem] text-ink placeholder:text-ink-soft/70 disabled:bg-wall';
const quietButton = 'rounded-md border border-line bg-white px-3 py-2 text-sm font-semibold hover:bg-wall disabled:opacity-50';

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-semibold">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-sm text-ink-soft">{hint}</span>}
    </label>
  );
}

function ProviderFields({ id, settings, update, llm }) {
  const preset = PROVIDERS[id];
  const own = settings.providers[id] ?? {};
  const set = (key) => (event) => update(`providers.${id}.${key}`, event.target.value);
  const listId = useId();
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState(preset.models ?? []);
  const [status, setStatus] = useState(null); // { tone, text }
  const [busy, setBusy] = useState('');

  useEffect(() => {
    setModels(preset.models ?? []);
    setStatus(null);
  }, [id, preset.models]);

  async function attempt(name, work) {
    setBusy(name);
    setStatus(null);
    try {
      setStatus({ tone: 'good', text: await work() });
    } catch (error) {
      setStatus({ tone: 'bad', text: [error.message, error.hint].filter(Boolean).join(' ') });
    } finally {
      setBusy('');
    }
  }

  const loadModels = () =>
    attempt('models', async () => {
      const found = await llm.listModels();
      setModels(found);
      return found.length ? `${found.length} models found. Pick one from the Model field.` : 'The provider returned no models.';
    });
  const test = () =>
    attempt('test', async () => {
      const result = await llm.testConnection();
      return `Connected to ${result.label} (${result.model}) in ${result.ms} ms.`;
    });

  const testRow = (
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className={quietButton} onClick={test} disabled={Boolean(busy)}>
        {busy === 'test' ? 'Testing' : 'Test connection'}
      </button>
      {status && (
        <p role="status" className={`min-w-0 flex-1 text-sm ${status.tone === 'bad' ? 'text-alarm' : 'text-ink'}`}>
          {status.text}
        </p>
      )}
    </div>
  );

  if (preset.kind === 'demo') {
    return (
      <p className="text-ink-soft">
        The demo plays a scripted lesson on Fourier series, with keyword grading and a few prepared answers. Choose
        another option above to learn any topic.
      </p>
    );
  }

  if (preset.kind === 'claude') {
    return (
      <div className="space-y-4">
        <p className="text-ink-soft">
          Claude writes and grades the lesson. Each step uses a little of your own Claude usage, and the first one
          asks for your permission.
        </p>
        <Field label="Speed and depth" hint={DEPTH_HINTS[own.depth] ?? DEPTH_HINTS.balanced}>
          <select className={fieldClass} value={own.depth ?? 'balanced'} onChange={set('depth')}>
            {DEPTHS.map((depth) => (
              <option key={depth} value={depth}>
                {DEPTH_LABELS[depth]}
              </option>
            ))}
          </select>
        </Field>
        {testRow}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {id === 'custom' && (
        <Field label="Base URL" hint='Up to and including "/v1". The app adds "/chat/completions".'>
          <input className={fieldClass} value={own.baseUrl ?? ''} onChange={set('baseUrl')} placeholder="https://api.example.com/v1" spellCheck={false} />
        </Field>
      )}

      <Field
        label="API key"
        hint={
          preset.keyUrl ? (
            <>
              Get one at{' '}
              <a className="underline" href={preset.keyUrl} target="_blank" rel="noreferrer">
                {new URL(preset.keyUrl).host}
              </a>
              . It is stored in this browser only and sent straight to {preset.label}.
            </>
          ) : (
            'Stored in this browser only. Leave empty for a local server without a key.'
          )
        }
      >
        <span className="flex gap-2">
          <input
            className={fieldClass}
            type={showKey ? 'text' : 'password'}
            value={own.apiKey ?? ''}
            onChange={set('apiKey')}
            placeholder="Paste your key"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" className={quietButton} onClick={() => setShowKey((v) => !v)} aria-label={showKey ? 'Hide key' : 'Show key'}>
            {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </span>
      </Field>

      <Field label="Model" hint={preset.model ? `Leave empty to use ${preset.model}.` : 'The model ID your endpoint expects.'}>
        <span className="flex gap-2">
          <input className={fieldClass} list={listId} value={own.model ?? ''} onChange={set('model')} placeholder={preset.model || 'model-id'} spellCheck={false} />
          <button type="button" className={`${quietButton} shrink-0`} onClick={loadModels} disabled={Boolean(busy)}>
            {busy === 'models' ? 'Loading' : 'Load models'}
          </button>
        </span>
        <datalist id={listId}>
          {models.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      </Field>

      <details>
        <summary className="cursor-pointer text-sm font-semibold">Advanced</summary>
        <div className="mt-3 space-y-4">
          {id !== 'custom' && (
            <Field label="Base URL">
              <input className={fieldClass} value={own.baseUrl ?? ''} onChange={set('baseUrl')} placeholder={preset.baseUrl} spellCheck={false} />
            </Field>
          )}
          {preset.kind === 'openai' && (
            <Field label="JSON mode" hint="Auto tries a strict schema, then JSON mode, then prompt-only, and remembers what the endpoint accepts.">
              <select className={fieldClass} value={own.jsonMode ?? 'auto'} onChange={set('jsonMode')}>
                {JSON_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {preset.kind === 'openai' && (
            <Field label="Extra headers (JSON)">
              <input className={fieldClass} value={own.headers ?? ''} onChange={set('headers')} placeholder='{"x-header": "value"}' spellCheck={false} />
            </Field>
          )}
          <Field label="Extra request fields (JSON)" hint="Merged into every request body, for example a reasoning or thinking level.">
            <input className={fieldClass} value={own.extraBody ?? ''} onChange={set('extraBody')} placeholder="{}" spellCheck={false} />
          </Field>
        </div>
      </details>

      {testRow}
    </div>
  );
}

function VoiceFields({ settings, update, speech }) {
  const [voices, setVoices] = useState([]);
  const [info, setInfo] = useState(() => speech.info());
  useEffect(() => {
    let alive = true;
    speech.voices().then((list) => alive && setVoices(list));
    speech.ready.then(() => alive && setInfo(speech.info()));
    return () => {
      alive = false;
    };
  }, [speech]);

  const sample = () =>
    speech.speak("Hello. I'll talk at this pace, and stop whenever you raise your hand.", {
      voiceURI: settings.voice.voiceURI,
      rate: settings.voice.rate,
    });
  const noVoice = !info.claudeVoice && (!info.browserVoice || voices.length === 0);

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-3">
        <input type="checkbox" className="size-5 accent-slate" checked={settings.voice.enabled} onChange={(e) => update('voice.enabled', e.target.checked)} />
        <span>Speak out loud</span>
      </label>
      {noVoice && (
        <p className="text-sm text-ink-soft">No voice has been found in this browser yet. Captions and the board run without one.</p>
      )}
      <Field label="Voice">
        <select className={fieldClass} value={settings.voice.voiceURI} onChange={(e) => update('voice.voiceURI', e.target.value)}>
          <option value="">{info.claudeVoice ? 'Claude voice (default)' : 'Best available English voice'}</option>
          {info.claudeVoice && (
            <optgroup label="Claude voices">
              {CLAUDE_VOICES.map((name) => (
                <option key={name} value={`claude:${name}`}>
                  {name[0].toUpperCase() + name.slice(1)}
                </option>
              ))}
            </optgroup>
          )}
          {voices.length > 0 && (
            <optgroup label="This browser's voices">
              {voices.map((voice) => (
                <option key={voice.voiceURI} value={voice.voiceURI}>
                  {voice.name} ({voice.lang})
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </Field>
      <Field label={`Speaking speed: ${settings.voice.rate.toFixed(2)}×`}>
        <input
          type="range"
          className="w-full accent-slate"
          min="0.7"
          max="1.3"
          step="0.05"
          value={settings.voice.rate}
          onChange={(e) => update('voice.rate', Number(e.target.value))}
        />
      </Field>
      <button type="button" className={quietButton} onClick={sample}>
        Play a sample
      </button>
    </div>
  );
}

export default function SettingsDrawer({ open, onClose, settings, update, llm, speech }) {
  const panelRef = useRef(null);
  const current = resolveConfig(settings).id;

  useEffect(() => {
    if (!open) return undefined;
    panelRef.current?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" className="absolute inset-0 cursor-default bg-slate-deep/50" aria-label="Close settings" onClick={onClose} />
      <section
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="relative flex h-full w-full max-w-md flex-col overflow-y-auto bg-paper shadow-2xl outline-none"
      >
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-paper px-6 py-4">
          <h2 id="settings-title" className="text-xl font-semibold">
            Settings
          </h2>
          <button type="button" className="rounded-md p-2 hover:bg-wall" onClick={onClose} aria-label="Close settings">
            <X className="size-5" />
          </button>
        </header>

        <div className="space-y-9 px-6 py-6">
          <section className="space-y-4">
            <h3 className="text-lg font-semibold">Language model</h3>
            <div role="radiogroup" aria-label="Provider" className="grid gap-2">
              {availableProviders().map((provider) => {
                const selected = current === provider.id;
                return (
                  <label
                    key={provider.id}
                    className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 ${selected ? 'border-slate bg-wall' : 'border-line bg-white hover:bg-wall/60'}`}
                  >
                    <input
                      type="radio"
                      name="provider"
                      className="mt-1 size-4 accent-slate"
                      checked={selected}
                      onChange={() => update('provider', provider.id)}
                    />
                    <span>
                      <span className="block font-semibold">{provider.label}</span>
                      <span className="block text-sm text-ink-soft">{provider.blurb}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <ProviderFields id={current} settings={settings} update={update} llm={llm} />
            <p className="text-sm text-ink-soft">
              {isHosted()
                ? 'This hosted page cannot call other AI services. To use Gemini, Groq or your own endpoint, run the app locally.'
                : 'Built-in Claude, with no key, is available when the app is opened as a hosted page on claude.ai.'}
            </p>
          </section>

          <section className="space-y-4">
            <h3 className="text-lg font-semibold">Voice</h3>
            <VoiceFields settings={settings} update={update} speech={speech} />
          </section>

          <section className="space-y-4">
            <h3 className="text-lg font-semibold">Pacing</h3>
            <Field
              label="Step in after silence on a check question"
              hint="Seconds without typing before the teacher treats it as hesitation and explains again another way. 0 turns this off."
            >
              <input
                className={fieldClass}
                type="number"
                min="0"
                max="600"
                value={settings.pacing.hesitationSeconds}
                onChange={(e) => update('pacing.hesitationSeconds', Math.max(0, Number(e.target.value) || 0))}
              />
            </Field>
          </section>
        </div>
      </section>
    </div>
  );
}
