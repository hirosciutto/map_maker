export const PEN_BRUSH_SIZES = [1, 4, 12, 21, 32, 45, 96, 169];

function buildSquareMinusCorners(size) {
  const cells = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const isCorner = (x === 0 || x === size - 1) && (y === 0 || y === size - 1);
      if (!isCorner) cells.push([x, y]);
    }
  }
  return cells;
}

export const BRUSH_SHAPES = {
  1: {
    width: 1,
    height: 1,
    anchor: "cell",
    label: "1×1",
    cells: [[0, 0]],
  },
  4: {
    width: 2,
    height: 2,
    anchor: "topleft",
    label: "2×2",
    cells: [[0, 0], [1, 0], [0, 1], [1, 1]],
  },
  12: {
    width: 4,
    height: 4,
    anchor: "center-bbox",
    label: "4×4角削り",
    cells: buildSquareMinusCorners(4),
  },
  21: {
    width: 5,
    height: 5,
    anchor: "center-bbox",
    label: "5×5角削り",
    cells: buildSquareMinusCorners(5),
  },
  32: {
    width: 6,
    height: 6,
    anchor: "center-bbox",
    label: "6×6角削り",
    cells: buildSquareMinusCorners(6),
  },
  45: {
    width: 7,
    height: 7,
    anchor: "center-bbox",
    label: "7×7角削り",
    cells: buildSquareMinusCorners(7),
  },
  96: {
    width: 10,
    height: 10,
    anchor: "center-bbox",
    label: "10×10角削り",
    cells: buildSquareMinusCorners(10),
  },
  169: {
    width: 13,
    height: 13,
    anchor: "center-bbox",
    label: "13×13角削り",
    cells: buildSquareMinusCorners(13),
  },
};

export function normalizeBrushSize(size) {
  if (PEN_BRUSH_SIZES.includes(size)) return size;
  return PEN_BRUSH_SIZES.reduce(
    (best, value) => (Math.abs(value - size) < Math.abs(best - size) ? value : best),
    PEN_BRUSH_SIZES[0],
  );
}

export function getBrushShape(brushSize) {
  return BRUSH_SHAPES[normalizeBrushSize(brushSize)];
}

export function brushOrigin(cx, cy, shape) {
  if (shape.anchor === "topleft") return { x: cx, y: cy };
  if (shape.anchor === "center-bbox") {
    return {
      x: cx - Math.floor(shape.width / 2),
      y: cy - Math.floor(shape.height / 2),
    };
  }
  return { x: cx, y: cy };
}

export function brushPaintCells(cx, cy, brushSize) {
  const shape = getBrushShape(brushSize);
  const origin = brushOrigin(cx, cy, shape);
  return shape.cells.map(([dx, dy]) => ({ x: origin.x + dx, y: origin.y + dy }));
}
