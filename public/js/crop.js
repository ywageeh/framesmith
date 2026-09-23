// Crop-rectangle math in source-image pixels. Pure, so it runs under `node --test`.

import { clamp } from './layout.js';

export const CROP_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Handle positions for a rect. */
export function cropHandlePoints(r) {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const x2 = r.x + r.w;
  const y2 = r.y + r.h;
  return {
    nw: { x: r.x, y: r.y },
    n: { x: cx, y: r.y },
    ne: { x: x2, y: r.y },
    e: { x: x2, y: cy },
    se: { x: x2, y: y2 },
    s: { x: cx, y: y2 },
    sw: { x: r.x, y: y2 },
    w: { x: r.x, y: cy },
  };
}

/**
 * Resize `r` by dragging `handle` to point `p`, inside a W×H image.
 * With `aspect` (w/h) the rect keeps that ratio: corners pivot on the opposite corner,
 * edges pivot on the opposite edge and stay centred on the other axis.
 */
export function resizeCrop(r, handle, p, aspect, W, H, min = 16) {
  // Direction of growth per axis: +1 grows right/down, -1 left/up, 0 = this axis follows.
  const sx = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0;
  const sy = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0;
  const ax = sx > 0 ? r.x : sx < 0 ? r.x + r.w : r.x + r.w / 2;
  const ay = sy > 0 ? r.y : sy < 0 ? r.y + r.h : r.y + r.h / 2;

  let w = sx ? Math.max(min, sx > 0 ? p.x - ax : ax - p.x) : r.w;
  let h = sy ? Math.max(min, sy > 0 ? p.y - ay : ay - p.y) : r.h;

  const maxW = sx > 0 ? W - ax : sx < 0 ? ax : aspect ? 2 * Math.min(ax, W - ax) : W;
  const maxH = sy > 0 ? H - ay : sy < 0 ? ay : aspect ? 2 * Math.min(ay, H - ay) : H;

  if (aspect) {
    if (sx && sy) {
      // Corner: follow whichever axis the pointer pushed further.
      if (w / h > aspect) h = w / aspect;
      else w = h * aspect;
    } else if (sx) h = w / aspect;
    else w = h * aspect;
    if (w > maxW) {
      w = maxW;
      h = w / aspect;
    }
    if (h > maxH) {
      h = maxH;
      w = h * aspect;
    }
  } else {
    w = Math.min(w, maxW);
    h = Math.min(h, maxH);
  }

  const x = sx > 0 ? ax : sx < 0 ? ax - w : aspect ? ax - w / 2 : r.x;
  const y = sy > 0 ? ay : sy < 0 ? ay - h : aspect ? ay - h / 2 : r.y;
  return roundRect({ x, y, w, h }, W, H);
}

/** Move a rect by dx/dy, kept inside the image. */
export function moveCrop(r, dx, dy, W, H) {
  return roundRect({ ...r, x: clamp(r.x + dx, 0, W - r.w), y: clamp(r.y + dy, 0, H - r.h) }, W, H);
}

/** The largest rect of `aspect` centred inside `r` (or the whole image when r is null). */
export function fitAspect(r, aspect, W, H) {
  const base = r || { x: 0, y: 0, w: W, h: H };
  if (!aspect) return roundRect(base, W, H);
  let w = base.w;
  let h = w / aspect;
  if (h > base.h) {
    h = base.h;
    w = h * aspect;
  }
  return roundRect({ x: base.x + (base.w - w) / 2, y: base.y + (base.h - h) / 2, w, h }, W, H);
}

function roundRect(r, W, H) {
  const x = clamp(Math.round(r.x), 0, W - 1);
  const y = clamp(Math.round(r.y), 0, H - 1);
  return { x, y, w: clamp(Math.round(r.w), 1, W - x), h: clamp(Math.round(r.h), 1, H - y) };
}

/** A crop equal to the whole image is no crop at all. */
export const isFullCrop = (r, W, H) => !r || (r.x === 0 && r.y === 0 && r.w === W && r.h === H);
