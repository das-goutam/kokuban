/**
 * Voice in and out.
 *
 * The rest of the app only uses this interface:
 *
 *   speak(text, { voiceURI, rate, muted, timeScale, onBoundary }) → { done, cancel }
 *       onBoundary({ charIndex, charLength }) fires as each word is spoken.
 *       done resolves with { finished } (false if cancelled).
 *   cancel()                        stop any speech immediately
 *   hush()                          stop the sound but let the words run on as captions
 *   voices() → Promise<voice[]>     browser voices to offer in Settings
 *   listen({ onInterim }) → { result, stop }   one utterance of speech-to-text
 *   ready, info()                   which engines this view has
 *
 * Three ways of speaking sit behind speak(), tried in this order:
 *   1. a Claude voice, when the app runs as a hosted claude.ai page;
 *   2. the browser's Web Speech API (no cost, no server);
 *   3. silence: the words are "mimed" at reading pace, so captions and the
 *      chalkboard keep running when there is no audio at all.
 *
 * To drop in ElevenLabs or OpenAI TTS later, add a fourth branch that plays
 * an <audio> element and calls emit() from that service's word timestamps,
 * as speakHosted() does from playback position. Nothing else has to change.
 *
 * The Web Speech API is uneven across browsers, so that branch is defensive:
 *  - text is spoken one sentence at a time (Chrome cuts long utterances off);
 *  - voices that never report word boundaries get estimated ones;
 *  - if no audio starts at all, the sentence is mimed instead.
 */
import { splitSentences, wordSpans } from '../lib/text.js';

const CHARS_PER_SECOND = 14; // about 150 words a minute at rate 1
const START_TIMEOUT_MS = 4000;
const QUIET_AFTER_DICTATION_MS = 1800;
export const CLAUDE_VOICES = ['buttery', 'airy', 'glassy', 'rounded'];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const durationMs = (text, rate) => (text.length / (CHARS_PER_SECOND * rate)) * 1000;

export function createSpeechService() {
  const hasWindow = typeof window !== 'undefined';
  const synth = hasWindow ? window.speechSynthesis : null;
  const Recognition = hasWindow ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
  const hostedPage = hasWindow && typeof window.claude?.use === 'function';
  const keepAlive = new Set(); // Chrome can garbage-collect a speaking utterance and never fire "end"
  let session = null;
  let silentUntil = 0; // browser voice failed to start: mime for a while instead of waiting again

  /* ------------------- hosted page: Claude voice and dictation ------------------- */

  const hosted = { tts: null, dictation: null, off: false, offUntil: 0, charsPerMs: (CHARS_PER_SECOND * 1.1) / 1000 };
  const use = (name) => window.claude.use(name).catch(() => null);
  const ready = hostedPage
    ? Promise.all([use('tts'), use('dictation')]).then(([tts, dictation]) => {
        hosted.tts = tts;
        hosted.dictation = dictation;
      })
    : Promise.resolve();

  const info = () => ({
    hostedPage,
    claudeVoice: Boolean(hosted.tts),
    browserVoice: Boolean(synth),
    // A hosted page cannot open the microphone itself; only the platform's dictation can.
    canListen: hostedPage ? Boolean(hosted.dictation) : Boolean(Recognition),
  });

  /* ------------------------------ voices ------------------------------ */

  let firstLook = null;
  function voices() {
    if (!synth) return Promise.resolve([]);
    const now = synth.getVoices();
    if (now.length) return Promise.resolve(now);
    // Voices load asynchronously. Wait for them once, briefly; after that an
    // empty list is taken at face value (some systems simply have none).
    firstLook ??= new Promise((resolve) => {
      synth.addEventListener('voiceschanged', resolve, { once: true });
      setTimeout(resolve, 1200);
    });
    return firstLook.then(() => synth.getVoices());
  }

  function pickVoice(list, voiceURI) {
    const chosen = list.find((voice) => voice.voiceURI === voiceURI);
    if (chosen) return chosen;
    const score = (voice) =>
      (voice.lang?.startsWith('en-US') ? 4 : voice.lang?.startsWith('en') ? 2 : -10) +
      (/natural|neural/i.test(voice.name) ? 5 : 0) +
      (/google|samantha|aria|jenny|daniel/i.test(voice.name) ? 2 : 0) +
      (voice.default ? 1 : 0);
    return [...list].sort((a, b) => score(b) - score(a))[0] ?? null;
  }

  /* ------------------------------ speaking ----------------------------- */

  /** Emit word boundaries on a timer. Used when there is no audio, or no boundary events. */
  function mime(text, { rate, timeScale, emit, fromMs = 0 }) {
    const speed = CHARS_PER_SECOND * rate * timeScale;
    const timers = [];
    let finish;
    const done = new Promise((resolve) => {
      finish = resolve;
      for (const word of wordSpans(text)) {
        const at = (word.start / speed) * 1000 - fromMs;
        if (at >= 0) timers.push(setTimeout(() => emit(word.start, word.length), at));
      }
      timers.push(setTimeout(resolve, Math.max(0, (text.length / speed) * 1000 - fromMs)));
    });
    return {
      done,
      stop() {
        timers.forEach(clearTimeout);
        finish();
      },
    };
  }

  /**
   * Claude voice. The platform plays the sound and reports how many
   * milliseconds have been heard; that is turned into a word position with a
   * characters-per-millisecond figure that is re-measured after every reading.
   */
  async function speakHosted(text, { voiceURI, rate, emit, mine }) {
    const tts = hosted.tts;
    const words = wordSpans(text);
    let current = -1;
    const stopPosition = tts.onPosition(({ ms }) => {
      const reached = ms * hosted.charsPerMs * rate;
      let i = Math.max(0, current);
      while (i + 1 < words.length && words[i + 1].start <= reached) i += 1;
      if (i !== current && words.length) {
        current = i;
        emit(words[i].start, words[i].length);
      }
    });
    mine.abort = () => tts.stop().catch(() => {});
    try {
      const voice = voiceURI.startsWith('claude:') ? voiceURI.slice(7) : undefined;
      const { playedMs } = await tts.speak(text, { voice, rate });
      if (playedMs > 500) hosted.charsPerMs = 0.5 * hosted.charsPerMs + 0.5 * (text.length / (playedMs * rate));
      return true;
    } catch (error) {
      // Turned off by the viewer: stay silent, and do not reach for another voice.
      if (error?.code === 'not_granted') hosted.off = true;
      if (error?.code === 'rate_limited' || error?.code === 'unavailable') hosted.offUntil = Date.now() + (error.retryAfterMs || 60_000);
      return false;
    } finally {
      stopPosition();
      mine.abort = null;
    }
  }

  function speakSentence(text, { voice, rate, timeScale, emit, mine }) {
    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      }
      utterance.rate = rate;

      let settled = false;
      let sawBoundary = false;
      let estimator = null;
      let startTimer = 0;
      let boundaryTimer = 0;
      let watchdog = 0;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        clearTimeout(boundaryTimer);
        clearTimeout(watchdog);
        estimator?.stop();
        utterance.onstart = utterance.onboundary = utterance.onend = utterance.onerror = null;
        keepAlive.delete(utterance);
        mine.abort = null;
        resolve();
      };

      utterance.onstart = () => {
        clearTimeout(startTimer);
        emit(0, wordSpans(text)[0]?.length ?? 0);
        // Network voices in Chrome never fire "boundary": estimate the words instead.
        boundaryTimer = setTimeout(() => {
          if (!settled && !sawBoundary) estimator = mime(text, { rate, timeScale: 1, emit, fromMs: 700 });
        }, 700);
      };
      utterance.onboundary = (event) => {
        if (event.name && event.name !== 'word') return;
        sawBoundary = true;
        estimator?.stop();
        estimator = null;
        const length = event.charLength || /^\S*/.exec(text.slice(event.charIndex))[0].length;
        emit(event.charIndex, length);
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      mine.abort = () => {
        finish();
        synth.cancel();
      };

      // If nothing starts, do not stall the lesson: mime this sentence instead.
      startTimer = setTimeout(() => {
        if (settled) return;
        silentUntil = Date.now() + 60_000;
        utterance.onend = utterance.onerror = null;
        synth.cancel();
        estimator = mime(text, { rate, timeScale, emit });
        estimator.done.then(finish);
      }, START_TIMEOUT_MS);
      watchdog = setTimeout(finish, durationMs(text, rate) * 2.5 + START_TIMEOUT_MS + 4000);

      keepAlive.add(utterance);
      synth.resume();
      synth.speak(utterance);
    });
  }

  /**
   * Speak `text`. Returns at once; await `done`. Calling speak() or cancel()
   * again stops the previous speech.
   */
  function speak(text, { voiceURI = '', rate = 1, muted = false, timeScale = 1, onBoundary } = {}) {
    const wasBusy = Boolean(session) || Boolean(synth?.speaking || synth?.pending);
    cancel();
    const mine = { cancelled: false, hushed: muted, abort: null, position: 0 };
    session = mine;

    const done = (async () => {
      const content = String(text ?? '');
      if (!content.trim()) return { finished: true };

      const emit = (index, length) => {
        if (mine.cancelled) return;
        mine.position = index;
        onBoundary?.({ charIndex: index, charLength: length });
      };
      /** Run a stretch of the text silently, at reading pace. */
      const mimeSpan = async (from, to) => {
        if (mine.cancelled || from >= to) return;
        const silent = mime(content.slice(from, to), { rate, timeScale, emit: (i, n) => emit(from + i, n) });
        mine.abort = silent.stop;
        await silent.done;
        mine.abort = null;
      };
      /** Where the next unspoken word starts, after sound stopped mid-sentence. */
      const afterCurrentWord = () => {
        const next = /\s\S/.exec(content.slice(mine.position));
        return next ? mine.position + next.index + 1 : content.length;
      };
      const end = () => {
        if (session === mine) session = null;
        return { finished: !mine.cancelled };
      };

      // 1. Claude voice (hosted page), unless a browser voice was chosen by name.
      const wantsClaude = voiceURI === '' || voiceURI.startsWith('claude:');
      if (hosted.tts && wantsClaude && !mine.hushed) {
        if (!hosted.off && Date.now() >= hosted.offUntil) {
          const spoken = await speakHosted(content, { voiceURI, rate, emit, mine });
          if (!spoken) await mimeSpan(afterCurrentWord(), content.length);
        } else await mimeSpan(0, content.length);
        return end();
      }

      // 2. Browser voice, one sentence at a time. 3. Silence.
      if (wasBusy) await delay(60); // let the engine flush a cancelled utterance first
      const list = mine.hushed || !synth || hosted.off ? [] : await voices();
      const voice = pickVoice(list, voiceURI);
      for (const sentence of splitSentences(content)) {
        if (mine.cancelled) break;
        const stop = sentence.start + sentence.text.length;
        let audible = list.length > 0 && !mine.hushed && Date.now() >= silentUntil;
        if (audible) {
          try {
            await speakSentence(sentence.text, { voice, rate, timeScale, emit: (i, n) => emit(sentence.start + i, n), mine });
          } catch {
            // The speech engine refused outright. Never let that stop the lesson.
            silentUntil = Date.now() + 60_000;
            audible = false;
          }
        }
        if (!audible) await mimeSpan(sentence.start, stop);
        else if (mine.hushed) await mimeSpan(Math.min(stop, afterCurrentWord()), stop);
      }
      return end();
    })();

    return {
      done,
      cancel() {
        if (session === mine) cancel();
      },
    };
  }

  function cancel() {
    const current = session;
    session = null;
    if (current) {
      current.cancelled = true;
      current.abort?.();
    }
    if (synth && (synth.speaking || synth.pending)) synth.cancel();
  }

  /** Voice switched off mid-sentence: cut the sound, keep the words coming as captions. */
  function hush() {
    if (!session || session.hushed) return;
    session.hushed = true;
    session.abort?.();
  }

  /* ------------------------------ listening ---------------------------- */

  const MIC_ERRORS = {
    'not-allowed': 'Microphone access was blocked. Allow it in the browser, or type instead.',
    'service-not-allowed': 'Speech recognition is not allowed here. Type instead.',
    'audio-capture': 'No microphone was found. Type instead.',
    network: 'Speech recognition needs a network connection. Type instead.',
    // hosted dictation
    not_granted: 'Dictation is turned off for this page. Type instead.',
    dismissed: 'The microphone request was closed. Click the microphone to try again, or type.',
    unavailable: 'Dictation is not available here. Type instead.',
    rate_limited: 'Dictation is busy right now. Try again shortly, or type.',
    upstream_error: 'Dictation failed. Try again, or type.',
    no_gesture: 'Click the microphone button to start dictation.',
  };

  /**
   * Hosted page: the platform holds the microphone and hands over words.
   * It listens until told to stop, so stop by itself after a short silence
   * that follows at least one settled phrase.
   */
  function listenHosted(dictation, onInterim) {
    let settled = '';
    let quiet = 0;
    const stop = () => dictation.stop().catch(() => {});
    const result = new Promise((resolve, reject) => {
      const subscriptions = [];
      let over = false;
      const finish = (code) => {
        if (over) return;
        over = true;
        clearTimeout(quiet);
        subscriptions.forEach((unsubscribe) => unsubscribe());
        if (MIC_ERRORS[code] && code !== 'stopped') reject(new Error(MIC_ERRORS[code]));
        else resolve(settled.trim());
      };
      const waitForQuiet = () => {
        clearTimeout(quiet);
        if (settled.trim()) quiet = setTimeout(stop, QUIET_AFTER_DICTATION_MS);
      };
      let listening = false;
      subscriptions.push(
        dictation.onPartial(({ text }) => {
          if (text) clearTimeout(quiet);
          else waitForQuiet();
          onInterim?.(`${settled} ${text}`.trim());
        }),
        dictation.onFinal(({ text }) => {
          settled += text;
          onInterim?.(settled.trim());
          waitForQuiet();
        }),
        dictation.onState(({ state, reason }) => {
          if (state === 'listening') listening = true;
          else if (state === 'idle' && listening) finish(reason);
        }),
      );
      // start() has to run inside the viewer's click, so nothing is awaited before it.
      dictation.start().catch((error) => finish(error?.code ?? 'upstream_error'));
    });
    return { result, stop };
  }

  /** Listen for one utterance. `result` resolves with the transcript ("" if nothing was heard). */
  function listen({ lang = 'en-US', onInterim } = {}) {
    if (hosted.dictation) return listenHosted(hosted.dictation, onInterim);
    if (hostedPage || !Recognition) {
      return {
        result: Promise.reject(new Error('Speech recognition is not available here. Type instead.')),
        stop() {},
      };
    }
    const recognition = new Recognition();
    recognition.lang = lang;
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;

    let final = '';
    let failed = false;
    const result = new Promise((resolve, reject) => {
      recognition.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const piece = event.results[i];
          if (piece.isFinal) final += piece[0].transcript;
          else interim += piece[0].transcript;
        }
        onInterim?.(`${final}${interim}`.trim());
      };
      recognition.onerror = (event) => {
        if (event.error === 'no-speech' || event.error === 'aborted') return;
        failed = true;
        reject(new Error(MIC_ERRORS[event.error] ?? `Speech recognition failed (${event.error}). Type instead.`));
      };
      recognition.onend = () => {
        if (!failed) resolve(final.trim());
      };
      try {
        recognition.start();
      } catch (error) {
        failed = true;
        reject(error);
      }
    });
    return { result, stop: () => recognition.stop() };
  }

  return { speak, cancel, hush, voices, listen, ready, info };
}
