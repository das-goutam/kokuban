/**
 * The student's notebook: the roadmap with progress, what the diagnostic
 * concluded (the StudentProfile), and a transcript of the session.
 */
import { Check } from 'lucide-react';
import { parseRuns, tidyMath } from '../board/chalkText.js';

/** Board-style text (x^2, b_3) rendered as HTML. */
export function MathText({ text }) {
  return parseRuns(tidyMath(text)).map((run, i) =>
    run.script === 1 ? <sup key={i}>{run.text}</sup> : run.script === -1 ? <sub key={i}>{run.text}</sub> : <span key={i}>{run.text}</span>,
  );
}

function Roadmap({ modules }) {
  if (!modules.length) {
    return <p className="text-ink-soft">Your roadmap appears here after the warm-up questions.</p>;
  }
  return (
    <ol>
      {modules.map((module, i) => {
        const percent = Math.round(module.mastery * 100);
        const shown = module.status !== 'upcoming';
        return (
          <li key={module.title} data-status={module.status} className={module.status === 'upcoming' ? 'text-ink-soft' : ''}>
            <div className="flex items-baseline gap-2">
              <span className="w-4 shrink-0 tabular-nums">{i + 1}.</span>
              <span className={`min-w-0 flex-1 truncate ${module.status === 'current' ? 'font-semibold' : ''}`} title={module.objective}>
                {module.title}
              </span>
              {module.status === 'passed' && <Check aria-label="passed" className="size-4 shrink-0 self-center text-slate" strokeWidth={3} />}
              {module.status === 'current' && <span className="shrink-0 text-sm text-ink-soft">now</span>}
            </div>
            {(module.is_prerequisite || shown) && (
              <div className="flex h-8 items-center gap-2 pl-6 text-sm text-ink-soft">
                {module.is_prerequisite && <span className="shrink-0">fills a gap</span>}
                {shown && (
                  <>
                    <span
                      className="h-1.5 min-w-8 flex-1 overflow-hidden rounded-full bg-wall-deep"
                      role="meter"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={percent}
                      aria-label={`Estimated mastery of ${module.title}`}
                    >
                      <span className="block h-full rounded-full bg-slate transition-[width] duration-700" style={{ width: `${percent}%` }} />
                    </span>
                    <span className="shrink-0 tabular-nums" title="Estimated mastery (Bayesian knowledge tracing)">
                      {percent}%
                    </span>
                  </>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Profile({ profile }) {
  const list = (items) => (items.length ? items.join('; ') : 'none found');
  return (
    <>
      <p>{profile.level_summary}</p>
      <p>
        <b>Has:</b> {list(profile.strengths)}
      </p>
      <p>
        <b>Missing:</b> {list(profile.missing_prerequisites)}
      </p>
      <p>
        <b>Pace:</b> {profile.target_pacing}
      </p>
      <details>
        <summary className="cursor-pointer text-ink-soft">StudentProfile JSON</summary>
        <pre className="my-2 max-h-64 overflow-auto rounded bg-slate p-3 text-xs text-chalk">{JSON.stringify(profile, null, 2)}</pre>
      </details>
    </>
  );
}

export default function Notebook({ view }) {
  return (
    <aside className="notebook self-start rounded-sm text-[0.95rem]" aria-label="Your notebook">
      <h2>Roadmap</h2>
      {view.document && (
        <p className="truncate text-ink-soft" title={view.document.name}>
          From your file: {view.document.name}
        </p>
      )}
      <Roadmap modules={view.modules} />

      {view.profile && (
        <>
          <h2 className="mt-8">Where you're starting from</h2>
          <Profile profile={view.profile} />
        </>
      )}

      {view.log.length > 0 && (
        <details className="mt-8">
          <summary className="cursor-pointer">
            <h2 className="inline">Transcript</h2>
          </summary>
          <ol className="max-h-96 overflow-y-auto pr-1">
            {view.log.map((entry) => (
              <li key={entry.id} className={entry.role === 'student' ? 'font-semibold' : ''}>
                <span className="text-ink-soft">{entry.role === 'student' ? 'You: ' : 'Teacher: '}</span>
                {entry.text}
              </li>
            ))}
          </ol>
        </details>
      )}
    </aside>
  );
}
