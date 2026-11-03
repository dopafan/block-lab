/** Fixed-orientation tetromino packing. Coordinates are [column, row]. */
export const SHAPES = [
  { id: 'i_h', name: '横直条', family: 'I', color: '#326e62', cells: [[0, 0], [1, 0], [2, 0], [3, 0]] },
  { id: 'i_v', name: '竖直条', family: 'I', color: '#438c7d', cells: [[0, 0], [0, 1], [0, 2], [0, 3]] },
  { id: 'z_h', name: '正 Z', family: 'Z', color: '#df9051', cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
  { id: 's_h', name: '反 Z', family: 'Z', color: '#c76c48', cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
  { id: 'z_v', name: '竖 Z', family: 'Z', color: '#be9650', cells: [[1, 0], [0, 1], [1, 1], [0, 2]] },
  { id: 's_v', name: '反竖 Z', family: 'Z', color: '#a77b36', cells: [[0, 0], [0, 1], [1, 1], [1, 2]] },
  { id: 'l_left', name: '左 L', family: 'L', color: '#7f83bb', cells: [[0, 0], [0, 1], [0, 2], [1, 2]] },
  { id: 'l_right', name: '右 L', family: 'L', color: '#a384b8', cells: [[1, 0], [1, 1], [0, 2], [1, 2]] },
  { id: 'l_left_up', name: '倒左 L', family: 'L', color: '#6974a9', cells: [[0, 0], [1, 0], [0, 1], [0, 2]] },
  { id: 'l_right_up', name: '倒右 L', family: 'L', color: '#8e69a3', cells: [[0, 0], [1, 0], [1, 1], [1, 2]] },
  { id: 'l_h_down', name: '横 L · 左下', family: 'L', color: '#687aa0', cells: [[0, 0], [1, 0], [2, 0], [0, 1]] },
  { id: 'l_h_right_down', name: '横 L · 右下', family: 'L', color: '#9073a7', cells: [[0, 0], [1, 0], [2, 0], [2, 1]] },
  { id: 'l_h_up', name: '横 L · 左上', family: 'L', color: '#6375b5', cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  { id: 'l_h_right_up', name: '横 L · 右上', family: 'L', color: '#ad81a5', cells: [[2, 0], [0, 1], [1, 1], [2, 1]] },
  { id: 't_down', name: '下 T', family: 'T', color: '#538ca0', cells: [[0, 0], [1, 0], [2, 0], [1, 1]] },
  { id: 't_up', name: '上 T', family: 'T', color: '#40758e', cells: [[1, 0], [0, 1], [1, 1], [2, 1]] },
  { id: 't_left', name: '左 T', family: 'T', color: '#579ea8', cells: [[1, 0], [0, 1], [1, 1], [1, 2]] },
  { id: 't_right', name: '右 T', family: 'T', color: '#3a8189', cells: [[0, 0], [0, 1], [1, 1], [0, 2]] },
  { id: 'o_square', name: '正方形', family: 'O', color: '#c99a63', cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
];

const BOARD_SIZE = 6;
const FULL = (1n << 36n) - 1n;
const BITS = Array.from({ length: 36 }, (_, index) => 1n << BigInt(index));
const FIRST_COLUMN = BITS.filter((_, index) => index % 6 === 0).reduce((a, b) => a | b, 0n);
const LAST_COLUMN = FIRST_COLUMN << 5n;
const RIGHT_ALLOWED = FULL ^ LAST_COLUMN;
const LEFT_ALLOWED = FULL ^ FIRST_COLUMN;
const PLACEMENTS = SHAPES.map((shape, shapeIndex) => {
  const width = Math.max(...shape.cells.map(([x]) => x)) + 1;
  const height = Math.max(...shape.cells.map(([, y]) => y)) + 1;
  const result = [];
  for (let y = 0; y <= BOARD_SIZE - height; y += 1) {
    for (let x = 0; x <= BOARD_SIZE - width; x += 1) {
      const cells = shape.cells.map(([dx, dy]) => [x + dx, y + dy]);
      const mask = cells.reduce((value, [cx, cy]) => value | BITS[cy * 6 + cx], 0n);
      result.push({ shapeId: shape.id, shapeIndex, cells, mask, x, y });
    }
  }
  return result;
});
const COVERING = BITS.map((bit) => PLACEMENTS.flat().filter((placement) => (placement.mask & bit) !== 0n));

function publicPlacement(placement) {
  return { shapeId: placement.shapeId, x: placement.x, y: placement.y, cells: placement.cells.map((cell) => [...cell]) };
}

function retainedCounts(placements) {
  const counts = Array(SHAPES.length).fill(0);
  for (const placement of placements) counts[placement.shapeIndex] += 1;
  return counts;
}

function componentCapacity(free, required) {
  let capacity = 0;
  while (free !== 0n) {
    let connected = free & -free;
    let previous = 0n;
    while (connected !== previous) {
      previous = connected;
      connected = (connected | (connected << 6n) | (connected >> 6n)
        | ((connected & RIGHT_ALLOWED) << 1n) | ((connected & LEFT_ALLOWED) >> 1n)) & free;
    }
    let size = 0;
    for (let bits = connected; bits !== 0n; bits &= bits - 1n) size += 1;
    capacity += Math.floor(size / 4);
    if (capacity >= required) return true;
    free ^= connected;
  }
  return false;
}

/**
 * All searches are exhaustive unless `complete` is false. Alternatives identify
 * removal multisets, not every translation of an otherwise identical layout.
 * `timeLimitMs` includes alternative enumeration; `maxAlternatives` bounds output.
 */
export function solveInventory(input = {}, options = {}) {
  const started = performance.now();
  const requestedTime = Number(options.timeLimitMs ?? 12000);
  const requestedAlternatives = Number(options.maxAlternatives ?? options.alternativeLimit ?? 60);
  if (!Number.isFinite(requestedTime) || !Number.isFinite(requestedAlternatives)) {
    throw new RangeError('Search limits must be finite numbers.');
  }
  const timeLimitMs = Math.max(1, requestedTime);
  const deadline = started + timeLimitMs;
  const maxAlternatives = Math.max(1, Math.floor(requestedAlternatives));
  const original = SHAPES.map((shape) => {
    const value = Number(input[shape.id] ?? 0);
    if (!Number.isSafeInteger(value) || value < 0 || value > 99) {
      throw new RangeError(`Invalid count for ${shape.id}: expected an integer from 0 to 99.`);
    }
    return value;
  });
  const total = original.reduce((a, b) => a + b, 0);
  const available = original.map((count) => Math.min(9, count));
  let nodes = 0;
  let timedOut = false;
  let best = [];
  let complete = false;
  let alternativesComplete = true;
  const alternatives = [];
  const alternativeSignatures = new Set();

  function outOfTime(force = false) {
    if ((force || (nodes & 1023) === 0) && performance.now() >= deadline) timedOut = true;
    return timedOut;
  }

  // A fast valid lower bound is returned even if a later proof times out.
  for (const reverse of [false, true]) {
    let occupied = 0n;
    const counts = [...available];
    const candidate = [];
    const order = reverse ? [...PLACEMENTS].reverse() : PLACEMENTS;
    for (const placements of order) {
      for (const placement of placements) {
        if (counts[placement.shapeIndex] > 0 && (occupied & placement.mask) === 0n) {
          candidate.push(placement);
          counts[placement.shapeIndex] -= 1;
          occupied |= placement.mask;
        }
      }
    }
    if (candidate.length > best.length) best = candidate;
  }

  function findLayout(inventory, target) {
    const counts = [...inventory];
    const path = [];
    const failed = new Set();
    function visit(blocked, blockedCount, remaining, nextIndex) {
      nodes += 1;
      if (outOfTime()) return null;
      if (remaining === 0) return [...path];
      if (36 - blockedCount < remaining * 4) return null;
      while (nextIndex < 36 && (blocked & BITS[nextIndex]) !== 0n) nextIndex += 1;
      if (nextIndex === 36) return null;
      const key = `${blocked.toString(36)}:${remaining}:${counts.join(',')}`;
      if (failed.has(key)) return null;
      if (remaining >= 2 && !componentCapacity(FULL ^ blocked, remaining)) return null;
      for (const placement of COVERING[nextIndex]) {
        if (counts[placement.shapeIndex] === 0 || (blocked & placement.mask) !== 0n) continue;
        counts[placement.shapeIndex] -= 1;
        path.push(placement);
        const result = visit(blocked | placement.mask, blockedCount + 4, remaining - 1, nextIndex + 1);
        if (result !== null) return result;
        path.pop();
        counts[placement.shapeIndex] += 1;
        if (timedOut) return null;
      }
      if (36 - blockedCount > remaining * 4) {
        const result = visit(blocked | BITS[nextIndex], blockedCount + 1, remaining, nextIndex + 1);
        if (result !== null) return result;
        if (timedOut) return null;
      }
      // Keep memory bounded during unusually difficult searches. Clearing only
      // loses speed; it cannot change the set of explored legal arrangements.
      if (failed.size > 180000) failed.clear();
      failed.add(key);
      return null;
    }
    return visit(0n, 0, target, 0);
  }

  for (let target = Math.min(total, 9); target >= best.length; target -= 1) {
    if (target === best.length) {
      complete = true;
      break;
    }
    const candidate = findLayout(available, target);
    if (candidate !== null) {
      best = candidate;
      complete = true;
      break;
    }
    if (timedOut) break;
  }
  if (total === 0) complete = true;

  function addAlternative(retained, placements) {
    const signature = retained.join(',');
    if (alternativeSignatures.has(signature)) return true;
    if (alternatives.length >= maxAlternatives) {
      alternativesComplete = false;
      return false;
    }
    alternativeSignatures.add(signature);
    const removed = {};
    original.forEach((count, index) => {
      if (count > retained[index]) removed[SHAPES[index].id] = count - retained[index];
    });
    alternatives.push({ removed, placements: placements.map(publicPlacement) });
    return true;
  }

  if (complete && best.length < total) {
    const bestCounts = retainedCounts(best);
    addAlternative(bestCounts, best);
    const retained = Array(SHAPES.length).fill(0);
    const suffix = Array(SHAPES.length + 1).fill(0);
    for (let index = SHAPES.length - 1; index >= 0; index -= 1) suffix[index] = suffix[index + 1] + available[index];
    function enumerate(index, remaining) {
      if (outOfTime(true)) {
        alternativesComplete = false;
        return false;
      }
      if (remaining > suffix[index]) return true;
      if (index === SHAPES.length) {
        if (remaining !== 0 || alternativeSignatures.has(retained.join(','))) return true;
        const candidate = findLayout(retained, best.length);
        if (timedOut) {
          alternativesComplete = false;
          return false;
        }
        return candidate === null || addAlternative(retained, candidate);
      }
      const lower = Math.max(0, remaining - suffix[index + 1]);
      const upper = Math.min(available[index], remaining);
      for (let value = upper; value >= lower; value -= 1) {
        retained[index] = value;
        if (!enumerate(index + 1, remaining - value)) return false;
      }
      retained[index] = 0;
      return true;
    }
    enumerate(0, best.length);
  } else if (!complete) {
    alternativesComplete = false;
  }

  return {
    maxPlaced: best.length,
    total,
    minRemoved: complete ? total - best.length : null,
    placements: best.map(publicPlacement),
    alternatives,
    complete,
    alternativesComplete,
    nodes,
    elapsedMs: Math.round(performance.now() - started),
    timedOut,
  };
}
