/**
 * Chalk text: a small maths-aware text layout for the canvas board.
 *
 * Board text is plain text with two conveniences:
 *   x^2, e^{iπt}   superscripts        b_3, x_{k+1}   subscripts
 * Stray LaTeX commands (\pi, \int, \frac{a}{b}) and Unicode sub/superscript
 * digits are tidied into the same form, because models slip into them.
 */

export const CHALK_FAMILY = '"Playpen Sans", "Lexend", "Segoe UI Symbol", "Apple Symbols", sans-serif';
export const chalkFont = (size, weight = 400) => `${weight} ${size}px ${CHALK_FAMILY}`;

const SCRIPT_SCALE = 0.62;
const LINE_HEIGHT = 1.3;

const COMMANDS = {
  pi: 'π', theta: 'θ', omega: 'ω', alpha: 'α', beta: 'β', gamma: 'γ', phi: 'φ', lambda: 'λ', mu: 'μ',
  sigma: 'σ', tau: 'τ', delta: 'δ', epsilon: 'ε', Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω', sum: 'Σ', int: '∫',
  infty: '∞', cdot: '·', times: '×', to: '→', rightarrow: '→', Rightarrow: '⇒', leq: '≤', le: '≤', geq: '≥',
  ge: '≥', neq: '≠', ne: '≠', approx: '≈', pm: '±', sqrt: '√', partial: '∂', quad: '  ', left: '', right: '',
  ',': ' ', ';': ' ', '!': '',
};
const SUPERSCRIPTS = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', 'ⁿ': 'n', '⁺': '+', '⁻': '-' };
const SUBSCRIPTS = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9', 'ₙ': 'n', '₊': '+', '₋': '-' };

/** Normalise model output into board text. */
export function tidyMath(raw) {
  return String(raw ?? '')
    .replace(/\$+|`/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)')
    .replace(/\\(?:text|mathrm|operatorname)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\([a-zA-Z]+|[,;!])/g, (_, name) => (name in COMMANDS ? COMMANDS[name] : name))
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹ⁿ⁺⁻]+/g, (m) => `^{${[...m].map((c) => SUPERSCRIPTS[c]).join('')}}`)
    .replace(/[₀₁₂₃₄₅₆₇₈₉ₙ₊₋]+/g, (m) => `_{${[...m].map((c) => SUBSCRIPTS[c]).join('')}}`)
    .trim();
}

/** The text as a reader would say it is on the board (no ^ _ { } markup). */
export const plainText = (raw) => tidyMath(raw).replace(/[\^_{}]/g, '').replace(/\s+/g, ' ').trim();

function closing(line, at, open, close) {
  let depth = 0;
  for (let i = at; i < line.length; i += 1) {
    if (line[i] === open) depth += 1;
    else if (line[i] === close && --depth === 0) return i;
  }
  return -1;
}

/** Split a line into runs: { text, script } with script 0 (normal), 1 (super) or -1 (sub). */
export function parseRuns(line) {
  const runs = [];
  let plain = '';
  const push = (text, script) => {
    const clean = text.replace(/[\^_{}]/g, script ? '' : (m) => (m === '{' || m === '}' ? '' : m));
    if (clean) runs.push({ text: clean, script, w: 0, x: 0 });
  };
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const attached = i > 0 && !/\s/.test(line[i - 1]);
    if ((ch === '^' || ch === '_') && attached && i + 1 < line.length) {
      const next = line[i + 1];
      let body = null;
      let end = i;
      if (next === '{' || next === '(') {
        const stop = closing(line, i + 1, next, next === '{' ? '}' : ')');
        if (stop > 0) {
          body = line.slice(i + 2, stop);
          end = stop;
        }
      } else {
        const short = /^[+\-−]?(\d+|[A-Za-zα-ωΑ-Ω∞])/.exec(line.slice(i + 1));
        if (short) {
          body = short[0];
          end = i + short[0].length;
        }
      }
      if (body !== null) {
        push(plain, 0);
        plain = '';
        push(body, ch === '^' ? 1 : -1);
        i = end;
        continue;
      }
    }
    plain += ch;
  }
  push(plain, 0);
  return runs;
}

function measure(ctx, text, size, weight) {
  const runs = parseRuns(text);
  let cursor = 0;
  runs.forEach((run, i) => {
    ctx.font = chalkFont(run.script ? size * SCRIPT_SCALE : size, weight);
    run.w = ctx.measureText(run.text).width;
    const before = runs[i - 1];
    if (before && before.script && run.script && before.script !== run.script) {
      // A subscript directly followed by a superscript (integral limits): stack them.
      run.x = before.x;
      cursor = before.x + Math.max(before.w, run.w);
    } else {
      run.x = cursor;
      cursor += run.w;
    }
  });
  return { runs, w: cursor };
}

/** Split on spaces, but never inside braces. */
function words(text) {
  const out = [];
  let word = '';
  let depth = 0;
  for (const ch of text) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ' ' && depth === 0) {
      out.push(word);
      word = '';
    } else word += ch;
  }
  out.push(word);
  return out;
}

function wrap(ctx, source, size, maxWidth, weight) {
  const lines = [];
  for (const paragraph of source.split('\n')) {
    let line = '';
    for (const word of words(paragraph)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line.trim() && measure(ctx, candidate.trimEnd(), size, weight).w > maxWidth) {
        lines.push(measure(ctx, line.trimEnd(), size, weight));
        line = word;
      } else line = candidate;
    }
    if (line.trim()) lines.push(measure(ctx, line.trimEnd(), size, weight));
  }
  return lines;
}

/**
 * Lay text out to fit a width (wrapping, then shrinking if it still overflows).
 * Returns { lines, size, w, h, lineHeight, chars } for drawLayout().
 */
export function layoutText(ctx, raw, { size = 32, maxWidth = Infinity, maxHeight = Infinity, maxLines = 4, minSize = 15, weight = 400 } = {}) {
  const source = tidyMath(raw);
  let s = size;
  for (;;) {
    const lines = wrap(ctx, source, s, maxWidth, weight);
    const h = lines.length * s * LINE_HEIGHT;
    const fits = lines.length <= maxLines && h <= maxHeight && lines.every((line) => line.w <= maxWidth + 0.5);
    if (fits || s <= minSize) {
      const kept = lines.slice(0, maxLines);
      return {
        lines: kept,
        size: s,
        weight,
        lineHeight: s * LINE_HEIGHT,
        w: Math.max(0, ...kept.map((line) => line.w)),
        h: kept.length * s * LINE_HEIGHT,
        chars: kept.reduce((n, line) => n + line.runs.reduce((m, run) => m + run.text.length, 0), 0),
      };
    }
    s = Math.max(minSize, s * 0.92);
  }
}

/**
 * Draw a layout with its top-left corner at (x, y). `progress` in [0, 1]
 * reveals it character by character, as if being written. Returns the pen
 * position while writing, or null once the text is complete.
 */
export function drawLayout(ctx, layout, x, y, { progress = 1, align = 'left' } = {}) {
  let remaining = progress >= 1 ? Infinity : Math.round(layout.chars * progress);
  let pen = null;
  ctx.textBaseline = 'alphabetic';
  layout.lines.forEach((line, i) => {
    const left = x + (align === 'center' ? (layout.w - line.w) / 2 : 0);
    const baseline = y + i * layout.lineHeight + layout.size * 0.98;
    for (const run of line.runs) {
      if (remaining <= 0) return;
      const cx = left + run.x;
      ctx.font = chalkFont(run.script ? layout.size * SCRIPT_SCALE : layout.size, layout.weight);
      const shown = remaining >= run.text.length ? run.text : run.text.slice(0, remaining);
      const lift = run.script === 1 ? -layout.size * 0.42 : run.script === -1 ? layout.size * 0.2 : 0;
      ctx.fillText(shown, cx, baseline + lift);
      remaining -= shown.length;
      const partial = shown.length < run.text.length;
      pen = { x: cx + (partial ? ctx.measureText(shown).width : run.w), y: baseline + lift - layout.size * 0.3 };
    }
  });
  return progress >= 1 ? null : pen;
}
