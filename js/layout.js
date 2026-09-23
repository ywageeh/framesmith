// Pure geometry for the composition. No DOM access, so it runs under `node --test`.
// All sizes are in "base pixels": 1 base px == 1 source-image px at 1x export.

export const ASPECTS = [
  { id: 'auto', label: 'Auto', ratio: null, hint: 'Fits the shot' },
  { id: '16:9', label: '16:9', ratio: 16 / 9, hint: 'X · YouTube' },
  { id: '1.91:1', label: '1.91:1', ratio: 1.91, hint: 'Open Graph · LinkedIn' },
  { id: '4:3', label: '4:3', ratio: 4 / 3, hint: 'Slides · docs' },
  { id: '1:1', label: '1:1', ratio: 1, hint: 'Instagram · square' },
  { id: '4:5', label: '4:5', ratio: 4 / 5, hint: 'Feed portrait' },
  { id: '9:16', label: '9:16', ratio: 9 / 16, hint: 'Stories · Reels' },
];

export const FRAMES = [
  { id: 'none', label: 'None' },
  { id: 'mac-light', label: 'macOS' },
  { id: 'mac-dark', label: 'macOS dark' },
  { id: 'browser-light', label: 'Browser' },
  { id: 'browser-dark', label: 'Browser dark' },
  { id: 'glass', label: 'Glass' },
  { id: 'stack', label: 'Stack' },
];

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Scale unit so chrome looks the same on a 600px shot and a 4K one. */
export function unitFor(w, h) {
  return clamp(Math.max(w, h) / 1400, 0.45, 3);
}

/** Chrome thickness around the image for a frame, in base px. */
export function chromeFor(frame, u) {
  switch (frame) {
    case 'mac-light':
    case 'mac-dark':
      return { top: Math.round(36 * u), right: 0, bottom: 0, left: 0 };
    case 'browser-light':
    case 'browser-dark':
      return { top: Math.round(48 * u), right: 0, bottom: 0, left: 0 };
    case 'glass': {
      const g = Math.round(12 * u);
      return { top: g, right: g, bottom: g, left: g };
    }
    default:
      return { top: 0, right: 0, bottom: 0, left: 0 };
  }
}

/**
 * Lay out a shot of imgW×imgH with the given style.
 * Returns the output canvas size, the card rect (image + chrome) and the image rect.
 */
export function computeLayout(imgW, imgH, style) {
  const u = unitFor(imgW, imgH);
  const chrome = chromeFor(style.frame, u);
  const cardW = imgW + chrome.left + chrome.right;
  const cardH = imgH + chrome.top + chrome.bottom;
  const pad = Math.round((clamp(style.padding, 0, 40) / 100) * Math.max(cardW, cardH));

  let W = cardW + pad * 2;
  let H = cardH + pad * 2;
  const aspect = ASPECTS.find((a) => a.id === style.aspect);
  if (aspect && aspect.ratio) {
    if (W / H < aspect.ratio) W = H * aspect.ratio;
    else H = W / aspect.ratio;
  }
  W = Math.round(W);
  H = Math.round(H);

  const cardX = Math.round((W - cardW) / 2);
  const cardY = Math.round((H - cardH) / 2);
  const radius = Math.min((clamp(style.radius, 0, 48) * u), cardW / 2, cardH / 2);

  return {
    W,
    H,
    u,
    pad,
    radius,
    chrome,
    card: { x: cardX, y: cardY, w: cardW, h: cardH },
    img: { x: cardX + chrome.left, y: cardY + chrome.top, w: imgW, h: imgH },
  };
}

/**
 * Project a card of w×h rotated `deg` degrees around its vertical axis.
 * Returns a function mapping a local x (0..w) to { x, scale } in output space where the
 * result is fitted back inside the original w×h box (so tilt never changes the layout).
 */
export function tiltProjector(w, h, deg) {
  const t = (deg * Math.PI) / 180;
  const D = 2.4 * Math.max(w, h);
  const raw = (x) => {
    const X = x - w / 2;
    const s = D / (D + X * Math.sin(t));
    return { x: X * Math.cos(t) * s, scale: s };
  };
  const a = raw(0);
  const b = raw(w);
  const spanW = Math.abs(b.x - a.x);
  const maxScale = Math.max(a.scale, b.scale);
  const fit = Math.min(w / spanW, 1 / maxScale);
  return (x) => {
    const p = raw(x);
    return { x: w / 2 + p.x * fit, scale: p.scale * fit };
  };
}

/** The four corners of a tilted card, in card-local coordinates. */
export function tiltQuad(w, h, deg) {
  const p = tiltProjector(w, h, deg);
  const l = p(0);
  const r = p(w);
  const cy = h / 2;
  return [
    { x: l.x, y: cy - (h / 2) * l.scale },
    { x: r.x, y: cy - (h / 2) * r.scale },
    { x: r.x, y: cy + (h / 2) * r.scale },
    { x: l.x, y: cy + (h / 2) * l.scale },
  ];
}

/**
 * Largest export multiplier that keeps the canvas inside what every browser can allocate
 * (Safari caps canvases at ~16.7M pixels).
 */
export const MAX_PIXELS = 16_000_000;
export function safeScale(W, H, wanted) {
  const max = Math.sqrt(MAX_PIXELS / (W * H));
  return Math.min(wanted, Math.floor(max * 100) / 100);
}

/** Normalise a rectangle drawn in any direction. */
export function normRect(x1, y1, x2, y2) {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

/** Distance from point p to segment ab. */
export function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
