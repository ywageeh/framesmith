// Renderer: background → shadow → (stack) → card (chrome + shot + annotations) → tilt.
// One code path draws both the live preview (small scale) and the export (1–3x).

import { computeLayout, tiltProjector, tiltQuad, MAX_PIXELS } from './layout.js';
import { paintBackground, isDarkBackground } from './backgrounds.js';
import { inkUnit, fontSize, textBox, stepRadius, SIZES, handles, bounds } from './annotations.js';

const FONT = '"Geist", system-ui, -apple-system, "Segoe UI", sans-serif';

const canvas = (w, h) => {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
};

function rr(ctx, x, y, w, h, r) {
  const rad = Array.isArray(r) ? r : [r, r, r, r];
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, rad.map((v) => Math.max(0, Math.min(v, w / 2, h / 2))));
}

const luminance = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};

/* ------------------------------------------------------------------ annotations */

function pixelate(ctx, src, a, iu) {
  const block = Math.max(6, Math.round(12 * iu));
  const w = Math.max(1, Math.ceil(a.w / block));
  const h = Math.max(1, Math.ceil(a.h / block));
  const tmp = canvas(w, h);
  const t = tmp.getContext('2d');
  t.imageSmoothingEnabled = true;
  t.drawImage(src, a.x, a.y, a.w, a.h, 0, 0, w, h);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, w, h, a.x, a.y, a.w, a.h);
  ctx.restore();
}

function arrow(ctx, a, iu) {
  const w = 5 * iu * (SIZES[a.size] || 1);
  const len = Math.hypot(a.x2 - a.x1, a.y2 - a.y1);
  if (len < 1) return;
  const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
  const head = Math.min(len * 0.6, w * 4.2);
  const bx = a.x2 - Math.cos(ang) * head * 0.8;
  const by = a.y2 - Math.sin(ang) * head * 0.8;
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Tapered shaft: thin at the tail, full weight at the head.
  const nx = -Math.sin(ang);
  const ny = Math.cos(ang);
  ctx.beginPath();
  ctx.moveTo(a.x1 + (nx * w) / 4, a.y1 + (ny * w) / 4);
  ctx.lineTo(bx + (nx * w) / 2, by + (ny * w) / 2);
  ctx.lineTo(bx - (nx * w) / 2, by - (ny * w) / 2);
  ctx.lineTo(a.x1 - (nx * w) / 4, a.y1 - (ny * w) / 4);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(a.x1, a.y1, w / 4, 0, Math.PI * 2);
  ctx.fill();
  // Head.
  const spread = 0.48;
  ctx.beginPath();
  ctx.moveTo(a.x2, a.y2);
  ctx.lineTo(a.x2 - Math.cos(ang - spread) * head, a.y2 - Math.sin(ang - spread) * head);
  ctx.quadraticCurveTo(bx, by, a.x2 - Math.cos(ang + spread) * head, a.y2 - Math.sin(ang + spread) * head);
  ctx.closePath();
  ctx.lineWidth = w * 0.5;
  ctx.stroke();
  ctx.fill();
}

function inkShadow(ctx, iu, s) {
  ctx.shadowColor = 'rgba(15, 10, 5, 0.28)';
  ctx.shadowBlur = 6 * iu * s;
  ctx.shadowOffsetY = 1.5 * iu * s;
}

export function measureText(text, fs) {
  const c = measureText.ctx || (measureText.ctx = canvas(1, 1).getContext('2d'));
  c.font = `600 ${fs}px ${FONT}`;
  return c.measureText(text).width;
}

/** Draw annotations in image space. `s` = device px per image px (for shadow blur). */
export function drawAnnotations(ctx, src, list, imgW, imgH, s) {
  const iu = inkUnit(imgW, imgH);
  const order = (a) => ({ redact: 0, focus: 1, highlight: 2 })[a.type] ?? 3;
  const sorted = [...list].sort((a, b) => order(a) - order(b));
  for (const a of sorted) {
    ctx.save();
    switch (a.type) {
      case 'redact':
        pixelate(ctx, src, a, iu);
        break;
      case 'focus': {
        ctx.fillStyle = 'rgba(12, 10, 14, 0.58)';
        ctx.beginPath();
        ctx.rect(0, 0, imgW, imgH);
        ctx.roundRect(a.x, a.y, a.w, a.h, 8 * iu);
        ctx.fill('evenodd');
        break;
      }
      case 'highlight':
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = a.color;
        rr(ctx, a.x, a.y, a.w, a.h, 3 * iu);
        ctx.fill();
        break;
      case 'rect': {
        const w = 4 * iu * (SIZES[a.size] || 1);
        inkShadow(ctx, iu, s);
        ctx.strokeStyle = a.color;
        ctx.lineWidth = w;
        rr(ctx, a.x, a.y, a.w, a.h, 6 * iu);
        ctx.stroke();
        break;
      }
      case 'arrow':
        inkShadow(ctx, iu, s);
        arrow(ctx, a, iu);
        break;
      case 'text': {
        const b = textBox(a, iu, measureText);
        inkShadow(ctx, iu, s);
        ctx.fillStyle = a.color;
        rr(ctx, b.x, b.y, b.w, b.h, b.fs * 0.45);
        ctx.fill();
        ctx.shadowColor = 'transparent';
        ctx.fillStyle = luminance(a.color) > 0.62 ? '#17171b' : '#ffffff';
        ctx.font = `600 ${b.fs}px ${FONT}`;
        ctx.textBaseline = 'middle';
        b.lines.forEach((line, i) => {
          ctx.fillText(line, b.x + b.padX, b.y + b.padY + b.fs * 1.25 * (i + 0.5));
        });
        break;
      }
      case 'step': {
        const r = stepRadius(a, iu);
        inkShadow(ctx, iu, s);
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(a.x, a.y, r + 2.5 * iu, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowColor = 'transparent';
        ctx.fillStyle = a.color;
        ctx.beginPath();
        ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = luminance(a.color) > 0.62 ? '#17171b' : '#ffffff';
        ctx.font = `700 ${Math.round(r * 1.05)}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(a.n), a.x, a.y + r * 0.06);
        break;
      }
    }
    ctx.restore();
  }
}

/** Selection chrome for the preview (never exported). */
export function drawSelection(ctx, a, imgW, imgH, s) {
  const iu = inkUnit(imgW, imgH);
  const b = bounds(a, iu, measureText);
  const px = 1 / s;
  ctx.save();
  ctx.lineWidth = 1.5 * px;
  ctx.strokeStyle = '#ff5a36';
  ctx.setLineDash([5 * px, 4 * px]);
  const m = 5 * px;
  if (a.type !== 'arrow') ctx.strokeRect(b.x - m, b.y - m, b.w + m * 2, b.h + m * 2);
  ctx.setLineDash([]);
  for (const h of handles(a)) {
    ctx.beginPath();
    ctx.arc(h.x, h.y, 5.5 * px, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ chrome */

function trafficLights(ctx, x, cy, u) {
  const colors = ['#ff5f57', '#febc2e', '#28c840'];
  colors.forEach((c, i) => {
    ctx.beginPath();
    ctx.arc(x + i * 20 * u, cy, 6 * u, 0, Math.PI * 2);
    ctx.fillStyle = c;
    ctx.fill();
    ctx.lineWidth = 0.75 * u;
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.stroke();
  });
}

function paintPhone(ctx, style, L) {
  const dark = style.frame.endsWith('dark');
  const { w, h } = L.card;
  const g = ctx.createLinearGradient(0, 0, w, h);
  if (dark) {
    g.addColorStop(0, '#3a3a3f');
    g.addColorStop(0.5, '#17171a');
    g.addColorStop(1, '#2c2c30');
  } else {
    g.addColorStop(0, '#f4f2ee');
    g.addColorStop(0.5, '#d4d0c9');
    g.addColorStop(1, '#e9e6e0');
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // Inner black rim between the metal band and the glass.
  const b = L.chrome.left;
  const rim = b * 0.42;
  rr(ctx, b - rim, b - rim, w - 2 * (b - rim), h - 2 * (b - rim), Math.max(0, L.radius - (b - rim)));
  ctx.fillStyle = '#0b0b0d';
  ctx.fill();
}

/** Dynamic-island pill over the top of the screen. */
function paintIsland(ctx, shotW) {
  const iw = shotW * 0.29;
  const ih = shotW * 0.085;
  rr(ctx, (shotW - iw) / 2, shotW * 0.028, iw, ih, ih / 2);
  ctx.fillStyle = '#060607';
  ctx.fill();
}

function paintChrome(ctx, style, L, u) {
  const { frame, frameTitle } = style;
  const w = L.card.w;
  const tb = L.chrome.top;
  if (frame.startsWith('phone')) {
    paintPhone(ctx, style, L);
    return;
  }
  if (frame.startsWith('mac') || frame.startsWith('browser')) {
    const dark = frame.endsWith('dark');
    const g = ctx.createLinearGradient(0, 0, 0, tb);
    g.addColorStop(0, dark ? '#34343a' : '#f6f4f1');
    g.addColorStop(1, dark ? '#2a2a2f' : '#ebe8e3');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, tb);
    ctx.fillStyle = dark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.09)';
    ctx.fillRect(0, tb - Math.max(1, u), w, Math.max(1, u));
    trafficLights(ctx, 18 * u, tb / 2, u);
    const title = (frameTitle || '').trim();
    if (frame.startsWith('browser')) {
      const pw = Math.min(w * 0.56, 560 * u);
      const ph = 26 * u;
      const px = (w - pw) / 2;
      const py = (tb - ph) / 2;
      rr(ctx, px, py, pw, ph, 7 * u);
      ctx.fillStyle = dark ? '#1e1e22' : '#fdfcfa';
      ctx.fill();
      ctx.lineWidth = u;
      ctx.strokeStyle = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)';
      ctx.stroke();
      // Padlock.
      const text = title || 'framesmith.app';
      ctx.font = `500 ${12.5 * u}px ${FONT}`;
      const tw = Math.min(ctx.measureText(text).width, pw - 60 * u);
      const lx = w / 2 - tw / 2 - 12 * u;
      ctx.fillStyle = dark ? '#8d8a90' : '#8a847c';
      rr(ctx, lx - 4 * u, tb / 2 - 1 * u, 8 * u, 6.5 * u, 1.5 * u);
      ctx.fill();
      ctx.beginPath();
      ctx.lineWidth = 1.3 * u;
      ctx.strokeStyle = ctx.fillStyle;
      ctx.arc(lx, tb / 2 - 1 * u, 2.6 * u, Math.PI, 0);
      ctx.stroke();
      ctx.fillStyle = dark ? '#c9c6cc' : '#57524c';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.save();
      ctx.beginPath();
      ctx.rect(px, py, pw - 14 * u, ph);
      ctx.clip();
      ctx.fillText(text, w / 2 - tw / 2 + 2 * u, tb / 2 + 0.5 * u);
      ctx.restore();
    } else if (title) {
      ctx.font = `600 ${13 * u}px ${FONT}`;
      ctx.fillStyle = dark ? '#b8b5ba' : '#6f6962';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(title, w / 2, tb / 2 + 0.5 * u, w - 160 * u);
    }
  }
}

/** Render the card (chrome + shot + annotations) at scale s into a new canvas. */
function renderCard(doc, shot, L, s, selectedId) {
  const { style } = doc;
  const u = L.u;
  const c = canvas(L.card.w * s, L.card.h * s);
  const ctx = c.getContext('2d');
  ctx.scale(s, s);
  const r = L.radius;

  rr(ctx, 0, 0, L.card.w, L.card.h, r);
  ctx.clip();

  if (style.frame === 'glass') {
    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    ctx.fillRect(0, 0, L.card.w, L.card.h);
  }
  paintChrome(ctx, style, L, u);

  // Shot region (with its own rounding for inner corners).
  const ix = L.chrome.left;
  const iy = L.chrome.top;
  const phone = style.frame.startsWith('phone');
  const innerR =
    style.frame === 'glass' || phone
      ? Math.max(0, r - L.chrome.left)
      : L.chrome.top
        ? [0, 0, r, r]
        : r;
  ctx.save();
  rr(ctx, ix, iy, shot.w, shot.h, innerR);
  ctx.clip();
  ctx.translate(ix, iy);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(shot.bitmap, shot.sx || 0, shot.sy || 0, shot.w, shot.h, 0, 0, shot.w, shot.h);
  if (doc.annotations.length) {
    // Redactions sample the (cropped) source pixels.
    drawAnnotations(ctx, sourceOf(shot), doc.annotations, shot.w, shot.h, s);
  }
  if (phone && style.island !== false) paintIsland(ctx, shot.w);
  const sel = selectedId && doc.annotations.find((a) => a.id === selectedId);
  if (sel) drawSelection(ctx, sel, shot.w, shot.h, s);
  ctx.restore();

  // Hairline edge for definition.
  rr(ctx, 0.5 / s, 0.5 / s, L.card.w - 1 / s, L.card.h - 1 / s, r);
  ctx.lineWidth = Math.max(1 / s, u * 0.8);
  ctx.strokeStyle =
    style.frame === 'glass'
      ? 'rgba(255,255,255,0.55)'
      : phone
        ? style.frame.endsWith('dark')
          ? 'rgba(255,255,255,0.22)'
          : 'rgba(0,0,0,0.18)'
        : style.frame.endsWith('dark')
          ? 'rgba(255,255,255,0.1)'
          : 'rgba(0,0,0,0.08)';
  ctx.stroke();
  return c;
}

/** The pixels actually on show: the crop when there is one, else the bitmap itself. */
function sourceOf(shot) {
  const b = shot.bitmap;
  return shot.sx || shot.sy || shot.w !== b.width || shot.h !== b.height ? cropped(shot) : b;
}

const cropCache = new WeakMap();
function cropped(shot) {
  const key = shot.bitmap;
  const hit = cropCache.get(key);
  if (hit && hit.sx === shot.sx && hit.sy === shot.sy && hit.w === shot.w && hit.h === shot.h) return hit.c;
  const c = canvas(shot.w, shot.h);
  c.getContext('2d').drawImage(shot.bitmap, shot.sx, shot.sy, shot.w, shot.h, 0, 0, shot.w, shot.h);
  cropCache.set(key, { c, sx: shot.sx, sy: shot.sy, w: shot.w, h: shot.h });
  return c;
}

/* ------------------------------------------------------------------ shadow */

function castShadow(ctx, path, strength, unit) {
  const k = strength / 100;
  if (k <= 0) return;
  const OFF = 50000;
  const layers = [
    { blur: 3, y: 1, a: 0.16 },
    { blur: 22, y: 10, a: 0.18 },
    { blur: 70, y: 34, a: 0.26 },
  ];
  for (const l of layers) {
    ctx.save();
    ctx.shadowColor = `rgba(24, 14, 6, ${Math.min(0.9, l.a * k * 1.6)})`;
    ctx.shadowBlur = l.blur * unit * (0.5 + k);
    ctx.shadowOffsetX = OFF;
    ctx.shadowOffsetY = l.y * unit * (0.4 + k);
    ctx.translate(-OFF, 0);
    path();
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ badge */

/** Signature pill ("@handle") in a bottom corner of the canvas. */
function paintBadge(ctx, style, L, s, palette) {
  const text = (style.badge?.text || '').trim();
  if (!text) return;
  const m = Math.min(L.W, L.H);
  const fs = Math.max(12, Math.min(64, m * 0.026));
  ctx.save();
  ctx.scale(s, s);
  ctx.font = `600 ${fs}px ${FONT}`;
  const tw = Math.min(ctx.measureText(text).width, L.W * 0.6);
  const padX = fs * 0.8;
  const h = fs * 2;
  const w = tw + padX * 2;
  const margin = Math.max(fs, m * 0.035);
  const pos = style.badge?.pos || 'right';
  const x = pos === 'left' ? margin : pos === 'center' ? (L.W - w) / 2 : L.W - margin - w;
  const y = L.H - margin - h;
  const dark = isDarkBackground(style.bg, palette);
  rr(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = dark ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.72)';
  ctx.fill();
  ctx.lineWidth = Math.max(1, fs * 0.06);
  ctx.strokeStyle = dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.06)';
  ctx.stroke();
  ctx.fillStyle = dark ? '#ffffff' : '#1d1a17';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + padX, y + h / 2 + fs * 0.04, tw);
  ctx.restore();
}

/* ------------------------------------------------------------------ main */

/**
 * Draw the whole composition into `ctx` (already sized to L.W*s × L.H*s).
 * @param {object} opts { s, flat, selectedId, supersample }
 */
export function render(ctx, doc, shot, assets, opts = {}) {
  const s = opts.s || 1;
  const { style } = doc;
  const L = computeLayout(shot.w, shot.h, style);
  const W = L.W * s;
  const H = L.H * s;
  ctx.clearRect(0, 0, W, H);

  paintBackground(ctx, W, H, style.bg, {
    shot: sourceOf(shot),
    assets,
    grainOn: style.grain,
    palette: shot.palette,
  });

  const tilt = opts.flat ? 0 : style.tilt || 0;
  const cx = L.card.x * s;
  const cy = L.card.y * s;
  const cw = Math.round(L.card.w * s);
  const ch = Math.round(L.card.h * s);
  const r = L.radius * s;
  const unit = L.u * s;
  // The tilt warp resamples, so it works on a 2x card and downsamples at the end
  // (supersampling) to keep text crisp. Capped to stay within the canvas budget.
  const ss = tilt
    ? (opts.supersample ?? Math.max(1, Math.min(2, Math.sqrt(MAX_PIXELS / Math.max(1, cw * ch)))))
    : 1;
  const card = renderCard(doc, shot, L, s * ss, opts.selectedId);

  if (style.frame === 'stack') {
    // Two ghost cards peeking out above.
    const layers = [
      { dy: -30, k: 0.88, a: 0.32 },
      { dy: -15, k: 0.94, a: 0.6 },
    ];
    for (const l of layers) {
      const w = cw * l.k;
      const h = ch * l.k;
      const x = cx + (cw - w) / 2;
      const y = cy + l.dy * unit;
      castShadow(ctx, () => rr(ctx, x, y, w, h, r), style.shadow * 0.5, unit);
      ctx.save();
      ctx.globalAlpha = l.a;
      rr(ctx, x, y, w, h, r);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.restore();
    }
  }

  if (!tilt) {
    castShadow(ctx, () => rr(ctx, cx, cy, cw, ch, r), style.shadow, unit);
    ctx.drawImage(card, cx, cy);
    paintBadge(ctx, style, L, s, shot.palette);
    return L;
  }

  // Tilted: warp the (supersampled) card column by column into a layer, add a sheen,
  // then downsample onto the composition.
  const q = tiltQuad(cw, ch, tilt);
  castShadow(
    ctx,
    () => {
      ctx.beginPath();
      q.forEach((p, i) => (i ? ctx.lineTo(cx + p.x, cy + p.y) : ctx.moveTo(cx + p.x, cy + p.y)));
      ctx.closePath();
    },
    style.shadow,
    unit,
  );
  const sw = card.width;
  const sh = card.height;
  const layer = canvas(sw, sh);
  const lc = layer.getContext('2d');
  const proj = tiltProjector(sw, sh, tilt);
  const sq = tiltQuad(sw, sh, tilt);
  lc.imageSmoothingEnabled = true;
  lc.imageSmoothingQuality = 'high';
  // Walk output columns and sample the source column each one sees: no seams, no overlap.
  // The fractional source x lets the browser interpolate between neighbouring columns.
  const x0 = Math.floor(Math.min(sq[0].x, sq[3].x));
  const x1 = Math.ceil(Math.max(sq[1].x, sq[2].x));
  for (let ox = x0; ox < x1; ox++) {
    const m = proj.inverse(ox + 0.5);
    if (!m) continue;
    const dh = sh * m.scale;
    const sx = Math.min(sw - 1, Math.max(0, m.sx - 0.5));
    lc.drawImage(card, sx, 0, 1, sh, ox, sh / 2 - dh / 2, 1, dh);
  }
  lc.globalCompositeOperation = 'source-atop';
  const near = tilt > 0 ? 0 : sw;
  const g = lc.createLinearGradient(near, 0, sw - near, 0);
  g.addColorStop(0, 'rgba(255,255,255,0.14)');
  g.addColorStop(0.5, 'rgba(255,255,255,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.08)');
  lc.fillStyle = g;
  lc.fillRect(0, 0, sw, sh);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(layer, cx, cy, cw, ch);
  ctx.restore();
  paintBadge(ctx, style, L, s, shot.palette);
  return L;
}

/** Export at `scale` → Blob. */
export async function exportBlob(doc, shot, assets, { scale = 2, type = 'image/png', quality = 0.92 } = {}) {
  const L = computeLayout(shot.w, shot.h, doc.style);
  let c = canvas(L.W * scale, L.H * scale);
  render(c.getContext('2d'), doc, shot, assets, { s: scale });
  if (type === 'image/jpeg') {
    // JPEG has no alpha: flatten onto white rather than black.
    const flat = canvas(c.width, c.height);
    const f = flat.getContext('2d');
    f.fillStyle = '#ffffff';
    f.fillRect(0, 0, flat.width, flat.height);
    f.drawImage(c, 0, 0);
    c = flat;
  }
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Export failed'))), type, quality));
}

export { computeLayout, fontSize };
