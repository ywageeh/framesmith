// Annotation model: plain objects in source-image pixel space. Pure functions only.
//   arrow     { x1, y1, x2, y2, color, size }
//   rect      { x, y, w, h, color, size }
//   highlight { x, y, w, h, color }
//   redact    { x, y, w, h }
//   focus     { x, y, w, h }
//   text      { x, y, text, color, size }       (x, y = top-left)
//   step      { x, y, n, color, size }          (x, y = centre)

import { distToSegment, normRect } from './layout.js';

export const TOOLS = [
  { id: 'select', key: 'v', label: 'Select & move' },
  { id: 'arrow', key: 'a', label: 'Arrow' },
  { id: 'rect', key: 'r', label: 'Box' },
  { id: 'highlight', key: 'h', label: 'Highlight' },
  { id: 'text', key: 't', label: 'Text label' },
  { id: 'step', key: 'n', label: 'Numbered step' },
  { id: 'redact', key: 'b', label: 'Redact (pixelate)' },
  { id: 'focus', key: 'f', label: 'Spotlight' },
];

export const INK = ['#ff4d2e', '#ffc21a', '#1fb57a', '#2f7df6', '#8a5cf6', '#15161a', '#ffffff'];

export const SIZES = { s: 0.65, m: 1, l: 1.5 };

/** Stroke/scale unit for an image, so annotations read the same on any resolution. */
export function inkUnit(imgW, imgH) {
  return Math.max(1, Math.max(imgW, imgH) / 1000);
}

export const isBoxy = (a) => ['rect', 'highlight', 'redact', 'focus'].includes(a.type);

/** Font size in image px for text/step annotations. */
export function fontSize(a, iu) {
  return Math.round(22 * iu * (SIZES[a.size] || 1));
}

/** Rough text metrics without a canvas (good enough for hit-testing; renderer measures exactly). */
export function textBox(a, iu, measure) {
  const fs = fontSize(a, iu);
  const lines = String(a.text || '').split('\n');
  const width = Math.max(...lines.map((l) => (measure ? measure(l, fs) : l.length * fs * 0.56)), fs);
  const padX = fs * 0.6;
  const padY = fs * 0.38;
  return { x: a.x, y: a.y, w: width + padX * 2, h: lines.length * fs * 1.25 + padY * 2, fs, padX, padY, lines };
}

export function stepRadius(a, iu) {
  return 17 * iu * (SIZES[a.size] || 1);
}

export function bounds(a, iu, measure) {
  switch (a.type) {
    case 'arrow':
      return normRect(a.x1, a.y1, a.x2, a.y2);
    case 'text': {
      const b = textBox(a, iu, measure);
      return { x: b.x, y: b.y, w: b.w, h: b.h };
    }
    case 'step': {
      const r = stepRadius(a, iu);
      return { x: a.x - r, y: a.y - r, w: r * 2, h: r * 2 };
    }
    default:
      return { x: a.x, y: a.y, w: a.w, h: a.h };
  }
}

/** Is point p (image px) on annotation a? `tol` in image px. */
export function hit(a, p, iu, tol, measure) {
  if (a.type === 'arrow') {
    return distToSegment(p, { x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }) <= tol + 4 * iu;
  }
  if (a.type === 'rect') {
    // Boxes are hollow: only the outline is grabbable, so you can click what's inside.
    const b = bounds(a, iu);
    const inOuter = p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol;
    const inInner = p.x > b.x + tol && p.x < b.x + b.w - tol && p.y > b.y + tol && p.y < b.y + b.h - tol;
    return inOuter && !inInner;
  }
  const b = bounds(a, iu, measure);
  return p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol;
}

/** Topmost annotation under p, or null. */
export function pick(list, p, iu, tol, measure) {
  for (let i = list.length - 1; i >= 0; i--) if (hit(list[i], p, iu, tol, measure)) return list[i];
  return null;
}

/** Handles: named points that can be dragged to reshape an annotation. */
export function handles(a) {
  if (a.type === 'arrow') {
    return [
      { id: 'p1', x: a.x1, y: a.y1 },
      { id: 'p2', x: a.x2, y: a.y2 },
    ];
  }
  if (isBoxy(a)) {
    return [
      { id: 'nw', x: a.x, y: a.y },
      { id: 'ne', x: a.x + a.w, y: a.y },
      { id: 'se', x: a.x + a.w, y: a.y + a.h },
      { id: 'sw', x: a.x, y: a.y + a.h },
    ];
  }
  return [];
}

export function moveBy(a, dx, dy) {
  if (a.type === 'arrow') return { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy };
  return { ...a, x: a.x + dx, y: a.y + dy };
}

/** Drag handle `id` of `orig` to point p. */
export function dragHandle(orig, id, p) {
  if (orig.type === 'arrow') {
    return id === 'p1' ? { ...orig, x1: p.x, y1: p.y } : { ...orig, x2: p.x, y2: p.y };
  }
  const x2 = orig.x + orig.w;
  const y2 = orig.y + orig.h;
  const fixed = { nw: [x2, y2], ne: [orig.x, y2], se: [orig.x, orig.y], sw: [x2, orig.y] }[id];
  return { ...orig, ...normRect(fixed[0], fixed[1], p.x, p.y) };
}

/** Next number for a step badge. */
export function nextStep(list) {
  return list.filter((a) => a.type === 'step').reduce((m, a) => Math.max(m, a.n), 0) + 1;
}

/** Drop annotations too small to be intentional (a click without a drag). */
export function isDegenerate(a, iu) {
  if (a.type === 'arrow') return Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 10 * iu;
  if (isBoxy(a)) return a.w < 6 * iu || a.h < 6 * iu;
  if (a.type === 'text') return !String(a.text || '').trim();
  return false;
}
