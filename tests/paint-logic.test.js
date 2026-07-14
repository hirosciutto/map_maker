import assert from "node:assert/strict";
import { brushPaintCells } from "../brush-shapes.js";

function createGrid(size, code = "O") {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => code));
}

function canPaint(grid, size, mask, x, y) {
  return x >= 0 && y >= 0 && x < size && y < size && !mask.has(grid[y][x]);
}

function paintCell(grid, mask, size, cx, cy, brushSize, code) {
  for (const { x, y } of brushPaintCells(cx, cy, brushSize)) {
    if (canPaint(grid, size, mask, x, y)) grid[y][x] = code;
  }
}

function linePaint(grid, mask, size, a, b, brushSize, code) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(a.x + (dx * i) / steps);
    const y = Math.round(a.y + (dy * i) / steps);
    paintCell(grid, mask, size, x, y, brushSize, code);
  }
}

const size = 16;
const grid = createGrid(size, "O");
const mask = new Set();

paintCell(grid, mask, size, 5, 5, 1, "P");
assert.equal(grid[5][5], "P", "1x1: クリック位置に塗れる");
assert.equal(grid[5][6], "O", "1x1: 隣は塗らない");

const grid4 = createGrid(size, "O");
paintCell(grid4, mask, size, 8, 8, 4, "F");
assert.equal(grid4[8][8], "F");
assert.equal(grid4[8][9], "F");
assert.equal(grid4[9][8], "F");
assert.equal(grid4[9][9], "F");
assert.equal(grid4[7][8], "O", "2x2: 左上基準で上にはみ出さない");

const grid12 = createGrid(size, "O");
paintCell(grid12, mask, size, 10, 10, 12, "M");
assert.equal(brushPaintCells(10, 10, 12).length, 12);
assert.equal(grid12[10][10], "M");
assert.equal(grid12[8][8], "O", "12: 角は塗らない");
assert.equal(grid12[9][10], "M", "12: 内側は塗る");

const gridLine = createGrid(size, "O");
linePaint(gridLine, mask, size, { x: 2, y: 2 }, { x: 6, y: 2 }, 1, "D");
for (let x = 2; x <= 6; x++) {
  assert.equal(gridLine[2][x], "D", `linePaint: x=${x} が塗られている`);
}

const gridMask = createGrid(size, "O");
gridMask[4][4] = "W";
const maskSea = new Set(["W"]);
paintCell(gridMask, maskSea, size, 4, 4, 1, "P");
assert.equal(gridMask[4][4], "W", "マスク中バイオームは上書き不可");
paintCell(gridMask, maskSea, size, 5, 5, 1, "P");
assert.equal(gridMask[5][5], "P", "マスク対象外は塗れる");

const gridEdge = createGrid(size, "O");
paintCell(gridEdge, mask, size, 0, 0, 4, "P");
assert.equal(gridEdge[0][0], "P");
assert.equal(gridEdge[0][1], "P");
assert.equal(gridEdge[1][0], "P");
assert.equal(gridEdge[1][1], "P");

console.log("paint-logic: all tests passed");
