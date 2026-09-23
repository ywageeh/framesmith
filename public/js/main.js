import { computeLayout, ASPECTS, safeScale } from './layout.js';
import { GRADIENTS, MESHES, SOLIDS, paintBackground } from './backgrounds.js';
import { render, exportBlob, measureText } from './render.js';
import {
  TOOLS, INK, inkUnit, pick, handles, moveBy, dragHandle, nextStep, isDegenerate, textBox,
} from './annotations.js';
import { History } from './history.js';
import { findTrim } from './trim.js';
import { demoShot, demoAnnotations } from './demo.js';
import { CROP_HANDLES, cropHandlePoints, resizeCrop, moveCrop, fitAspect, isFullCrop } from './crop.js';
import { extractPalette, MATCH_VARIANTS } from './palette.js';
import { loadSession, saveSession, clearSession } from './session.js';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};

/* ================================================================== state */

const DEFAULT_STYLE = {
  bg: { kind: 'mesh', id: 'peach' },
  grain: false,
  frame: 'mac-light',
  frameTitle: '',
  aspect: 'auto',
  padding: 9,
  radius: 12,
  shadow: 55,
  tilt: 0,
  trim: false,
  offset: { x: 0, y: 0 },
  badge: { text: '', pos: 'right' },
};

const LOOKS = [
  { name: 'Match', style: { bg: { kind: 'match', variant: 'soft' }, grain: false, frame: 'mac-light', aspect: '16:9', padding: 10, radius: 12, shadow: 45, tilt: 0 } },
  { name: 'Launch', style: { bg: { kind: 'mesh', id: 'peach' }, grain: false, frame: 'mac-light', aspect: '16:9', padding: 9, radius: 12, shadow: 55, tilt: 0 } },
  { name: 'Night', style: { bg: { kind: 'mesh', id: 'aurora' }, grain: true, frame: 'mac-dark', aspect: '16:9', padding: 10, radius: 12, shadow: 70, tilt: -16 } },
  { name: 'Docs', style: { bg: { kind: 'solid', color: '#f4efe6' }, grain: false, frame: 'browser-light', aspect: 'auto', padding: 6, radius: 10, shadow: 30, tilt: 0 } },

  { name: 'Poster', style: { bg: { kind: 'gradient', id: 'ember' }, grain: false, frame: 'stack', aspect: '4:5', padding: 12, radius: 14, shadow: 60, tilt: 0 } },
  { name: 'Echo', style: { bg: { kind: 'blur' }, grain: false, frame: 'none', aspect: '1.91:1', padding: 8, radius: 14, shadow: 60, tilt: 14 } },
];

const TOOL_HELP = {
  select: 'Click an annotation to select it. Drag to move, drag the dots to reshape. Double-click a label to edit it.',
  arrow: 'Drag from what you are talking about to what you are pointing at. Hold Shift to snap to 45°.',
  rect: 'Drag to draw a box around something. Hold Shift for a square.',
  highlight: 'Drag over text to mark it like a highlighter.',
  text: 'Click where the label should go, type, then press Enter. Shift+Enter adds a line.',
  step: 'Click to drop numbered badges. They count up automatically.',
  redact: 'Drag over emails, tokens or faces to pixelate them for good. The original pixels are not exported.',
  focus: 'Drag a region to keep it bright and dim everything else.',
};

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* private mode: fine, just not remembered */
    }
  },
};

const assets = new Map(); // id → { bitmap, w, h, name, trim }
const saved = store.get('fs:style', {});
const initialStyle = { ...DEFAULT_STYLE, ...saved, badge: { ...DEFAULT_STYLE.badge, ...saved.badge } };
if (initialStyle.bg.kind === 'image') initialStyle.bg = DEFAULT_STYLE.bg;

// crop: source-pixel rect or null (whole image). Annotations live in cropped-shot space.
let doc = { style: initialStyle, annotations: [], imageId: null, crop: null };
let history = null;

const ui = {
  tab: 'style',
  tool: 'select',
  color: INK[0],
  size: 'm',
  selectedId: null,
  editingId: null,
  draft: null,
  drag: null,
  exportType: store.get('fs:format', 'auto'),
  exportScale: store.get('fs:scale', 1),
  view: null, // { L, fit }
  userImage: false,
  crop: null, // crop mode: { rect, aspectId, drag }
  guides: null, // snap guides while dragging the shot
};

const lastBgId = { mesh: 'peach', gradient: 'ember', solid: '#f4efe6', match: 'soft' };

const uid = () => Math.random().toString(36).slice(2, 10);

function shotFor(d = doc) {
  const a = assets.get(d.imageId);
  const t = d.crop || { x: 0, y: 0, w: a.w, h: a.h };
  return { bitmap: a.bitmap, sx: t.x, sy: t.y, w: t.w, h: t.h, palette: a.palette };
}

/** Replace the document. `record` pushes an undo step. */
function commit(next, record = true) {
  doc = next;
  if (record && history) {
    history.push(doc);
    renderThumbs();
  }
  store.set('fs:style', doc.style);
  scheduleRender();
  syncUI();
  scheduleSave();
}

function setStyle(patch, record = true) {
  commit({ ...doc, style: { ...doc.style, ...patch } }, record);
}

function setAnnotations(list, record = true) {
  commit({ ...doc, annotations: list }, record);
}

/* ================================================================== images */

async function toBitmap(blob) {
  try {
    return await createImageBitmap(blob);
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function computeTrim(bitmap, w, h) {
  // Trim on a copy capped at ~4MP; scale the rect back up.
  const k = Math.min(1, Math.sqrt(4_000_000 / (w * h)));
  const cw = Math.max(1, Math.round(w * k));
  const ch = Math.max(1, Math.round(h * k));
  const c = el('canvas', { width: cw, height: ch });
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bitmap, 0, 0, cw, ch);
  const r = findTrim(x.getImageData(0, 0, cw, ch).data, cw, ch, 12);
  const pad = r.w === cw && r.h === ch ? 0 : 1;
  const sx = Math.max(0, Math.floor(r.x / k) + pad);
  const sy = Math.max(0, Math.floor(r.y / k) + pad);
  return {
    x: sx,
    y: sy,
    w: Math.min(w - sx, Math.ceil(r.w / k) - pad * 2),
    h: Math.min(h - sy, Math.ceil(r.h / k) - pad * 2),
  };
}

function computePalette(bitmap, w, h) {
  const k = Math.min(1, 72 / Math.max(w, h));
  const c = el('canvas', { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) });
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bitmap, 0, 0, c.width, c.height);
  return extractPalette(x.getImageData(0, 0, c.width, c.height).data);
}

function makeAsset(bitmap, name, blob = null) {
  const w = bitmap.width;
  const h = bitmap.height;
  return { bitmap, w, h, name, blob, trim: computeTrim(bitmap, w, h), palette: computePalette(bitmap, w, h) };
}

/** Add a screenshot and make it current. Returns its id and a note about automatic choices. */
function addImage(bitmap, name, { user = true, blob = null } = {}) {
  const id = 'img-' + uid();
  const asset = makeAsset(bitmap, name, blob);
  assets.set(id, asset);
  ui.selectedId = null;
  let style = doc.style;
  let note = '';
  if (user) {
    ui.userImage = true;
    $('#stage-hint').classList.add('quiet');
  }
  // Pick a frame that suits the shape: phones for tall shots, windows for wide ones.
  const fam = familyOf(style.frame);
  if (asset.h / asset.w >= 1.5 && (fam === 'mac' || fam === 'browser')) {
    style = { ...style, frame: 'phone-dark' };
    note = ' · phone frame';
  } else if (asset.w / asset.h > 1.05 && fam === 'phone') {
    style = { ...style, frame: 'mac-light' };
    note = ' · window frame';
  }
  const trimmed = style.trim && !isFullCrop(asset.trim, asset.w, asset.h) ? { ...asset.trim } : null;
  const next = { ...doc, style, imageId: id, annotations: [], crop: trimmed };
  if (!history) {
    doc = next;
    history = new History(doc);
    scheduleRender();
    syncUI();
    scheduleSave();
  } else commit(next);
  renderThumbs();
  return { id, note };
}

async function loadBlob(blob, name = 'image') {
  if (!blob || !blob.type.startsWith('image/')) {
    toast('That file isn’t an image');
    return;
  }
  try {
    const bmp = await toBitmap(blob);
    const hadImage = !!history;
    const { note } = addImage(bmp, name.replace(/\.[^.]+$/, ''), { blob });
    toast(`Loaded ${bmp.width} × ${bmp.height}${note}`, hadImage ? { label: 'Undo', run: undo } : null);
  } catch {
    toast('Couldn’t read that image');
  }
}

/* ---------------------------------------------------------------- session */

let saveTimer = 0;
function scheduleSave() {
  if (!ui.userImage) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const images = {};
    const ids = [doc.imageId];
    if (doc.style.bg.kind === 'image') ids.push(doc.style.bg.assetId);
    for (const id of ids) {
      const a = assets.get(id);
      if (!a || !a.blob) return; // not ready yet (e.g. a capture still encoding)
      images[id] = { blob: a.blob, name: a.name };
    }
    await saveSession({ v: 1, doc, images, ts: Date.now() });
  }, 500);
}

async function restoreSession(sess) {
  if (!sess || sess.v !== 1 || !sess.images?.[sess.doc?.imageId]) return false;
  try {
    for (const [id, img] of Object.entries(sess.images)) {
      const bmp = await toBitmap(img.blob);
      assets.set(id, makeAsset(bmp, img.name, img.blob));
    }
  } catch {
    return false;
  }
  const st = sess.doc.style || {};
  const style = { ...DEFAULT_STYLE, ...st, badge: { ...DEFAULT_STYLE.badge, ...st.badge } };
  if (style.bg.kind === 'image' && !assets.has(style.bg.assetId)) style.bg = DEFAULT_STYLE.bg;
  doc = { ...sess.doc, style, crop: sess.doc.crop || null, annotations: sess.doc.annotations || [] };
  history = new History(doc);
  ui.userImage = true;
  $('#stage-hint').classList.add('quiet');
  store.set('fs:style', doc.style);
  return true;
}

function startFresh() {
  clearSession();
  ui.userImage = false;
  $('#stage-hint').classList.remove('quiet');
  addImage(demoShot(), 'framesmith-sample', { user: false });
  setAnnotations(demoAnnotations());
}

async function captureScreen() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'window' }, audio: false });
    const video = el('video', { muted: true, playsInline: true, srcObject: stream });
    await video.play();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const c = el('canvas', { width: video.videoWidth, height: video.videoHeight });
    c.getContext('2d').drawImage(video, 0, 0);
    stream.getTracks().forEach((t) => t.stop());
    const { id, note } = addImage(c, 'capture');
    toast(`Captured${note}`, { label: 'Undo', run: undo });
    // Keep a PNG copy so the capture survives a reload.
    c.toBlob((b) => {
      const a = assets.get(id);
      if (a && b) {
        a.blob = b;
        scheduleSave();
      }
    }, 'image/png');
  } catch (e) {
    if (e && e.name !== 'NotAllowedError') toast('Screen capture isn’t available here');
  }
}

/* ================================================================== render */

const view = $('#view');
const vctx = view.getContext('2d');
const stage = $('#stage');
let raf = 0;
let rafFallback = 0;

function scheduleRender() {
  if (raf) return;
  raf = requestAnimationFrame(draw);
  // Background tabs pause rAF; still paint so export/thumbnail state never goes stale.
  rafFallback = setTimeout(() => {
    if (!raf) return;
    cancelAnimationFrame(raf);
    draw();
  }, 150);
}

function stageFit(W, H) {
  const rect = stage.getBoundingClientRect();
  const mobile = rect.width < 600;
  const m = mobile ? 14 : 44;
  const avW = rect.width - m * 2;
  // Leave room for whatever floats at the bottom of the stage (hint pill or crop toolbar).
  const avH = rect.height - m * 2 - (ui.crop ? (rect.width < 760 ? 150 : 96) : mobile ? 36 : 56);
  return Math.max(0.05, Math.min(avW / W, avH / H, 2));
}

function sizeView(W, H, fit) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const s = fit * dpr;
  const cw = Math.round(W * s);
  const ch = Math.round(H * s);
  if (view.width !== cw || view.height !== ch) {
    view.width = cw;
    view.height = ch;
  }
  view.style.width = `${W * fit}px`;
  view.style.height = `${H * fit}px`;
  return s;
}

/** Crop mode: the whole source image with the crop rectangle on top. */
function drawCrop() {
  const a = assets.get(doc.imageId);
  const fit = stageFit(a.w, a.h);
  const s = sizeView(a.w, a.h, fit);
  const ctx = vctx;
  const r = ui.crop.rect;
  ctx.save();
  ctx.clearRect(0, 0, view.width, view.height);
  ctx.scale(s, s);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(a.bitmap, 0, 0);
  ctx.fillStyle = 'rgba(18, 14, 10, 0.62)';
  ctx.beginPath();
  ctx.rect(0, 0, a.w, a.h);
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.fill('evenodd');
  const px = 1 / s;
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = px;
  ctx.beginPath();
  for (const t of [1 / 3, 2 / 3]) {
    ctx.moveTo(r.x + r.w * t, r.y);
    ctx.lineTo(r.x + r.w * t, r.y + r.h);
    ctx.moveTo(r.x, r.y + r.h * t);
    ctx.lineTo(r.x + r.w, r.y + r.h * t);
  }
  ctx.stroke();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2 * px;
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  const hp = cropHandlePoints(r);
  for (const id of CROP_HANDLES) {
    const p = hp[id];
    const corner = id.length === 2;
    const hw = (corner ? 14 : id === 'n' || id === 's' ? 22 : 6) * px;
    const hh = (corner ? 14 : id === 'e' || id === 'w' ? 22 : 6) * px;
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 4;
    ctx.fillRect(p.x - hw / 2, p.y - hh / 2, hw, hh);
  }
  ctx.restore();
  ui.view = { mode: 'crop', fit, a };
  $('#dims').textContent = `Crop ${r.w} × ${r.h}`;
}

function draw() {
  raf = 0;
  clearTimeout(rafFallback);
  if (!doc.imageId) return;
  if (ui.crop) return drawCrop();
  const shot = shotFor();
  const L = computeLayout(shot.w, shot.h, doc.style);
  const fit = stageFit(L.W, L.H);
  const s = sizeView(L.W, L.H, fit);

  let annotations = doc.annotations;
  if (ui.editingId) annotations = annotations.filter((a) => a.id !== ui.editingId);
  if (ui.draft) annotations = [...annotations, ui.draft];
  const flat = ui.tab === 'annotate';
  render(vctx, { ...doc, annotations }, shot, assets, {
    s,
    flat,
    selectedId: flat ? ui.selectedId : null,
  });
  if (ui.guides) {
    // Centre guides while the shot snaps into place.
    vctx.save();
    vctx.strokeStyle = '#ff5a36';
    vctx.lineWidth = Math.max(1, s);
    vctx.setLineDash([6 * s, 5 * s]);
    vctx.beginPath();
    if (ui.guides.x) {
      vctx.moveTo((L.W / 2) * s, 0);
      vctx.lineTo((L.W / 2) * s, L.H * s);
    }
    if (ui.guides.y) {
      vctx.moveTo(0, (L.H / 2) * s);
      vctx.lineTo(L.W * s, (L.H / 2) * s);
    }
    vctx.stroke();
    vctx.restore();
  }
  ui.view = { L, fit, shot };
  stage.dataset.transparent = String(doc.style.bg.kind === 'none');
  $('#dims').textContent = `${L.W} × ${L.H}`;
  updateExportNote();
}

new ResizeObserver(scheduleRender).observe(stage);

/* ================================================================== thumbnails */

function renderInto(canvas, style, W = 150, H = 104) {
  if (!doc.imageId) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const d = { ...doc, style: { ...doc.style, ...style } };
  const shot = shotFor(d);
  const L = computeLayout(shot.w, shot.h, d.style);
  const s = Math.min(canvas.width / L.W, canvas.height / L.H);
  const off = el('canvas', { width: Math.round(L.W * s), height: Math.round(L.H * s) });
  render(off.getContext('2d'), d, shot, assets, { s });
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(off, (canvas.width - off.width) / 2, (canvas.height - off.height) / 2);
}

let thumbTimer = 0;
function renderThumbs() {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    document.querySelectorAll('[data-look]').forEach((b) => {
      const look = LOOKS[+b.dataset.look];
      renderInto(b.querySelector('canvas'), adaptLook(look.style));
    });
    document.querySelectorAll('[data-preset]').forEach((b) => {
      const p = presets.find((x) => x.id === b.dataset.preset);
      if (p) renderInto(b.querySelector('canvas'), p.style);
    });
  }, 60);
}

/* ================================================================== controls */

function radios(container, value, attr = 'aria-checked') {
  container.querySelectorAll('[data-v]').forEach((b) => b.setAttribute(attr, String(b.dataset.v === String(value))));
}

function buildLooks() {
  const host = $('#looks');
  LOOKS.forEach((look, i) => {
    const b = el('button', { className: 'look', type: 'button', title: `Apply the ${look.name} look` });
    b.dataset.look = i;
    b.append(el('canvas'), el('span', { textContent: look.name }));
    b.addEventListener('click', () => {
      setStyle({ ...adaptLook(look.style), frameTitle: doc.style.frameTitle });
      toast(`${look.name} look applied`, { label: 'Undo', run: undo });
    });
    host.append(b);
  });
}

/** Looks are designed for desktop shots; on a tall phone screenshot, swap window chrome for a phone. */
function adaptLook(style) {
  const a = assets.get(doc.imageId);
  if (!a || a.h / a.w < 1.5 || !/^(mac|browser)-/.test(style.frame)) return style;
  return { ...style, frame: 'phone-dark' };
}

function styleMatches(style) {
  return Object.entries(style).every(([k, v]) => JSON.stringify(doc.style[k]) === JSON.stringify(v));
}

let swatchKey = '';
function buildSwatches() {
  const { bg } = doc.style;
  // Rebuild only when the background actually changes, and never under an open color picker.
  const key = JSON.stringify(bg) + (bg.kind === 'match' ? doc.imageId : '');
  if (key === swatchKey || ui.pickingColor) return;
  swatchKey = key;
  const host = $('#swatches');
  host.replaceChildren();
  const swatch = (checked, paint, label, onClick) => {
    const b = el('button', { className: 'swatch', type: 'button', title: label });
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(checked));
    b.setAttribute('aria-label', label);
    const c = el('canvas', { width: 64, height: 64 });
    paint(c.getContext('2d'));
    b.append(c);
    b.addEventListener('click', onClick);
    host.append(b);
  };
  const pretty = (id) => id.replace(/-/g, ' ');
  if (bg.kind === 'match') {
    const palette = assets.get(doc.imageId)?.palette;
    MATCH_VARIANTS.forEach((v) =>
      swatch(bg.variant === v.id, (x) => paintBackground(x, 64, 64, { kind: 'match', variant: v.id }, { palette }), `${v.label}, from your screenshot`, () => {
        lastBgId.match = v.id;
        setStyle({ bg: { kind: 'match', variant: v.id } });
      }),
    );
    host.append(el('p', { className: 'swatch-note', textContent: 'Built from the colours in your screenshot, so it always belongs.' }));
  } else if (bg.kind === 'mesh') {
    MESHES.forEach((m) =>
      swatch(bg.id === m.id, (x) => paintBackground(x, 64, 64, { kind: 'mesh', id: m.id }), pretty(m.id), () => {
        lastBgId.mesh = m.id;
        setStyle({ bg: { kind: 'mesh', id: m.id } });
      }),
    );
  } else if (bg.kind === 'gradient') {
    GRADIENTS.forEach((g) =>
      swatch(bg.id === g.id, (x) => paintBackground(x, 64, 64, { kind: 'gradient', id: g.id }), pretty(g.id), () => {
        lastBgId.gradient = g.id;
        setStyle({ bg: { kind: 'gradient', id: g.id } });
      }),
    );
  } else if (bg.kind === 'solid') {
    SOLIDS.forEach((c) =>
      swatch(bg.color === c, (x) => paintBackground(x, 64, 64, { kind: 'solid', color: c }), c, () => {
        lastBgId.solid = c;
        setStyle({ bg: { kind: 'solid', color: c } });
      }),
    );
    const custom = !SOLIDS.includes(bg.color);
    const add = el('label', { className: 'swatch add', title: 'Pick any color' });
    if (custom) {
      add.style.background = bg.color;
      add.setAttribute('aria-checked', 'true');
      add.classList.remove('add');
    } else add.innerHTML = '<svg><use href="#i-plus"/></svg>';
    const input = el('input', { type: 'color', value: custom ? bg.color : '#ff5a36' });
    input.setAttribute('aria-label', 'Custom color');
    input.addEventListener('input', () => {
      ui.pickingColor = true;
      setStyle({ bg: { kind: 'solid', color: input.value } }, false);
    });
    input.addEventListener('change', () => {
      ui.pickingColor = false;
      lastBgId.solid = input.value;
      setStyle({ bg: { kind: 'solid', color: input.value } });
    });
    add.append(input);
    host.append(add);
  } else if (bg.kind === 'blur') {
    host.append(el('p', { className: 'swatch-note', textContent: 'A soft, blurred copy of your own screenshot. Always matches.' }));
  } else if (bg.kind === 'image') {
    const a = assets.get(bg.assetId);
    if (a) {
      swatch(true, (x) => {
        const k = Math.max(64 / a.w, 64 / a.h);
        x.drawImage(a.bitmap, (64 - a.w * k) / 2, (64 - a.h * k) / 2, a.w * k, a.h * k);
      }, a.name, () => $('#bg-input').click());
    }
    const add = el('button', { className: 'swatch add', type: 'button', title: 'Choose a wallpaper' });
    add.innerHTML = '<svg><use href="#i-plus"/></svg>';
    add.setAttribute('aria-label', 'Choose a background image');
    add.addEventListener('click', () => $('#bg-input').click());
    host.append(add);
  } else {
    host.append(el('p', { className: 'swatch-note', textContent: 'Transparent. Export as PNG or WebP to keep it.' }));
  }
}

function frameSvg(id) {
  const dark = id.endsWith('dark');
  const bar = dark ? '#34343a' : '#f1eeea';
  const body = dark ? '#1f1f23' : '#ffffff';
  const line = dark ? '#4a4a50' : '#d9d4cc';
  const dots = `<circle cx="9" cy="8" r="1.8" fill="#ff5f57"/><circle cx="14.5" cy="8" r="1.8" fill="#febc2e"/><circle cx="20" cy="8" r="1.8" fill="#28c840"/>`;
  const shell = (inner) => `<svg viewBox="0 0 64 44" aria-hidden="true">${inner}</svg>`;
  switch (id) {
    case 'none':
      return shell(`<rect x="4" y="4" width="56" height="36" rx="4" fill="${body}" stroke="${line}"/>`);
    case 'mac-light':
    case 'mac-dark':
      return shell(`<rect x="4" y="2" width="56" height="40" rx="5" fill="${body}" stroke="${line}"/><path d="M4 7a5 5 0 0 1 5-5h46a5 5 0 0 1 5 5v7H4z" fill="${bar}"/>${dots}`);
    case 'browser-light':
    case 'browser-dark':
      return shell(`<rect x="4" y="2" width="56" height="40" rx="5" fill="${body}" stroke="${line}"/><path d="M4 7a5 5 0 0 1 5-5h46a5 5 0 0 1 5 5v8H4z" fill="${bar}"/>${dots}<rect x="26" y="5" width="28" height="6" rx="2" fill="${dark ? '#1e1e22' : '#fff'}" stroke="${line}" stroke-width=".6"/>`);
    case 'glass':
      return shell(`<rect x="2" y="2" width="60" height="40" rx="7" fill="#ffffff" fill-opacity=".45" stroke="#ffffff"/><rect x="7" y="7" width="50" height="30" rx="3" fill="${body}" stroke="${line}"/>`);
    case 'phone':
      return shell(`<rect x="23" y="2" width="18" height="40" rx="5" fill="#1d1d20"/><rect x="24.6" y="3.6" width="14.8" height="36.8" rx="3.6" fill="${body === '#ffffff' ? '#f4f1ec' : body}"/><rect x="29" y="5" width="6" height="1.8" rx=".9" fill="#1d1d20"/>`);
    case 'stack':
      return shell(`<rect x="12" y="2" width="40" height="30" rx="4" fill="${body}" fill-opacity=".45" stroke="${line}"/><rect x="8" y="6" width="48" height="32" rx="4" fill="${body}" fill-opacity=".75" stroke="${line}"/><rect x="4" y="10" width="56" height="32" rx="4" fill="${body}" stroke="${line}"/>`);
  }
  return '';
}

const FRAME_FAMILIES = [
  { id: 'none', label: 'None' },
  { id: 'mac', label: 'macOS' },
  { id: 'browser', label: 'Browser' },
  { id: 'phone', label: 'Phone' },
  { id: 'glass', label: 'Glass' },
  { id: 'stack', label: 'Stack' },
];
const familyOf = (frame) => frame.replace(/-(light|dark)$/, '');
const hasChrome = (frame) => /^(mac|browser|phone)-/.test(frame);
const hasTitle = (frame) => /^(mac|browser)-/.test(frame);

function buildFrames() {
  const host = $('#frames');
  FRAME_FAMILIES.forEach((f) => {
    const b = el('button', { className: 'frame-tile', type: 'button' });
    b.dataset.v = f.id;
    b.setAttribute('role', 'radio');
    const preview = f.id === 'mac' || f.id === 'browser' ? `${f.id}-light` : f.id;
    b.innerHTML = `<span class="ft">${frameSvg(preview)}</span><span>${f.label}</span>`;
    b.addEventListener('click', () => {
      const dark = doc.style.frame.endsWith('-dark');
      let frame = f.id;
      if (f.id === 'mac' || f.id === 'browser') frame = `${f.id}-${dark ? 'dark' : 'light'}`;
      if (f.id === 'phone') frame = doc.style.frame === 'phone-light' ? 'phone-light' : 'phone-dark';
      setStyle({ frame });
    });
    host.append(b);
  });
  $('#chk-dark-chrome').addEventListener('change', (e) => {
    if (!hasChrome(doc.style.frame)) return;
    const fam = familyOf(doc.style.frame);
    setStyle({ frame: `${fam}-${e.target.checked ? 'dark' : 'light'}` });
  });
  const title = $('#frame-title');
  title.addEventListener('input', () => setStyle({ frameTitle: title.value }, false));
  title.addEventListener('change', () => setStyle({ frameTitle: title.value }));
}

function buildAspects() {
  const host = $('#aspects');
  ASPECTS.forEach((a) => {
    const b = el('button', { className: 'chip', type: 'button', title: a.hint });
    b.dataset.v = a.id;
    b.setAttribute('role', 'radio');
    if (a.ratio) {
      const w = a.ratio >= 1 ? 14 : Math.round(14 * a.ratio);
      const h = a.ratio >= 1 ? Math.round(14 / a.ratio) : 14;
      b.append(el('i', { style: `width:${w}px;height:${h}px` }));
    }
    b.append(a.label);
    b.addEventListener('click', () => setStyle({ aspect: a.id }));
    host.append(b);
  });
}

const SLIDERS = {
  padding: (v) => `${v}%`,
  radius: (v) => `${v}px`,
  shadow: (v) => (v == 0 ? 'Off' : `${v}%`),
  tilt: (v) => (v == 0 ? 'Flat' : `${v > 0 ? '' : '−'}${Math.abs(v)}°`),
};

function paintRange(input) {
  const p = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--p', `${p}%`);
}

function buildSliders() {
  for (const key of Object.keys(SLIDERS)) {
    const input = $(`#rng-${key}`);
    if (key === 'tilt') input.classList.add('centered');
    input.addEventListener('input', () => {
      paintRange(input);
      $(`#out-${key}`).textContent = SLIDERS[key](+input.value);
      setStyle({ [key]: +input.value }, false);
    });
    input.addEventListener('change', () => {
      setStyle({ [key]: +input.value });
      renderThumbs();
    });
    input.addEventListener('dblclick', () => {
      input.value = DEFAULT_STYLE[key];
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new Event('change'));
    });
  }
}

/* ---------------------------------------------------------------- presets */

let presets = store.get('fs:presets', []);

function buildPresets() {
  const host = $('#presets');
  host.replaceChildren();
  presets.forEach((p) => {
    const wrap = el('div', { className: 'preset' });
    const b = el('button', { className: 'look', type: 'button', title: 'Apply this style' });
    b.dataset.preset = p.id;
    b.append(el('canvas'), el('span', { textContent: p.name }));
    b.addEventListener('click', () => {
      setStyle({ ...p.style });
      toast(`${p.name} applied`);
    });
    const del = el('button', { className: 'del', type: 'button', title: 'Delete style' });
    del.setAttribute('aria-label', `Delete ${p.name}`);
    del.innerHTML = '<svg><use href="#i-x"/></svg>';
    del.addEventListener('click', () => {
      presets = presets.filter((x) => x.id !== p.id);
      store.set('fs:presets', presets);
      buildPresets();
    });
    wrap.append(b, del);
    host.append(wrap);
  });
  renderThumbs();
}

function saveStyle() {
  const style = { ...doc.style };
  delete style.trim;
  if (style.bg.kind === 'image') {
    toast('Wallpaper images aren’t saved. Pick another background first.');
    return;
  }
  const n = presets.length + 1;
  presets = [...presets, { id: uid(), name: `Style ${n}`, style }].slice(-9);
  store.set('fs:presets', presets);
  buildPresets();
  toast('Style saved on this device');
}

/* ---------------------------------------------------------------- annotate controls */

function buildTools() {
  const host = $('#tools');
  TOOLS.forEach((t) => {
    const b = el('button', { className: 'tool', type: 'button', title: `${t.label} (${t.key.toUpperCase()})` });
    b.dataset.v = t.id;
    b.innerHTML = `<svg><use href="#t-${t.id}"/></svg><span>${t.label.split(' ')[0]}</span><kbd>${t.key.toUpperCase()}</kbd>`;
    b.addEventListener('click', () => setTool(t.id));
    host.append(b);
  });
  const inks = $('#inks');
  INK.forEach((c) => {
    const b = el('button', { className: 'ink', type: 'button', title: c });
    b.dataset.v = c;
    b.style.background = c;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', `Color ${c}`);
    b.addEventListener('click', () => {
      ui.color = c;
      applyToSelection({ color: c });
      syncUI();
    });
    inks.append(b);
  });
  $('#seg-size').addEventListener('click', (e) => {
    const v = e.target.closest('[data-v]')?.dataset.v;
    if (!v) return;
    ui.size = v;
    applyToSelection({ size: v });
    syncUI();
  });
  $('#btn-delete').addEventListener('click', deleteSelection);
  $('#btn-clear').addEventListener('click', () => {
    ui.selectedId = null;
    setAnnotations([]);
    toast('Annotations cleared', { label: 'Undo', run: undo });
  });
}

function applyToSelection(patch) {
  const a = doc.annotations.find((x) => x.id === ui.selectedId);
  if (!a) return;
  if ('color' in patch && ['redact', 'focus'].includes(a.type)) return;
  setAnnotations(doc.annotations.map((x) => (x.id === a.id ? { ...x, ...patch } : x)));
}

function deleteSelection() {
  if (!ui.selectedId) return;
  const id = ui.selectedId;
  ui.selectedId = null;
  setAnnotations(doc.annotations.filter((a) => a.id !== id));
}

function setTab(tab) {
  if (ui.tab === tab) return;
  commitTextEditor();
  ui.tab = tab;
  if (tab === 'style') ui.selectedId = null;
  syncUI();
  scheduleRender();
}

function setTool(tool) {
  if (ui.crop) exitCrop();
  commitTextEditor();
  ui.tool = tool;
  if (tool !== 'select') ui.selectedId = null;
  setTab('annotate');
  syncUI();
  scheduleRender();
}

/* ================================================================== sync */

function syncUI() {
  const { style } = doc;
  $('#app').dataset.tab = ui.tab;
  $('#tab-style').setAttribute('aria-selected', String(ui.tab === 'style'));
  $('#tab-annotate').setAttribute('aria-selected', String(ui.tab === 'annotate'));
  $('#panel-style').hidden = ui.tab !== 'style';
  $('#panel-annotate').hidden = ui.tab !== 'annotate';

  radios($('#seg-bg'), style.bg.kind);
  radios($('#seg-badge'), style.badge?.pos || 'right');
  const badgeInput = $('#badge-text');
  if (document.activeElement !== badgeInput) badgeInput.value = style.badge?.text || '';
  $('#seg-badge').hidden = !(style.badge?.text || '').trim();
  const off = style.offset || { x: 0, y: 0 };
  $('#btn-center').disabled = !off.x && !off.y;
  $('#btn-crop').classList.toggle('on', !!doc.crop);
  $('#crop-state').textContent = doc.crop ? `${doc.crop.w} × ${doc.crop.h}` : '';
  buildSwatches();
  $('#chk-grain').checked = style.grain;
  $('#chk-grain').disabled = style.bg.kind === 'none';
  radios($('#frames'), familyOf(style.frame));
  $('#chrome-opts').hidden = !hasChrome(style.frame);
  $('#frame-title').hidden = !hasTitle(style.frame);
  $('#dark-label').textContent = style.frame.startsWith('phone') ? 'Black finish' : 'Dark title bar';
  $('#chk-dark-chrome').checked = style.frame.endsWith('-dark');
  const title = $('#frame-title');
  title.placeholder = style.frame.startsWith('browser') ? 'framesmith.app' : 'Window title (optional)';
  if (document.activeElement !== title) title.value = style.frameTitle || '';
  radios($('#aspects'), style.aspect);
  for (const key of Object.keys(SLIDERS)) {
    const input = $(`#rng-${key}`);
    input.value = style[key];
    paintRange(input);
    $(`#out-${key}`).textContent = SLIDERS[key](style[key]);
  }
  $('#chk-trim').checked = !!style.trim;
  document.querySelectorAll('[data-look]').forEach((b) => {
    b.setAttribute('aria-pressed', String(styleMatches(adaptLook(LOOKS[+b.dataset.look].style))));
  });

  radios($('#tools'), ui.tool, 'aria-pressed');
  const sel = doc.annotations.find((a) => a.id === ui.selectedId);
  radios($('#inks'), sel && sel.color ? sel.color : ui.color);
  radios($('#seg-size'), sel && sel.size ? sel.size : ui.size);
  $('#tool-help').textContent = TOOL_HELP[ui.tool];
  $('#btn-delete').disabled = !sel;
  $('#btn-clear').disabled = !doc.annotations.length;
  $('#tilt-note').hidden = !style.tilt;
  const count = $('#ann-count');
  count.hidden = !doc.annotations.length;
  count.textContent = doc.annotations.length;
  stage.dataset.tool = ui.tab === 'annotate' ? ui.tool : '';

  $('#btn-undo').disabled = !history?.canUndo;
  $('#btn-redo').disabled = !history?.canRedo;

  radios($('#seg-format'), ui.exportType);
  radios($('#seg-scale'), ui.exportScale);
  const ext = { auto: '', 'image/png': ' PNG', 'image/jpeg': ' JPEG', 'image/webp': ' WebP' }[ui.exportType] ?? '';
  $('#export-label').textContent = `Export${ext}`;
  $('#app').dataset.mode = ui.crop ? 'crop' : '';
}

function updateExportNote() {
  if (!ui.view) return;
  const { L } = ui.view;
  const k = safeScale(L.W, L.H, ui.exportScale);
  const w = Math.round(L.W * k);
  const h = Math.round(L.H * k);
  let note = `${w} × ${h} px`;
  if (k < ui.exportScale) note += ' · capped to stay within browser limits';
  if (ui.exportType === 'auto') note += ' · PNG, or JPEG if a PNG would top X’s 5 MB limit';
  if (ui.exportType === 'image/jpeg' && doc.style.bg.kind === 'none') note += ' · JPEG has no transparency, so the background will be white';
  $('#export-note').textContent = note;
}

/* ================================================================== export */

function exportOpts(type) {
  const { L } = ui.view;
  return { type, scale: safeScale(L.W, L.H, ui.exportScale), quality: 0.93 };
}

const LIMIT = 5 * 1048576; // X's image upload limit
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Render the export. "auto" keeps PNG unless it would be too heavy to post. */
async function produceExport() {
  const shot = shotFor();
  if (ui.exportType !== 'auto') {
    const opts = exportOpts(ui.exportType);
    return { blob: await exportBlob(doc, shot, assets, opts), type: opts.type, scale: opts.scale, note: '' };
  }
  const opts = exportOpts('image/png');
  const png = await exportBlob(doc, shot, assets, opts);
  if (png.size <= LIMIT) return { blob: png, type: 'image/png', scale: opts.scale, note: '' };
  const type = doc.style.bg.kind === 'none' ? 'image/webp' : 'image/jpeg';
  const blob = await exportBlob(doc, shot, assets, { ...opts, type, quality: 0.92 });
  return { blob, type, scale: opts.scale, note: ` (PNG would be ${fmtSize(png.size)})` };
}

function filename(ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const base = assets.get(doc.imageId)?.name || 'shot';
  const safe = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'shot';
  return `${safe}-framed-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}

async function download() {
  if (!ui.view || ui.crop) return;
  commitTextEditor();
  try {
    const { blob, type, scale, note } = await produceExport();
    const ext = type.split('/')[1].replace('jpeg', 'jpg');
    const a = el('a', { href: URL.createObjectURL(blob), download: filename(ext) });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    const { L } = ui.view;
    toast(
      blob.size > LIMIT
        ? `Saved ${fmtSize(blob.size)} ${ext.toUpperCase()}. Over 5 MB: choose WebP or 1× to post on X`
        : `Saved ${Math.round(L.W * scale)} × ${Math.round(L.H * scale)} ${ext.toUpperCase()} · ${fmtSize(blob.size)}${note}`,
    );
  } catch {
    toast('Export failed. Try a smaller size.');
  }
}

async function copy() {
  if (!ui.view) return;
  commitTextEditor();
  if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
    toast('This browser can’t copy images. Use Export instead.');
    return;
  }
  if (ui.crop) return;
  const opts = exportOpts('image/png');
  try {
    // Safari needs the promise handed over inside the gesture; Firefox only accepts a Blob.
    const pending = exportBlob(doc, shotFor(), assets, opts);
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pending })]);
    } catch {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': await pending })]);
    }
    const size = (await pending).size;
    toast(size > LIMIT ? `Copied (${fmtSize(size)}). X may compress it; Export picks a lighter format` : 'Copied. Paste it anywhere.');
  } catch {
    toast('Copy was blocked. Use Export instead.');
  }
}

async function share() {
  const { blob, type } = await produceExport();
  const ext = type.split('/')[1].replace('jpeg', 'jpg');
  const file = new File([blob], filename(ext), { type });
  try {
    await navigator.share({ files: [file] });
  } catch {
    /* dismissed */
  }
}

/* ================================================================== crop mode */

const CROP_ASPECTS = [
  { id: 'free', label: 'Free' },
  { id: 'original', label: 'Original' },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '4:5', label: '4:5', ratio: 4 / 5 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
];

function cropRatio() {
  const a = assets.get(doc.imageId);
  const c = CROP_ASPECTS.find((x) => x.id === ui.crop?.aspectId);
  if (!c || c.id === 'free') return null;
  return c.id === 'original' ? a.w / a.h : c.ratio;
}

function enterCrop() {
  if (ui.crop || !doc.imageId) return;
  commitTextEditor();
  const a = assets.get(doc.imageId);
  ui.crop = { rect: doc.crop ? { ...doc.crop } : { x: 0, y: 0, w: a.w, h: a.h }, aspectId: 'free', drag: null };
  ui.selectedId = null;
  syncCropBar();
  syncUI();
  scheduleRender();
}

function exitCrop() {
  ui.crop = null;
  ui.drag = null;
  syncCropBar();
  syncUI();
  scheduleRender();
}

/** Change the crop (and optionally style) in one undo step, keeping annotations pinned. */
function setCrop(rect, stylePatch = {}) {
  const a = assets.get(doc.imageId);
  const next = isFullCrop(rect, a.w, a.h) ? null : rect;
  const before = shotFor();
  const after = shotFor({ ...doc, crop: next });
  const dx = before.sx - after.sx;
  const dy = before.sy - after.sy;
  commit({
    ...doc,
    crop: next,
    style: { ...doc.style, ...stylePatch },
    annotations: doc.annotations.map((x) => moveBy(x, dx, dy)),
  });
}

function applyCrop() {
  if (!ui.crop) return;
  const r = ui.crop.rect;
  const a = assets.get(doc.imageId);
  const had = !!doc.crop;
  exitCrop();
  if (isFullCrop(r, a.w, a.h)) {
    if (had) {
      setCrop(null);
      toast('Crop removed', { label: 'Undo', run: undo });
    }
    return;
  }
  setCrop(r);
  toast(`Cropped to ${r.w} × ${r.h}`, { label: 'Undo', run: undo });
}

function syncCropBar() {
  const bar = $('#crop-bar');
  bar.hidden = !ui.crop;
  $('#stage-hint').hidden = !!ui.crop;
  if (ui.crop) radios($('#crop-aspects'), ui.crop.aspectId);
}

function buildCropBar() {
  const host = $('#crop-aspects');
  CROP_ASPECTS.forEach((c) => {
    const b = el('button', { className: 'chip', type: 'button', textContent: c.label });
    b.dataset.v = c.id;
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => {
      ui.crop.aspectId = c.id;
      const a = assets.get(doc.imageId);
      ui.crop.rect = fitAspect(ui.crop.rect, cropRatio(), a.w, a.h);
      syncCropBar();
      scheduleRender();
    });
    host.append(b);
  });
  $('#crop-trim').addEventListener('click', () => {
    const a = assets.get(doc.imageId);
    if (isFullCrop(a.trim, a.w, a.h)) return toast('No empty edges found on this image');
    ui.crop.aspectId = 'free';
    ui.crop.rect = { ...a.trim };
    syncCropBar();
    scheduleRender();
  });
  $('#crop-reset').addEventListener('click', () => {
    const a = assets.get(doc.imageId);
    ui.crop.aspectId = 'free';
    ui.crop.rect = { x: 0, y: 0, w: a.w, h: a.h };
    syncCropBar();
    scheduleRender();
  });
  $('#crop-cancel').addEventListener('click', exitCrop);
  $('#crop-apply').addEventListener('click', applyCrop);
  $('#btn-crop').addEventListener('click', enterCrop);
  $('#btn-center').addEventListener('click', () => setStyle({ offset: { x: 0, y: 0 } }));
}

const toSource = (e) => {
  const r = view.getBoundingClientRect();
  return { x: (e.clientX - r.left) / ui.view.fit, y: (e.clientY - r.top) / ui.view.fit };
};

function cropHit(p) {
  const r = ui.crop.rect;
  const tol = 14 / ui.view.fit;
  const hp = cropHandlePoints(r);
  const h = CROP_HANDLES.find((id) => Math.abs(hp[id].x - p.x) <= tol && Math.abs(hp[id].y - p.y) <= tol);
  if (h) return h;
  if (p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h) return 'move';
  return null;
}

const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move' };

/* ================================================================== canvas interaction */

/** Base-pixel point on the composition (for dragging the shot around). */
const toBase = (e) => {
  const r = view.getBoundingClientRect();
  return { x: (e.clientX - r.left) / ui.view.fit, y: (e.clientY - r.top) / ui.view.fit };
};
const onCard = (p) => {
  const c = ui.view.L.card;
  return p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h;
};

function toImage(e) {
  const { L, fit } = ui.view;
  const r = view.getBoundingClientRect();
  return { x: (e.clientX - r.left) / fit - L.img.x, y: (e.clientY - r.top) / fit - L.img.y };
}

const iuNow = () => inkUnit(ui.view.shot.w, ui.view.shot.h);
const tolNow = () => 7 / ui.view.fit;

function handleAt(p) {
  const a = doc.annotations.find((x) => x.id === ui.selectedId);
  if (!a) return null;
  const tol = 9 / ui.view.fit;
  const h = handles(a).find((h) => Math.hypot(h.x - p.x, h.y - p.y) <= tol);
  return h ? { a, h } : null;
}

function snap(start, p, e, kind) {
  if (!e.shiftKey) return p;
  const dx = p.x - start.x;
  const dy = p.y - start.y;
  if (kind === 'arrow') {
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(dx, dy);
    return { x: start.x + Math.cos(ang) * len, y: start.y + Math.sin(ang) * len };
  }
  const m = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: start.x + Math.sign(dx || 1) * m, y: start.y + Math.sign(dy || 1) * m };
}

view.addEventListener('pointerdown', (e) => {
  if (!ui.view || e.button > 0) return;
  if (ui.crop) {
    const a = assets.get(doc.imageId);
    const p = toSource(e);
    const hit = cropHit(p);
    if (hit === 'move') ui.drag = { kind: 'crop-move', start: p, orig: { ...ui.crop.rect } };
    else if (hit) ui.drag = { kind: 'crop-resize', handle: hit, orig: { ...ui.crop.rect } };
    else {
      // Start a fresh rectangle from here.
      const x = Math.max(0, Math.min(a.w - 1, p.x));
      const y = Math.max(0, Math.min(a.h - 1, p.y));
      ui.drag = { kind: 'crop-resize', handle: 'se', orig: { x, y, w: 1, h: 1 } };
    }
    view.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  if (ui.tab !== 'annotate') {
    // Style tab: drag the shot to reposition it on the canvas.
    const p = toBase(e);
    if (!onCard(p)) return;
    ui.drag = { kind: 'offset', cx: e.clientX, cy: e.clientY, orig: { ...(doc.style.offset || { x: 0, y: 0 }) } };
    stage.dataset.hover = 'grabbing';
    view.setPointerCapture(e.pointerId);
    return;
  }
  commitTextEditor();
  const p = toImage(e);
  const iu = iuNow();

  if (ui.tool === 'select') {
    const h = handleAt(p);
    if (h) {
      ui.drag = { kind: 'handle', id: h.h.id, orig: h.a, before: doc };
    } else {
      const a = pick(doc.annotations, p, iu, tolNow(), measureText);
      ui.selectedId = a ? a.id : null;
      if (a) ui.drag = { kind: 'move', start: p, orig: a, before: doc };
    }
    syncUI();
    scheduleRender();
  } else if (ui.tool === 'text') {
    const existing = pick(doc.annotations.filter((a) => a.type === 'text'), p, iu, tolNow(), measureText);
    if (existing) openTextEditor(existing);
    else openTextEditor({ id: uid(), type: 'text', x: p.x, y: p.y - 12 * iu, text: '', color: ui.color, size: ui.size }, true);
    e.preventDefault();
    return;
  } else if (ui.tool === 'step') {
    const a = { id: uid(), type: 'step', x: p.x, y: p.y, n: nextStep(doc.annotations), color: ui.color, size: ui.size };
    ui.selectedId = a.id;
    setAnnotations([...doc.annotations, a]);
    return;
  } else {
    const base = { id: uid(), type: ui.tool, color: ui.tool === 'highlight' && ui.color === INK[0] ? INK[1] : ui.color, size: ui.size };
    ui.draft = ui.tool === 'arrow' ? { ...base, x1: p.x, y1: p.y, x2: p.x, y2: p.y } : { ...base, x: p.x, y: p.y, w: 0, h: 0 };
    ui.drag = { kind: 'draw', start: p };
  }
  view.setPointerCapture(e.pointerId);
});

view.addEventListener('pointermove', (e) => {
  if (!ui.view) return;
  if (ui.crop) {
    const a = assets.get(doc.imageId);
    const p = toSource(e);
    const d = ui.drag;
    if (!d) {
      stage.style.setProperty('--crop-cursor', CURSORS[cropHit(p)] || 'crosshair');
      return;
    }
    if (d.kind === 'crop-move') ui.crop.rect = moveCrop(d.orig, p.x - d.start.x, p.y - d.start.y, a.w, a.h);
    else ui.crop.rect = resizeCrop(d.orig, d.handle, p, cropRatio(), a.w, a.h);
    scheduleRender();
    return;
  }
  if (ui.tab !== 'annotate') {
    const d = ui.drag;
    if (d?.kind === 'offset') {
      const { L, fit } = ui.view;
      let x = d.orig.x + (e.clientX - d.cx) / fit / L.W;
      let y = d.orig.y + (e.clientY - d.cy) / fit / L.H;
      const snapX = Math.abs(x) < 0.012;
      const snapY = Math.abs(y) < 0.012;
      if (snapX) x = 0;
      if (snapY) y = 0;
      x = Math.max(-0.5, Math.min(0.5, x));
      y = Math.max(-0.5, Math.min(0.5, y));
      ui.guides = snapX || snapY ? { x: snapX, y: snapY } : null;
      doc = { ...doc, style: { ...doc.style, offset: { x, y } } };
      scheduleRender();
    } else if (!d) {
      stage.dataset.hover = onCard(toBase(e)) ? 'grab' : '';
    }
    return;
  }
  const p = toImage(e);
  const d = ui.drag;
  if (!d) {
    if (ui.tool === 'select') {
      stage.dataset.hover = handleAt(p) ? 'handle' : pick(doc.annotations, p, iuNow(), tolNow(), measureText) ? 'move' : '';
    } else stage.dataset.hover = '';
    return;
  }
  if (d.kind === 'draw') {
    const q = snap(d.start, p, e, ui.draft.type);
    if (ui.draft.type === 'arrow') ui.draft = { ...ui.draft, x2: q.x, y2: q.y };
    else ui.draft = { ...ui.draft, x: Math.min(d.start.x, q.x), y: Math.min(d.start.y, q.y), w: Math.abs(q.x - d.start.x), h: Math.abs(q.y - d.start.y) };
  } else if (d.kind === 'move') {
    const moved = moveBy(d.orig, p.x - d.start.x, p.y - d.start.y);
    doc = { ...doc, annotations: doc.annotations.map((a) => (a.id === moved.id ? moved : a)) };
  } else if (d.kind === 'handle') {
    const next = dragHandle(d.orig, d.id, p);
    doc = { ...doc, annotations: doc.annotations.map((a) => (a.id === next.id ? next : a)) };
  }
  scheduleRender();
});

function endDrag() {
  const d = ui.drag;
  if (!d) return;
  ui.drag = null;
  if (d.kind === 'crop-move' || d.kind === 'crop-resize') return;
  if (d.kind === 'offset') {
    ui.guides = null;
    stage.dataset.hover = 'grab';
    commit(doc);
    return;
  }
  if (d.kind === 'draw') {
    const a = ui.draft;
    ui.draft = null;
    if (a && !isDegenerate(a, iuNow())) {
      ui.selectedId = a.id;
      setAnnotations([...doc.annotations, a]);
    } else scheduleRender();
  } else {
    commit(doc);
  }
}
view.addEventListener('pointerup', endDrag);
view.addEventListener('pointercancel', endDrag);

view.addEventListener('dblclick', (e) => {
  if (ui.crop) return applyCrop();
  if (ui.tab !== 'annotate') {
    if (ui.view && onCard(toBase(e))) setStyle({ offset: { x: 0, y: 0 } });
    return;
  }
  const p = toImage(e);
  const a = pick(doc.annotations.filter((x) => x.type === 'text'), p, iuNow(), tolNow(), measureText);
  if (a) openTextEditor(a);
});

/* ---------------------------------------------------------------- text editor */

const editor = $('#text-editor');
let editing = null; // { a, isNew }

function layoutEditor() {
  if (!editing) return;
  const { L, fit } = ui.view;
  const a = { ...editing.a, text: editor.value || ' ' };
  const b = textBox(a, iuNow(), measureText);
  const lum = (() => {
    const n = parseInt(a.color.slice(1), 16);
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  })();
  Object.assign(editor.style, {
    left: `${(L.img.x + b.x) * fit}px`,
    top: `${(L.img.y + b.y) * fit}px`,
    width: `${Math.max(b.w, b.fs * 3) * fit + 4}px`,
    height: `${b.h * fit}px`,
    fontSize: `${b.fs * fit}px`,
    padding: `${b.padY * fit}px ${b.padX * fit}px`,
    background: a.color,
    color: lum > 0.62 ? '#17171b' : '#ffffff',
    borderRadius: `${b.fs * 0.45 * fit}px`,
  });
}

function openTextEditor(a, isNew = false) {
  if (!ui.view) return;
  editing = { a, isNew };
  ui.editingId = a.id;
  ui.selectedId = a.id;
  editor.value = a.text || '';
  editor.hidden = false;
  layoutEditor();
  scheduleRender();
  requestAnimationFrame(() => {
    editor.focus();
    editor.select();
  });
}

function commitTextEditor(cancel = false) {
  if (!editing) return;
  const { a, isNew } = editing;
  editing = null;
  ui.editingId = null;
  editor.hidden = true;
  const text = editor.value.replace(/\s+$/, '');
  if (cancel && isNew) return scheduleRender();
  if (cancel) return scheduleRender();
  if (!text.trim()) {
    ui.selectedId = null;
    setAnnotations(doc.annotations.filter((x) => x.id !== a.id));
    return;
  }
  const next = { ...a, text };
  setAnnotations(isNew ? [...doc.annotations, next] : doc.annotations.map((x) => (x.id === a.id ? next : x)));
}

editor.addEventListener('input', layoutEditor);
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    commitTextEditor();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    commitTextEditor(true);
  }
  e.stopPropagation();
});
editor.addEventListener('blur', () => commitTextEditor());

/* ================================================================== wiring */

function undo() {
  commitTextEditor();
  const d = history.undo();
  if (d) {
    doc = d;
    ui.selectedId = null;
    store.set('fs:style', doc.style);
    syncUI();
    scheduleRender();
    renderThumbs();
    scheduleSave();
  }
}
function redo() {
  const d = history.redo();
  if (d) {
    doc = d;
    ui.selectedId = null;
    store.set('fs:style', doc.style);
    syncUI();
    scheduleRender();
    renderThumbs();
    scheduleSave();
  }
}

let toastTimer = 0;
/** Status message; `action` = { label, run } adds a button (e.g. Undo). */
function toast(msg, action = null) {
  const t = $('#toast');
  t.replaceChildren(el('span', { textContent: msg }));
  if (action) {
    const b = el('button', { type: 'button', textContent: action.label });
    b.addEventListener('click', () => {
      t.classList.remove('show');
      action.run();
    });
    t.append(b);
  }
  t.classList.toggle('actionable', !!action);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 5000 : 2400);
}

function wire() {
  $('#tab-style').addEventListener('click', () => {
    if (ui.crop) exitCrop();
    setTab('style');
  });
  $('#tab-annotate').addEventListener('click', () => {
    if (ui.crop) exitCrop();
    setTab('annotate');
  });
  $('#btn-undo').addEventListener('click', undo);
  $('#btn-redo').addEventListener('click', redo);

  const fileInput = $('#file-input');
  const open = () => fileInput.click();
  $('#btn-open').addEventListener('click', open);
  $('#hint-open').addEventListener('click', open);
  $('#hint-open-touch').addEventListener('click', open);
  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    if (f) loadBlob(f, f.name);
    fileInput.value = '';
  });

  const bgInput = $('#bg-input');
  bgInput.addEventListener('change', async () => {
    const f = bgInput.files[0];
    bgInput.value = '';
    if (!f) return;
    try {
      const bmp = await toBitmap(f);
      const id = 'bg-' + uid();
      assets.set(id, { bitmap: bmp, w: bmp.width, h: bmp.height, name: f.name });
      setStyle({ bg: { kind: 'image', assetId: id } });
    } catch {
      toast('Couldn’t read that image');
    }
  });

  if (navigator.mediaDevices?.getDisplayMedia && !matchMedia('(pointer: coarse)').matches) {
    $('#hint-capture').addEventListener('click', captureScreen);
  } else document.body.classList.add('no-capture');

  $('#seg-bg').addEventListener('click', (e) => {
    const kind = e.target.closest('[data-v]')?.dataset.v;
    if (!kind || kind === doc.style.bg.kind) return;
    if (kind === 'image') {
      const existing = [...assets.entries()].find(([k]) => k.startsWith('bg-'));
      if (existing) setStyle({ bg: { kind: 'image', assetId: existing[0] } });
      else {
        $('#bg-input').click();
        return;
      }
    } else if (kind === 'solid') setStyle({ bg: { kind, color: lastBgId.solid } });
    else if (kind === 'mesh' || kind === 'gradient') setStyle({ bg: { kind, id: lastBgId[kind] } });
    else if (kind === 'match') setStyle({ bg: { kind, variant: lastBgId.match } });
    else setStyle({ bg: { kind } });
  });
  $('#chk-grain').addEventListener('change', (e) => setStyle({ grain: e.target.checked }));
  $('#chk-trim').addEventListener('change', (e) => {
    const a = assets.get(doc.imageId);
    const on = e.target.checked;
    setCrop(on ? { ...a.trim } : null, { trim: on });
    if (on && isFullCrop(a.trim, a.w, a.h)) toast('No empty edges on this one. New screenshots get trimmed automatically');
    renderThumbs();
  });
  const badge = $('#badge-text');
  badge.addEventListener('input', () => setStyle({ badge: { ...doc.style.badge, text: badge.value } }, false));
  badge.addEventListener('change', () => setStyle({ badge: { ...doc.style.badge, text: badge.value } }));
  $('#seg-badge').addEventListener('click', (e) => {
    const v = e.target.closest('[data-v]')?.dataset.v;
    if (v) setStyle({ badge: { ...doc.style.badge, pos: v } });
  });
  $('#btn-save-style').addEventListener('click', saveStyle);

  // Export popover.
  const pop = $('#export-pop');
  const menu = $('#btn-export-menu');
  const setPop = (open) => {
    pop.hidden = !open;
    menu.setAttribute('aria-expanded', String(open));
    if (open) updateExportNote();
  };
  menu.addEventListener('click', (e) => {
    e.stopPropagation();
    setPop(pop.hidden);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !$('#export-split').contains(e.target)) setPop(false);
  });
  $('#seg-format').addEventListener('click', (e) => {
    const v = e.target.closest('[data-v]')?.dataset.v;
    if (!v) return;
    ui.exportType = v;
    store.set('fs:format', v);
    syncUI();
    updateExportNote();
  });
  $('#seg-scale').addEventListener('click', (e) => {
    const v = e.target.closest('[data-v]')?.dataset.v;
    if (!v) return;
    ui.exportScale = +v;
    store.set('fs:scale', +v);
    syncUI();
    updateExportNote();
  });
  $('#btn-export').addEventListener('click', download);
  $('#btn-copy').addEventListener('click', copy);
  const shareBtn = $('#btn-share');
  try {
    if (navigator.canShare && navigator.canShare({ files: [new File([''], 'x.png', { type: 'image/png' })] })) {
      shareBtn.hidden = false;
      shareBtn.addEventListener('click', share);
    }
  } catch {
    /* no share */
  }

  const keys = $('#keys-dialog');
  $('#btn-keys').addEventListener('click', () => keys.showModal());

  // Paste.
  window.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (!item) {
      if (!/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) toast('No image on the clipboard. Copy a screenshot first.');
      return;
    }
    e.preventDefault();
    loadBlob(item.getAsFile(), 'pasted');
  });

  // Drag and drop anywhere.
  let depth = 0;
  const app = $('#app');
  window.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    depth++;
    app.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) app.classList.remove('dragging');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    app.classList.remove('dragging');
    const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) loadBlob(f, f.name);
    else toast('Drop an image file');
  });

  // Keyboard.
  window.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) && document.activeElement.type !== 'range' && document.activeElement.type !== 'checkbox';
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (ui.crop) {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyCrop();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        exitCrop();
      }
      return;
    }
    if (mod && k === 'z' && !typing) {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    } else if (mod && k === 'y' && !typing) {
      e.preventDefault();
      redo();
    } else if (mod && k === 's') {
      e.preventDefault();
      download();
    } else if (mod && k === 'o') {
      e.preventDefault();
      open();
    } else if (mod && k === 'c' && !typing && !String(window.getSelection())) {
      e.preventDefault();
      copy();
    } else if (typing || mod || e.altKey) {
      return;
    } else if (e.key === '?') {
      keys.showModal();
    } else if (k === 'c') {
      enterCrop();
    } else if (e.key === 'Escape') {
      if (!pop.hidden) setPop(false);
      else if (ui.selectedId) {
        ui.selectedId = null;
        syncUI();
        scheduleRender();
      } else if (ui.tool !== 'select') setTool('select');
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && ui.selectedId) {
      e.preventDefault();
      deleteSelection();
    } else if (e.key.startsWith('Arrow') && ui.selectedId && ui.tab === 'annotate') {
      e.preventDefault();
      const n = e.shiftKey ? 10 : 1;
      const dx = { ArrowLeft: -n, ArrowRight: n }[e.key] || 0;
      const dy = { ArrowUp: -n, ArrowDown: n }[e.key] || 0;
      setAnnotations(doc.annotations.map((a) => (a.id === ui.selectedId ? moveBy(a, dx, dy) : a)));
    } else {
      const t = TOOLS.find((x) => x.key === k);
      if (t) setTool(t.id);
    }
  });

  // Launched as an installed app with a file ("Open with Framesmith").
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      const h = params.files && params.files[0];
      if (h) {
        const f = await h.getFile();
        loadBlob(f, f.name);
      }
    });
  }
}

async function receiveShared() {
  const url = new URL(location.href);
  if (!url.searchParams.has('shared')) return;
  window.history.replaceState(null, '', '/');
  try {
    const cache = await caches.open('fs-share');
    const res = await cache.match('/shared-image');
    if (res) {
      await loadBlob(await res.blob(), 'shared');
      await cache.delete('/shared-image');
    }
  } catch {
    /* nothing shared */
  }
}

/* ================================================================== boot */

async function boot() {
  buildLooks();
  buildFrames();
  buildAspects();
  buildSliders();
  buildTools();
  buildCropBar();
  buildPresets();
  wire();
  syncUI();
  try {
    await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
    await document.fonts.load('600 20px Geist');
  } catch {
    /* system font fallback */
  }
  // Bring back the last session unless a file has already arrived (Open with…, share target).
  const params = new URLSearchParams(location.search);
  if (!ui.userImage && !params.has('fresh') && !params.has('shared')) {
    if (await restoreSession(await loadSession())) {
      scheduleRender();
      syncUI();
      renderThumbs();
      toast('Welcome back. Your last shot is restored', { label: 'Start fresh', run: startFresh });
    }
  }
  if (!ui.userImage) {
    addImage(demoShot(), 'framesmith-sample', { user: false });
    // Show what annotations look like before anyone has to discover the tab.
    doc = { ...doc, annotations: demoAnnotations() };
    history = new History(doc);
  }
  if (new URLSearchParams(location.search).get('tab') === 'annotate') setTab('annotate');
  syncUI();
  scheduleRender();
  receiveShared();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

boot();
