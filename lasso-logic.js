/** @param {number | { width: number, height: number }} size */
function resolveDims(size) {
  if (typeof size === "number") return { width: size, height: size };
  return { width: size.width, height: size.height };
}

export function pointInPolygon(px, py, polygon) {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersects = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function cellsInsidePolygon(points, size) {
  const { width, height } = resolveDims(size);
  if (!points.length) return [];
  if (points.length === 1) {
    const p = points[0];
    if (p.x < 0 || p.y < 0 || p.x >= width || p.y >= height) return [];
    return [`${p.x},${p.y}`];
  }
  if (points.length === 2) {
    const x0 = Math.max(0, Math.min(points[0].x, points[1].x));
    const y0 = Math.max(0, Math.min(points[0].y, points[1].y));
    const x1 = Math.min(width - 1, Math.max(points[0].x, points[1].x));
    const y1 = Math.min(height - 1, Math.max(points[0].y, points[1].y));
    const keys = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        keys.push(`${x},${y}`);
      }
    }
    return keys;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }

  minX = Math.max(0, Math.floor(minX));
  minY = Math.max(0, Math.floor(minY));
  maxX = Math.min(width - 1, Math.ceil(maxX));
  maxY = Math.min(height - 1, Math.ceil(maxY));

  const keys = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (pointInPolygon(x + 0.5, y + 0.5, points)) {
        keys.push(`${x},${y}`);
      }
    }
  }
  return keys;
}

export function buildSelectionCells(keys, grid) {
  const cells = new Map();
  for (const key of keys) {
    const [x, y] = key.split(",").map(Number);
    cells.set(key, grid[y][x]);
  }
  return cells;
}

export function entriesFromCells(cells) {
  return [...cells.entries()].map(([key, code]) => {
    const [x, y] = key.split(",").map(Number);
    return { x, y, code };
  });
}

export function cellsFromEntries(entries) {
  const cells = new Map();
  for (const entry of entries) {
    cells.set(`${entry.x},${entry.y}`, entry.code);
  }
  return cells;
}

export function rotateEntries(entries, cx, cy, angleRad) {
  const used = new Set();
  const result = [];
  for (const entry of entries) {
    const next = rotateCell(entry.x, entry.y, cx, cy, angleRad);
    const key = `${next.x},${next.y}`;
    if (used.has(key)) continue;
    used.add(key);
    result.push({ x: next.x, y: next.y, code: entry.code });
  }
  return result;
}

export function offsetEntries(entries, dx, dy) {
  return entries.map((entry) => ({
    x: entry.x + dx,
    y: entry.y + dy,
    code: entry.code,
  }));
}

export function selectionBounds(cells) {
  if (!cells.size) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const key of cells.keys()) {
    const [x, y] = key.split(",").map(Number);
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return {
    x0,
    y0,
    x1,
    y1,
    cx: (x0 + x1 + 1) / 2,
    cy: (y0 + y1 + 1) / 2,
  };
}

export function bboxCorners(bounds) {
  return [
    { id: "tl", x: bounds.x0, y: bounds.y0 },
    { id: "tr", x: bounds.x1 + 1, y: bounds.y0 },
    { id: "br", x: bounds.x1 + 1, y: bounds.y1 + 1 },
    { id: "bl", x: bounds.x0, y: bounds.y1 + 1 },
  ];
}

export function rotatePointFloat(x, y, cx, cy, angleRad) {
  const rx = x - cx;
  const ry = y - cy;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    x: cx + rx * cos - ry * sin,
    y: cy + rx * sin + ry * cos,
  };
}

export function rotateCell(x, y, cx, cy, angleRad) {
  const rx = x + 0.5 - cx;
  const ry = y + 0.5 - cy;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    x: Math.round(cx + rx * cos - ry * sin - 0.5),
    y: Math.round(cy + rx * sin + ry * cos - 0.5),
  };
}

export function rotateCells(cells, cx, cy, angleRad) {
  const rotated = new Map();
  for (const [key, code] of cells) {
    const [x, y] = key.split(",").map(Number);
    const next = rotateCell(x, y, cx, cy, angleRad);
    const nextKey = `${next.x},${next.y}`;
    if (!rotated.has(nextKey)) rotated.set(nextKey, code);
  }
  return rotated;
}

export function getRotatedBoxGeometry(bounds, angleRad, handleDistance = 0.65) {
  const corners = bboxCorners(bounds).map((corner) => ({
    id: corner.id,
    ...rotatePointFloat(corner.x, corner.y, bounds.cx, bounds.cy, angleRad),
  }));
  const handles = corners.map((corner) => {
    const dx = corner.x - bounds.cx;
    const dy = corner.y - bounds.cy;
    const len = Math.hypot(dx, dy) || 1;
    return {
      id: corner.id,
      x: corner.x + (dx / len) * handleDistance,
      y: corner.y + (dy / len) * handleDistance,
    };
  });
  return { corners, handles };
}

export function bboxEdges(bounds) {
  return [
    { id: "t", x: (bounds.x0 + bounds.x1 + 1) / 2, y: bounds.y0 },
    { id: "r", x: bounds.x1 + 1, y: (bounds.y0 + bounds.y1 + 1) / 2 },
    { id: "b", x: (bounds.x0 + bounds.x1 + 1) / 2, y: bounds.y1 + 1 },
    { id: "l", x: bounds.x0, y: (bounds.y0 + bounds.y1 + 1) / 2 },
  ];
}

export function getSelectionBoxHandles(bounds, angleRad = 0, rotateOutset = 0.85) {
  const { corners, handles: rotateHandles } = getRotatedBoxGeometry(bounds, angleRad, rotateOutset);
  const edges = bboxEdges(bounds).map((edge) => ({
    id: edge.id,
    ...rotatePointFloat(edge.x, edge.y, bounds.cx, bounds.cy, angleRad),
  }));
  return { corners, edges, rotateHandles };
}

export function hitHandlePoint(px, py, handles, radius = 0.75) {
  for (const handle of handles) {
    if (Math.hypot(px - handle.x, py - handle.y) <= radius) return handle.id;
  }
  return null;
}

/** @deprecated Use hitHandlePoint */
export function hitRotateHandle(px, py, handles, radius = 0.75) {
  return hitHandlePoint(px, py, handles, radius);
}

/**
 * 角の外側（rotateHandles 付近）だけ回転ヒットを返す。
 * 角そのもの（innerRadius 以内）はスケール用に残す。
 */
export function hitRotateHandleOutside(px, py, corners, rotateHandles, innerRadius, outerRadius) {
  for (let i = 0; i < rotateHandles.length; i++) {
    const handle = rotateHandles[i];
    const corner = corners[i];
    if (!corner) continue;
    const distHandle = Math.hypot(px - handle.x, py - handle.y);
    const distCorner = Math.hypot(px - corner.x, py - corner.y);
    if (distHandle <= outerRadius && distCorner >= innerRadius) return handle.id;
  }
  return null;
}

const OPPOSITE_CORNER = { tl: "br", tr: "bl", br: "tl", bl: "tr" };

export function cornerPoint(bounds, id) {
  switch (id) {
    case "tl":
      return { x: bounds.x0, y: bounds.y0 };
    case "tr":
      return { x: bounds.x1 + 1, y: bounds.y0 };
    case "br":
      return { x: bounds.x1 + 1, y: bounds.y1 + 1 };
    case "bl":
      return { x: bounds.x0, y: bounds.y1 + 1 };
    default:
      return { x: bounds.cx, y: bounds.cy };
  }
}

export function computeScaleFromCorner(bounds, cornerId, pointer) {
  const w = bounds.x1 - bounds.x0 + 1;
  const h = bounds.y1 - bounds.y0 + 1;
  const anchor = cornerPoint(bounds, OPPOSITE_CORNER[cornerId]);
  const start = cornerPoint(bounds, cornerId);
  const origDx = start.x - anchor.x;
  const origDy = start.y - anchor.y;
  let scaleX = origDx === 0 ? 1 : (pointer.x - anchor.x) / origDx;
  let scaleY = origDy === 0 ? 1 : (pointer.y - anchor.y) / origDy;
  scaleX = Math.max(1 / w, scaleX);
  scaleY = Math.max(1 / h, scaleY);
  return { anchorX: anchor.x, anchorY: anchor.y, scaleX, scaleY };
}

export function computeScaleFromEdge(bounds, edgeId, pointer) {
  const w = bounds.x1 - bounds.x0 + 1;
  const h = bounds.y1 - bounds.y0 + 1;
  if (edgeId === "r") {
    return {
      anchorX: bounds.x0,
      anchorY: bounds.cy,
      scaleX: Math.max(1 / w, (pointer.x - bounds.x0) / w),
      scaleY: 1,
    };
  }
  if (edgeId === "l") {
    return {
      anchorX: bounds.x1 + 1,
      anchorY: bounds.cy,
      scaleX: Math.max(1 / w, (bounds.x1 + 1 - pointer.x) / w),
      scaleY: 1,
    };
  }
  if (edgeId === "b") {
    return {
      anchorX: bounds.cx,
      anchorY: bounds.y0,
      scaleX: 1,
      scaleY: Math.max(1 / h, (pointer.y - bounds.y0) / h),
    };
  }
  return {
    anchorX: bounds.cx,
    anchorY: bounds.y1 + 1,
    scaleX: 1,
    scaleY: Math.max(1 / h, (bounds.y1 + 1 - pointer.y) / h),
  };
}

export function scaleCell(x, y, anchorX, anchorY, scaleX, scaleY) {
  return {
    x: Math.round(anchorX + (x + 0.5 - anchorX) * scaleX - 0.5),
    y: Math.round(anchorY + (y + 0.5 - anchorY) * scaleY - 0.5),
  };
}

export function scaleEntries(entries, anchorX, anchorY, scaleX, scaleY) {
  const used = new Set();
  const result = [];
  for (const entry of entries) {
    const next = scaleCell(entry.x, entry.y, anchorX, anchorY, scaleX, scaleY);
    const key = `${next.x},${next.y}`;
    if (used.has(key)) continue;
    used.add(key);
    result.push({ x: next.x, y: next.y, code: entry.code });
  }
  return result;
}

export function buildPlacementsFromScale(sourceCells, anchorX, anchorY, scaleX, scaleY) {
  return [...sourceCells.entries()].map(([key, code]) => {
    const [fromX, fromY] = key.split(",").map(Number);
    const next = scaleCell(fromX, fromY, anchorX, anchorY, scaleX, scaleY);
    return { fromX, fromY, toX: next.x, toY: next.y, code };
  });
}

export function applySelectionScale(grid, cells, anchorX, anchorY, scaleX, scaleY, size, canPaint) {
  if (scaleX === 1 && scaleY === 1) {
    return { grid, cells: new Map(cells), moved: 0, stayed: 0, sourceFilled: 0, gapFilled: 0 };
  }
  const placed = applySelectionPlacements(
    grid,
    buildPlacementsFromScale(cells, anchorX, anchorY, scaleX, scaleY),
    size,
    canPaint,
  );
  const gaps = fillGridGapsAroundCells(placed.grid, placed.cells, size, canPaint);
  return {
    grid: gaps.grid,
    cells: placed.cells,
    moved: placed.moved,
    stayed: placed.stayed,
    sourceFilled: placed.sourceFilled,
    gapFilled: gaps.filled,
  };
}

export function resizeGrid(grid, newWidth, newHeight, fillCode = "OCN") {
  const oldHeight = grid.length;
  if (!oldHeight) {
    return Array.from({ length: newHeight }, () => Array.from({ length: newWidth }, () => fillCode));
  }
  const oldWidth = grid[0].length;
  if (newWidth === oldWidth && newHeight === oldHeight) {
    return grid.map((row) => row.slice());
  }
  const next = Array.from({ length: newHeight }, () => Array.from({ length: newWidth }, () => fillCode));
  for (let y = 0; y < newHeight; y++) {
    const sy = Math.min(oldHeight - 1, Math.floor((y * oldHeight) / newHeight));
    for (let x = 0; x < newWidth; x++) {
      const sx = Math.min(oldWidth - 1, Math.floor((x * oldWidth) / newWidth));
      next[y][x] = grid[sy][sx];
    }
  }
  return next;
}

/**
 * 内容の縮尺は変えず、キャンバス枠だけ変える。
 * 縮小: 中央を残して切り取り / 拡大: 周囲を fillCode（海）で埋める。
 */
export function resizeGridCanvas(grid, newWidth, newHeight, fillCode = "OCN") {
  const oldHeight = grid.length;
  if (!oldHeight) {
    return Array.from({ length: newHeight }, () => Array.from({ length: newWidth }, () => fillCode));
  }
  const oldWidth = grid[0].length;
  if (newWidth === oldWidth && newHeight === oldHeight) {
    return grid.map((row) => row.slice());
  }

  const offsetX = Math.floor((newWidth - oldWidth) / 2);
  const offsetY = Math.floor((newHeight - oldHeight) / 2);
  const next = Array.from({ length: newHeight }, () => Array.from({ length: newWidth }, () => fillCode));

  for (let y = 0; y < newHeight; y++) {
    const sy = y - offsetY;
    if (sy < 0 || sy >= oldHeight) continue;
    for (let x = 0; x < newWidth; x++) {
      const sx = x - offsetX;
      if (sx < 0 || sx >= oldWidth) continue;
      next[y][x] = grid[sy][sx];
    }
  }
  return next;
}

export function cropGridToRect(grid, rect) {
  const oldHeight = grid.length;
  if (!oldHeight) {
    return { grid: [], width: 0, height: 0 };
  }
  const oldWidth = grid[0].length;
  const x0 = Math.max(0, Math.min(oldWidth - 1, Math.min(rect.x0, rect.x1)));
  const x1 = Math.max(0, Math.min(oldWidth - 1, Math.max(rect.x0, rect.x1)));
  const y0 = Math.max(0, Math.min(oldHeight - 1, Math.min(rect.y0, rect.y1)));
  const y1 = Math.max(0, Math.min(oldHeight - 1, Math.max(rect.y0, rect.y1)));
  const width = x1 - x0 + 1;
  const height = y1 - y0 + 1;
  const next = [];
  for (let y = y0; y <= y1; y++) {
    next.push(grid[y].slice(x0, x1 + 1));
  }
  return { grid: next, width, height, x0, y0, x1, y1 };
}

/** @deprecated Prefer resizeGrid */
export function resizeGridWidth(grid, newWidth, fillCode = "OCN") {
  const height = grid.length;
  if (!height) return [];
  return resizeGrid(grid, newWidth, height, fillCode);
}

const NEIGHBOR_DIRS = [[0, -1], [0, 1], [-1, 0], [1, 0]];

export function getDominantNeighborCode(grid, x, y, size, excludeKeys = new Set()) {
  const { width, height } = resolveDims(size);
  const counts = new Map();
  for (const [dx, dy] of NEIGHBOR_DIRS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
    const key = `${nx},${ny}`;
    if (excludeKeys.has(key)) continue;
    const code = grid[ny][nx];
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  if (!counts.size) return "OCN";

  let bestCode = "OCN";
  let bestCount = -1;
  for (const [code, count] of counts) {
    const prefer =
      count > bestCount ||
      (count === bestCount && isOceanCode(bestCode) && !isOceanCode(code));
    if (prefer) {
      bestCode = code;
      bestCount = count;
    }
  }
  return bestCode;
}

function isOceanCode(code) {
  return code === "OCN" || code === "O";
}

export function fillGridGapsAroundCells(grid, selectionCells, size, canPaint) {
  const { width, height } = resolveDims(size);
  const occupied = new Set(selectionCells.keys());
  const bounds = selectionBounds(selectionCells);
  if (!bounds) return { grid, filled: 0 };

  const next = grid.map((row) => row.slice());
  let filled = 0;
  let changed = true;

  while (changed) {
    changed = false;
    for (let y = bounds.y0 - 1; y <= bounds.y1 + 1; y++) {
      for (let x = bounds.x0 - 1; x <= bounds.x1 + 1; x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const key = `${x},${y}`;
        if (occupied.has(key)) continue;
        if (!canPaint(x, y)) continue;

        // Opposite neighbors only: fills scale/rotate gaps without
        // flooding concave lasso regions into the full bounding box.
        const hasL = occupied.has(`${x - 1},${y}`);
        const hasR = occupied.has(`${x + 1},${y}`);
        const hasU = occupied.has(`${x},${y - 1}`);
        const hasD = occupied.has(`${x},${y + 1}`);
        if (!(hasL && hasR) && !(hasU && hasD)) continue;

        const code = getDominantNeighborCode(next, x, y, size);
        next[y][x] = code;
        occupied.add(key);
        filled++;
        changed = true;
      }
    }
  }

  return { grid: next, filled };
}

export function fillClearedSourcesWithNeighbors(grid, clearedKeys, selectionKeys, size) {
  const next = grid.map((row) => row.slice());
  let filled = 0;
  for (const key of clearedKeys) {
    if (selectionKeys.has(key)) continue;
    const [x, y] = key.split(",").map(Number);
    const code = getDominantNeighborCode(next, x, y, size);
    if (next[y][x] !== code) filled++;
    next[y][x] = code;
  }
  return { grid: next, filled };
}

export function buildPlacementsFromTransform(sourceCells, cx, cy, angleRad) {
  return [...sourceCells.entries()].map(([key, code]) => {
    const [fromX, fromY] = key.split(",").map(Number);
    const next = rotateCell(fromX, fromY, cx, cy, angleRad);
    return { fromX, fromY, toX: next.x, toY: next.y, code };
  });
}

export function buildPlacementsFromOffset(sourceCells, dx, dy) {
  return [...sourceCells.entries()].map(([key, code]) => {
    const [fromX, fromY] = key.split(",").map(Number);
    return { fromX, fromY, toX: fromX + dx, toY: fromY + dy, code };
  });
}

export function applySelectionPlacements(grid, placements, size, canPaint) {
  const { width, height } = resolveDims(size);
  const nextGrid = grid.map((row) => row.slice());
  const nextCells = new Map();
  const valid = [];
  let stayed = 0;
  const usedDestinations = new Set();

  for (const placement of placements) {
    const { fromX, fromY, toX, toY, code } = placement;
    const inBounds = toX >= 0 && toY >= 0 && toX < width && toY < height;
    const destKey = `${toX},${toY}`;
    if (
      !inBounds ||
      !canPaint(fromX, fromY) ||
      !canPaint(toX, toY) ||
      usedDestinations.has(destKey)
    ) {
      nextCells.set(`${fromX},${fromY}`, code);
      stayed++;
      continue;
    }
    usedDestinations.add(destKey);
    valid.push(placement);
  }

  for (const placement of valid) {
    nextGrid[placement.fromY][placement.fromX] = "OCN";
  }
  for (const placement of valid) {
    nextGrid[placement.toY][placement.toX] = placement.code;
    nextCells.set(`${placement.toX},${placement.toY}`, placement.code);
  }

  const clearedKeys = valid.map((placement) => `${placement.fromX},${placement.fromY}`);
  const sourceFill = fillClearedSourcesWithNeighbors(nextGrid, clearedKeys, new Set(nextCells.keys()), size);

  return {
    grid: sourceFill.grid,
    cells: nextCells,
    moved: valid.length,
    stayed,
    sourceFilled: sourceFill.filled,
  };
}

export function applySelectionMove(grid, cells, dx, dy, size, canPaint) {
  return applySelectionPlacements(
    grid,
    buildPlacementsFromOffset(cells, dx, dy),
    size,
    canPaint,
  );
}

export function applySelectionRotate(grid, cells, cx, cy, angleRad, size, canPaint) {
  if (angleRad === 0) {
    return { grid, cells: new Map(cells), moved: 0, stayed: 0, sourceFilled: 0, gapFilled: 0 };
  }
  const placed = applySelectionPlacements(
    grid,
    buildPlacementsFromTransform(cells, cx, cy, angleRad),
    size,
    canPaint,
  );
  const gaps = fillGridGapsAroundCells(placed.grid, placed.cells, size, canPaint);
  return {
    grid: gaps.grid,
    cells: placed.cells,
    moved: placed.moved,
    stayed: placed.stayed,
    sourceFilled: placed.sourceFilled,
    gapFilled: gaps.filled,
  };
}

/** Replace selection content with a preview map (for confirm-after-edit flows). */
export function applySelectionContentReplace(grid, sourceCells, targetCells, size, canPaint) {
  const { width, height } = resolveDims(size);
  const nextGrid = grid.map((row) => row.slice());
  const targetKeys = new Set(targetCells.keys());
  const clearedKeys = [];

  for (const key of sourceCells.keys()) {
    const [x, y] = key.split(",").map(Number);
    if (!canPaint(x, y)) continue;
    if (!targetKeys.has(key)) {
      nextGrid[y][x] = "OCN";
      clearedKeys.push(key);
    }
  }

  const nextCells = new Map();
  let moved = 0;
  let stayed = 0;
  for (const [key, code] of targetCells) {
    const [x, y] = key.split(",").map(Number);
    const inBounds = x >= 0 && y >= 0 && x < width && y < height;
    if (!inBounds || !canPaint(x, y)) {
      stayed++;
      continue;
    }
    if (!sourceCells.has(key) || sourceCells.get(key) !== code) moved++;
    nextGrid[y][x] = code;
    nextCells.set(key, code);
  }

  const sourceFill = fillClearedSourcesWithNeighbors(
    nextGrid,
    clearedKeys,
    new Set(nextCells.keys()),
    size,
  );
  const gaps = fillGridGapsAroundCells(sourceFill.grid, nextCells, size, canPaint);
  return {
    grid: gaps.grid,
    cells: nextCells,
    moved,
    stayed,
    sourceFilled: sourceFill.filled,
    gapFilled: gaps.filled,
  };
}

export function selectionMapsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const [key, code] of a) {
    if (b.get(key) !== code) return false;
  }
  return true;
}
