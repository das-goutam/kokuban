/**
 * Study material the student uploaded (a PDF, a Word file, notes).
 *
 * A document is far too long to send with every request, so it is cut into
 * numbered sections once. The planner sees a condensed overview of ALL
 * sections and says which ones each micro-module draws on; the teaching,
 * grading and question prompts then carry only those sections in full.
 * Pure functions: no DOM, no network.
 */

const SECTION_CHARS = 1600;
export const MAX_DOCUMENT_CHARS = 400_000;
export const BUDGET = { warmUp: 5_000, plan: 20_000, lesson: 7_000 };

const tidy = (text) =>
  String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Cut text into sections of about SECTION_CHARS, at paragraph or sentence ends. */
export function prepareDocument({ name, text }) {
  const clean = tidy(text).slice(0, MAX_DOCUMENT_CHARS);
  const pieces = clean
    .split(/\n\n+/)
    .flatMap((paragraph) =>
      paragraph.length <= SECTION_CHARS * 1.5 ? [paragraph] : paragraph.match(new RegExp(`[\\s\\S]{1,${SECTION_CHARS}}(?:[.!?]\\s|\\n|$)|[\\s\\S]{1,${SECTION_CHARS}}`, 'g')),
    )
    .map((piece) => piece.trim())
    .filter(Boolean);

  const sections = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + piece.length > SECTION_CHARS) {
      sections.push(current);
      current = piece;
    } else current = current ? `${current}\n\n${piece}` : piece;
  }
  if (current) sections.push(current);
  return { name: String(name || 'document').slice(0, 120), characters: clean.length, sections };
}

const numbered = (doc, index, text) => `[section ${index + 1} of ${doc.sections.length}]\n${text}`;

/** Every section, each cut short if needed, so the whole document fits the budget. */
export function overview(doc, budget) {
  const share = Math.max(160, Math.floor(budget / doc.sections.length) - 30);
  const step = Math.max(1, Math.ceil((doc.sections.length * 190) / budget)); // very long: sample evenly
  return doc.sections
    .map((section, i) => (i % step === 0 ? numbered(doc, i, section.length > share ? `${section.slice(0, share)} …` : section) : null))
    .filter(Boolean)
    .join('\n\n');
}

const words = (text) => new Set(String(text).toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []);

/** Sections that share the most vocabulary with a module, for when the planner named none. */
export function relevantSections(doc, query, count = 3) {
  const wanted = words(query);
  return doc.sections
    .map((section, i) => {
      let hits = 0;
      for (const word of words(section)) if (wanted.has(word)) hits += 1;
      return { i, hits };
    })
    .sort((a, b) => b.hits - a.hits || a.i - b.i)
    .slice(0, count)
    .map((entry) => entry.i + 1)
    .sort((a, b) => a - b);
}

/** The named sections in full (1-based numbers), trimmed to the budget. */
export function excerpt(doc, sectionNumbers, budget) {
  const valid = [...new Set(sectionNumbers.map(Number))].filter((n) => Number.isInteger(n) && n >= 1 && n <= doc.sections.length);
  const out = [];
  let used = 0;
  for (const n of valid.sort((a, b) => a - b)) {
    const text = doc.sections[n - 1];
    if (used + text.length > budget && out.length) break;
    out.push(numbered(doc, n - 1, text.slice(0, budget - used)));
    used += text.length;
  }
  return out.join('\n\n');
}
