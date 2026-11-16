/**
 * ChalkScene: the chalkboard renderer.
 *
 * A tiny retained scene (text, boxes, arrows, highlight marks) drawn on an
 * HTML5 canvas. Every item is drawn progressively: text appears character by
 * character, Rough.js shapes are stroked side by side, and "clear" is an
 * eraser sweep. Chalk dust is produced by knocking a noise pattern out of the
 * chalk layer before compositing it over the slate.
 *
 * Coordinates: actions use a 100 x 100 grid; the scene works in a fixed
 * 1000 x 600 space and scales to the canvas.
 */
import rough from 'roughjs';
import { drawLayout, layoutText, plainText } from './chalkText.js';

export const BOARD = { width: 1000, height: 600 };
export const CHALK = { white: '#f4f1e6', yellow: '#f7d96b', blue: '#a5d3f2', pink: '#f5aabd', green: '#a9e2a3' };

const MARGIN = 26;
const TEXT_SIZE = { small: 24, normal: 32, large: 44 };
const STROKE = 3.2;
const WIPE_MS = 520;
const GLOW_MS = 1600;

const ux = (x) => (x / 100) * BOARD.width;
const uy = (y) => (y / 100) * BOARD.height;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const squash = (text) => text.toLowerCase().replace(/\s+/g, ' ').trim();

/** Deterministic random numbers, so the slate looks the same after every resize. */
function lcg(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

let probe;
/** Length of an SVG path string, used to animate strokes. */
function pathLength(d) {
  try {
    probe ??= document.createElementNS('http://www.w3.org/2000/svg', 'path');
    probe.setAttribute('d', d);
    const length = probe.getTotalLength();
    if (length > 0) return length;
  } catch {
    /* fall through to a rough estimate */
  }
  const numbers = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
  return numbers.length >= 4 ? Math.hypot(numbers.at(-2) - numbers[0], numbers.at(-1) - numbers[1]) || 60 : 60;
}

function overlaps(a, b, slack = 5) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y + slack < b.y + b.h - slack && b.y + slack < a.y + a.h - slack;
}

export class ChalkScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.layer = document.createElement('canvas'); // chalk only, transparent
    this.lctx = this.layer.getContext('2d');
    this.back = document.createElement('canvas'); // slate, smears and ghosts of erased chalk
    this.gen = rough.generator();
    this.items = [];
    this.wipes = [];
    this.waiters = [];
    this.clock = 0; // scene time in ms; all animation is expressed in it
    this.speed = 1;
    this.last = 0;
    this.frame = 0;
    this.scale = 0;
    this.ids = 0;
    this.busyUntil = 0;
    this.activeId = null;
    this.tick = this.tick.bind(this);
  }

  /* ---------------------------- sizing ---------------------------- */

  resize(cssWidth, dpr = window.devicePixelRatio || 1) {
    if (!cssWidth) return;
    const scale = (cssWidth / BOARD.width) * dpr;
    if (Math.abs(scale - this.scale) < 0.002) return;
    this.scale = scale;
    for (const surface of [this.canvas, this.layer, this.back]) {
      surface.width = Math.round(BOARD.width * scale);
      surface.height = Math.round(BOARD.height * scale);
    }
    this.paintSlate();
    this.grain = this.makeGrain();
    this.invalidate();
  }

  paintSlate(alpha = 1) {
    const b = this.back.getContext('2d');
    const { width: w, height: h } = this.back;
    b.save();
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.globalAlpha = alpha;
    const slate = b.createLinearGradient(0, 0, w, h);
    slate.addColorStop(0, '#2b3e37');
    slate.addColorStop(0.55, '#24352f');
    slate.addColorStop(1, '#1d2c27');
    b.fillStyle = slate;
    b.fillRect(0, 0, w, h);

    const random = lcg(11);
    for (let i = 0; i < 16; i += 1) {
      // Old eraser smears: wide, faint, slightly tilted clouds.
      const x = random() * w;
      const y = random() * h;
      const rx = (0.1 + random() * 0.22) * w;
      const flat = 0.14 + random() * 0.22;
      const cloud = b.createRadialGradient(0, 0, 0, 0, 0, rx);
      cloud.addColorStop(0, 'rgba(255,255,255,0.045)');
      cloud.addColorStop(1, 'rgba(255,255,255,0)');
      b.save();
      b.translate(x, y);
      b.rotate((random() - 0.5) * 0.5);
      b.scale(1, flat);
      b.fillStyle = cloud;
      b.fillRect(-rx, -rx, rx * 2, rx * 2);
      b.restore();
    }
    const dot = Math.max(1, Math.round(this.scale));
    b.fillStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i < 2600; i += 1) b.fillRect(random() * w, random() * h, dot, dot);
    b.restore();
  }

  makeGrain() {
    const cell = Math.max(1, Math.round(this.scale * 0.9));
    const cells = 96;
    const tile = document.createElement('canvas');
    tile.width = tile.height = cells * cell;
    const t = tile.getContext('2d');
    const random = lcg(5);
    for (let y = 0; y < cells; y += 1) {
      for (let x = 0; x < cells; x += 1) {
        const r = random();
        if (r < 0.42) {
          t.fillStyle = `rgba(0,0,0,${0.18 + r * 1.3})`;
          t.fillRect(x * cell, y * cell, cell, cell);
        }
      }
    }
    return this.lctx.createPattern(tile, 'repeat');
  }

  /* ------------------------- building items ------------------------ */

  /** Start drawing one chalkboard action. Returns the new item's id (null for "clear"). */
  add(action, { duration = 900 } = {}) {
    if (!action) return null;
    if (action.type === 'clear') {
      this.clear();
      return null;
    }
    const build = { write_text: this.text, draw_box: this.box, draw_arrow: this.arrow, highlight: this.mark }[action.type];
    const item = build?.call(this, action);
    if (!item) return null;
    Object.assign(item, { id: ++this.ids, t0: Math.max(this.clock, this.busyUntil), dur: duration });
    this.items.push(item);
    this.invalidate();
    return item.id;
  }

  roughOptions(color, extra) {
    return { stroke: color, strokeWidth: STROKE, roughness: 1.1, bowing: 1.1, disableMultiStroke: true, seed: 1 + this.ids * 7, ...extra };
  }

  /** Turn a Rough.js drawable into sub-strokes that can be drawn one after another. */
  strokes(drawable) {
    const out = [];
    for (const path of this.gen.toPaths(drawable)) {
      for (const d of path.d.split(/(?=M)/)) {
        if (d.trim()) out.push({ path: new Path2D(d), length: pathLength(d) });
      }
    }
    return out;
  }

  text(action) {
    const right = BOARD.width - MARGIN;
    const size = TEXT_SIZE[action.size] ?? TEXT_SIZE.normal;
    let x = clamp(action.x == null ? ux(8) : ux(action.x), MARGIN, right - 120);

    // Prefer sliding a long line left over wrapping it.
    const natural = layoutText(this.lctx, action.content, { size, maxLines: 1 });
    if (x + natural.w > right) x = Math.max(MARGIN, right - natural.w);
    const layout = layoutText(this.lctx, action.content, { size, maxWidth: right - x, maxLines: 4 });

    const lowest = Math.max(MARGIN, ...this.items.map((it) => it.y + it.h));
    const top = action.y == null ? lowest + 14 : uy(action.y);
    const floor = BOARD.height - MARGIN + 8 - layout.h;
    let y = clamp(top, 14, Math.max(14, floor));

    // Never write over existing writing: nudge down until the line is free.
    const others = this.items.filter((it) => it.kind === 'text');
    for (let step = 0; step < 40; step += 1) {
      const here = { x, y, w: layout.w, h: layout.h };
      if (!others.some((it) => overlaps(here, it))) break;
      if (y + layout.lineHeight * 0.5 > floor) {
        y = clamp(top, 14, Math.max(14, floor));
        break;
      }
      y += layout.lineHeight * 0.5;
    }
    return { kind: 'text', x, y, w: layout.w, h: layout.h, layout, color: CHALK[action.color] ?? CHALK.white, label: plainText(action.content) };
  }

  box(action) {
    const color = CHALK[action.color] ?? CHALK.white;
    let w = action.w ? ux(action.w) : 0;
    let h = action.h ? uy(action.h) : 0;
    const fit = (maxWidth, maxHeight) =>
      action.content ? layoutText(this.lctx, action.content, { size: 30, maxWidth, maxHeight, maxLines: 3 }) : null;
    let inner = fit(w ? w - 26 : 420, h ? h - 8 : Infinity);
    if (!w) w = (inner?.w ?? 120) + 48;
    if (!h) h = (inner?.h ?? 40) + 30;
    w = clamp(w, 40, BOARD.width - 2 * MARGIN);
    h = clamp(h, 30, BOARD.height - 2 * MARGIN);
    if (inner && (inner.w > w - 20 || inner.h > h - 4)) inner = fit(w - 26, h - 8);
    const x = clamp(ux(action.x ?? 8), 8, BOARD.width - 8 - w);
    const y = clamp(uy(action.y ?? 20), 8, BOARD.height - 8 - h);
    const strokes = this.strokes(this.gen.rectangle(x, y, w, h, this.roughOptions(color)));
    return {
      kind: 'box', x, y, w, h, color, strokes,
      length: strokes.reduce((n, s) => n + s.length, 0),
      inner,
      ix: inner ? x + (w - inner.w) / 2 : 0,
      iy: inner ? y + (h - inner.h) / 2 : 0,
      label: plainText(action.content),
    };
  }

  arrow(action) {
    const color = CHALK[action.color] ?? CHALK.white;
    const x1 = clamp(ux(action.x ?? 10), 8, BOARD.width - 8);
    const y1 = clamp(uy(action.y ?? 50), 8, BOARD.height - 8);
    const x2 = clamp(action.x2 == null ? x1 + 140 : ux(action.x2), 8, BOARD.width - 8);
    const y2 = clamp(action.y2 == null ? y1 : uy(action.y2), 8, BOARD.height - 8);
    if (Math.hypot(x2 - x1, y2 - y1) < 6) return null;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = Math.min(17, Math.hypot(x2 - x1, y2 - y1) * 0.6);
    const options = this.roughOptions(color);
    const wing = (turn) =>
      this.gen.line(x2, y2, x2 + head * Math.cos(angle + turn), y2 + head * Math.sin(angle + turn), { ...options, roughness: 0.5 });
    const strokes = [
      ...this.strokes(this.gen.line(x1, y1, x2, y2, options)),
      ...this.strokes(wing(Math.PI - 0.5)),
      ...this.strokes(wing(Math.PI + 0.5)),
    ];
    const inner = action.content ? layoutText(this.lctx, action.content, { size: 22, maxWidth: 260, maxLines: 2 }) : null;
    // The label sits beside the shaft, on the upper or left side.
    const nx = Math.sin(angle);
    const ny = -Math.cos(angle);
    const side = ny < 0 || (ny === 0 && nx < 0) ? 1 : -1;
    const mx = (x1 + x2) / 2 + side * nx * 20;
    const my = (y1 + y2) / 2 + side * ny * 20;
    return {
      kind: 'arrow',
      x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
      color, strokes,
      length: strokes.reduce((n, s) => n + s.length, 0),
      inner,
      ix: inner ? clamp(mx - inner.w / 2, 6, BOARD.width - 6 - inner.w) : 0,
      iy: inner ? clamp(my - inner.h / 2, 6, BOARD.height - 6 - inner.h) : 0,
      label: plainText(action.content),
    };
  }

  /** Highlight: circle something already on the board and make it glow for a moment. */
  mark(action) {
    const target = this.find(action);
    if (!target) return null;
    target.glowUntil = this.clock + GLOW_MS;
    const color = CHALK[action.color] ?? CHALK.yellow;
    const w = target.w + 52;
    const h = target.h + (target.kind === 'text' ? 26 : 34);
    const strokes = this.strokes(
      this.gen.ellipse(target.x + target.w / 2, target.y + target.h / 2, w, h, this.roughOptions(color, { roughness: 1.5, strokeWidth: 2.6 })),
    );
    return {
      kind: 'mark',
      x: target.x - 26, y: target.y - 13, w, h, color, strokes,
      length: strokes.reduce((n, s) => n + s.length, 0),
      label: '',
    };
  }

  find(action) {
    const candidates = this.items.filter((it) => it.kind !== 'mark' && it.label);
    const needle = squash(plainText(action.content ?? ''));
    if (needle) {
      const newestFirst = [...candidates].reverse();
      const hit =
        newestFirst.find((it) => squash(it.label).includes(needle)) ??
        newestFirst.find((it) => it.label.length > 2 && needle.includes(squash(it.label)));
      if (hit) return hit;
    }
    if (action.x != null && action.y != null && candidates.length) {
      const px = ux(action.x);
      const py = uy(action.y);
      const distance = (it) => Math.hypot(it.x + it.w / 2 - px, it.y + it.h / 2 - py);
      return candidates.reduce((best, it) => (distance(it) < distance(best) ? it : best));
    }
    return null;
  }

  /* --------------------------- lifecycle --------------------------- */

  /** Eraser sweep. Leaves a faint ghost on the slate, like a real board. */
  clear({ ghost = true } = {}) {
    if (!this.items.length) return;
    this.paintSlate(0.7); // older ghosts fade each time
    if (ghost) {
      const b = this.back.getContext('2d');
      b.save();
      b.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      b.globalAlpha = 0.03;
      b.filter = 'blur(3px)';
      b.lineCap = 'round';
      for (const item of this.items) this.drawItem(b, item, 1, true);
      b.restore();
    }
    this.wipes.push({ items: this.items, t0: this.clock });
    this.items = [];
    this.activeId = null;
    this.busyUntil = this.clock + WIPE_MS * 0.7; // new chalk waits for the eraser to pass
    this.invalidate();
  }

  /** Complete every in-flight animation at once (used when the teacher is interrupted). */
  finishAll() {
    for (const item of this.items) item.dur = 0;
    this.wipes = [];
    this.invalidate();
  }

  setActive(id) {
    this.activeId = id;
    this.invalidate();
  }

  /** Resolves when the chalk has caught up, or after `maxMs` by finishing it. */
  settle(maxMs = 1200) {
    if (!this.animating()) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.finishAll();
        done();
      }, maxMs / this.speed);
      const done = () => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve();
      };
      this.waiters.push(done);
    });
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms / this.speed));
  }

  snapshot() {
    return { items: this.items.map((item) => ({ ...item, dur: 0, glowUntil: 0 })) };
  }

  /** Bring a saved board back (after an interruption was answered on a fresh board). */
  async restore(snapshot) {
    const unchanged =
      snapshot.items.length === this.items.length && snapshot.items.every((item, i) => item.id === this.items[i].id);
    if (unchanged) return;
    this.clear({ ghost: false });
    await this.sleep(WIPE_MS * 0.8);
    this.wipes = [];
    this.busyUntil = 0;
    this.items = snapshot.items.map((item) => ({ ...item, fadeFrom: this.clock }));
    this.invalidate();
    await this.sleep(320);
  }

  reset() {
    this.items = [];
    this.wipes = [];
    this.busyUntil = 0;
    this.activeId = null;
    if (this.scale) this.paintSlate();
    this.invalidate();
  }

  /** What is written on the board, for the model and for screen readers. */
  describe() {
    return this.items.map((item) => item.label).filter(Boolean);
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    for (const done of [...this.waiters]) done();
  }

  /* ---------------------------- drawing ---------------------------- */

  progress(item) {
    return item.dur <= 0 ? 1 : clamp((this.clock - item.t0) / item.dur, 0, 1);
  }

  animating() {
    return (
      this.wipes.length > 0 ||
      this.items.some(
        (item) =>
          this.progress(item) < 1 ||
          (item.glowUntil ?? 0) > this.clock ||
          (item.fadeFrom != null && this.clock - item.fadeFrom < 300),
      )
    );
  }

  invalidate() {
    if (!this.frame && this.scale) this.frame = requestAnimationFrame(this.tick);
  }

  tick(now) {
    this.frame = 0;
    const dt = this.last ? Math.min(64, now - this.last) : 16;
    this.last = now;
    this.clock += dt * this.speed;
    this.wipes = this.wipes.filter((wipe) => this.clock - wipe.t0 < WIPE_MS);
    this.draw();
    if (this.animating()) this.frame = requestAnimationFrame(this.tick);
    else {
      this.last = 0;
      for (const done of [...this.waiters]) done();
    }
  }

  drawStrokes(ctx, item, p) {
    let budget = item.length * p;
    for (const stroke of item.strokes) {
      if (budget <= 0) break;
      const visible = Math.min(stroke.length, budget);
      ctx.setLineDash(visible >= stroke.length ? [] : [visible, stroke.length + 10]);
      ctx.stroke(stroke.path);
      budget -= stroke.length;
    }
    ctx.setLineDash([]);
  }

  drawItem(ctx, item, p, flat = false) {
    const lit = !flat && (item.id === this.activeId || p < 1 || (item.glowUntil ?? 0) > this.clock);
    ctx.save();
    if (!flat && item.fadeFrom != null) ctx.globalAlpha = clamp((this.clock - item.fadeFrom) / 300, 0, 1);
    ctx.fillStyle = item.color;
    ctx.strokeStyle = item.color;
    ctx.lineWidth = item.kind === 'mark' ? 2.6 : STROKE;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (lit) {
      ctx.shadowColor = item.color;
      ctx.shadowBlur = 12 * this.scale;
    }
    item.pen = null;
    if (item.kind === 'text') {
      item.pen = drawLayout(ctx, item.layout, item.x, item.y, { progress: p });
    } else {
      // Shapes: outline first, then the label is written inside or beside it.
      const share = item.inner ? 0.6 : 1;
      this.drawStrokes(ctx, item, Math.min(1, p / share));
      if (item.inner && p > share) {
        item.pen = drawLayout(ctx, item.inner, item.ix, item.iy, { progress: (p - share) / (1 - share), align: 'center' });
      }
    }
    ctx.restore();
  }

  draw() {
    const { ctx, lctx, canvas } = this;
    const { width: W, height: H } = BOARD;

    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, canvas.width, canvas.height);
    lctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);

    // Board being erased: old chalk survives only to the right of the eraser.
    const edges = [];
    for (const wipe of this.wipes) {
      const t = clamp((this.clock - wipe.t0) / WIPE_MS, 0, 1);
      const edge = W * (1 - (1 - t) * (1 - t));
      edges.push({ edge, t });
      lctx.save();
      lctx.beginPath();
      lctx.rect(edge, 0, W - edge, H);
      lctx.clip();
      for (const item of wipe.items) this.drawItem(lctx, item, 1, true);
      lctx.restore();
    }
    for (const item of this.items) this.drawItem(lctx, item, this.progress(item));

    // Chalk dust: punch a fixed noise pattern out of the chalk.
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.globalCompositeOperation = 'destination-out';
    lctx.fillStyle = this.grain;
    lctx.fillRect(0, 0, canvas.width, canvas.height);
    lctx.globalCompositeOperation = 'source-over';

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.back, 0, 0);
    ctx.drawImage(this.layer, 0, 0);
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);

    // The eraser itself: a soft band of dust and a felt block.
    for (const { edge, t } of edges) {
      const dust = ctx.createLinearGradient(edge - 90, 0, edge + 20, 0);
      dust.addColorStop(0, 'rgba(255,255,255,0)');
      dust.addColorStop(0.75, 'rgba(255,255,255,0.10)');
      dust.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = dust;
      ctx.fillRect(edge - 90, 0, 110, H);
      const y = H * (0.5 + 0.3 * Math.sin(t * Math.PI * 3));
      ctx.fillStyle = '#5b4a3a';
      ctx.fillRect(edge - 16, y - 55, 32, 110);
      ctx.fillStyle = '#d9d2c0';
      ctx.fillRect(edge - 16, y - 55, 9, 110);
    }

    // A stub of chalk at the point being written.
    for (const item of this.items) {
      if (!item.pen) continue;
      ctx.save();
      ctx.translate(item.pen.x + 2, item.pen.y);
      ctx.rotate(-0.6);
      ctx.fillStyle = '#fffdf5';
      ctx.shadowColor = item.color;
      ctx.shadowBlur = 10 * this.scale;
      ctx.fillRect(0, -3.5, 22, 7);
      ctx.restore();
    }
  }
}
