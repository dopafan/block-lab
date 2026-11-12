import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SHAPES, solveInventory } from '../dist/solver.js';

const shapesById = new Map(SHAPES.map((shape) => [shape.id, shape]));

function validatePlacements(placements, inventory) {
  const occupied = new Set();
  const used = {};
  for (const piece of placements) {
    const source = shapesById.get(piece.shapeId);
    assert.ok(source, 'every placement has a known fixed shape');
    assert.equal(piece.cells.length, 4);
    const minX = Math.min(...piece.cells.map(([x]) => x));
    const minY = Math.min(...piece.cells.map(([, y]) => y));
    const actual = piece.cells.map(([x, y]) => `${x - minX},${y - minY}`).sort();
    const expected = source.cells.map(([x, y]) => `${x},${y}`).sort();
    assert.deepEqual(actual, expected, 'fixed direction must be preserved');
    used[piece.shapeId] = (used[piece.shapeId] || 0) + 1;
    assert.ok(used[piece.shapeId] <= inventory[piece.shapeId]);
    for (const [x, y] of piece.cells) {
      assert.ok(Number.isInteger(x) && x >= 0 && x < 6);
      assert.ok(Number.isInteger(y) && y >= 0 && y < 6);
      const key = `${x},${y}`;
      assert.ok(!occupied.has(key), 'pieces must never overlap');
      occupied.add(key);
    }
  }
  assert.equal(occupied.size, placements.length * 4);
  return used;
}

// Independent oracle: choose subsets of translated piece positions directly.
// It does not use the solver's cell anchoring, skip branches, or component bound.
function translatedMasks(shape) {
  const masks = [];
  for (let dy = 0; dy < 6; dy += 1) {
    for (let dx = 0; dx < 6; dx += 1) {
      const cells = shape.cells.map(([x, y]) => [x + dx, y + dy]);
      if (cells.some(([x, y]) => x >= 6 || y >= 6)) continue;
      masks.push(cells.reduce((mask, [x, y]) => mask | (1n << BigInt(y * 6 + x)), 0n));
    }
  }
  return masks;
}

function singleShapeMaximum(shape) {
  const masks = translatedMasks(shape);
  let maximum = 0;
  function choose(start, occupied, placed) {
    maximum = Math.max(maximum, placed);
    if (placed + masks.length - start <= maximum) return;
    for (let i = start; i < masks.length; i += 1) {
      if ((occupied & masks[i]) === 0n) choose(i + 1, occupied | masks[i], placed + 1);
    }
  }
  choose(0, 0n, 0);
  return maximum;
}

function canPlaceByPiece(inventory) {
  const types = Object.entries(inventory).filter(([, count]) => count > 0)
    .map(([id, count]) => ({ masks: translatedMasks(shapesById.get(id)), count }));
  function placeType(typeIndex, start, left, occupied) {
    if (typeIndex === types.length) return true;
    if (left === 0) {
      const next = typeIndex + 1;
      return next === types.length || placeType(next, 0, types[next].count, occupied);
    }
    const masks = types[typeIndex].masks;
    for (let index = start; index <= masks.length - left; index += 1) {
      if ((occupied & masks[index]) === 0n
        && placeType(typeIndex, index + 1, left - 1, occupied | masks[index])) return true;
    }
    return false;
  }
  return types.length === 0 || placeType(0, 0, types[0].count, 0n);
}

function checkResult(result, inventory) {
  assert.equal(result.total, Object.values(inventory).reduce((a, b) => a + b, 0));
  assert.equal(result.maxPlaced, result.placements.length);
  validatePlacements(result.placements, inventory);
  const signatures = new Set();
  for (const alternative of result.alternatives) {
    assert.equal(alternative.placements.length, result.maxPlaced);
    const used = validatePlacements(alternative.placements, inventory);
    for (const [id, count] of Object.entries(inventory)) {
      assert.equal((used[id] || 0) + (alternative.removed[id] || 0), count);
    }
    assert.equal(Object.values(alternative.removed).reduce((a, b) => a + b, 0), result.minRemoved);
    const signature = JSON.stringify(Object.entries(alternative.removed).sort());
    assert.ok(!signatures.has(signature), 'equivalent removal multisets must be deduplicated');
    signatures.add(signature);
  }
}

test('catalog has all 19 distinct fixed orientations, each connected and four cells', () => {
  assert.equal(SHAPES.length, 19);
  const signatures = new Set();
  for (const shape of SHAPES) {
    assert.equal(shape.cells.length, 4);
    const signature = shape.cells.map(([x, y]) => `${x},${y}`).sort().join(';');
    assert.ok(!signatures.has(signature));
    signatures.add(signature);
    const seen = new Set([shape.cells[0].join(',')]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [x, y] of shape.cells) {
        if (seen.has(`${x},${y}`)) continue;
        if ([[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]].some((p) => seen.has(p.join(',')))) {
          seen.add(`${x},${y}`);
          changed = true;
        }
      }
    }
    assert.equal(seen.size, 4);
  }
});

test('empty inventory and requested eight-piece example', () => {
  const empty = solveInventory({});
  assert.equal(empty.maxPlaced, 0);
  assert.equal(empty.complete, true);
  const inventory = { i_h: 2, z_h: 1, s_h: 1, z_v: 1, l_left: 1, t_right: 1, l_right: 1 };
  const result = solveInventory(inventory);
  checkResult(result, inventory);
  assert.equal(result.maxPlaced, 8);
  assert.equal(result.complete, true);
  assert.equal(result.minRemoved, 0);
  assert.deepEqual(result.alternatives, []);
});

test('all single-direction maxima agree with independent exhaustive subset oracle', () => {
  for (const shape of SHAPES) {
    const expected = singleShapeMaximum(shape);
    const inventory = { [shape.id]: 9 };
    const result = solveInventory(inventory);
    checkResult(result, inventory);
    assert.equal(result.complete, true, shape.id);
    assert.equal(result.maxPlaced, expected, shape.id);
    assert.equal(result.maxPlaced, shape.id === 'o_square' ? 9 : 6, shape.id);
    assert.equal(result.alternativesComplete, true);
    if (shape.id === 'o_square') assert.deepEqual(result.alternatives, []);
    else assert.deepEqual(result.alternatives[0].removed, { [shape.id]: 3 });
  }
});

test('nine squares tile the board and a tenth requires removing exactly one square', () => {
  for (const count of [9, 10]) {
    const inventory = { o_square: count };
    const result = solveInventory(inventory);
    checkResult(result, inventory);
    assert.equal(result.complete, true);
    assert.equal(result.alternativesComplete, true);
    assert.equal(result.maxPlaced, 9);
    assert.equal(result.minRemoved, count - 9);
    if (count === 10) assert.deepEqual(result.alternatives.map((entry) => entry.removed), [{ o_square: 1 }]);
  }
});

test('corrected nine-piece example requires one removal and includes every removable type', () => {
  const inventory = { i_h: 2, z_h: 1, s_h: 1, z_v: 1, l_left: 1, t_right: 1, l_right: 1, o_square: 1 };
  const result = solveInventory(inventory);
  checkResult(result, inventory);
  assert.equal(result.complete, true);
  assert.equal(result.alternativesComplete, true);
  assert.equal(result.maxPlaced, 8);
  assert.equal(result.minRemoved, 1);
  assert.equal(result.alternatives.length, 8);
  assert.deepEqual(new Set(result.alternatives.map(({ removed }) => JSON.stringify(removed))),
    new Set(Object.keys(inventory).map((id) => JSON.stringify({ [id]: 1 }))));
  // Independent impossibility proof: T covers 3:1 checkerboard colors;
  // every other selected shape covers 2:2, so 18:18 coverage is impossible.
  for (const id of Object.keys(inventory)) {
    const black = shapesById.get(id).cells.filter(([x, y]) => (x + y) % 2 === 0).length;
    assert.equal(Math.abs(black - (4 - black)), id === 't_right' ? 2 : 0);
  }
});

test('all optimal removal multisets are returned, including when more than one removal is required', () => {
  const inventory = { i_h: 7, i_v: 7 };
  const result = solveInventory(inventory);
  checkResult(result, inventory);
  assert.equal(result.complete, true);
  assert.equal(result.maxPlaced, 8);
  assert.equal(result.minRemoved, 6);
  assert.equal(result.alternativesComplete, true);
  assert.deepEqual(result.alternatives.map((entry) => entry.removed), [
    { i_h: 1, i_v: 5 }, { i_h: 3, i_v: 3 }, { i_h: 5, i_v: 1 },
  ]);
  // Every possible retained split of eight is checked independently.
  for (let horizontal = 1; horizontal <= 7; horizontal += 1) {
    assert.equal(canPlaceByPiece({ i_h: horizontal, i_v: 8 - horizontal }), [2, 4, 6].includes(horizontal));
  }
});

test('one-piece removal identifies which type can actually be removed', () => {
  const inventory = { i_h: 7, i_v: 1 };
  const result = solveInventory(inventory);
  checkResult(result, inventory);
  assert.equal(result.maxPlaced, 7);
  assert.deepEqual(result.alternatives.map((entry) => entry.removed), [{ i_h: 1 }]);
  assert.equal(result.alternativesComplete, true);
});

test('alternative cap is explicit and does not invalidate the proved maximum', () => {
  const inventory = { i_h: 7, i_v: 7 };
  const result = solveInventory(inventory, { alternativeLimit: 1 });
  checkResult(result, inventory);
  assert.equal(result.maxPlaced, 8);
  assert.equal(result.complete, true);
  assert.equal(result.alternatives.length, 1);
  assert.equal(result.alternativesComplete, false);
});

test('seeded small mixtures agree with independent piece-by-piece placement search', () => {
  let seed = 4242;
  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  }
  for (let sample = 0; sample < 30; sample += 1) {
    const inventory = {};
    const pieces = 1 + Math.floor(random() * 6);
    for (let i = 0; i < pieces; i += 1) {
      const id = SHAPES[Math.floor(random() * SHAPES.length)].id;
      inventory[id] = (inventory[id] || 0) + 1;
    }
    const result = solveInventory(inventory);
    checkResult(result, inventory);
    assert.equal(result.complete, true);
    assert.equal(result.maxPlaced === pieces, canPlaceByPiece(inventory));
  }
});

test('time limit keeps the best valid layout without claiming an unproved optimum', () => {
  const inventory = { z_h: 1, l_left_up: 2, t_right: 1, z_v: 1, l_h_down: 2, l_left: 1, t_down: 1 };
  const result = solveInventory(inventory, { timeLimitMs: 1 });
  checkResult(result, inventory);
  assert.equal(result.complete, false);
  assert.equal(result.minRemoved, null);
  assert.equal(result.alternativesComplete, false);
  assert.ok(result.maxPlaced > 0);
});

test('invalid counts and non-finite search limits fail clearly', () => {
  for (const count of [-1, 1.2, NaN, Infinity, 100]) {
    assert.throws(() => solveInventory({ i_h: count }), RangeError);
  }
  assert.throws(() => solveInventory({}, { timeLimitMs: NaN }), RangeError);
  assert.throws(() => solveInventory({}, { maxAlternatives: Infinity }), RangeError);
});

function validateFill(option, inventory, extra) {
  const added = option.placements.filter((piece) => piece.added);
  const own = option.placements.filter((piece) => !piece.added);
  assert.equal(added.length, extra);
  const merged = { ...inventory };
  for (const [id, count] of Object.entries(option.added)) merged[id] = (merged[id] || 0) + count;
  validatePlacements(option.placements, merged);
  const ownUsed = validatePlacements(own, inventory);
  for (const [id, count] of Object.entries(inventory)) assert.equal(ownUsed[id] || 0, count, 'every owned piece stays on the board');
  const addedUsed = {};
  for (const piece of added) addedUsed[piece.shapeId] = (addedUsed[piece.shapeId] || 0) + 1;
  assert.deepEqual(addedUsed, option.added);
}

test('fill suggestions complete the board when everything fits with room to spare', () => {
  const squares = { o_square: 8 };
  const result = solveInventory(squares);
  assert.equal(result.maxPlaced, 8);
  assert.ok(result.fill && result.fill.exact && result.fill.extra === 1);
  assert.ok(result.fill.options.some((option) => option.added.o_square === 1));
  for (const option of result.fill.options) {
    validateFill(option, squares, 1);
    assert.equal(option.placements.length, 9);
  }

  const example = { i_h: 2, z_h: 1, s_h: 1, z_v: 1, l_left: 1, t_right: 1, l_right: 1 };
  const second = solveInventory(example);
  assert.equal(second.maxPlaced, 8);
  assert.ok(second.fill);
  for (const option of second.fill.options) validateFill(option, example, second.fill.extra);
  const signatures = second.fill.options.map((option) => JSON.stringify(option.added));
  assert.equal(new Set(signatures).size, signatures.length, 'each suggestion adds a different set');

  const few = { t_up: 2, i_v: 1 };
  const third = solveInventory(few);
  assert.ok(third.fill.exact && third.fill.extra === 6 && third.fill.options.length > 0);
  for (const option of third.fill.options) validateFill(option, few, 6);
});

test('no fill suggestion for an empty, full, or overfull inventory; removal options may carry a swap', () => {
  assert.equal(solveInventory({}).fill, null);
  assert.equal(solveInventory({ o_square: 9 }).fill, null);
  const inventory = { i_h: 2, z_h: 1, s_h: 1, z_v: 1, l_left: 1, t_right: 1, l_right: 1, o_square: 1 };
  const result = solveInventory(inventory);
  assert.equal(result.fill, null);
  for (const alternative of result.alternatives) {
    if (!alternative.fill) continue;
    const retained = { ...inventory };
    for (const [id, count] of Object.entries(alternative.removed)) retained[id] -= count;
    for (const option of alternative.fill.options) validateFill(option, retained, alternative.fill.extra);
  }
});

test('when nothing can be added, swapping one owned piece is suggested instead', () => {
  const example = { i_h: 2, z_h: 1, s_h: 1, z_v: 1, l_left: 1, t_right: 1, l_right: 1 };
  const result = solveInventory(example);
  assert.ok(result.fill);
  if (result.fill.exact) return;
  assert.ok(result.fill.swaps.length > 0, 'a one-piece trade that fills the board exists');
  for (const swap of result.fill.swaps) {
    const [removedId] = Object.keys(swap.removed);
    assert.equal(swap.removed[removedId], 1);
    assert.ok(!swap.added[removedId], 'the removed shape is not simply added back');
    const retained = { ...example, [removedId]: example[removedId] - 1 };
    validateFill(swap, retained, 2);
    assert.equal(swap.placements.length, 9);
  }
});
