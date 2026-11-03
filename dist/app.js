import { SHAPES } from './solver.js';

const $ = (selector) => document.querySelector(selector);
const LEGACY_DEFAULT = { i_h: 2, z_h: 1, s_h: 1, z_v: 1, l_left: 1, t_right: 1, l_right: 1 };
const DEFAULT = { ...LEGACY_DEFAULT, o_square: 1 };
const SHAPE_MAP = Object.fromEntries(SHAPES.map((shape) => [shape.id, shape]));
const SHAPE_GROUPS = [
  { family: 'I', name: '直条' },
  { family: 'O', name: '正方形' },
  { family: 'Z', name: 'Z 型' },
  { family: 'T', name: 'T 型' },
  { family: 'L', name: 'L 型' },
];
const BASE_COLORS = { i_h: '#d9b94b', i_v: '#b6a146', z_h: '#df8a78', s_h: '#a39ac5', z_v: '#8daec6', s_v: '#7794c3', l_left: '#8ab99d', l_right: '#d4a77d', l_left_up: '#9bc49a', l_right_up: '#c4a4bf', l_h_down: '#92b6aa', l_h_right_down: '#d1b289', l_h_up: '#9fb989', l_h_right_up: '#c398b4', t_down: '#9db4b8', t_up: '#80aaa7', t_left: '#97b4c8', t_right: '#a6bc81', o_square: '#c99a63' };
let counts = { ...DEFAULT };
let result = null;
let solvedCounts = {};
let resultCounts = {};
let activeScenario = -1;
let shownAlternatives = 8;
let worker = null;
let searchTimer = null;
let runId = 0;
let busy = false;

function mix(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const values = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v * (1 - amount) + 255 * amount));
  return `#${values.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function colors(id) {
  const base = BASE_COLORS[id] || '#98b19a';
  return { fill: mix(base, 0.41), stroke: mix(base, 0.22), ink: '#485747' };
}

function shapeSvg(shape, size = 8) {
  const width = Math.max(...shape.cells.map(([x]) => x)) + 1;
  const height = Math.max(...shape.cells.map(([, y]) => y)) + 1;
  const c = colors(shape.id);
  return `<svg viewBox="0 0 ${width * size} ${height * size}" width="${width * size}" height="${height * size}" aria-hidden="true">${shape.cells.map(([x, y]) => `<rect x="${x * size + 0.6}" y="${y * size + 0.6}" width="${size - 1.2}" height="${size - 1.2}" rx="1.5" fill="${c.fill}" stroke="${c.stroke}" stroke-width=".5"/>`).join('')}</svg>`;
}

function inventoryTotal(source = counts) {
  return Object.values(source).reduce((a, b) => a + b, 0);
}

function saveInventory() {
  try { localStorage.setItem('block-lab-inventory-v1', JSON.stringify({ counts })); } catch { /* Storage may be unavailable in private contexts. */ }
}

function restoreInventory() {
  try {
    const stored = JSON.parse(localStorage.getItem('block-lab-inventory-v1'));
    if (!stored || !stored.counts || typeof stored.counts !== 'object' || Array.isArray(stored.counts)) return;
    const clean = {};
    for (const shape of SHAPES) {
      const value = stored.counts[shape.id];
      if (Number.isInteger(value) && value >= 0 && value <= 99) clean[shape.id] = value;
    }
    // Update only the old example; preserve every custom saved inventory.
    if (!Object.hasOwn(stored.counts, 'o_square')
      && SHAPES.every((shape) => (clean[shape.id] || 0) === (LEGACY_DEFAULT[shape.id] || 0))) {
      clean.o_square = 1;
    }
    counts = clean;
  } catch { /* Fall back to the requested example. */ }
}

function renderInventory() {
  $('#inventory-list').innerHTML = SHAPE_GROUPS.map(({ family, name }) => {
    const variants = SHAPES.filter((shape) => shape.family === family);
    return `<section class="shape-group" data-family="${family}" aria-labelledby="shape-group-${family}-title"><div class="shape-group-heading"><h3 id="shape-group-${family}-title"><span class="family-name">${name}</span><span class="variant-count">${variants.length} 种方向</span></h3><span class="family-count" data-family-count="${family}"></span></div><div class="orientation-grid">${variants.map((shape) => {
      const id = shape.id;
      const n = counts[id] || 0;
      return `<div class="inventory-row orientation-card ${n > 0 ? 'is-selected' : ''}" data-shape="${id}"><div class="shape-thumbnail">${shapeSvg(shape, 14)}</div><div class="shape-label"><strong>${shape.name}</strong></div><div class="stepper"><button data-adjust="-1" data-id="${id}" aria-label="减少${shape.name}" ${n === 0 ? 'disabled' : ''}>−</button><input type="number" min="0" max="99" step="1" inputmode="numeric" value="${n}" data-count="${id}" aria-label="${shape.name}数量"><button data-adjust="1" data-id="${id}" aria-label="增加${shape.name}" ${n >= 99 ? 'disabled' : ''}>+</button></div></div>`;
    }).join('')}</div></section>`;
  }).join('');
  renderInventorySummary();
}

function renderInventorySummary() {
  document.querySelectorAll('[data-family-count]').forEach((badge) => {
    const selected = SHAPES.filter((shape) => shape.family === badge.dataset.familyCount)
      .reduce((sum, shape) => sum + (counts[shape.id] || 0), 0);
    badge.textContent = `已选 ${selected} 块`;
    badge.classList.toggle('has-pieces', selected > 0);
  });
  document.querySelectorAll('.orientation-card').forEach((card) => {
    const n = counts[card.dataset.shape] || 0;
    card.classList.toggle('is-selected', n > 0);
    const input = card.querySelector('[data-count]');
    if (document.activeElement !== input) input.value = n;
    card.querySelector('[data-adjust="-1"]').disabled = n === 0;
    card.querySelector('[data-adjust="1"]').disabled = n >= 99;
  });
  const total = inventoryTotal();
  $('#inventory-count').textContent = `${total} 块`;
  $('#area-count').textContent = total * 4;
  $('#area-meter-fill').style.width = `${Math.min(100, total * 4 / 36 * 100)}%`;
  $('#area-meter-fill').style.background = total > 9 ? '#d7aa78' : '';
  $('#area-note').textContent = total > 9 ? `仅按面积就至少需要移除 ${total - 9} 块，实际还要看形状。` : '面积放得下，不一定形状也刚好。';
  $('#area-note').classList.toggle('over', total > 9);
}

function inventoryDirty() {
  return SHAPES.some((shape) => (counts[shape.id] || 0) !== (resultCounts[shape.id] || 0));
}

function inventoryChanged(renderRows = true) {
  if (busy) stopSearch(true);
  saveInventory();
  if (renderRows) renderInventory();
  else renderInventorySummary();
  $('#result-stale').hidden = !result || !inventoryDirty();
  if (result && inventoryDirty()) {
    $('#proof-badge').textContent = '结果待更新';
    $('#proof-badge').className = 'proof-badge pending';
  }
  $('#solve-label').textContent = '寻找最优摆法';
}

function decoratedPlacements(placements) {
  return [...placements].sort((a, b) => SHAPES.findIndex((shape) => shape.id === a.shapeId) - SHAPES.findIndex((shape) => shape.id === b.shapeId) || a.y - b.y || a.x - b.x).map((placement, index) => ({ ...placement, label: String.fromCharCode(65 + index), color: colors(placement.shapeId) }));
}

function boardMarkup(placements, withAxes = true) {
  const decorated = decoratedPlacements(placements);
  const occupied = new Map();
  decorated.forEach((piece) => piece.cells.forEach(([x, y]) => occupied.set(y * 6 + x, piece)));
  let cells = '';
  for (let y = 0; y < 6; y += 1) {
    for (let x = 0; x < 6; x += 1) {
      const piece = occupied.get(y * 6 + x);
      if (!piece) { cells += `<div class="board-cell empty" title="第${y + 1}行，第${x + 1}列：空格"></div>`; continue; }
      const label = piece.label;
      cells += `<div class="board-cell filled" data-piece="${piece.label}" style="--tile:${piece.color.fill};--tile-stroke:${piece.color.stroke};--tile-ink:${piece.color.ink}" title="${piece.label} · ${SHAPE_MAP[piece.shapeId].name} · 第${y + 1}行，第${x + 1}列">${label}</div>`;
    }
  }
  return `${withAxes ? `<div class="axis-x" aria-hidden="true">${[1, 2, 3, 4, 5, 6].map((n) => `<span>${n}</span>`).join('')}</div><div class="axis-y" aria-hidden="true">${[1, 2, 3, 4, 5, 6].map((n) => `<span>${n}</span>`).join('')}</div>` : ''}<div class="board-cells" aria-hidden="true">${cells}</div>`;
}

function currentPlacements() {
  return activeScenario >= 0 ? result.alternatives[activeScenario].placements : result?.placements || [];
}

function displayBoard() {
  const placements = currentPlacements();
  $('#board').innerHTML = boardMarkup(placements);
  $('#board').setAttribute('aria-label', `6乘6棋盘，摆放${placements.length}块，留空${36 - placements.length * 4}格。${decoratedPlacements(placements).map((p) => `${p.label}是${SHAPE_MAP[p.shapeId].name}`).join('，')}`);
  $('#empty-count').textContent = `${36 - placements.length * 4} 格留白`;
  $('#board-caption').textContent = activeScenario >= 0 ? `移除方案 ${String(activeScenario + 1).padStart(2, '0')} 的摆法` : result?.complete ? '最优摆放方案' : result ? '当前找到的摆法' : '等待放入积木';
  $('#piece-legend').innerHTML = decoratedPlacements(placements).map((piece) => `<span class="legend-item" data-highlight="${piece.label}"><i class="legend-swatch" style="--tile:${piece.color.fill};--tile-ink:${piece.color.ink}">${piece.label}</i>${SHAPE_MAP[piece.shapeId].name}</span>`).join('');
}

function removedText(removed) {
  return Object.entries(removed).map(([id, count]) => `${SHAPE_MAP[id].name} × ${count}`).join('、');
}

function renderAlternatives() {
  const show = result?.complete && result.maxPlaced < result.total;
  $('#alternatives-section').hidden = !show;
  if (!show) return;
  const min = result.minRemoved;
  $('#alternatives-title').textContent = min === 1 ? '少一块，也有新解法。' : `腾出 ${min} 块的位置，剩下的就能放好。`;
  $('#alternatives-description').textContent = min === 1 ? '以下每一种减法都能放下剩余积木，点击小棋盘查看大图。相同形状不区分具体哪一块。' : `已证明只减 ${min - 1} 块仍放不下。以下是最少移除组合，每种组合展示一个摆法。`;
  $('#alternatives-count').textContent = `${result.alternativesComplete ? '共' : '已找到'} ${result.alternatives.length} 种减法`;
  $('#alternatives-grid').innerHTML = result.alternatives.slice(0, shownAlternatives).map((alternative, index) => `<button class="alternative-card ${activeScenario === index ? 'selected' : ''}" data-scenario="${index}" aria-label="查看方案${index + 1}，移除${removedText(alternative.removed)}" aria-pressed="${activeScenario === index}"><div class="alternative-top"><span>方案 ${String(index + 1).padStart(2, '0')}</span><span class="selected-label">正在查看 ↗</span></div><div class="alternative-mini">${boardMarkup(alternative.placements, false)}</div><div class="alternative-removed">减去 ${Object.entries(alternative.removed).map(([id, n]) => `<span class="removed-shape">${shapeSvg(SHAPE_MAP[id], 6)}${SHAPE_MAP[id].name} × ${n}</span>`).join('')}</div><p class="alternative-note">剩余 ${result.maxPlaced} 块全部放下 · 留空 ${36 - result.maxPlaced * 4} 格</p></button>`).join('');
  $('#more-alternatives').hidden = shownAlternatives >= result.alternatives.length;
  $('#more-alternatives').textContent = `显示更多方案（还有 ${Math.max(0, result.alternatives.length - shownAlternatives)} 种）`;
  $('#alternatives-limit').hidden = result.alternativesComplete;
  $('#alternatives-limit').textContent = '最大摆放数量已经证明。移除组合较多或枚举达到时间上限，目前只展示已找到的组合，尚未列全。';
}

function renderResult() {
  const { maxPlaced, total, complete, elapsedMs, nodes } = result;
  const allFit = maxPlaced === total;
  $('#placed-count').textContent = maxPlaced;
  $('#total-count').textContent = total;
  $('#coverage-value').textContent = `${(maxPlaced * 4 / 36 * 100).toFixed(1).replace('.0', '')}%`;
  $('#coverage-fill').style.width = `${maxPlaced * 4 / 36 * 100}%`;
  $('#result-title').textContent = total === 0 ? '空棋盘，等你来搭' : !complete ? '已找到一个可行摆法' : allFit ? '刚刚好，全都放下了' : `最多放下 ${maxPlaced} 块积木`;
  $('#result-description').textContent = total === 0 ? '设置积木数量，再来找找它们的位置。' : !complete ? `当前可放 ${maxPlaced} 块，搜索达到时间上限，尚不能确定最大值。` : allFit ? `${total} 块积木保持固定方向，全部进入棋盘，还留有 ${36 - maxPlaced * 4} 格空间。` : `全部 ${total} 块无法同时放下，最少需要移除 ${result.minRemoved} 块。下方可以查看具体减法。`;
  $('#proof-badge').textContent = complete ? total === 0 ? '等待选择' : '✓ 已证明最优' : '尚未证明最优';
  $('#proof-badge').className = `proof-badge ${complete ? 'verified' : 'pending'}`;
  $('#solver-detail').textContent = `${complete ? '精确搜索' : '搜索未完成'} · ${nodes.toLocaleString()} 个状态 · ${elapsedMs < 1000 ? `${elapsedMs} ms` : `${(elapsedMs / 1000).toFixed(2)} s`}`;
  const message = total === 0 ? '在左侧设置数量后，点击寻找最优摆法。' : !complete ? `搜索达到时间上限。目前至少能放 ${maxPlaced} 块；再次求解将增加搜索时间。` : allFit ? `所有积木都找到了位置。${total <= 9 ? '只平移，不旋转，也没有重叠。' : ''}` : `已经穷尽更多块数的可能性，${maxPlaced} 块就是上限。${result.minRemoved === 1 ? '往下看看，拿掉哪一块就能全部放下。' : `少于 ${result.minRemoved} 块的移除方案都无法放下剩余积木。`}`;
  $('#result-message').classList.toggle('warning', !complete || !allFit);
  $('#result-message').innerHTML = `<span class="message-icon">${complete && allFit ? '✓' : '↗'}</span><span>${message}</span>`;
  $('#export-button').disabled = total === 0;
  displayBoard();
  renderAlternatives();
}

function stopSearch(cancelled = false) {
  runId += 1;
  worker?.terminate();
  worker = null;
  clearInterval(searchTimer);
  busy = false;
  $('.result-panel').classList.remove('searching');
  $('#solve-label').textContent = '寻找最优摆法';
  $('#proof-badge').classList.remove('busy');
  if (cancelled) {
    if (result) renderResult();
    $('#result-stale').hidden = !result || !inventoryDirty();
    $('#proof-badge').textContent = result && inventoryDirty() ? '结果待更新' : '搜索已取消';
    $('#proof-badge').className = 'proof-badge pending';
    $('#result-message').classList.add('warning');
    $('#result-message').textContent = result ? '本次搜索已取消，当前显示上次的摆法。点击「寻找最优摆法」可以重新计算。' : '本次搜索已取消，点击「寻找最优摆法」可以重新计算。';
  }
}

function solve(revealResult = false) {
  if (busy) { stopSearch(true); return; }
  const previousIncomplete = result && !result.complete && JSON.stringify(solvedCounts) === JSON.stringify(counts);
  solvedCounts = { ...counts };
  const timeLimitMs = previousIncomplete ? 60000 : 15000;
  busy = true;
  const thisRun = ++runId;
  const started = performance.now();
  $('#result-stale').hidden = true;
  $('#solve-label').textContent = '正在求解 · 点击取消';
  $('#proof-badge').textContent = '正在搜索…';
  $('#proof-badge').className = 'proof-badge busy';
  $('.result-panel').classList.add('searching');
  $('#result-message').classList.remove('warning');
  $('#result-message').innerHTML = '<span class="message-icon">✧</span><span>正在寻找摆法，并检查是否还能放入更多积木…</span>';
  searchTimer = setInterval(() => {
    $('#proof-badge').textContent = `搜索中 · ${Math.floor((performance.now() - started) / 1000)} s`;
  }, 500);
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (thisRun !== runId) return;
      if (data.error) { handleError(data.error); return; }
      const next = data.result;
      stopSearch();
      result = next;
      resultCounts = { ...solvedCounts };
      activeScenario = result.complete && result.alternatives.length ? 0 : -1;
      shownAlternatives = 8;
      renderResult();
      if (revealResult) {
        $('#result-panel').scrollIntoView({
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
          block: 'start',
        });
      }
    };
    worker.onerror = () => handleError('求解器加载失败，请刷新页面后重试。');
    worker.postMessage({ counts: solvedCounts, options: { timeLimitMs, maxAlternatives: 60 } });
  } catch (error) { handleError(error.message); }
}

function handleError(message) {
  stopSearch();
  $('#proof-badge').textContent = '需要重试';
  $('#proof-badge').className = 'proof-badge pending';
  $('#result-message').classList.add('warning');
  $('#result-message').textContent = message;
  $('#result-stale').hidden = !result;
}

function exportBoard() {
  if (!result) return;
  const placements = decoratedPlacements(currentPlacements());
  const header = result.complete ? `最多放下 ${result.maxPlaced} / ${result.total} 块` : `当前可放 ${result.maxPlaced} / ${result.total} 块 · 尚未证明最优`;
  const context = activeScenario >= 0 ? `移除：${removedText(result.alternatives[activeScenario].removed)}` : '固定方向 · 只平移 · 不旋转 · 不重叠';
  const descriptionLines = context.length > 42 ? context.match(/.{1,42}/g) : [context];
  const boardY = 120 + Math.max(0, descriptionLines.length - 2) * 13;
  const extraHeight = boardY - 120;
  const occupied = new Map();
  placements.forEach((p) => p.cells.forEach(([x, y]) => occupied.set(y * 6 + x, p)));
  const rects = Array.from({ length: 36 }, (_, index) => {
    const p = occupied.get(index);
    const x = 36 + index % 6 * 65;
    const y = boardY + Math.floor(index / 6) * 65;
    const label = p?.label || '';
    return `<rect x="${x}" y="${y}" width="60" height="60" rx="6" fill="${p ? p.color.fill : '#f4f7ee'}" stroke="${p ? p.color.stroke : '#e1e8d8'}"/>${label ? `<text x="${x + 30}" y="${y + 38}" text-anchor="middle" fill="${p.color.ink}" font-size="22" font-weight="600">${label}</text>` : ''}`;
  }).join('');
  const footerStart = 540 + extraHeight;
  const legend = placements.map((p, index) => {
    const x = 36 + index % 3 * 142;
    const y = footerStart + Math.floor(index / 3) * 30;
    return `<rect x="${x}" y="${y - 14}" width="19" height="19" rx="4" fill="${p.color.fill}"/><text x="${x + 9.5}" y="${y}" text-anchor="middle" font-size="12" fill="${p.color.ink}">${p.label}</text><text x="${x + 26}" y="${y}" font-size="11" fill="#63775d">${SHAPE_MAP[p.shapeId].name}</text>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="460" height="${690 + extraHeight}" viewBox="0 0 460 ${690 + extraHeight}"><rect width="460" height="${690 + extraHeight}" fill="#fafbf6"/><g font-family="Arial, 'Noto Sans SC', sans-serif"><text x="36" y="42" font-size="20" font-weight="600" fill="#164d42">积木实验室 · 6 × 6</text><text x="36" y="70" font-size="14" fill="#536d45">${header}</text>${descriptionLines.map((line, i) => `<text x="36" y="${91 + i * 13}" font-size="9" fill="#87967a">${line}</text>`).join('')}${rects}${legend}<text x="36" y="${663 + extraHeight}" font-size="9" fill="#98a58b">每个字母代表一块完整积木 · 空余 ${36 - placements.length * 4} 格</text></g></svg>`;
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = `积木摆法-${result.maxPlaced}块${activeScenario >= 0 ? `-方案${activeScenario + 1}` : ''}.svg`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#inventory-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-adjust]');
  if (!button) return;
  const id = button.dataset.id;
  counts[id] = Math.max(0, Math.min(99, (counts[id] || 0) + Number(button.dataset.adjust)));
  inventoryChanged(false);
});
$('#inventory-list').addEventListener('input', (event) => {
  const input = event.target.closest('[data-count]');
  if (!input) return;
  counts[input.dataset.count] = Math.max(0, Math.min(99, Math.trunc(Number(input.value) || 0)));
  inventoryChanged(false);
});
$('#inventory-list').addEventListener('change', (event) => {
  const input = event.target.closest('[data-count]');
  if (input) input.value = counts[input.dataset.count] || 0;
});
$('#solve-button').addEventListener('click', () => solve(true));
$('#reset-example').addEventListener('click', () => { counts = { ...DEFAULT }; inventoryChanged(); solve(); });
$('#clear-all').addEventListener('click', () => { counts = {}; inventoryChanged(); solve(); });
$('#help-button').addEventListener('click', () => $('#help-dialog').showModal());
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => document.getElementById(button.dataset.close).close()));
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } }));
$('#alternatives-grid').addEventListener('click', (event) => { const button = event.target.closest('[data-scenario]'); if (!button || busy) return; activeScenario = Number(button.dataset.scenario); displayBoard(); renderAlternatives(); });
$('#more-alternatives').addEventListener('click', () => { shownAlternatives += 8; renderAlternatives(); });
$('#export-button').addEventListener('click', exportBoard);
$('#piece-legend').addEventListener('pointerover', (event) => { const legend = event.target.closest('[data-highlight]'); if (!legend) return; $('#board').querySelectorAll('[data-piece]').forEach((cell) => cell.classList.toggle('dimmed', cell.dataset.piece !== legend.dataset.highlight)); });
$('#piece-legend').addEventListener('pointerleave', () => $('#board').querySelectorAll('.dimmed').forEach((cell) => cell.classList.remove('dimmed')));
restoreInventory();
renderInventory();
displayBoard();
solve();
