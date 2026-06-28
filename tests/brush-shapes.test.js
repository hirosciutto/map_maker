import assert from "node:assert/strict";
import { BRUSH_SHAPES, brushPaintCells, normalizeBrushSize } from "../brush-shapes.js";

assert.equal(normalizeBrushSize(9), 12);
assert.equal(BRUSH_SHAPES[12].cells.length, 12);
assert.equal(BRUSH_SHAPES[21].cells.length, 21);

function cellSet(shape) {
  return new Set(shape.cells.map(([x, y]) => `${x},${y}`));
}

const cells12 = cellSet(BRUSH_SHAPES[12]);
for (const corner of ["0,0", "3,0", "0,3", "3,3"]) {
  assert.ok(!cells12.has(corner), `12: corner ${corner} should be excluded`);
}
for (let y = 0; y < 4; y++) {
  for (let x = 0; x < 4; x++) {
    const key = `${x},${y}`;
    const isCorner = (x === 0 || x === 3) && (y === 0 || y === 3);
    assert.equal(cells12.has(key), !isCorner, `12: ${key}`);
  }
}

const cells21 = cellSet(BRUSH_SHAPES[21]);
for (const corner of ["0,0", "4,0", "0,4", "4,4"]) {
  assert.ok(!cells21.has(corner), `21: corner ${corner} should be excluded`);
}
for (let y = 0; y < 5; y++) {
  for (let x = 0; x < 5; x++) {
    const key = `${x},${y}`;
    const isCorner = (x === 0 || x === 4) && (y === 0 || y === 4);
    assert.equal(cells21.has(key), !isCorner, `21: ${key}`);
  }
}

const painted12 = brushPaintCells(10, 10, 12);
assert.equal(painted12.length, 12);
assert.ok(painted12.some(({ x, y }) => x === 10 && y === 10));

const painted21 = brushPaintCells(10, 10, 21);
assert.equal(painted21.length, 21);
assert.ok(painted21.some(({ x, y }) => x === 10 && y === 10));

console.log("brush-shapes: all tests passed");
