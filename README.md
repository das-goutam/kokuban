# Kokuban (proof of concept)

Kokuban (黒板) is Japanese for blackboard.

A browser-only prototype of the animated, human-paced AI teacher: a patient tutor that speaks in short
chunks, draws on a chalkboard while it talks, stops and waits after every step, can be interrupted
mid-sentence, and will not move on until the student has answered an applied check question.

It follows the three-layer split from the white paper:

| Layer | Decides | Code |
|---|---|---|
| Pedagogy | what happens next | `src/engine/` (state machine, pacing rules, learner model) |
| Language | how to say it, what to draw | `src/services/llmService.js` + the prompts in `tutorEngine.js` |
| Embodiment | delivering it | `src/components/ChalkboardCanvas.jsx`, `src/board/`, `src/services/speechService.js` |

The language model never chooses the next teaching action. It fills in a turn the engine asked for.

## Run it

Needs Node 20 or newer.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # engine, provider adapters, documents and board logic (33 tests, no network)
```

It opens in **Demo lesson** mode: a scripted Fourier series lesson that needs no API key, so every
stage, the voice and the board can be tried at once. To teach any topic, open **Settings** (gear icon),
pick a provider and paste a key.

Use Chrome or Edge for the full experience. Firefox has no speech recognition, so the microphone
buttons are hidden there; everything else works.

`?speed=8` in the URL runs the silent mode and the chalk eight times faster (handy for demos and tests).

## Study from your own file

On the first screen, **Study from your own file** takes a PDF, a Word `.docx` file or a text file (a
paper, a report, lecture notes). The class is then built on that file instead of a topic name.

- The file is read in the browser (`services/documentReader.js`, using pdf.js and mammoth); it is not
  uploaded anywhere. Only extracted text goes to the model you selected, in parts.
- `engine/sourceDocument.js` cuts the text into numbered sections of about 1,600 characters. The
  planner sees a condensed overview of every section and lists, per micro-module, the sections it
  draws on. Teaching, grading and question prompts then carry only those sections in full
  (about 7,000 characters), with an instruction to teach what the text says and not to invent details.
- Scanned PDFs (pictures of pages) contain no text and are rejected with a message. Figures, tables
  and equation layout are lost in extraction, so a formula-heavy PDF comes through imperfectly.
- A roadmap is three to five micro-modules, so a long document is covered at the level of its main
  ideas; use the focus field to aim the class at one part.
- Not available in demo mode.

## Put it on GitHub Pages

The app is a static site, so GitHub Pages can host it. `.github/workflows/pages.yml` is included.

1. Create a repository on GitHub and push this folder to its `main` branch.
2. In the repository: Settings, Pages, Source: **GitHub Actions**.
3. The workflow runs the tests, builds, and publishes. The site appears at
   `https://<user>.github.io/<repository>/` (asset paths are relative, so any repository name works).

On GitHub Pages it behaves like the local app: the demo lesson works for everyone, and each visitor
pastes their own Gemini or Groq key in Settings, which stays in their browser. Never commit a key to
the repository. Built-in Claude and the Claude voice exist only on the hosted claude.ai page.

## Use it without installing anything

`npm run build:hosted` produces a three-file page (`dist-hosted/`) that can be published as a hosted
claude.ai page. There the app has no backend and no keys:

| | Hosted page | Local app |
|---|---|---|
| Model | Claude itself, on the viewer's own Claude account, or the demo lesson | Gemini, Groq, Together, any OpenAI-compatible endpoint, or the demo |
| Voice | a Claude voice (falls back to the browser's voice, then to captions) | the browser's Web Speech voices |
| Microphone | the platform's dictation | the browser's speech recognition |

The app detects where it is running (`isHosted()` in `llmService.js`) and offers only what can work
there. A hosted page may not call other hosts, so the key-based providers are local-only; the built-in
Claude provider is hosted-only. Model tier per request kind is set in `TIERS` in `llmService.js`
(quick replies for warm-up questions and interruptions, more thought for planning, scripts and grading).
The voice and dictation features need a desktop Chromium browser; elsewhere the page falls back to
captions and typing.

## Stack

React 19 + Vite 8 + Tailwind CSS 4 + Rough.js, plain JavaScript. No backend: the browser calls the
model provider directly and uses the Web Speech API for voice.

```
kokuban/
├── index.html
├── package.json
├── vite.config.js               Vite, React, Tailwind, hosted build, optional dev proxy for CORS
├── .env.example                 LLM_PROXY_TARGET for that proxy
├── .github/workflows/pages.yml  build and publish to GitHub Pages
├── src/
│   ├── main.jsx
│   ├── fonts.js                 bundled fonts (the hosted build uses Google Fonts)
│   ├── index.css                design tokens, board frame, notebook
│   ├── App.jsx                  layout, stage stepper, the controls under the board
│   ├── components/
│   │   ├── ChalkboardCanvas.jsx board + speech sync (the engine's "stage")
│   │   ├── SettingsDrawer.jsx   provider and API key, voice, pacing
│   │   └── Notebook.jsx         roadmap, StudentProfile, transcript
│   ├── engine/
│   │   ├── tutorEngine.js       five-stage state machine and all system prompts
│   │   ├── turnSchema.js        JSON schemas and normalisers (pacing rules live here)
│   │   ├── learnerModel.js      Bayesian knowledge tracing estimate per module
│   │   ├── sourceDocument.js    sections and excerpts of an uploaded document
│   │   └── demoLesson.js        the scripted offline lesson
│   ├── services/
│   │   ├── llmService.js        provider adapters behind one generateJSON()
│   │   ├── speechService.js     Claude voice, Web Speech, silent captions; dictation
│   │   └── documentReader.js    text out of PDF, Word and text files
│   ├── board/
│   │   ├── chalkScene.js        canvas renderer: Rough.js shapes, chalk dust, eraser
│   │   ├── chalkText.js         maths-aware chalk text (x^2, b_3, integral limits)
│   │   └── cues.js              which spoken word starts which drawing
│   ├── hooks/useTutor.js        binds the engine to React
│   └── lib/                     settings (localStorage) and text helpers
└── tests/                       node --test, no browser needed
```

## The state machine

`tutorEngine.js` holds the only table of legal transitions. Anything else throws.

```
STATE_INTAKE → STATE_DIAGNOSTIC → STATE_CURRICULUM → STATE_TEACHING ⇄ STATE_CHECK → STATE_COMPLETE
```

| Stage | What happens | Model calls |
|---|---|---|
| Intake | Two questions: the topic, and age plus background. | none |
| Diagnostic | Three to five prerequisite questions, one at a time, each chosen after the previous answer, each with answers to pick from (or type one). No feedback is given. | one per question |
| Curriculum | Answers are analysed into a `StudentProfile` (strengths, missing prerequisites, pacing). A roadmap of three to five micro-modules is drawn, missing prerequisites first. Waits for **Start lesson**. | one |
| Teaching | One micro-module is delivered as micro-chunks. After each step the teacher stops and waits. The student can go on, reply (answer a question the teacher asked, or ask one), or have the last chunk said again. | one per module, plus one per reply |
| Check | An applied question gates progress. Correct: next module. Wrong, partial, "not sure" or silence: back to Teaching with a different analogy, a new drawing and a new question. | one per answer |

### The turn schema

Every teaching turn the model returns has this shape. `x2`/`y2`, `w`/`h`, `size`, `color` and `cue`
are small additions to the schema in the brief (an arrow needs an end point, a box needs a size).

```json
{
  "spoken_text": "Short, conversational, patient teacher dialogue (max 40 words).",
  "chalkboard_actions": [
    { "type": "clear | write_text | draw_arrow | draw_box | highlight", "content": "...", "x": 0, "y": 0,
      "x2": 0, "y2": 0, "w": 0, "h": 0, "size": "small | normal | large",
      "color": "white | yellow | blue | pink | green", "cue": "word in spoken_text" }
  ],
  "pause_type": "continue | ask_if_following | comprehension_quiz",
  "quiz_question": "Only if pause_type is comprehension_quiz",
  "expected_concept": "Key idea the answer must demonstrate"
}
```

A micro-module arrives as one script, `{ "analogy": "...", "turns": [ ... ] }`, and is then played one
turn at a time. Asking for the whole module in one call removes the dead air between chunks and keeps
a lesson within free-tier request limits; the next module is fetched while the student thinks about
the current check question.

### Rules enforced in code, whatever the model returns

`turnSchema.js` normalises every reply before the engine sees it:

- speech is stripped of Markdown, LaTeX and bare symbols, and trimmed to whole sentences past 60 words;
- a script ends at its first `comprehension_quiz` turn and must contain one;
- two `continue` turns in a row are not allowed: the second becomes a pause;
- a stock check-in tacked onto the end of a turn ("With me so far?") is removed; a real question is kept;
- an unknown `pause_type` becomes a pause, unknown action types are dropped, coordinates are clamped;
- the roadmap is re-ordered so prerequisite repairs come first.

A reply that cannot be repaired is sent back to the model once with the reason. If it fails again the
student sees an error with **Try again**, and the stage does not advance.

### Interruptions

**Interrupt / ask a question** (or `Esc`, or the microphone button) calls `engine.interrupt()`, which
synchronously stops the audio, records the character where the teacher was cut off, and saves the board.
The question is answered on a fresh board, the lesson board is restored, and the teacher restarts from
the last sentence boundary before the cut with a short bridge ("Okay, back to where we were."). Only
the drawings that had not started yet are drawn. Interrupting during a pause returns to the same pause.

### Voice and board sync

`ChalkboardCanvas.perform(turn)` speaks the turn and plans a start character for each action
(`board/cues.js`): an action with a `cue` starts when that phrase is spoken, the others are spread
between their neighbours. `SpeechSynthesisUtterance` boundary events advance the caption highlight and
trigger the drawings. Each drawing is animated over the time until the next cue and glows while it is
the one being talked about.

The Web Speech API is uneven, so `speechService.js` speaks one sentence at a time, estimates word
timing for voices that report no boundaries (Chrome's network voices), and falls back to silent
captions at reading pace if no audio starts. The hosted Claude voice reports playback position
instead of words, so position is converted to a word with a rate that is re-measured after every
reading. To use ElevenLabs or OpenAI TTS, add a branch to `speak()` that plays an audio element and
calls `emit()` from the service's word timestamps; nothing else changes.

### Learner model

Each module carries a BKT mastery estimate (`learnerModel.js`, the update equations from the white
paper), shown in the notebook. Its parameters are untuned placeholders. In this PoC the gate is a
passed check, not the 0.95 threshold.

## Providers

| Provider | Default model | Notes |
|---|---|---|
| Google Gemini | `gemini-3.8-flash` | `generateContent` REST API with a JSON schema. No sampling parameters are sent. |
| Groq | `openai/gpt-oss-120b` | OpenAI-compatible. See the note on Llama below. |
| Together AI | `Prism-ML/Ternary-Bonsai-27B` | OpenAI-compatible. Listed as free; untested for this task. |
| OpenAI-compatible endpoint | none | Any `/chat/completions` server: base URL, optional key, model. |

Model IDs go stale quickly. **Load models** in Settings asks the provider for its current list, and
**Test connection** makes one tiny round trip.

**Llama.** As of November 2026, Groq's deprecation page gives 16 August 2026 as the shutdown date
for `llama-3.3-70b-versatile` (its models page still lists it, so it may survive on some accounts),
and Together's serverless list has no Llama models. The Meta models listed on both are the Muse
family. The presets therefore default to models documented as current; the Model field accepts any
other ID, and the suggestions include `meta-models/muse-spark-open` and `llama-3.3-70b-versatile`.

**JSON output.** Providers disagree on request fields, so each adapter tries an ordered list of
request variants and remembers the first one the endpoint accepts:

- Gemini: `responseFormat.text.schema`, then `responseMimeType` + `responseJsonSchema`, then JSON
  mime type only, then prompt only.
- OpenAI-compatible: strict `json_schema`, then `json_object`, then no `response_format`, then a bare
  request without `max_tokens`. Force one mode under Settings, Advanced.

**Claude or another custom endpoint.** Use "OpenAI-compatible endpoint" with the base URL and model
your endpoint expects (for Anthropic's compatibility layer: `https://api.anthropic.com/v1`, model for
example `claude-fable-5-2`). If the endpoint refuses direct browser requests (CORS), route it through
the dev server:

```bash
echo "LLM_PROXY_TARGET=https://api.anthropic.com" > .env.local
npm run dev
# Settings → OpenAI-compatible endpoint → Base URL: /llm-proxy/v1
```

**Slow replies.** Models that think by default add latency. "Extra request fields" under Advanced is
merged into every request body, so a lower thinking or reasoning level can be set there in whatever
form your provider documents.

**Keys** are stored in this browser's `localStorage` and sent only to the provider you select. That
is fine for a local PoC and not for a deployed product: put a server in between before sharing it.

## What has and has not been verified

Verified here: the 33 unit tests; reading a generated PDF and Word file in headless Chrome; a production build; complete lessons in headless Chrome in demo
mode (all five stages, interruption and resume, wrong answer and re-teach, hesitation, restart); the
Gemini and OpenAI-compatible adapters in the browser against a local stand-in server that rejects the
strictest JSON settings; the voice code path against a scripted `speechSynthesis`; the hosted build
against a scripted stand-in for the claude.ai page runtime (model, voice, dictation).

Not verified: calls to the live Gemini, Groq, Together or Anthropic APIs (no keys or network access
where this was built), real audio output (the build machine has no speech voices), and the hosted
page inside claude.ai itself. Expect to adjust a model ID or a request field on first contact with a
real provider; the error message shown in the app quotes the provider's own reason.

## Known limits, in white paper terms

- **No verifier.** Mathematical statements from the model are not checked. This is the largest gap.
- **No curated curriculum graph.** The roadmap and scripts are generated per session.
- **Board vocabulary is five action types.** There is no function plotter yet, which Fourier analysis
  will want (partial sums, spectra, phasors). `chalkScene.js` builds each item type in one method, so a
  `plot` action is a contained addition.
- **Model-chosen coordinates.** Text is kept on the board and nudged off other text, but a weak model
  can still produce a cluttered board.
- **No character**, no streaming speech, no barge-in by voice alone (the microphone button interrupts).
- **Nothing is persisted** between sessions and there is no event log export.
