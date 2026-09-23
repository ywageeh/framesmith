// "Match" backgrounds: pull the accent colours out of a screenshot and build a mesh that
// belongs with it. Pure, so it runs under `node --test`.

export function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

export function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.min(1, Math.max(0, s));
  l = Math.min(1, Math.max(0, l));
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (x) =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

const hueDist = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/**
 * Extract up to `n` accent hues from RGBA pixels (pass a small downscaled copy).
 * Screenshots are mostly white/grey UI, so colour is weighted far above area.
 * @returns {{ hues: number[], neutral: boolean, dominant: {h,s,l} }}
 */
export function extractPalette(data, n = 3) {
  const bins = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    const b = bins.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    b.n++;
    b.r += data[i];
    b.g += data[i + 1];
    b.b += data[i + 2];
    bins.set(key, b);
  }
  const colors = [...bins.values()].map((b) => {
    const c = rgbToHsl(b.r / b.n, b.g / b.n, b.b / b.n);
    const usable = c.l > 0.12 && c.l < 0.9 ? 1 : 0.1;
    return { ...c, n: b.n, score: b.n * (0.05 + c.s * c.s * 3) * usable };
  });
  const dominant = colors.reduce((m, c) => (c.n > m.n ? c : m), { n: 0, h: 0, s: 0, l: 1 });
  const vivid = colors.filter((c) => c.s > 0.22 && c.l > 0.12 && c.l < 0.9).sort((a, b) => b.score - a.score);

  const hues = [];
  for (const c of vivid) {
    if (hues.every((h) => hueDist(h, c.h) >= 28)) hues.push(Math.round(c.h));
    if (hues.length === n) break;
  }
  return { hues, neutral: hues.length === 0, dominant: { h: dominant.h, s: dominant.s, l: dominant.l } };
}

/** Fill out to three hues with analogous companions so the mesh never looks flat. */
export function companionHues(palette) {
  const hues = palette.hues.length ? [...palette.hues] : [28, 12, 350]; // warm fallback for grey UIs
  if (hues.length === 1) hues.push(hues[0] + 34, hues[0] - 28);
  if (hues.length === 2) hues.push(hues[0] + (hueDist(hues[0], hues[1]) > 90 ? 180 : -40));
  return hues.slice(0, 3);
}

export const MATCH_VARIANTS = [
  { id: 'soft', label: 'Soft' },
  { id: 'vivid', label: 'Vivid' },
  { id: 'deep', label: 'Deep' },
  { id: 'duo', label: 'Duotone' },
];

/**
 * Build a background spec from a palette.
 * Returns { kind: 'mesh', base, blobs } or { kind: 'gradient', angle, stops }.
 */
export function matchBackground(palette, variant = 'soft') {
  const [a, b, c] = companionHues(palette);
  switch (variant) {
    case 'vivid':
      return {
        kind: 'mesh',
        base: hslToHex(a, 0.72, 0.58),
        blobs: [
          [0.08, 0.12, 0.7, hslToHex(b, 0.86, 0.64)],
          [0.92, 0.2, 0.6, hslToHex(c, 0.82, 0.56)],
          [0.7, 0.98, 0.75, hslToHex(a, 0.9, 0.7)],
          [0.15, 0.95, 0.5, hslToHex(b, 0.75, 0.5)],
        ],
      };
    case 'deep':
      return {
        kind: 'mesh',
        base: hslToHex(a, 0.42, 0.1),
        blobs: [
          [0.15, 0.2, 0.65, hslToHex(a, 0.7, 0.32)],
          [0.9, 0.85, 0.7, hslToHex(b, 0.65, 0.36)],
          [0.85, 0.1, 0.45, hslToHex(c, 0.6, 0.24)],
        ],
      };
    case 'duo':
      return { kind: 'gradient', angle: 135, stops: [hslToHex(a, 0.78, 0.74), hslToHex(b, 0.7, 0.56)] };
    case 'soft':
    default:
      return {
        kind: 'mesh',
        base: hslToHex(a, 0.5, 0.94),
        blobs: [
          [0.1, 0.1, 0.7, hslToHex(a, 0.75, 0.8)],
          [0.9, 0.15, 0.6, hslToHex(b, 0.75, 0.83)],
          [0.75, 0.95, 0.7, hslToHex(c, 0.7, 0.79)],
          [0.1, 0.92, 0.5, hslToHex(a, 0.6, 0.88)],
        ],
      };
  }
}
