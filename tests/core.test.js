// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeLayout, tiltProjector, tiltQuad, safeScale, MAX_PIXELS, normRect, distToSegment } from '../public/js/layout.js';
import { findTrim } from '../public/js/trim.js';
import { History } from '../public/js/history.js';
import { pick, moveBy, dragHandle, nextStep, isDegenerate, handles, bounds } from '../public/js/annotations.js';

const base = { frame: 'none', padding: 10, radius: 12, aspect: 'auto', tilt: 0 };

test('auto layout wraps the shot in even padding', () => {
  const L = computeLayout(1000, 600, base);
  assert.equal(L.pad, 100);
  assert.equal(L.W, 1200);
  assert.equal(L.H, 800);
  assert.deepEqual(L.img, { x: 100, y: 100, w: 1000, h: 600 });
});

test('fixed aspect grows the short side and centres the card', () => {
  for (const [aspect, ratio] of [['16:9', 16 / 9], ['1:1', 1], ['9:16', 9 / 16], ['1.91:1', 1.91]]) {
    const L = computeLayout(1000, 600, { ...base, aspect });
    assert.ok(Math.abs(L.W / L.H - ratio) < 0.01, `${aspect} → ${L.W}x${L.H}`);
    assert.ok(L.card.x >= L.pad - 1 && L.card.y >= L.pad - 1, 'card never loses its padding');
    assert.ok(Math.abs(L.card.x * 2 + L.card.w - L.W) <= 1, 'centred horizontally');
  }
});

test('window chrome adds a title bar above the image', () => {
  const L = computeLayout(1400, 900, { ...base, frame: 'mac-light', padding: 0 });
  assert.ok(L.chrome.top > 0);
  assert.equal(L.card.h, 900 + L.chrome.top);
  assert.equal(L.img.y, L.card.y + L.chrome.top);
});

test('chrome and radius scale with resolution', () => {
  const small = computeLayout(700, 400, { ...base, frame: 'browser-light' });
  const big = computeLayout(2800, 1600, { ...base, frame: 'browser-light' });
  assert.ok(big.chrome.top > small.chrome.top * 2.5);
  assert.ok(big.radius > small.radius);
});

test('radius never exceeds half the card', () => {
  const L = computeLayout(40, 20, { ...base, radius: 48 });
  assert.ok(L.radius <= 10);
});

test('tilt keeps the card inside its original box', () => {
  for (const deg of [-30, -12, 8, 30]) {
    const q = tiltQuad(1000, 600, deg);
    for (const p of q) {
      assert.ok(p.x >= -0.01 && p.x <= 1000.01, `x ${p.x} at ${deg}°`);
      assert.ok(p.y >= -0.01 && p.y <= 600.01, `y ${p.y} at ${deg}°`);
    }
  }
});

test('tilt inverse undoes the projection', () => {
  const p = tiltProjector(1200, 800, 18);
  for (const x of [5, 300, 600, 1100]) {
    const fwd = p(x);
    const back = p.inverse(fwd.x);
    assert.ok(Math.abs(back.sx - x) < 1e-6);
    assert.ok(Math.abs(back.scale - fwd.scale) < 1e-9);
  }
  assert.equal(p.inverse(-50), null);
});

test('positive tilt brings the left edge closer (taller)', () => {
  const q = tiltQuad(1000, 600, 20);
  const left = q[3].y - q[0].y;
  const right = q[2].y - q[1].y;
  assert.ok(left > right);
});

test('export scale is capped under the browser canvas budget', () => {
  assert.equal(safeScale(1000, 1000, 2), 2);
  const k = safeScale(4000, 3000, 3);
  assert.ok(k < 3);
  assert.ok(4000 * k * 3000 * k <= MAX_PIXELS);
});

function img(w, h, fill, inner) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = inner && x >= inner.x && x < inner.x + inner.w && y >= inner.y && y < inner.y + inner.h ? inner.c : fill;
      d.set(c, (y * w + x) * 4);
    }
  return d;
}

test('trim finds content inside a uniform margin', () => {
  const d = img(100, 80, [240, 240, 240, 255], { x: 12, y: 9, w: 60, h: 50, c: [20, 30, 40, 255] });
  assert.deepEqual(findTrim(d, 100, 80), { x: 12, y: 9, w: 60, h: 50 });
});

test('trim tolerates compression noise but not content', () => {
  const d = img(50, 50, [250, 250, 250, 255], { x: 10, y: 10, w: 30, h: 30, c: [0, 0, 0, 255] });
  d.set([244, 252, 247, 255], 0 + 3 * 4); // a noisy border pixel
  assert.deepEqual(findTrim(d, 50, 50, 10), { x: 10, y: 10, w: 30, h: 30 });
});

test('trim leaves uniform and edge-to-edge images alone', () => {
  assert.deepEqual(findTrim(img(40, 30, [9, 9, 9, 255]), 40, 30), { x: 0, y: 0, w: 40, h: 30 });
  const full = img(40, 30, [0, 0, 0, 255], { x: 0, y: 0, w: 40, h: 30, c: [0, 0, 0, 255] });
  assert.deepEqual(findTrim(full, 40, 30), { x: 0, y: 0, w: 40, h: 30 });
});

test('history undoes, redoes and drops the redo branch on new edits', () => {
  const h = new History({ v: 1 });
  h.push({ v: 2 });
  h.push({ v: 3 });
  assert.deepEqual(h.undo(), { v: 2 });
  assert.deepEqual(h.undo(), { v: 1 });
  assert.equal(h.undo(), null);
  assert.deepEqual(h.redo(), { v: 2 });
  h.push({ v: 9 });
  assert.equal(h.canRedo, false);
  assert.deepEqual(h.undo(), { v: 2 });
});

test('history ignores no-op pushes and is immune to later mutation', () => {
  const h = new History({ list: [1] });
  assert.equal(h.push({ list: [1] }), false);
  const next = { list: [1, 2] };
  h.push(next);
  next.list.push(3);
  assert.deepEqual(h.undo(), { list: [1] });
  assert.deepEqual(h.redo(), { list: [1, 2] });
});

test('history respects its limit', () => {
  const h = new History({ v: 0 }, 3);
  for (let i = 1; i <= 10; i++) h.push({ v: i });
  let n = 0;
  while (h.undo()) n++;
  assert.equal(n, 3);
});

test('annotation picking: hollow boxes, arrows, topmost wins', () => {
  const box = { id: 'b', type: 'rect', x: 100, y: 100, w: 200, h: 100 };
  const arrow = { id: 'a', type: 'arrow', x1: 0, y1: 0, x2: 100, y2: 100 };
  const hl = { id: 'h', type: 'highlight', x: 150, y: 120, w: 50, h: 20 };
  const list = [box, arrow, hl];
  assert.equal(pick(list, { x: 101, y: 150 }, 1, 4)?.id, 'b', 'box edge');
  assert.equal(pick(list, { x: 250, y: 150 }, 1, 4), null, 'box interior is click-through');
  assert.equal(pick(list, { x: 50, y: 51 }, 1, 4)?.id, 'a', 'on the arrow');
  assert.equal(pick(list, { x: 160, y: 125 }, 1, 4)?.id, 'h', 'filled highlight');
});

test('annotation move and handle drags', () => {
  const a = { type: 'arrow', x1: 0, y1: 0, x2: 10, y2: 10 };
  assert.deepEqual(moveBy(a, 5, -5), { type: 'arrow', x1: 5, y1: -5, x2: 15, y2: 5 });
  assert.deepEqual(dragHandle(a, 'p2', { x: 30, y: 40 }), { type: 'arrow', x1: 0, y1: 0, x2: 30, y2: 40 });
  const r = { type: 'rect', x: 10, y: 10, w: 20, h: 20 };
  // Dragging the NW corner past the SE corner flips cleanly.
  assert.deepEqual(dragHandle(r, 'nw', { x: 50, y: 40 }), { type: 'rect', x: 30, y: 30, w: 20, h: 10 });
  assert.equal(handles(r).length, 4);
});

test('steps count up and tiny drags are discarded', () => {
  assert.equal(nextStep([]), 1);
  assert.equal(nextStep([{ type: 'step', n: 1 }, { type: 'step', n: 4 }, { type: 'rect' }]), 5);
  assert.equal(isDegenerate({ type: 'rect', x: 0, y: 0, w: 2, h: 40 }, 1), true);
  assert.equal(isDegenerate({ type: 'arrow', x1: 0, y1: 0, x2: 40, y2: 0 }, 1), false);
  assert.equal(isDegenerate({ type: 'text', text: '   ' }, 1), true);
});

test('text bounds grow with lines and size', () => {
  const one = bounds({ type: 'text', x: 0, y: 0, text: 'Hi', size: 'm' }, 1);
  const two = bounds({ type: 'text', x: 0, y: 0, text: 'Hi\nthere', size: 'm' }, 1);
  const big = bounds({ type: 'text', x: 0, y: 0, text: 'Hi', size: 'l' }, 1);
  assert.ok(two.h > one.h);
  assert.ok(big.h > one.h && big.w > one.w);
});

test('geometry helpers', () => {
  assert.deepEqual(normRect(10, 20, 0, 5), { x: 0, y: 5, w: 10, h: 15 });
  assert.equal(distToSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5);
  assert.equal(distToSegment({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5);
});
