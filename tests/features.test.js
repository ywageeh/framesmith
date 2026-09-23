// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeLayout, bezelFor } from '../public/js/layout.js';
import { resizeCrop, moveCrop, fitAspect, isFullCrop, cropHandlePoints } from '../public/js/crop.js';
import { extractPalette, matchBackground, companionHues, rgbToHsl, hslToHex } from '../public/js/palette.js';

const base = { frame: 'none', padding: 10, radius: 12, aspect: 'auto', tilt: 0 };

/* ---------------------------------------------------------------- layout */

test('offset shifts the card by a fraction of the canvas', () => {
  const c = computeLayout(1000, 600, base);
  const o = computeLayout(1000, 600, { ...base, offset: { x: 0.1, y: -0.2 } });
  assert.equal(o.W, c.W);
  assert.equal(o.card.x - c.card.x, Math.round(0.1 * c.W));
  assert.equal(o.card.y - c.card.y, Math.round(-0.2 * c.H));
  assert.equal(o.img.x - o.card.x, c.img.x - c.card.x, 'image moves with the card');
});

test('offset is clamped so the card never leaves the canvas entirely', () => {
  const o = computeLayout(1000, 600, { ...base, offset: { x: 5, y: -5 } });
  const c = computeLayout(1000, 600, { ...base, offset: { x: 0.5, y: -0.5 } });
  assert.deepEqual(o.card, c.card);
});

test('phone frame wraps the screen in an even bezel with big corners', () => {
  const L = computeLayout(1170, 2532, { ...base, frame: 'phone-dark', padding: 0 });
  const b = bezelFor(1170);
  assert.deepEqual(L.chrome, { top: b, right: b, bottom: b, left: b });
  assert.equal(L.card.w, 1170 + 2 * b);
  assert.ok(L.radius > 100, 'phone corners ignore the corner slider and stay device-like');
});

/* ---------------------------------------------------------------- crop */

const W = 1000;
const H = 800;
const r0 = { x: 100, y: 100, w: 400, h: 300 };

test('free resize from a corner pins the opposite corner', () => {
  const r = resizeCrop(r0, 'se', { x: 700, y: 600 }, null, W, H);
  assert.deepEqual(r, { x: 100, y: 100, w: 600, h: 500 });
  const l = resizeCrop(r0, 'nw', { x: 50, y: 20 }, null, W, H);
  assert.deepEqual(l, { x: 50, y: 20, w: 450, h: 380 });
});

test('free resize from an edge only changes that axis', () => {
  const r = resizeCrop(r0, 'e', { x: 800, y: 9999 }, null, W, H);
  assert.deepEqual(r, { x: 100, y: 100, w: 700, h: 300 });
});

test('resizing clamps to the image and a minimum size', () => {
  assert.deepEqual(resizeCrop(r0, 'se', { x: 5000, y: 5000 }, null, W, H), { x: 100, y: 100, w: 900, h: 700 });
  const tiny = resizeCrop(r0, 'se', { x: 0, y: 0 }, null, W, H);
  assert.equal(tiny.w, 16);
  assert.equal(tiny.h, 16);
});

test('locked aspect holds through corner and edge drags', () => {
  for (const [handle, p] of [['se', { x: 900, y: 350 }], ['nw', { x: 0, y: 0 }], ['e', { x: 900, y: 0 }], ['n', { x: 0, y: 10 }]]) {
    const r = resizeCrop(r0, handle, p, 16 / 9, W, H);
    assert.ok(Math.abs(r.w / r.h - 16 / 9) < 0.02, `${handle}: ${r.w}x${r.h}`);
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= W && r.y + r.h <= H, `${handle} stays inside`);
  }
});

test('move keeps the crop inside the image', () => {
  assert.deepEqual(moveCrop(r0, -500, 9999, W, H), { x: 0, y: 500, w: 400, h: 300 });
});

test('fitAspect finds the largest centred rect', () => {
  assert.deepEqual(fitAspect(null, 1, W, H), { x: 100, y: 0, w: 800, h: 800 });
  assert.deepEqual(fitAspect(null, null, W, H), { x: 0, y: 0, w: 1000, h: 800 });
});

test('full-image crops count as no crop', () => {
  assert.equal(isFullCrop(null, W, H), true);
  assert.equal(isFullCrop({ x: 0, y: 0, w: W, h: H }, W, H), true);
  assert.equal(isFullCrop(r0, W, H), false);
  assert.equal(Object.keys(cropHandlePoints(r0)).length, 8);
});

/* ---------------------------------------------------------------- palette */

function pixels(list) {
  // list of [count, [r,g,b]]
  const out = [];
  for (const [n, c] of list) for (let i = 0; i < n; i++) out.push(...c, 255);
  return new Uint8ClampedArray(out);
}

test('colour conversions round-trip', () => {
  const { h, s, l } = rgbToHsl(31, 111, 92);
  assert.equal(hslToHex(h, s, l), '#1f6f5c');
  assert.equal(hslToHex(0, 0, 1), '#ffffff');
});

test('a mostly white UI with a green accent yields the green hue', () => {
  const p = extractPalette(pixels([[900, [251, 250, 248]], [60, [228, 224, 217]], [40, [31, 111, 92]]]));
  assert.equal(p.neutral, false);
  assert.ok(Math.abs(p.hues[0] - 166) < 8, `hue ${p.hues[0]}`);
});

test('distinct accents are kept, near-duplicates merged', () => {
  const p = extractPalette(
    pixels([[800, [255, 255, 255]], [50, [59, 130, 246]], [45, [66, 135, 250]], [40, [239, 68, 68]]]),
  );
  assert.equal(p.hues.length, 2);
});

test('grey screenshots fall back to a warm palette', () => {
  const p = extractPalette(pixels([[500, [240, 240, 240]], [500, [30, 30, 30]]]));
  assert.equal(p.neutral, true);
  assert.equal(companionHues(p).length, 3);
});

test('every match variant produces a valid background spec', () => {
  const p = { hues: [210], neutral: false };
  for (const v of ['soft', 'vivid', 'deep', 'duo']) {
    const bg = matchBackground(p, v);
    const colors = bg.kind === 'mesh' ? [bg.base, ...bg.blobs.map((b) => b[3])] : bg.stops;
    for (const c of colors) assert.match(c, /^#[0-9a-f]{6}$/);
  }
});
