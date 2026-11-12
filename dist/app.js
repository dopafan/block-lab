import { SHAPES } from './solver.js?v=5';

const $ = (selector) => document.querySelector(selector);
const FAMILIES = [
  { id: 'I', name: '直条' },
  { id: 'O', name: '正方形' },
  { id: 'T', name: 'T 型' },
  { id: 'Z', name: 'Z 型' },
  { id: 'L', name: 'L 型' },
];
const FAMILY_COLORS = { I: '#22b3a4', O: '#f4b740', T: '#9b6cf0', Z: '#f0695a', L: '#3f8cf0' };
const FAMILY_INK = { I: '#ffffff', O: '#4a3200', T: '#ffffff', Z: '#ffffff', L: '#ffffff' };
const SHAPE_MAP = Object.fromEntries(SHAPES.map((shape) => [shape.id, shape]));
const SHAPE_ORDER = Object.fromEntries(SHAPES.map((shape, index) => [shape.id, index]));
// Orientations of one family get slightly different shades so neighbours stay distinguishable.
const SHAPE_SHADE = Object.fromEntries(SHAPES.map((shape) => [shape.id, SHAPES.filter((other) => other.family === shape.family).indexOf(shape) % 4]));
const SHAPE_BY_KEY = Object.fromEntries(SHAPES.map((shape) => [cellsKey(shape.cells), shape]));
const DEFAULT = { i_h: 2, z_h: 1, s_h: 1, z_v: 1, l_left: 1, t_right: 1, l_right: 1, o_square: 1 };
const STORE_KEY = 'block-lab-inventory-v1';
const MAX_EACH = 9;
const PAGE = 6;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let counts = { ...DEFAULT };
let result = null;
let scenarios = [];
let scenarioKind = null;
let active = 0;
let shown = PAGE;
let worker = null;
let runId = 0;
let solveTimer = null;
let busyTimer = null;
let busyTick = null;
let animateTimer = null;

/* ---------- helpers ---------- */

function cellsKey(cells) {
  const minX = Math.min(...cells.map(([x]) => x));
  const minY = Math.min(...cells.map(([, y]) => y));
  return cells.map(([x, y]) => `${x - minX},${y - minY}`).sort().join(' ');
}

function total(source = counts) {
  return Object.values(source).reduce((a, b) => a + b, 0);
}

function piecesText(map) {
  return Object.entries(map).map(([id, n]) => `${SHAPE_MAP[id].name} × ${n}`).join('、');
}

/** Per-cell flags telling which sides are open, so one piece reads as one solid shape. */
function edgeStyle(cells, x, y) {
  const has = (cx, cy) => cells.some(([px, py]) => px === cx && py === cy);
  const up = has(x, y - 1);
  const right = has(x + 1, y);
  const down = has(x, y + 1);
  const left = has(x - 1, y);
  // d / e / f mark a filled 2×2 block, where the bridges must not draw an outline.
  const d = right && down && has(x + 1, y + 1) ? 1 : 0;
  const e = left && down && has(x - 1, y + 1) ? 1 : 0;
  const f = up && right && has(x + 1, y - 1) ? 1 : 0;
  return `--t:${up ? 0 : 1};--r:${right ? 0 : 1};--b:${down ? 0 : 1};--l:${left ? 0 : 1};--d:${d};--e:${e};--f:${f}`;
}

/** Every thumbnail uses the same cell size, whatever the shape's bounding box. */
function thumb(shape, extraClass = '') {
  const width = Math.max(...shape.cells.map(([x]) => x)) + 1;
  const height = Math.max(...shape.cells.map(([, y]) => y)) + 1;
  const tiles = shape.cells.map(([x, y]) => `<i class="tile" style="grid-column:${x + 1};grid-row:${y + 1};${edgeStyle(shape.cells, x, y)}"></i>`).join('');
  return `<span class="thumb ${extraClass}" data-family="${shape.family}" style="--w:${width};--h:${height};--k:${SHAPE_SHADE[shape.id]}" aria-hidden="true">${tiles}</span>`;
}

function decorate(placements) {
  const order = (a, b) => SHAPE_ORDER[a.shapeId] - SHAPE_ORDER[b.shapeId] || a.y - b.y || a.x - b.x;
  const own = placements.filter((piece) => !piece.added).sort(order)
    .map((piece, index) => ({ ...piece, key: `p${index}`, label: String.fromCharCode(65 + index) }));
  const added = placements.filter((piece) => piece.added).sort(order)
    .map((piece, index) => ({ ...piece, key: `a${index}`, label: '+' }));
  return [...own, ...added];
}

function boardMarkup(placements, labels = true) {
  let html = '';
  for (let y = 0; y < 6; y += 1) {
    for (let x = 0; x < 6; x += 1) html += `<span class="slot" style="grid-column:${x + 1};grid-row:${y + 1}"></span>`;
  }
  decorate(placements).forEach((piece, index) => {
    const family = SHAPE_MAP[piece.shapeId].family;
    const first = piece.cells.reduce((a, b) => (b[1] * 6 + b[0] < a[1] * 6 + a[0] ? b : a));
    for (const [x, y] of piece.cells) {
      const label = labels && first[0] === x && first[1] === y ? piece.label : '';
      const action = labels ? ` data-shape="${piece.shapeId}" title="${piece.added ? '点击加入' : '点击拿掉'} ${SHAPE_MAP[piece.shapeId].name}"` : '';
      html += `<i class="tile${piece.added ? ' ghost' : ''}" data-family="${family}" data-piece="${piece.key}"${action} style="grid-column:${x + 1};grid-row:${y + 1};${edgeStyle(piece.cells, x, y)};--i:${index};--k:${SHAPE_SHADE[piece.shapeId]}">${label}</i>`;
    }
  });
  return html;
}

/* ---------- inventory ---------- */

function saveInventory() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ counts })); } catch { /* Storage may be unavailable. */ }
}

function restoreInventory() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORE_KEY));
    if (!stored || typeof stored.counts !== 'object' || stored.counts === null || Array.isArray(stored.counts)) return;
    const clean = {};
    for (const shape of SHAPES) {
      const value = stored.counts[shape.id];
      if (Number.isInteger(value) && value > 0) clean[shape.id] = Math.min(MAX_EACH, value);
    }
    counts = clean;
  } catch { /* Keep the example. */ }
}

function renderInventory() {
  const ordered = FAMILIES.flatMap(({ id }) => SHAPES.filter((shape) => shape.family === id));
  const cards = ordered.map((shape) => `<div class="card" data-shape="${shape.id}" data-family="${shape.family}"><button class="card-main" type="button" data-add="${shape.id}" aria-label="加一块${shape.name}"><span class="thumb-box">${thumb(shape)}</span><span class="card-name">${shape.name}</span></button><div class="stepper"><button type="button" data-step="-1" data-id="${shape.id}" aria-label="减少${shape.name}">−</button><span class="count" data-count="${shape.id}" aria-label="${shape.name}数量">0</span><button type="button" data-step="1" data-id="${shape.id}" aria-label="增加${shape.name}">+</button></div></div>`);
  cards.splice(3, 0, '<div class="card hint-card"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20l4-1L19 8l-3-3L5 16l-1 4zM14 7l3 3"/></svg><b>手绘添加</b><span>在右边棋盘上<br>按住拖动画 4 格</span></div>');
  $('#inventory').innerHTML = cards.join('');
  updateInventory();
}

function updateInventory() {
  document.querySelectorAll('.card[data-shape]').forEach((card) => {
    const n = counts[card.dataset.shape] || 0;
    card.classList.toggle('on', n > 0);
    const count = card.querySelector('.count');
    if (count.textContent !== String(n)) {
      count.textContent = n;
      count.classList.remove('bump');
      void count.offsetWidth;
      count.classList.add('bump');
    }
    card.querySelector('[data-step="-1"]').disabled = n === 0;
    card.querySelector('[data-step="1"]').disabled = n >= MAX_EACH;
  });
  const n = total();
  $('#total-count').textContent = n;
  $('#area-count').textContent = n * 4;
  $('#meter-fill').style.width = `${Math.min(100, n * 4 / 36 * 100)}%`;
  $('#picker').classList.toggle('over', n > 9);
  $('#capacity-note').textContent = n > 9 ? `超出棋盘面积，至少要拿掉 ${n - 9} 块。`
    : n === 9 ? '面积刚好 36 格，能不能铺满要看形状。'
      : n === 0 ? '点小图加一块，或在棋盘上手绘。' : `还空 ${36 - n * 4} 格，最多能再加 ${9 - n} 块。`;
}

function setCount(id, value) {
  const next = Math.max(0, Math.min(MAX_EACH, value));
  if ((counts[id] || 0) === next) return;
  if (next === 0) delete counts[id]; else counts[id] = next;
  inventoryChanged();
}

function inventoryChanged() {
  saveInventory();
  updateInventory();
  clearTimeout(solveTimer);
  solveTimer = setTimeout(() => solve(), 160);
}

function flashCard(id) {
  const card = document.querySelector(`.card[data-shape="${id}"]`);
  if (!card) return;
  card.classList.remove('flash');
  void card.offsetWidth;
  card.classList.add('flash');
}

/* ---------- hand drawing, directly on the board ---------- */

const TIP_IDLE = '在棋盘上按住拖动画 4 格，可以手绘添加 · 点积木拿掉 · 点虚线积木加入';
const drawn = new Set(); // board cell indices, 0–35
const ink = new Map(); // cell index → overlay element
let shownPieces = new Map(); // cell index → piece currently displayed there
let stroke = null;
let committing = false;
let pendingFresh = null;
let tipTimer = null;
let tipHeld = false; // keep the "where did my piece go" message on screen for a moment

function drawnCells() {
  return [...drawn].map((index) => [index % 6, Math.floor(index / 6)]);
}

function drawnShape() {
  return drawn.size === 4 ? SHAPE_BY_KEY[cellsKey(drawnCells())] || null : null;
}

function boardIndex(event) {
  const board = $('#board');
  const rect = board.getBoundingClientRect();
  const style = getComputedStyle(board);
  const inset = parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth);
  const size = (rect.width - inset * 2) / 6;
  const x = Math.floor((event.clientX - rect.left - inset) / size);
  const y = Math.floor((event.clientY - rect.top - inset) / size);
  return x < 0 || x > 5 || y < 0 || y > 5 ? null : y * 6 + x;
}

function setTip(text, tone = '') {
  clearTimeout(tipTimer);
  const tip = $('#board-tip');
  tip.textContent = text;
  tip.className = `board-tip ${tone}`;
}

/** Draws the strokes on top of the board and dims every piece they run over. */
function renderInk() {
  const board = $('#board');
  const cells = drawnCells();
  const shape = drawnShape();
  for (const [index, element] of ink) {
    if (!drawn.has(index) || !element.isConnected) { element.remove(); ink.delete(index); }
  }
  for (const index of drawn) {
    let element = ink.get(index);
    if (!element) {
      element = document.createElement('i');
      element.className = 'tile ink';
      board.append(element);
      ink.set(index, element);
    }
    const x = index % 6;
    const y = Math.floor(index / 6);
    element.style.cssText = `grid-column:${x + 1};grid-row:${y + 1};${edgeStyle(cells, x, y)}`;
    if (shape) element.dataset.family = shape.family; else delete element.dataset.family;
  }
  const covered = new Set([...drawn].map((index) => shownPieces.get(index)?.key).filter(Boolean));
  board.querySelectorAll('[data-piece]').forEach((tile) => tile.classList.toggle('under', covered.has(tile.dataset.piece)));
  board.classList.toggle('drawing', drawn.size > 0);
  if (committing || (tipHeld && drawn.size === 0)) return;
  tipHeld = false;
  if (drawn.size === 0) setTip(TIP_IDLE);
  else if (drawn.size < 4) setTip(`再画 ${4 - drawn.size} 格 · 点已画的格子可擦掉 · Esc 取消`, 'active');
  else if (shape) setTip(stroke ? `松手加入「${shape.name}」` : `识别为「${shape.name}」`, 'ok');
  else setTip('4 个格子要边贴边连在一起', 'bad');
}

function paint(index) {
  if (committing || index === null) return;
  if (stroke.mode === 'erase') drawn.delete(index);
  else if (drawn.size < 4) drawn.add(index);
  renderInk();
}

function clearDrawing() {
  drawn.clear();
  committing = false;
  renderInk();
}

/** A finished drawing joins the inventory; the solver then re-arranges every piece around it. */
function finishDrawing() {
  if (drawn.size < 4 || committing) return;
  const shape = drawnShape();
  if (!shape) {
    committing = true;
    ink.forEach((element) => element.classList.add('bad'));
    tipTimer = setTimeout(clearDrawing, 650);
    return;
  }
  if ((counts[shape.id] || 0) >= MAX_EACH) {
    setTip(`「${shape.name}」已经有 ${MAX_EACH} 块了`, 'bad');
    tipTimer = setTimeout(clearDrawing, 900);
    return;
  }
  committing = true;
  ink.forEach((element) => element.classList.add('commit'));
  const overlapped = new Set([...drawn].map((index) => shownPieces.get(index)?.key).filter(Boolean)).size;
  pendingFresh = { shapeId: shape.id, cells: drawnCells(), overlapped };
  setTip(`已加入「${shape.name}」，正在重新摆放…`, 'ok');
  setCount(shape.id, (counts[shape.id] || 0) + 1);
  flashCard(shape.id);
}

/** After the new layout is drawn, point out where the hand-drawn piece ended up. */
function revealFresh(pieces) {
  if (!pendingFresh) return;
  const { shapeId, cells, overlapped } = pendingFresh;
  pendingFresh = null;
  drawn.clear();
  committing = false;
  const centre = (list) => [list.reduce((a, [x]) => a + x, 0) / list.length, list.reduce((a, [, y]) => a + y, 0) / list.length];
  const [cx, cy] = centre(cells);
  const candidates = pieces.filter((piece) => !piece.added && piece.shapeId === shapeId)
    .map((piece) => { const [px, py] = centre(piece.cells); return { piece, distance: Math.hypot(px - cx, py - cy) }; })
    .sort((a, b) => a.distance - b.distance);
  const name = SHAPE_MAP[shapeId].name;
  if (!candidates.length) {
    setTip(`已加入「${name}」，但这一块放不进棋盘，看右边的调整方案`, 'bad');
  } else {
    const { piece, distance } = candidates[0];
    $('#board').querySelectorAll(`[data-piece="${piece.key}"]`).forEach((tile) => tile.classList.add('fresh'));
    setTip(distance < 0.01 ? `已加入「${name}」，就放在你画的位置` : overlapped ? `已加入「${name}」，和原有积木重叠，已整体重新摆放（闪烁的是新加的那块）` : `已加入「${name}」，为了放得最多已重新摆放（闪烁的是新加的那块）`, 'ok');
  }
  tipHeld = true;
  tipTimer = setTimeout(() => { tipHeld = false; if (drawn.size === 0 && !committing) setTip(TIP_IDLE); }, 5000);
}

function setupDraw() {
  const board = $('#board');
  board.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || committing) return;
    const index = boardIndex(event);
    if (index === null) return;
    event.preventDefault();
    tipHeld = false;
    try { board.setPointerCapture(event.pointerId); } catch { /* Not critical. */ }
    // On a placed piece with nothing drawn yet, wait: a plain click removes it, a drag draws over it.
    const waiting = drawn.size === 0 && shownPieces.has(index);
    stroke = { start: index, waiting, mode: drawn.has(index) ? 'erase' : 'paint' };
    if (!waiting) paint(index);
  });
  board.addEventListener('pointermove', (event) => {
    if (!stroke) return;
    const index = boardIndex(event);
    if (index === null) return;
    if (stroke.waiting) {
      if (index === stroke.start) return;
      stroke.waiting = false;
      paint(stroke.start);
    }
    if (stroke.mode === 'paint' ? !drawn.has(index) : drawn.has(index)) paint(index);
  });
  const end = (event) => {
    if (!stroke) return;
    const { waiting, start } = stroke;
    stroke = null;
    if (waiting) {
      if (event.type === 'pointerup') {
        const piece = shownPieces.get(start);
        setCount(piece.shapeId, (counts[piece.shapeId] || 0) + (piece.added ? 1 : -1));
        flashCard(piece.shapeId);
      }
      return;
    }
    renderInk();
    finishDrawing();
  };
  board.addEventListener('pointerup', end);
  board.addEventListener('pointercancel', end);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drawn.size > 0 && !committing) { stroke = null; clearDrawing(); }
  });
  setTip(TIP_IDLE);
}

/* ---------- solving ---------- */

function stopWorker() {
  runId += 1;
  worker?.terminate();
  worker = null;
  clearTimeout(busyTimer);
  clearInterval(busyTick);
  $('#stage').classList.remove('busy');
}

function solve(deep = false) {
  stopWorker();
  const run = runId;
  const started = performance.now();
  busyTimer = setTimeout(() => {
    $('#stage').classList.add('busy');
    const chip = $('#status-chip');
    chip.className = 'chip-status working';
    chip.textContent = '搜索中';
    busyTick = setInterval(() => { chip.textContent = `搜索中 · ${Math.floor((performance.now() - started) / 1000)} 秒`; }, 500);
  }, 220);
  try {
    worker = new Worker(new URL('./worker.js?v=5', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (run !== runId) return;
      stopWorker();
      if (data.error) { showError(data.error); return; }
      result = data.result;
      buildScenarios();
      renderResult();
    };
    worker.onerror = () => {
      if (run !== runId) return;
      stopWorker();
      showError('求解器加载失败，请刷新页面后重试。');
    };
    worker.postMessage({ counts: { ...counts }, options: { timeLimitMs: deep ? 60000 : 15000, maxAlternatives: 60 } });
  } catch (error) {
    stopWorker();
    showError(error.message);
  }
}

function showError(message) {
  pendingFresh = null;
  clearDrawing();
  $('#status-chip').className = 'chip-status warn';
  $('#status-chip').textContent = '需要重试';
  $('#headline').textContent = '出了点问题';
  $('#subline').textContent = message;
}

function buildScenarios() {
  active = 0;
  shown = PAGE;
  if (result.complete && result.fill?.options.length) {
    scenarioKind = 'fill';
    scenarios = result.fill.options.map((option) => ({ placements: option.placements, added: option.added }));
  } else if (result.complete && result.fill?.swaps?.length) {
    scenarioKind = 'swap';
    scenarios = result.fill.swaps.map((swap) => ({ placements: swap.placements, removed: swap.removed, added: swap.added }));
  } else if (result.complete && result.maxPlaced < result.total && result.alternatives.length) {
    scenarioKind = 'remove';
    scenarios = result.alternatives.map((alternative) => ({
      placements: alternative.fill ? alternative.fill.options[0].placements : alternative.placements,
      removed: alternative.removed,
      swaps: alternative.fill ? alternative.fill.options.map((option) => option.added) : [],
    }));
  } else {
    scenarioKind = null;
    scenarios = [];
  }
}

function currentPlacements() {
  return scenarios.length ? scenarios[active].placements : result?.placements || [];
}

/* ---------- rendering ---------- */

function renderBoard(animate = true) {
  const placements = currentPlacements();
  const pieces = decorate(placements);
  const board = $('#board');
  board.classList.remove('animate');
  board.innerHTML = boardMarkup(placements);
  if (animate && !reducedMotion.matches) {
    void board.offsetWidth;
    board.classList.add('animate');
    // Never leave pieces invisible if the browser pauses animations (background tab).
    clearTimeout(animateTimer);
    animateTimer = setTimeout(() => board.classList.remove('animate'), 1400);
  }
  shownPieces = new Map();
  pieces.forEach((piece) => piece.cells.forEach(([x, y]) => shownPieces.set(y * 6 + x, piece)));
  revealFresh(pieces);
  renderInk();
  const own = pieces.filter((piece) => !piece.added);
  const added = pieces.filter((piece) => piece.added);
  board.setAttribute('aria-label', `6 乘 6 棋盘，已放 ${own.length} 块${added.length ? `，建议补 ${added.length} 块` : ''}。${pieces.map((piece) => `${piece.added ? '建议补' : piece.label} ${SHAPE_MAP[piece.shapeId].name}`).join('，')}`);
  $('#legend').innerHTML = pieces.map((piece) => `<button type="button" class="legend-item${piece.added ? ' ghost' : ''}" data-piece="${piece.key}" data-shape="${piece.shapeId}" data-family="${SHAPE_MAP[piece.shapeId].family}" title="${piece.added ? '点击加入' : '点击拿掉'} ${SHAPE_MAP[piece.shapeId].name}"><b>${piece.label}</b>${SHAPE_MAP[piece.shapeId].name}<span class="legend-x" aria-hidden="true">${piece.added ? '+' : '×'}</span></button>`).join('');
  const usedCells = own.length * 4;
  const time = result.elapsedMs < 1000 ? `${result.elapsedMs} 毫秒` : `${(result.elapsedMs / 1000).toFixed(1)} 秒`;
  $('#meta').textContent = result.total === 0 ? '' : `已占 ${usedCells} / 36 格 · 利用率 ${Math.round(usedCells / 36 * 100)}% · 搜索 ${result.nodes.toLocaleString()} 个状态，用时 ${time}`;
}

function optionChips(map, sign) {
  return Object.entries(map).map(([id, n]) => `<span class="piece-chip ${sign === '+' ? 'plus' : 'minus'}">${thumb(SHAPE_MAP[id], 'tiny')}<span>${sign} ${SHAPE_MAP[id].name}${n > 1 ? ` × ${n}` : ''}</span></span>`).join('');
}

function renderOptions() {
  const box = $('#options');
  box.hidden = scenarios.length === 0;
  $('#options-empty').hidden = scenarios.length > 0;
  if (!scenarios.length) {
    $('#options-empty-text').textContent = result.total === 0 ? '选好积木后，这里会列出可以补上或需要拿掉的积木。'
      : !result.complete ? '搜索还没完成，暂时给不出方案。'
        : result.maxPlaced === 9 ? '已经铺满，不需要再调整。' : '这组积木没有可以补上的方案。';
    return;
  }
  const kind = scenarioKind;
  const fill = result.fill;
  $('#options-title').textContent = kind === 'fill' ? (fill.exact ? '补上这些，刚好铺满' : '最多还能补上这些')
    : kind === 'swap' ? '换一块就能铺满'
      : (result.minRemoved === 1 ? '拿掉一块就能放下' : `拿掉 ${result.minRemoved} 块就能放下`);
  const listedAll = kind === 'fill' ? fill.exhaustive && fill.found <= scenarios.length : kind === 'remove' && result.alternativesComplete;
  $('#options-count').textContent = `${listedAll ? '共' : '列出'} ${scenarios.length} 种`;
  $('#options-note').textContent = kind === 'fill'
    ? (listedAll ? '点小棋盘查看摆法，满意就一键加入清单。' : '补法很多，这里挑了用到形状最少的几种。点小棋盘查看摆法。')
    : kind === 'swap' ? '现有积木怎么摆都留不出一块完整的空位。拿掉标 − 的那块，补上虚线的积木，就能铺满。'
      : (scenarios.some((scenario) => scenario.swaps.length) ? '每种拿法都能放下剩下的积木；虚线是换上后可以铺满的那一块。' : '每种拿法都能放下剩下的积木，相同形状不区分是哪一块。');
  const button = kind === 'fill' ? '加入清单' : kind === 'swap' ? '照这样换' : '就拿掉它';
  $('#options-grid').innerHTML = scenarios.slice(0, shown).map((scenario, index) => {
    const body = kind === 'remove'
      ? `<div class="option-pieces">${optionChips(scenario.removed, '−')}${scenario.swaps.length ? `<span class="swap-note">换成 ${scenario.swaps.map((swap) => piecesText(swap).replace(' × 1', '')).join(' 或 ')} 可铺满</span>` : ''}</div>`
      : `<div class="option-pieces">${scenario.removed ? optionChips(scenario.removed, '−') : ''}${optionChips(scenario.added, '+')}</div>`;
    const label = kind === 'remove' ? `拿法 ${index + 1}：拿掉 ${piecesText(scenario.removed)}`
      : `方案 ${index + 1}：${scenario.removed ? `拿掉 ${piecesText(scenario.removed)}，` : ''}加 ${piecesText(scenario.added)}`;
    return `<article class="option${index === active ? ' active' : ''}" data-option="${index}" style="--i:${index}"><button class="option-view" type="button" data-view="${index}" aria-pressed="${index === active}" aria-label="${label}"><span class="board mini">${boardMarkup(scenario.placements, false)}</span></button>${body}<button class="apply" type="button" data-apply="${index}">${button}</button></article>`;
  }).join('');
  const rest = scenarios.length - shown;
  $('#more-options').hidden = rest <= 0;
  $('#more-options').textContent = `显示更多（还有 ${Math.max(0, rest)} 种）`;
}

function renderResult() {
  const { maxPlaced, total: all, complete, fill } = result;
  const allFit = maxPlaced === all;
  const free = 36 - maxPlaced * 4;
  let headline;
  let subline;
  if (all === 0) {
    headline = '棋盘还是空的';
    subline = '在左边点几块积木，或者直接在棋盘上拖动画一块。';
  } else if (!complete) {
    headline = `目前能放下 ${maxPlaced} 块`;
    subline = '搜索到了时间上限，还不能确定这是不是最多。可以点「再搜 60 秒」。';
  } else if (!allFit) {
    headline = `最多放下 ${maxPlaced} 块`;
    subline = `${all} 块没法同时放进去，至少要拿掉 ${result.minRemoved} 块。`;
  } else if (free === 0) {
    headline = '刚好铺满';
    subline = `${all} 块积木，36 格一格不剩。`;
  } else if (fill?.options.length && fill.exact) {
    headline = `再加 ${fill.extra} 块就能铺满`;
    subline = `${all} 块全部放下，还空 ${free} 格。虚线是建议补上的积木。`;
  } else if (fill?.options.length) {
    headline = `最多还能再加 ${fill.extra} 块`;
    subline = `${all} 块全部放下。${fill.proven ? '这组积木怎么摆都铺不满' : '暂时没找到能铺满的补法'}，补上虚线的积木后还剩 ${free - fill.extra * 4} 格。`;
  } else if (fill?.swaps?.length) {
    headline = '换一块就能铺满';
    subline = `${all} 块全部放下，但剩下的 ${free} 格怎么摆都凑不成一块积木。右边列出该拿掉哪块，虚线是换上去的积木。`;
  } else {
    headline = '全部放下，但加不进新的了';
    subline = `还空 ${free} 格，可无论怎么摆，它们都凑不成一块完整的积木。`;
  }
  $('#score').textContent = maxPlaced;
  $('#score-total').textContent = all;
  $('#headline').textContent = headline;
  $('#subline').textContent = subline;
  const chip = $('#status-chip');
  chip.className = `chip-status ${all === 0 ? '' : complete ? 'ok' : 'warn'}`;
  chip.textContent = all === 0 ? '等待选择' : complete ? '已证明最优' : '未证明最优';
  $('#deepen').hidden = complete;
  $('#export-button').disabled = all === 0;
  const jump = $('#jump');
  jump.hidden = all === 0;
  jump.textContent = `${maxPlaced} / ${all} 块 · 看摆法 ↓`;
  renderBoard();
  renderOptions();
}

function selectScenario(index) {
  if (index === active || !scenarios[index]) return;
  active = index;
  renderBoard();
  document.querySelectorAll('.option').forEach((card) => {
    const on = Number(card.dataset.option) === active;
    card.classList.toggle('active', on);
    card.querySelector('.option-view').setAttribute('aria-pressed', on);
  });
}

function applyScenario(index) {
  const scenario = scenarios[index];
  if (!scenario) return;
  const changes = { ...Object.fromEntries(Object.entries(scenario.removed || {}).map(([id, n]) => [id, -n])) };
  if (scenarioKind !== 'remove') for (const [id, n] of Object.entries(scenario.added || {})) changes[id] = (changes[id] || 0) + n;
  for (const [id, n] of Object.entries(changes)) {
    const next = Math.max(0, Math.min(MAX_EACH, (counts[id] || 0) + n));
    if (next === 0) delete counts[id]; else counts[id] = next;
    flashCard(id);
  }
  inventoryChanged();
}

function focusPiece(key) {
  document.querySelectorAll('#board [data-piece], #legend [data-piece]').forEach((node) => {
    node.classList.toggle('dim', key !== null && node.dataset.piece !== key);
  });
}

/* ---------- export ---------- */

function exportBoard() {
  if (!result || result.total === 0) return;
  const pieces = decorate(currentPlacements());
  const own = pieces.filter((piece) => !piece.added);
  const added = pieces.filter((piece) => piece.added);
  const cellAt = new Map();
  pieces.forEach((piece) => piece.cells.forEach(([x, y]) => cellAt.set(y * 6 + x, piece)));
  const rects = Array.from({ length: 36 }, (_, index) => {
    const piece = cellAt.get(index);
    const x = 36 + index % 6 * 65;
    const y = 112 + Math.floor(index / 6) * 65;
    if (!piece) return `<rect x="${x}" y="${y}" width="60" height="60" rx="10" fill="#ecebe6"/>`;
    const family = SHAPE_MAP[piece.shapeId].family;
    const color = FAMILY_COLORS[family];
    return piece.added
      ? `<rect x="${x + 1}" y="${y + 1}" width="58" height="58" rx="10" fill="${color}" fill-opacity=".14" stroke="${color}" stroke-width="2" stroke-dasharray="6 5"/><text x="${x + 30}" y="${y + 38}" text-anchor="middle" fill="${color}" font-size="22" font-weight="700">+</text>`
      : `<rect x="${x}" y="${y}" width="60" height="60" rx="10" fill="${color}"/><text x="${x + 30}" y="${y + 38}" text-anchor="middle" fill="${FAMILY_INK[family]}" font-size="22" font-weight="700">${piece.label}</text>`;
  }).join('');
  const legend = pieces.map((piece, index) => {
    const x = 36 + index % 3 * 132;
    const y = 536 + Math.floor(index / 3) * 28;
    const family = SHAPE_MAP[piece.shapeId].family;
    return `<rect x="${x}" y="${y - 14}" width="19" height="19" rx="5" fill="${FAMILY_COLORS[family]}" ${piece.added ? 'fill-opacity=".2"' : ''}/><text x="${x + 9.5}" y="${y}" text-anchor="middle" font-size="12" font-weight="700" fill="${piece.added ? FAMILY_COLORS[family] : FAMILY_INK[family]}">${piece.label}</text><text x="${x + 26}" y="${y}" font-size="12" fill="#55555c">${SHAPE_MAP[piece.shapeId].name}</text>`;
  }).join('');
  const context = scenarioKind === 'fill' ? `建议补上：${piecesText(scenarios[active].added)}`
    : scenarioKind === 'swap' ? `拿掉：${piecesText(scenarios[active].removed)}　补上：${piecesText(scenarios[active].added)}`
      : scenarioKind === 'remove' ? `拿掉：${piecesText(scenarios[active].removed)}` : '固定方向 · 只平移 · 不旋转 · 不重叠';
  const height = 560 + Math.ceil(pieces.length / 3) * 28;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="460" height="${height}" viewBox="0 0 460 ${height}"><rect width="460" height="${height}" fill="#f5f4f0"/><g font-family="-apple-system, 'PingFang SC', 'Noto Sans SC', Arial, sans-serif"><text x="36" y="46" font-size="20" font-weight="700" fill="#18181b">积木实验室 · 6 × 6</text><text x="36" y="72" font-size="14" fill="#18181b">放下 ${own.length} / ${result.total} 块${added.length ? ` · 建议再补 ${added.length} 块` : ''}${result.complete ? '' : ' · 未证明最优'}</text><text x="36" y="92" font-size="11" fill="#77777f">${context}</text>${rects}${legend}</g></svg>`;
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `积木摆法-${own.length}块${scenarios.length ? `-方案${active + 1}` : ''}.svg`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- events ---------- */

$('#inventory').addEventListener('click', (event) => {
  const step = event.target.closest('[data-step]');
  const add = event.target.closest('[data-add]');
  if (step) setCount(step.dataset.id, (counts[step.dataset.id] || 0) + Number(step.dataset.step));
  else if (add) setCount(add.dataset.add, (counts[add.dataset.add] || 0) + 1);
});
$('#load-example').addEventListener('click', () => { counts = { ...DEFAULT }; inventoryChanged(); });
$('#clear-all').addEventListener('click', () => { counts = {}; inventoryChanged(); });
$('#deepen').addEventListener('click', () => solve(true));
$('#export-button').addEventListener('click', exportBoard);
$('#options-grid').addEventListener('click', (event) => {
  const apply = event.target.closest('[data-apply]');
  if (apply) { applyScenario(Number(apply.dataset.apply)); return; }
  const card = event.target.closest('[data-option]');
  if (card) selectScenario(Number(card.dataset.option));
});
$('#more-options').addEventListener('click', () => { shown += PAGE; renderOptions(); });
for (const id of ['#board', '#legend']) {
  $(id).addEventListener('pointerover', (event) => {
    const node = event.target.closest('[data-piece]');
    focusPiece(node && drawn.size === 0 ? node.dataset.piece : null);
  });
  $(id).addEventListener('pointerleave', () => focusPiece(null));
}
// A legend chip removes its piece; a suggested one is added. (On the board itself, setupDraw handles clicks.)
$('#legend').addEventListener('click', (event) => {
  const node = event.target.closest('[data-piece][data-shape]');
  if (!node) return;
  const shape = node.dataset.shape;
  setCount(shape, (counts[shape] || 0) + (node.classList.contains('ghost') ? 1 : -1));
  flashCard(shape);
});
$('#jump').addEventListener('click', () => $('#stage').scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'start' }));
$('#help-button').addEventListener('click', () => $('#help-dialog').showModal());
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
$('#help-dialog').addEventListener('click', (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); });

restoreInventory();
renderInventory();
setupDraw();
$('#board').innerHTML = boardMarkup([]);
solve();
