import assert from "node:assert/strict";
import {
  applySelectionContentReplace,
  applySelectionMove,
  applySelectionRotate,
  applySelectionScale,
  buildSelectionCells,
  cellsInsidePolygon,
  computeScaleFromCorner,
  computeScaleFromEdge,
  cropGridToRect,
  fillGridGapsAroundCells,
  getDominantNeighborCode,
  getRotatedBoxGeometry,
  getSelectionBoxHandles,
  hitHandlePoint,
  hitRotateHandle,
  hitRotateHandleOutside,
  pointInPolygon,
  resizeGrid,
  resizeGridCanvas,
  resizeGridWidth,
  rotateCell,
  scaleCell,
  scaleEntries,
  selectionBounds,
  selectionMapsEqual,
} from "../lasso-logic.js";

const square = [
  { x: 2, y: 2 },
  { x: 6, y: 2 },
  { x: 6, y: 6 },
  { x: 2, y: 6 },
];

assert.ok(pointInPolygon(4.5, 4.5, square));
assert.ok(!pointInPolygon(1.5, 1.5, square));

const keys = cellsInsidePolygon(square, 8);
assert.equal(keys.length, 16);
assert.ok(keys.includes("4,4"));
assert.ok(!keys.includes("1,1"));

const single = cellsInsidePolygon([{ x: 3, y: 5 }], 8);
assert.deepEqual(single, ["3,5"]);

const grid = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => "OCN"));
grid[4][4] = "P";
grid[5][4] = "F";
const cells = buildSelectionCells(["4,4", "4,5"], grid);
assert.equal(cells.get("4,4"), "P");
assert.equal(cells.get("4,5"), "F");

const moveGrid = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => "OCN"));
moveGrid[1][1] = "P";
const moveCells = new Map([["1,1", "P"]]);
const result = applySelectionMove(moveGrid, moveCells, 1, 0, 4, () => true);
assert.equal(result.grid[1][2], "P");
assert.equal(result.grid[1][1], "OCN");
assert.equal(result.moved, 1);

const bounds = selectionBounds(new Map([["2,2", "P"], ["3,2", "P"], ["2,3", "P"]]));
assert.equal(bounds.cx, 3);
assert.equal(bounds.cy, 3);

const rotated = rotateCell(4, 2, 3, 3, Math.PI / 2);
assert.equal(rotated.x, 3);
assert.equal(rotated.y, 4);

const rotateGrid = Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => "OCN"));
rotateGrid[2][2] = "P";
const rotateResult = applySelectionRotate(
  rotateGrid,
  new Map([["2,2", "P"]]),
  2.5,
  2.5,
  Math.PI / 2,
  6,
  () => true,
);
assert.equal(rotateResult.moved, 1);

const geometry = getRotatedBoxGeometry(bounds, 0);
assert.equal(geometry.handles.length, 4);
assert.ok(hitRotateHandle(geometry.handles[0].x, geometry.handles[0].y, geometry.handles));

const handles = getSelectionBoxHandles(bounds, 0, 0.85);
assert.equal(handles.corners.length, 4);
assert.equal(handles.edges.length, 4);
assert.equal(handles.rotateHandles.length, 4);
assert.equal(hitHandlePoint(handles.corners[0].x, handles.corners[0].y, handles.corners), "tl");
assert.equal(
  hitRotateHandleOutside(
    handles.rotateHandles[0].x,
    handles.rotateHandles[0].y,
    handles.corners,
    handles.rotateHandles,
    0.3,
    1,
  ),
  "tl",
);
assert.equal(
  hitRotateHandleOutside(
    handles.corners[0].x,
    handles.corners[0].y,
    handles.corners,
    handles.rotateHandles,
    0.3,
    1,
  ),
  null,
);

const scaleBounds = { x0: 1, y0: 1, x1: 2, y1: 2, cx: 2, cy: 2 };
const cornerScale = computeScaleFromCorner(scaleBounds, "br", { x: 5, y: 5 });
assert.equal(cornerScale.anchorX, 1);
assert.equal(cornerScale.anchorY, 1);
assert.equal(cornerScale.scaleX, 2);
assert.equal(cornerScale.scaleY, 2);
const edgeScale = computeScaleFromEdge(scaleBounds, "r", { x: 5, y: 2 });
assert.equal(edgeScale.scaleX, 2);
assert.equal(edgeScale.scaleY, 1);

const scaled = scaleCell(2, 1, 1, 1, 2, 1);
assert.equal(scaled.x, 4);
assert.equal(scaled.y, 1);

const scaleGrid = Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => "OCN"));
scaleGrid[1][1] = "P";
scaleGrid[1][2] = "P";
const scaleResult = applySelectionScale(
  scaleGrid,
  new Map([["1,1", "P"], ["2,1", "P"]]),
  1,
  1,
  2,
  1,
  6,
  () => true,
);
assert.ok(scaleResult.moved >= 1);
assert.ok(scaleResult.cells.has("2,1") || scaleResult.cells.has("4,1"));

const wide = resizeGridWidth(
  [
    ["A", "B", "C", "D"],
    ["E", "F", "G", "H"],
  ],
  2,
  "OCN",
);
assert.equal(wide[0].length, 2);
assert.equal(wide.length, 2);
assert.equal(wide[0][0], "A");
assert.equal(wide[0][1], "C");

const resized = resizeGrid(
  [
    ["A", "B"],
    ["C", "D"],
  ],
  4,
  1,
  "OCN",
);
assert.equal(resized.length, 1);
assert.equal(resized[0].length, 4);
assert.equal(resized[0][0], "A");
assert.equal(resized[0][2], "B");

const cropped = resizeGridCanvas(
  [
    ["A", "B", "C"],
    ["D", "E", "F"],
    ["G", "H", "I"],
  ],
  1,
  1,
  "OCN",
);
assert.deepEqual(cropped, [["E"]]);

const padded = resizeGridCanvas(
  [
    ["A", "B"],
    ["C", "D"],
  ],
  4,
  4,
  "OCN",
);
assert.equal(padded.length, 4);
assert.equal(padded[0].length, 4);
assert.equal(padded[1][1], "A");
assert.equal(padded[1][2], "B");
assert.equal(padded[2][1], "C");
assert.equal(padded[2][2], "D");
assert.equal(padded[0][0], "OCN");
assert.equal(padded[3][3], "OCN");

const neighborGrid = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => "OCN"));
neighborGrid[1][0] = "P";
neighborGrid[1][2] = "P";
neighborGrid[0][1] = "F";
assert.equal(getDominantNeighborCode(neighborGrid, 1, 1, 4), "P");

const gapGrid = Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => "OCN"));
gapGrid[2][1] = "P";
gapGrid[2][3] = "P";
gapGrid[1][2] = "P";
gapGrid[3][2] = "P";
const gapCells = new Map([
  ["1,2", "P"],
  ["2,1", "P"],
  ["2,3", "P"],
  ["3,2", "P"],
]);
const gapResult = fillGridGapsAroundCells(gapGrid, gapCells, 5, () => true);
assert.equal(gapResult.grid[2][2], "P");
assert.equal(gapResult.filled, 1);
assert.equal(gapCells.size, 4);

// L字選択の凹みは埋めない（バウンディングボックス全体のコピー防止）
const lGrid = Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => "OCN"));
const lCells = new Map([
  ["1,1", "P"],
  ["1,2", "P"],
  ["1,3", "P"],
  ["2,3", "P"],
  ["3,3", "P"],
]);
for (const [key, code] of lCells) {
  const [x, y] = key.split(",").map(Number);
  lGrid[y][x] = code;
}
const lGap = fillGridGapsAroundCells(lGrid, lCells, 6, () => true);
assert.equal(lGap.filled, 0);
assert.equal(lGap.grid[1][2], "OCN");
assert.equal(lGap.grid[2][2], "OCN");

// 移動確定でも L字の凹みは塗られない
const movedL = new Map([
  ["2,1", "P"],
  ["2,2", "P"],
  ["2,3", "P"],
  ["3,3", "P"],
  ["4,3", "P"],
]);
const lReplace = applySelectionContentReplace(lGrid, lCells, movedL, 6, () => true);
assert.equal(lReplace.gapFilled, 0);
assert.equal(lReplace.grid[1][3], "OCN");
assert.equal(lReplace.grid[2][3], "OCN");
assert.ok(lReplace.cells.has("2,1"));
assert.ok(!lReplace.cells.has("3,1"));

const replaceGrid = Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => "OCN"));
for (let y = 1; y <= 3; y++) {
  for (let x = 1; x <= 4; x++) replaceGrid[y][x] = "P";
}
const replaceSource = new Map([
  ["1,1", "P"],
  ["2,1", "P"],
  ["3,1", "P"],
  ["4,1", "P"],
  ["1,2", "P"],
  ["2,2", "P"],
  ["3,2", "P"],
  ["4,2", "P"],
  ["1,3", "P"],
  ["2,3", "P"],
  ["3,3", "P"],
  ["4,3", "P"],
]);
const rightBounds = selectionBounds(replaceSource);
const afterRight = scaleEntries(
  [...replaceSource.entries()].map(([key, code]) => {
    const [x, y] = key.split(",").map(Number);
    return { x, y, code };
  }),
  rightBounds.x0,
  rightBounds.cy,
  0.75,
  1,
);
const afterRightCells = new Map(afterRight.map((e) => [`${e.x},${e.y}`, e.code]));
const leftBounds = selectionBounds(afterRightCells);
const afterLeft = scaleEntries(
  afterRight,
  leftBounds.x1 + 1,
  leftBounds.cy,
  0.75,
  1,
);
const afterLeftCells = new Map(afterLeft.map((e) => [`${e.x},${e.y}`, e.code]));
assert.ok(afterLeftCells.size > 0);
assert.ok(!selectionMapsEqual(afterRightCells, afterLeftCells));
assert.ok(selectionBounds(afterLeftCells).x1 < selectionBounds(afterRightCells).x1 ||
  selectionBounds(afterLeftCells).x0 > selectionBounds(afterRightCells).x0);

const replaced = applySelectionContentReplace(
  replaceGrid,
  replaceSource,
  afterLeftCells,
  6,
  () => true,
);
assert.ok(replaced.cells.size > 0);
assert.ok(!replaced.cells.has("4,1") || afterLeftCells.has("4,1"));

const cropSource = [
  ["A", "B", "C", "D"],
  ["E", "F", "G", "H"],
  ["I", "J", "K", "L"],
];
const cropOut = cropGridToRect(cropSource, { x0: 1, y0: 0, x1: 2, y1: 1 });
assert.equal(cropOut.width, 2);
assert.equal(cropOut.height, 2);
assert.deepEqual(cropOut.grid, [
  ["B", "C"],
  ["F", "G"],
]);

console.log("lasso-logic: all tests passed");
