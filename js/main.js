import { computeLayout, ASPECTS, FRAMES, safeScale, clamp } from './layout.js';
import { GRADIENTS, MESHES, SOLIDS, paintBackground } from './backgrounds.js';
import { render, exportBlob, measureText } from './render.js';
import {
  TOOLS, INK, inkUnit, pick, handles, moveBy, dragHandle, nextStep, isDegenerate, textBox,
} from './annotations.js';
import { History } from './history.js';
import { findTrim } from './trim.js';
import { demoShot } from './demo.js';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};

/* ================================================================== state */

const DEFAULT_STYLE = {
  bg: { kind: 'mesh', id: 'peach' },
  grain: true,
  frame: 'mac-light',
  frameTitle: '',
  aspect: 'auto',
  padding: 9,
  radius: 12,
  shadow: 55,
  tilt: 0,
  trim: false,
};

const LOOKS = [
  { name: 'Launch', style: { bg: { kind: 'mesh', id: 'peach' }, grain: true, frame: 'mac-light', aspect: '16:9', padding: 9, radius: 12, shadow: 55, tilt: 0 } },
  { name: 'Night', style: { bg: { kind: 'mesh', id: 'aurora' }, grain: true, frame: 'mac-dark', aspect: '16:9', padding: 10, radius: 12, shadow: 70, tilt: -16 } },
  { name: 'Docs', style: { bg: { kind: 'solid', color: '#f4efe6' }, grain: false, frame: 'browser-light', aspect: 'auto', padding: 6, radius: 10, shadow: 30, tilt: 0 } },
  { name: 'Glass', style: { bg: { kind: 'gradient', id: 'lagoon' }, grain: false, frame: 'glass', aspect: '4:3', padding: 10, radius: 18, shadow: 40, tilt: 0 } },
  { name: 'Poster', style: { bg: { kind: 'gradient', id: 'ember' }, grain: true, frame: 'stack', aspect: '4:5', padding: 12, radius: 14, shadow: 60, tilt: 0 } },
  { name: 'Echo', style: { bg: { kind: 'blur' }, grain: true, frame: 'none', aspect: '1.91:1', padding: 8, radius: 14, shadow: 60, tilt: 14 } },
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
const initialStyle = { ...DEFAULT_STYLE, ...saved };
if (initialStyle.bg.kind === 'image') initialStyle.bg = DEFAULT_STYLE.bg;

let doc = { style: initialStyle, annotations: [], imageId: null };
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
  exportType: store.get('fs:type', 'image/png'),
  exportScale: store.get('fs:scale', 2),
  view: null, // { L, fit }
  userImage: false,
};

const lastBgId = { mesh: 'peach', gradient: 'ember', solid: '#f4efe6' };

const uid = () => Math.random().toString(36).slice(2, 10);

function shotFor(d = doc) {
  const a = assets.get(d.imageId);
  const t = d.style.trim ? a.trim : { x: 0, y: 0, w: a.w, h: a.h };
  return { bitmap: a.bitmap, sx: t.x, sy: t.y, w: t.w, h: t.h };
}

/** Replace the document. `record` pushes an undo step. */
function commit(next, record = true) {
  doc = next;
  if (record && history) history.push(doc);
  store.set('fs:style', doc.style);
  scheduleRender();
  syncUI();
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

function addImage(bitmap, name, { user = true } = {}) {
  const w = bitmap.width;
  const h = bitmap.height;
  const id = 'img-' + uid();
  assets.set(id, { bitmap, w, h, name, trim: computeTrim(bitmap, w, h) });
  ui.selectedId = null;
  if (user) {
    ui.userImage = true;
    $('#stage-hint').classList.add('quiet');
  }
  const next = { ...doc, imageId: id, annotations: [] };
  if (!history) {
    doc = next;
    history = new History(doc);
    scheduleRender();
    syncUI();
  } else commit(next);
  renderThumbs();
}

async function loadBlob(blob, name = 'image') {
  if (!blob || !blob.type.startsWith('image/')) {
    toast('That file isn’t an image');
    return;
  }
  try {
    const bmp = await toBitmap(blob);
    addImage(bmp, name.replace(/\.[^.]+$/, ''));
    toast(`Loaded ${bmp.width} × ${bmp.height}`);
  } catch {
    toast('Couldn’t read that image');
  }
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
    addImage(c, 'capture');
    toast('Captured');
  } catch (e) {
    if (e && e.name !== 'NotAllowedError') toast('Screen capture isn’t available here');
  }
}

/* ================================================================== render */

const view = $('#view');
const vctx = view.getContext('2d');
const stage = $('#stage');
let raf = 0;

function scheduleRender() {
  if (!raf) raf = requestAnimationFrame(draw);
}

function draw() {
  raf = 0;
  if (!doc.imageId) return;
  const shot = shotFor();
  const L = computeLayout(shot.w, shot.h, doc.style);
  const rect = stage.getBoundingClientRect();
  const mobile = rect.width < 600;
  const m = mobile ? 14 : 44;
  const avW = rect.width - m * 2;
  const avH = rect.height - m * 2 - (mobile ? 36 : 56);
  const fit = Math.max(0.05, Math.min(avW / L.W, avH / L.H, 2));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const s = fit * dpr;
  const cw = Math.round(L.W * s);
  const ch = Math.round(L.H * s);
  if (view.width !== cw || view.height !== ch) {
    view.width = cw;
    view.height = ch;
  }
  view.style.width = `${L.W * fit}px`;
  view.style.height = `${L.H * fit}px`;

  let annotations = doc.annotations;
  if (ui.editingId) annotations = annotations.filter((a) => a.id !== ui.editingId);
  if (ui.draft) annotations = [...annotations, ui.draft];
  const flat = ui.tab === 'annotate';
  render(vctx, { ...doc, annotations }, shot, assets, {
    s,
    flat,
    selectedId: flat && ui.tool === 'select' ? ui.selectedId : flat ? ui.selectedId : null,
  });
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
      renderInto(b.querySelector('canvas'), look.style);
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
      setStyle({ ...look.style, frameTitle: doc.style.frameTitle });
      toast(`${look.name} look applied`);
    });
    host.append(b);
  });
}

function styleMatches(style) {
  return Object.entries(style).every(([k, v]) => JSON.stringify(doc.style[k]) === JSON.stringify(v));
}

function buildSwatches() {
  const host = $('#swatches');
  host.replaceChildren();
  const { bg } = doc.style;
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
  if (bg.kind === 'mesh') {
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
    input.addEventListener('input', () => setStyle({ bg: { kind: 'solid', color: input.value } }, false));
    input.addEventListener('change', () => {
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
    case 'stack':
      return shell(`<rect x="12" y="2" width="40" height="30" rx="4" fill="${body}" fill-opacity=".45" stroke="${line}"/><rect x="8" y="6" width="48" height="32" rx="4" fill="${body}" fill-opacity=".75" stroke="${line}"/><rect x="4" y="10" width="56" height="32" rx="4" fill="${body}" stroke="${line}"/>`);
  }
  return '';
}

function buildFrames() {
  const host = $('#frames');
  FRAMES.forEach((f) => {
    const b = el('button', { className: 'frame-tile', type: 'button' });
    b.dataset.v = f.id;
    b.setAttribute('role', 'radio');
    b.innerHTML = `<span class="ft">${frameSvg(f.id)}</span><span>${f.label}</span>`;
    b.addEventListener('click', () => setStyle({ frame: f.id }));
    host.append(b);
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
    toast('Annotations cleared. Undo brings them back.');
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
  buildSwatches();
  $('#chk-grain').checked = style.grain;
  $('#chk-grain').disabled = style.bg.kind === 'none';
  radios($('#frames'), style.frame);
  const titled = style.frame.startsWith('mac') || style.frame.startsWith('browser');
  const title = $('#frame-title');
  title.hidden = !titled;
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
    b.setAttribute('aria-pressed', String(styleMatches(LOOKS[+b.dataset.look].style)));
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
  const ext = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP' }[ui.exportType];
  $('#export-label').textContent = `Export ${ext}`;
}

function updateExportNote() {
  if (!ui.view) return;
  const { L } = ui.view;
  const k = safeScale(L.W, L.H, ui.exportScale);
  const w = Math.round(L.W * k);
  const h = Math.round(L.H * k);
  let note = `${w} × ${h} px`;
  if (k < ui.exportScale) note += ' · capped to stay within browser limits';
  if (ui.exportType === 'image/jpeg' && doc.style.bg.kind === 'none') note += ' · JPEG has no transparency, so the background will be white';
  $('#export-note').textContent = note;
}

/* ================================================================== export */

function exportOpts(type = ui.exportType) {
  const { L } = ui.view;
  return { type, scale: safeScale(L.W, L.H, ui.exportScale), quality: 0.93 };
}

function filename(ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const base = assets.get(doc.imageId)?.name || 'shot';
  const safe = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'shot';
  return `${safe}-framed-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}

async function download() {
  if (!ui.view) return;
  commitTextEditor();
  const opts = exportOpts();
  try {
    const blob = await exportBlob(doc, shotFor(), assets, opts);
    const ext = opts.type.split('/')[1].replace('jpeg', 'jpg');
    const a = el('a', { href: URL.createObjectURL(blob), download: filename(ext) });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(`Saved ${Math.round(ui.view.L.W * opts.scale)} × ${Math.round(ui.view.L.H * opts.scale)} ${ext.toUpperCase()}`);
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
  const opts = exportOpts('image/png');
  try {
    // Hand the promise straight to ClipboardItem: Safari requires it within the gesture.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': exportBlob(doc, shotFor(), assets, opts) })]);
    toast('Copied. Paste it anywhere.');
  } catch {
    toast('Copy was blocked. Use Export instead.');
  }
}

async function share() {
  const opts = exportOpts();
  const blob = await exportBlob(doc, shotFor(), assets, opts);
  const ext = opts.type.split('/')[1].replace('jpeg', 'jpg');
  const file = new File([blob], filename(ext), { type: opts.type });
  try {
    await navigator.share({ files: [file] });
  } catch {
    /* dismissed */
  }
}

/* ================================================================== canvas interaction */

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
  if (ui.tab !== 'annotate') {
    setTab('annotate');
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
  if (!ui.view || ui.tab !== 'annotate') return;
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
  if (ui.tab !== 'annotate') return;
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
  }
}

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function wire() {
  $('#tab-style').addEventListener('click', () => setTab('style'));
  $('#tab-annotate').addEventListener('click', () => setTab('annotate'));
  $('#btn-undo').addEventListener('click', undo);
  $('#btn-redo').addEventListener('click', redo);

  const fileInput = $('#file-input');
  const open = () => fileInput.click();
  $('#btn-open').addEventListener('click', open);
  $('#hint-open').addEventListener('click', open);
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
    else setStyle({ bg: { kind } });
  });
  $('#chk-grain').addEventListener('change', (e) => setStyle({ grain: e.target.checked }));
  $('#chk-trim').addEventListener('change', (e) => {
    // Keep annotations pinned to the same pixels when the crop changes.
    const before = shotFor();
    const style = { ...doc.style, trim: e.target.checked };
    const after = shotFor({ ...doc, style });
    const dx = before.sx - after.sx;
    const dy = before.sy - after.sy;
    commit({ ...doc, style, annotations: doc.annotations.map((a) => moveBy(a, dx, dy)) });
    const a = assets.get(doc.imageId);
    if (e.target.checked && a.trim.w === a.w && a.trim.h === a.h) toast('No empty edges found on this image');
    renderThumbs();
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
    store.set('fs:type', v);
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
  buildPresets();
  wire();
  try {
    await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
    await document.fonts.load('600 20px Geist');
  } catch {
    /* system font fallback */
  }
  const demo = demoShot();
  addImage(demo, 'framesmith-sample', { user: false });
  receiveShared();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

boot();
