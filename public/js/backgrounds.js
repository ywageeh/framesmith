// Background presets and painters. Everything is procedural: no image assets to download.

export const GRADIENTS = [
  { id: 'ember', angle: 135, stops: ['#ff9a5a', '#ff4f6d'] },
  { id: 'apricot', angle: 160, stops: ['#ffe3c2', '#ffb08a', '#f7806b'] },
  { id: 'sherbet', angle: 120, stops: ['#ffe29f', '#ffa99f', '#ff719a'] },
  { id: 'citrus', angle: 140, stops: ['#fbe36b', '#f99b45'] },
  { id: 'moss', angle: 150, stops: ['#e2ebb1', '#8fb070', '#4e7a52'] },
  { id: 'sea-glass', angle: 135, stops: ['#d4f5ec', '#7fcdbb', '#3e9a8f'] },
  { id: 'lagoon', angle: 125, stops: ['#48b4ff', '#3ad8e8', '#a6f7c9'] },
  { id: 'glacier', angle: 180, stops: ['#eef4fb', '#c5d7ee'] },
  { id: 'rose', angle: 135, stops: ['#fcd9e8', '#e27aa6', '#a53d76'] },
  { id: 'dusk', angle: 160, stops: ['#2a2150', '#86417a', '#f07a5a'] },
  { id: 'midnight', angle: 145, stops: ['#0f2027', '#203a43', '#2c5364'] },
  { id: 'ink', angle: 160, stops: ['#2a2b31', '#16171b'] },
];

export const MESHES = [
  {
    id: 'peach',
    base: '#ffd9c2',
    blobs: [
      [0.1, 0.1, 0.7, '#ff8f70'],
      [0.9, 0.2, 0.6, '#ffc76b'],
      [0.7, 0.95, 0.7, '#ff6b8b'],
      [0.15, 0.9, 0.5, '#ffe8a3'],
    ],
  },
  {
    id: 'aurora',
    base: '#0c1a2a',
    blobs: [
      [0.2, 0.15, 0.7, '#1fbf9a'],
      [0.85, 0.3, 0.65, '#3d5bd9'],
      [0.5, 1, 0.7, '#9b4fd1'],
    ],
  },
  {
    id: 'orchard',
    base: '#eaf2d0',
    blobs: [
      [0.05, 0.2, 0.6, '#b7d77a'],
      [0.95, 0.05, 0.55, '#f6d36b'],
      [0.8, 0.95, 0.65, '#6fb58a'],
    ],
  },
  {
    id: 'blossom',
    base: '#fde8ef',
    blobs: [
      [0.1, 0.9, 0.7, '#f7a3c0'],
      [0.9, 0.1, 0.6, '#c7b7ff'],
      [0.6, 0.5, 0.45, '#ffd2b8'],
    ],
  },
  {
    id: 'sunset',
    base: '#2b1433',
    blobs: [
      [0.2, 1, 0.8, '#ff6a3d'],
      [0.85, 0.85, 0.6, '#ff3d7a'],
      [0.6, 0.05, 0.6, '#5b2a86'],
    ],
  },
  {
    id: 'tide',
    base: '#dff3f5',
    blobs: [
      [0.1, 0.1, 0.65, '#8fd3e8'],
      [0.95, 0.6, 0.7, '#4c8fe0'],
      [0.35, 1, 0.55, '#a8ecd2'],
    ],
  },
  {
    id: 'ember-mesh',
    base: '#1b1512',
    blobs: [
      [0.15, 0.2, 0.6, '#c2410c'],
      [0.9, 0.9, 0.7, '#f59e0b'],
      [0.8, 0.1, 0.4, '#7c2d12'],
    ],
  },
  {
    id: 'linen',
    base: '#f3ede3',
    blobs: [
      [0.1, 0.05, 0.6, '#e8dcc7'],
      [0.95, 0.95, 0.6, '#d9c7aa'],
      [0.9, 0.1, 0.45, '#f8f3ea'],
    ],
  },
];

export const SOLIDS = [
  '#f4efe6', '#ffffff', '#e9ecef', '#1d1e22', '#0b0b0d',
  '#ff5a36', '#ffc83d', '#3ecf8e', '#3b82f6', '#8b5cf6', '#ec4899',
];

function linear(ctx, W, H, angle, stops) {
  const t = ((angle - 90) * Math.PI) / 180;
  const len = Math.abs(W * Math.cos(t)) + Math.abs(H * Math.sin(t));
  const cx = W / 2;
  const cy = H / 2;
  const dx = (Math.cos(t) * len) / 2;
  const dy = (Math.sin(t) * len) / 2;
  const g = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
  return g;
}

function mesh(ctx, W, H, m) {
  ctx.fillStyle = m.base;
  ctx.fillRect(0, 0, W, H);
  const R = Math.max(W, H);
  for (const [x, y, r, c] of m.blobs) {
    const g = ctx.createRadialGradient(x * W, y * H, 0, x * W, y * H, r * R);
    g.addColorStop(0, c);
    g.addColorStop(1, c + '00');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
}

// Film grain: one deterministic noise tile, reused as a pattern.
let grainTile = null;
function grain() {
  if (grainTile) return grainTile;
  const c = document.createElement('canvas');
  c.width = c.height = 160;
  const x = c.getContext('2d');
  const img = x.createImageData(160, 160);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = rnd() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  grainTile = c;
  return c;
}

/** Cover-fit `src` into W×H with a cheap, cross-browser blur (downscale → upscale). */
export function blurredCover(ctx, src, W, H, strength = 1) {
  const sw = src.width;
  const sh = src.height;
  const tiny = document.createElement('canvas');
  const tw = Math.max(4, Math.round(24 / strength));
  tiny.width = tw;
  tiny.height = Math.max(4, Math.round((tw * H) / W));
  const t = tiny.getContext('2d');
  t.imageSmoothingQuality = 'high';
  const k = Math.max(tiny.width / sw, tiny.height / sh);
  t.drawImage(src, (tiny.width - sw * k) / 2, (tiny.height - sh * k) / 2, sw * k, sh * k);
  // Two upscale passes smooth out the bilinear blockiness.
  const mid = document.createElement('canvas');
  mid.width = tiny.width * 4;
  mid.height = tiny.height * 4;
  const m = mid.getContext('2d');
  m.imageSmoothingQuality = 'high';
  m.drawImage(tiny, 0, 0, mid.width, mid.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(mid, 0, 0, W, H);
}

function cover(ctx, src, W, H) {
  const k = Math.max(W / src.width, H / src.height);
  ctx.drawImage(src, (W - src.width * k) / 2, (H - src.height * k) / 2, src.width * k, src.height * k);
}

/**
 * Paint a background. `bg` = { kind, id?, color?, assetId? }.
 * `ctx` space is W×H in device pixels. `shot` is the screenshot (for the blur kind).
 */
export function paintBackground(ctx, W, H, bg, { shot, assets, grainOn } = {}) {
  ctx.save();
  switch (bg.kind) {
    case 'gradient': {
      const g = GRADIENTS.find((x) => x.id === bg.id) || GRADIENTS[0];
      ctx.fillStyle = linear(ctx, W, H, g.angle, g.stops);
      ctx.fillRect(0, 0, W, H);
      break;
    }
    case 'mesh':
      mesh(ctx, W, H, MESHES.find((x) => x.id === bg.id) || MESHES[0]);
      break;
    case 'solid':
      ctx.fillStyle = bg.color || SOLIDS[0];
      ctx.fillRect(0, 0, W, H);
      break;
    case 'blur':
      if (shot) {
        blurredCover(ctx, shot, W, H);
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(0, 0, W, H);
      }
      break;
    case 'image': {
      const a = assets && assets.get(bg.assetId);
      if (a) cover(ctx, a.bitmap, W, H);
      else {
        ctx.fillStyle = '#e9e4da';
        ctx.fillRect(0, 0, W, H);
      }
      break;
    }
    case 'none':
    default:
      break;
  }
  if (grainOn && bg.kind !== 'none') {
    ctx.globalAlpha = 0.07;
    ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = ctx.createPattern(grain(), 'repeat');
    ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();
}

/** Perceived luminance of a background, to pick contrasting UI details. */
export function isDarkBackground(bg) {
  const hex =
    bg.kind === 'solid'
      ? bg.color
      : bg.kind === 'gradient'
        ? (GRADIENTS.find((g) => g.id === bg.id) || GRADIENTS[0]).stops[0]
        : bg.kind === 'mesh'
          ? (MESHES.find((m) => m.id === bg.id) || MESHES[0]).base
          : '#ffffff';
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b < 110;
}
