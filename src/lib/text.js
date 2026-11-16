/** Small text helpers shared by the engine and the speech layer. */

/** Split text into sentences, keeping each one's offset in the original string. */
export function splitSentences(text) {
  const out = [];
  const boundary = /[.!?…]+["'”’)\]]*\s+/g;
  let start = 0;
  let match;
  while ((match = boundary.exec(text))) {
    const end = match.index + match[0].length;
    out.push({ text: text.slice(start, end), start });
    start = end;
  }
  if (start < text.length) out.push({ text: text.slice(start), start });
  return out.filter((s) => s.text.trim());
}

/** Offset of the sentence that contains `index` (where a resumed explanation restarts). */
export function sentenceStartBefore(text, index) {
  let start = 0;
  for (const sentence of splitSentences(text)) {
    if (sentence.start <= index) start = sentence.start;
    else break;
  }
  return start;
}

export const countWords = (text) => (String(text).trim().match(/\S+/g) || []).length;

/** Word spans of a string: [{ start, length }]. */
export function wordSpans(text) {
  const spans = [];
  const word = /\S+/g;
  let match;
  while ((match = word.exec(text))) spans.push({ start: match.index, length: match[0].length });
  return spans;
}
