import {
  brushOrigin,
  brushPaintCells,
  getBrushShape,
  normalizeBrushSize,
  PEN_BRUSH_SIZES,
} from "./brush-shapes.js";
import {
  cellMatchesReplaceRule as cellMatchesReplaceRuleAt,
  collectReplacePreviewCells as collectReplacePreviewCellsAt,
  getReplaceTargetsForRule as getReplaceTargetsForRuleAt,
  hasAdjacentBiome as hasAdjacentBiomeAt,
} from "./replace-logic.js";

const BIOMES = [
  { code: "T", name: "town", jp: "セントラルシティ", color: "#cfcfcf" },
  { code: "P", name: "plains", jp: "平原", color: "#7cbc4e" },
  { code: "Y", name: "meadow", jp: "花畑メドウ", color: "#b6e36b" },
  { code: "F", name: "woodland", jp: "山林", color: "#2f7d32" },
  { code: "M", name: "mountain", jp: "山岳", color: "#8d8676" },
  { code: "K", name: "volcano", jp: "火山", color: "#6e3326" },
  { code: "J", name: "jungle", jp: "ジャングル", color: "#1f6b3a" },
  { code: "D", name: "desert", jp: "砂漠", color: "#e3cf86" },
  { code: "V", name: "savanna", jp: "サバンナ", color: "#c9b04e" },
  { code: "S", name: "snowfield", jp: "雪原", color: "#eef3f7" },
  { code: "I", name: "glacier", jp: "氷河", color: "#bfe3ef" },
  { code: "U", name: "tundra", jp: "ツンドラ", color: "#9aa98c" },
  { code: "X", name: "snowy_mtn", jp: "雪の山岳", color: "#cdd6dd" },
  { code: "N", name: "tropic_isle", jp: "南国の島", color: "#57c79a" },
  { code: "R", name: "volcano_isle", jp: "火山島", color: "#7a4a3a" },
  { code: "G", name: "jungle_isle", jp: "ジャングル島", color: "#2a8f55" },
  { code: "O", name: "ocean", jp: "海", color: "#2a5b8c" },
  { code: "B", name: "beach", jp: "浜", color: "#e8d6a0" },
  { code: "C", name: "taiga", jp: "タイガ", color: "#2f6b54" },
  { code: "H", name: "cold_taiga", jp: "寒冷タイガ", color: "#68917e" },
  { code: "W", name: "wetland", jp: "湿地", color: "#5e7d68" },
  { code: "E", name: "mesa", jp: "メサ", color: "#b5653a" },
  { code: "A", name: "plateau", jp: "高原", color: "#88a665" },
  { code: "Q", name: "dry_plateau", jp: "乾燥高原", color: "#b2975c" },
];

const biomeByCode = new Map(BIOMES.map((biome) => [biome.code, biome]));
const biomeByColor = new Map(BIOMES.map((biome) => [biome.color.toLowerCase(), biome]));

const AUTOSAVE_KEY = "blockland-map-maker-autosave";
const AUTOSAVE_VERSION = 1;
const EYEDROPPER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path fill="#fff" stroke="#111" stroke-width="1.2" d="M2 18l2-2 9-9 2 2-9 9H2v-2zm12-11 1.4-1.4a1.4 1.4 0 0 1 2 2L15 9l-2-2z"/></svg>',
)}") 2 18, crosshair`;
const REPLACE_MODES = [
  { value: "touching", label: "面している" },
  { value: "not_touching", label: "面していない" },
  { value: "always", label: "条件なし" },
];
let autosaveTimer = null;

const state = {
  size: 256,
  grid: [],
  selectedCode: "P",
  highlight: new Set(),
  mask: new Set(),
  zoom: 4,
  brushSize: 1,
  tool: "paint",
  isDrawing: false,
  lastCell: null,
  guidePoints: [],
  showGrid: false,
  replaceRules: [],
  replacePreviewActive: false,
  optionKeyHeld: false,
  selection: null,
  selectionDrag: null,
  clipboard: null,
  undoStack: [],
  redoStack: [],
  panStart: null,
  wrapScrollStart: null,
  isPinching: false,
  lastCanvasPoint: null,
};

const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d", { alpha: false });
const guideCanvas = document.getElementById("guideCanvas");
const guideCtx = guideCanvas.getContext("2d");
const wrap = document.getElementById("canvasWrap");
const brushCursor = document.getElementById("brushCursor");

const els = {
  mapInfo: document.getElementById("mapInfo"),
  cursorInfo: document.getElementById("cursorInfo"),
  selectedInfo: document.getElementById("selectedInfo"),
  message: document.getElementById("message"),
  paletteList: document.getElementById("paletteList"),
  toolSelect: document.getElementById("toolSelect"),
  brushSizeField: document.getElementById("brushSizeField"),
  brushSizeLabel: document.getElementById("brushSizeLabel"),
  zoomRange: document.getElementById("zoomRange"),
  zoomLabel: document.getElementById("zoomLabel"),
  noiseRadius: document.getElementById("noiseRadius"),
  noiseRadiusLabel: document.getElementById("noiseRadiusLabel"),
  noiseDensity: document.getElementById("noiseDensity"),
  noiseDensityLabel: document.getElementById("noiseDensityLabel"),
  noiseJitter: document.getElementById("noiseJitter"),
  noiseJitterLabel: document.getElementById("noiseJitterLabel"),
  showGridToggle: document.getElementById("showGridToggle"),
  replaceRulesList: document.getElementById("replaceRulesList"),
  importScale: document.getElementById("importScale"),
};

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

const paletteRgb = BIOMES.map((biome) => ({ ...biome, rgb: hexToRgb(biome.color) }));

function nearestBiome(r, g, b) {
  let best = paletteRgb[0];
  let bestDistance = Infinity;
  for (const biome of paletteRgb) {
    const dr = r - biome.rgb.r;
    const dg = g - biome.rgb.g;
    const db = b - biome.rgb.b;
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = biome;
    }
  }
  return best;
}

function createGrid(size, code = "O") {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => code));
}

function upscaleGrid(grid, sourceSize, factor) {
  const targetSize = sourceSize * factor;
  const next = createGrid(targetSize, "O");
  for (let sy = 0; sy < sourceSize; sy++) {
    for (let sx = 0; sx < sourceSize; sx++) {
      const code = grid[sy][sx];
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          next[sy * factor + dy][sx * factor + dx] = code;
        }
      }
    }
  }
  return next;
}

function downscaleGrid(grid, sourceSize, factor) {
  const targetSize = sourceSize / factor;
  const next = createGrid(targetSize, "O");
  for (let ty = 0; ty < targetSize; ty++) {
    for (let tx = 0; tx < targetSize; tx++) {
      next[ty][tx] = grid[ty * factor][tx * factor];
    }
  }
  return next;
}

function applyImportScale(grid, size, scaleMode) {
  if (scaleMode === "2") {
    if (size !== 256) {
      throw new Error("2倍拡大は 256×256 データのみ対応しています");
    }
    return { grid: upscaleGrid(grid, size, 2), size: 512 };
  }
  if (scaleMode === "half") {
    if (size !== 512) {
      throw new Error("半分に縮小は 512×512 データのみ対応しています");
    }
    return { grid: downscaleGrid(grid, size, 2), size: 256 };
  }
  if (![256, 512].includes(size)) {
    throw new Error("読込後のサイズは 256 または 512 のみです");
  }
  return { grid, size };
}

function biomeSelectOptions(selectedCode = "P") {
  return BIOMES.map(
    (biome) => `<option value="${biome.code}"${biome.code === selectedCode ? " selected" : ""}>${biome.jp}</option>`,
  ).join("");
}

function normalizeReplaceRule(rule) {
  if (!rule || typeof rule !== "object") return null;
  const mode = REPLACE_MODES.some((item) => item.value === rule.mode) ? rule.mode : "touching";
  const from = biomeByCode.has(rule.from) ? rule.from : "B";
  const to = biomeByCode.has(rule.to) ? rule.to : "P";
  const adjacent = biomeByCode.has(rule.adjacent) ? rule.adjacent : "O";
  return { mode, adjacent, from, to };
}

function createReplaceRule() {
  return { mode: "touching", adjacent: "O", from: "B", to: "P" };
}

function setMessage(text) {
  els.message.textContent = text;
}

function serializeAutosave() {
  return {
    version: AUTOSAVE_VERSION,
    size: state.size,
    rows: state.grid.map((row) => row.join("")),
    selectedCode: state.selectedCode,
    highlight: [...state.highlight],
    mask: [...state.mask],
    zoom: state.zoom,
    brushSize: state.brushSize,
    tool: state.tool,
    guidePoints: state.guidePoints,
    showGrid: state.showGrid,
    replaceRules: state.replaceRules,
    noiseRadius: Number(els.noiseRadius.value),
    noiseDensity: Number(els.noiseDensity.value),
    noiseJitter: Number(els.noiseJitter.value),
  };
}

function saveAutosave() {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(serializeAutosave()));
    return true;
  } catch (error) {
    console.warn("autosave failed", error);
    if (error instanceof DOMException && error.name === "QuotaExceededError") {
      setMessage("オートセーブ失敗: 保存容量の上限に達しました");
    }
    return false;
  }
}

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(saveAutosave, 400);
}

function flushAutosave() {
  clearTimeout(autosaveTimer);
  saveAutosave();
}

function loadAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (data.version !== AUTOSAVE_VERSION) return false;

    const rows = data.rows;
    if (!Array.isArray(rows) || rows.length === 0) return false;
    const size = rows.length;
    if (!rows.every((row) => typeof row === "string" && row.length === size)) return false;
    for (const row of rows) {
      for (const code of row) {
        if (!biomeByCode.has(code)) return false;
      }
    }

    state.size = size;
    state.grid = rows.map((row) => row.split(""));
    state.selectedCode = biomeByCode.has(data.selectedCode) ? data.selectedCode : "P";
    state.highlight = new Set(
      Array.isArray(data.highlight) ? data.highlight.filter((code) => biomeByCode.has(code)) : [],
    );
    state.mask = new Set(
      Array.isArray(data.mask) ? data.mask.filter((code) => biomeByCode.has(code)) : [],
    );
    state.zoom = typeof data.zoom === "number" ? Math.min(32, Math.max(1, data.zoom)) : 4;
    state.brushSize = normalizeBrushSize(data.brushSize);
    state.tool = typeof data.tool === "string" ? data.tool : "paint";
    state.guidePoints = Array.isArray(data.guidePoints) ? data.guidePoints : [];
    state.showGrid = Boolean(data.showGrid);
    state.replaceRules = Array.isArray(data.replaceRules)
      ? data.replaceRules.map(normalizeReplaceRule).filter(Boolean)
      : [];
    state.undoStack = [];
    state.redoStack = [];
    state.replacePreviewActive = false;

    els.zoomRange.value = String(state.zoom);
    els.toolSelect.value = state.tool;
    if (typeof data.noiseRadius === "number") els.noiseRadius.value = String(data.noiseRadius);
    if (typeof data.noiseDensity === "number") els.noiseDensity.value = String(data.noiseDensity);
    if (typeof data.noiseJitter === "number") els.noiseJitter.value = String(data.noiseJitter);
    els.showGridToggle.checked = state.showGrid;
    return true;
  } catch {
    return false;
  }
}

function updateInfo() {
  els.mapInfo.textContent = `${state.size}×${state.size}`;
  const selected = biomeByCode.get(state.selectedCode);
  els.selectedInfo.textContent = `選択: ${state.selectedCode} ${selected.jp}`;
  const shape = getBrushShape(state.brushSize);
  els.brushSizeLabel.textContent = `${state.brushSize} (${shape.label})`;
  els.zoomLabel.textContent = `${state.zoom}x`;
  els.noiseRadiusLabel.textContent = els.noiseRadius.value;
  els.noiseDensityLabel.textContent = `${els.noiseDensity.value}%`;
  els.noiseJitterLabel.textContent = els.noiseJitter.value;
}

const CANVAS_INSET = 24;
const pinchZoomActivePointers = new Map();

function touchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

function touchMidpoint(touches) {
  return {
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2,
  };
}

function bindPinchZoom() {
  let pointerPinchStart = null;
  let touchPinchStart = null;
  let gestureStartZoom = null;
  let trackpadPinchZoom = null;
  let trackpadPinchTimer = null;

  function stopPinch() {
    pointerPinchStart = null;
    touchPinchStart = null;
    gestureStartZoom = null;
    state.isPinching = false;
  }

  function beginPinch() {
    state.isPinching = true;
    state.isDrawing = false;
    state.lastCell = null;
  }

  function isOverCanvasArea(clientX, clientY) {
    const rect = wrap.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right
      && clientY >= rect.top && clientY <= rect.bottom;
  }

  function wheelPinchDelta(event) {
    let delta = -event.deltaY;
    if (event.deltaMode === 1) delta *= 16;
    else if (event.deltaMode === 2) delta *= 800;
    return delta;
  }

  function zoomFromPinch(baseZoom, scale, anchorX, anchorY) {
    if (applyZoom(baseZoom * scale, anchorX, anchorY)) render();
  }

  function resetTrackpadPinch() {
    trackpadPinchZoom = null;
    clearTimeout(trackpadPinchTimer);
  }

  function onWheelPinch(event) {
    const isPinch = event.ctrlKey;
    if (!isPinch) {
      resetTrackpadPinch();
      return;
    }
    if (!isOverCanvasArea(event.clientX, event.clientY)) return;

    event.preventDefault();
    event.stopPropagation();

    if (trackpadPinchZoom == null) trackpadPinchZoom = state.zoom;
    trackpadPinchZoom *= Math.exp(wheelPinchDelta(event) * 0.01);
    if (applyZoom(trackpadPinchZoom, event.clientX, event.clientY)) render();

    clearTimeout(trackpadPinchTimer);
    trackpadPinchTimer = setTimeout(resetTrackpadPinch, 180);
  }

  document.addEventListener("wheel", onWheelPinch, { passive: false, capture: true });

  wrap.addEventListener("gesturestart", (event) => {
    event.preventDefault();
    gestureStartZoom = state.zoom;
    beginPinch();
  }, { passive: false });

  wrap.addEventListener("gesturechange", (event) => {
    event.preventDefault();
    if (gestureStartZoom == null) return;
    zoomFromPinch(gestureStartZoom, event.scale, event.clientX, event.clientY);
  }, { passive: false });

  wrap.addEventListener("gestureend", (event) => {
    event.preventDefault();
    stopPinch();
  }, { passive: false });

  wrap.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 2) return;
    event.preventDefault();
    beginPinch();
    touchPinchStart = {
      distance: touchDistance(event.touches),
      zoom: state.zoom,
    };
  }, { passive: false });

  wrap.addEventListener("touchmove", (event) => {
    if (event.touches.length !== 2 || !touchPinchStart) return;
    event.preventDefault();
    const midpoint = touchMidpoint(event.touches);
    const scale = touchDistance(event.touches) / touchPinchStart.distance;
    zoomFromPinch(touchPinchStart.zoom, scale, midpoint.x, midpoint.y);
  }, { passive: false });

  wrap.addEventListener("touchend", (event) => {
    if (event.touches.length >= 2) return;
    if (touchPinchStart) stopPinch();
  });

  wrap.addEventListener("touchcancel", () => {
    if (touchPinchStart) stopPinch();
  });

  function syncPointerPinch() {
    if (pinchZoomActivePointers.size !== 2) {
      pointerPinchStart = null;
      if (!touchPinchStart && gestureStartZoom == null) state.isPinching = false;
      return;
    }
    const [a, b] = [...pinchZoomActivePointers.values()];
    pointerPinchStart = {
      distance: Math.hypot(a.x - b.x, a.y - b.y),
      zoom: state.zoom,
    };
    beginPinch();
  }

  wrap.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "touch") return;
    pinchZoomActivePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinchZoomActivePointers.size === 2) syncPointerPinch();
  }, { capture: true });

  wrap.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") return;
    if (!pinchZoomActivePointers.has(event.pointerId)) return;
    pinchZoomActivePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinchZoomActivePointers.size !== 2 || !pointerPinchStart) return;
    event.preventDefault();
    const [a, b] = [...pinchZoomActivePointers.values()];
    const scale = Math.hypot(a.x - b.x, a.y - b.y) / pointerPinchStart.distance;
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    zoomFromPinch(pointerPinchStart.zoom, scale, midpoint.x, midpoint.y);
  }, { capture: true });

  function releasePointer(event) {
    if (event.pointerType === "touch") return;
    pinchZoomActivePointers.delete(event.pointerId);
    if (pinchZoomActivePointers.size === 2) syncPointerPinch();
    else if (pointerPinchStart) stopPinch();
  }

  wrap.addEventListener("pointerup", releasePointer, { capture: true });
  wrap.addEventListener("pointercancel", (event) => {
    releasePointer(event);
    pinchZoomActivePointers.delete(event.pointerId);
  }, { capture: true });
}

function applyZoom(nextZoom, anchorClientX, anchorClientY) {
  const clamped = Math.min(32, Math.max(1, Math.round(nextZoom)));
  if (clamped === state.zoom) return false;

  const wrapRect = wrap.getBoundingClientRect();
  const oldZoom = state.zoom;
  const viewX = anchorClientX - wrapRect.left + wrap.scrollLeft;
  const viewY = anchorClientY - wrapRect.top + wrap.scrollTop;
  const mapX = (viewX - CANVAS_INSET) / oldZoom;
  const mapY = (viewY - CANVAS_INSET) / oldZoom;

  state.zoom = clamped;
  els.zoomRange.value = String(state.zoom);
  resizeCanvases(false);

  const newViewX = mapX * state.zoom + CANVAS_INSET;
  const newViewY = mapY * state.zoom + CANVAS_INSET;
  wrap.scrollLeft = Math.max(0, newViewX - (anchorClientX - wrapRect.left));
  wrap.scrollTop = Math.max(0, newViewY - (anchorClientY - wrapRect.top));
  updateInfo();
  return true;
}

function resizeCanvases(centerScroll = true) {
  const px = state.size * state.zoom;
  canvas.width = px;
  canvas.height = px;
  canvas.style.width = `${px}px`;
  canvas.style.height = `${px}px`;
  guideCanvas.width = px;
  guideCanvas.height = px;
  guideCanvas.style.width = `${px}px`;
  guideCanvas.style.height = `${px}px`;
  if (centerScroll) {
    wrap.scrollLeft = Math.max(0, (px + CANVAS_INSET * 2 - wrap.clientWidth) / 2);
    wrap.scrollTop = Math.max(0, (px + CANVAS_INSET * 2 - wrap.clientHeight) / 2);
  }
}

function render() {
  const image = ctx.createImageData(state.size, state.size);
  const activeHighlight = state.highlight.size > 0;
  for (let y = 0; y < state.size; y++) {
    for (let x = 0; x < state.size; x++) {
      const code = state.grid[y][x];
      const biome = biomeByCode.get(code) ?? biomeByCode.get("O");
      const rgb = hexToRgb(biome.color);
      const offset = (y * state.size + x) * 4;
      const dim = activeHighlight && !state.highlight.has(code);
      image.data[offset] = dim ? Math.round(rgb.r * 0.32) : rgb.r;
      image.data[offset + 1] = dim ? Math.round(rgb.g * 0.32) : rgb.g;
      image.data[offset + 2] = dim ? Math.round(rgb.b * 0.32) : rgb.b;
      image.data[offset + 3] = 255;
    }
  }
  const offscreen = document.createElement("canvas");
  offscreen.width = state.size;
  offscreen.height = state.size;
  offscreen.getContext("2d").putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(offscreen, 0, 0, canvas.width, canvas.height);
  renderGuide();
  updateInfo();
  scheduleAutosave();
  if (state.lastCanvasPoint) updateBrushCursor(state.lastCanvasPoint);
}

function renderGuide() {
  guideCtx.clearRect(0, 0, guideCanvas.width, guideCanvas.height);
  if (state.showGrid) {
    guideCtx.save();
    guideCtx.strokeStyle = "rgba(255, 255, 255, 0.18)";
    guideCtx.lineWidth = 1;
    const w = state.size * state.zoom;
    const h = state.size * state.zoom;
    const step = state.zoom;
    guideCtx.beginPath();
    for (let x = 0; x <= state.size; x++) {
      const px = x * step + 0.5;
      guideCtx.moveTo(px, 0);
      guideCtx.lineTo(px, h);
    }
    for (let y = 0; y <= state.size; y++) {
      const py = y * step + 0.5;
      guideCtx.moveTo(0, py);
      guideCtx.lineTo(w, py);
    }
    guideCtx.stroke();
    guideCtx.restore();
  }
  renderReplacePreview();
  renderBrushCursor();
  renderSelection();
  if (state.guidePoints.length < 2) return;
  guideCtx.save();
  guideCtx.scale(state.zoom, state.zoom);
  guideCtx.strokeStyle = "rgba(255, 50, 210, 0.9)";
  guideCtx.lineWidth = Math.max(1, 2 / state.zoom);
  guideCtx.lineCap = "round";
  guideCtx.lineJoin = "round";
  guideCtx.beginPath();
  guideCtx.moveTo(state.guidePoints[0].x + 0.5, state.guidePoints[0].y + 0.5);
  for (const point of state.guidePoints.slice(1)) {
    guideCtx.lineTo(point.x + 0.5, point.y + 0.5);
  }
  guideCtx.stroke();
  guideCtx.restore();
}

function getReplaceTargetsForRule(rule) {
  return getReplaceTargetsForRuleAt(rule, state.grid, state.size, (x, y) => canPaint(x, y));
}

function collectReplacePreviewCells() {
  return collectReplacePreviewCellsAt(
    state.replaceRules,
    state.grid,
    state.size,
    (x, y) => canPaint(x, y),
  );
}

function renderReplacePreview() {
  if (!state.replacePreviewActive) return;
  const cells = collectReplacePreviewCells();
  if (!cells.size) return;

  guideCtx.save();
  guideCtx.imageSmoothingEnabled = false;
  const step = state.zoom;
  guideCtx.fillStyle = "rgba(255, 210, 60, 0.5)";
  guideCtx.strokeStyle = "rgba(255, 160, 0, 0.85)";
  guideCtx.lineWidth = 1;
  for (const key of cells) {
    const [x, y] = key.split(",").map(Number);
    const px = x * step;
    const py = y * step;
    guideCtx.fillRect(px, py, step, step);
    if (step > 1) {
      guideCtx.strokeRect(px + 0.5, py + 0.5, step - 1, step - 1);
    }
  }
  guideCtx.restore();
}

function previewReplaceRules() {
  if (!state.replaceRules.length) {
    setMessage("置換ルールがありません");
    return;
  }
  state.replacePreviewActive = true;
  syncCanvasCursor();
  renderGuide();
  const count = collectReplacePreviewCells().size;
  setMessage(count > 0 ? `プレビュー: ${count} マスが置換対象` : "置換対象はありません");
}

function clearReplacePreview() {
  if (!state.replacePreviewActive) return;
  state.replacePreviewActive = false;
  syncCanvasCursor();
  renderGuide();
  setMessage("プレビューを解除しました");
}

function refreshReplacePreviewIfActive() {
  if (!state.replacePreviewActive) return;
  renderGuide();
}

function normalizeSelectionRect(a, b) {
  const x0 = Math.max(0, Math.min(a.x, b.x, state.size - 1));
  const y0 = Math.max(0, Math.min(a.y, b.y, state.size - 1));
  const x1 = Math.max(0, Math.min(Math.max(a.x, b.x), state.size - 1));
  const y1 = Math.max(0, Math.min(Math.max(a.y, b.y), state.size - 1));
  return { x0, y0, x1, y1 };
}

function getActiveSelectionRect() {
  if (state.selectionDrag) {
    return normalizeSelectionRect(state.selectionDrag.start, state.selectionDrag.current);
  }
  return state.selection;
}

function clearSelection() {
  state.selection = null;
  state.selectionDrag = null;
}

function copySelection() {
  const sel = getActiveSelectionRect();
  if (!sel) {
    setMessage("選択範囲がありません");
    return;
  }
  const width = sel.x1 - sel.x0 + 1;
  const height = sel.y1 - sel.y0 + 1;
  const cells = [];
  for (let y = sel.y0; y <= sel.y1; y++) {
    const row = [];
    for (let x = sel.x0; x <= sel.x1; x++) {
      row.push(state.grid[y][x]);
    }
    cells.push(row);
  }
  state.clipboard = { width, height, cells };
  state.selection = sel;
  setMessage(`コピー: ${width}×${height}`);
}

function pasteClipboard() {
  if (!state.clipboard) {
    setMessage("クリップボードが空です");
    return;
  }
  let ox;
  let oy;
  if (state.selection) {
    ox = state.selection.x0;
    oy = state.selection.y0;
  } else if (state.lastCanvasPoint) {
    ox = state.lastCanvasPoint.x;
    oy = state.lastCanvasPoint.y;
  } else {
    ox = 0;
    oy = 0;
  }

  pushUndo();
  const { width, height, cells } = state.clipboard;
  let count = 0;
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      const x = ox + dx;
      const y = oy + dy;
      if (x < 0 || y < 0 || x >= state.size || y >= state.size) continue;
      if (!canPaint(x, y)) continue;
      state.grid[y][x] = cells[dy][dx];
      count++;
    }
  }
  state.selection = normalizeSelectionRect({ x: ox, y: oy }, { x: ox + width - 1, y: oy + height - 1 });
  render();
  setMessage(`ペースト: ${count} マス`);
}

function renderSelection() {
  const sel = getActiveSelectionRect();
  if (!sel) return;

  const step = state.zoom;
  const px = sel.x0 * step;
  const py = sel.y0 * step;
  const pw = (sel.x1 - sel.x0 + 1) * step;
  const ph = (sel.y1 - sel.y0 + 1) * step;

  guideCtx.save();
  guideCtx.imageSmoothingEnabled = false;
  guideCtx.fillStyle = "rgba(100, 180, 255, 0.22)";
  guideCtx.strokeStyle = "rgba(100, 180, 255, 0.95)";
  guideCtx.lineWidth = 1;
  guideCtx.setLineDash([5, 4]);
  guideCtx.fillRect(px, py, pw, ph);
  guideCtx.strokeRect(px + 0.5, py + 0.5, Math.max(0, pw - 1), Math.max(0, ph - 1));
  guideCtx.restore();
}

function pushUndo() {
  state.undoStack.push(state.grid.map((row) => row.join("")).join("\n"));
  if (state.undoStack.length > 80) state.undoStack.shift();
  state.redoStack.length = 0;
}

function restoreSnapshot(snapshot) {
  const rows = snapshot.split("\n");
  state.size = rows.length;
  state.grid = rows.map((row) => row.split(""));
  resizeCanvases();
  render();
}

function undo() {
  if (!state.undoStack.length) return;
  state.redoStack.push(state.grid.map((row) => row.join("")).join("\n"));
  restoreSnapshot(state.undoStack.pop());
}

function redo() {
  if (!state.redoStack.length) return;
  state.undoStack.push(state.grid.map((row) => row.join("")).join("\n"));
  restoreSnapshot(state.redoStack.pop());
}

function canPaint(x, y) {
  return x >= 0 && y >= 0 && x < state.size && y < state.size && !state.mask.has(state.grid[y][x]);
}

function isOptionPickActive(event) {
  return Boolean(event?.altKey || state.optionKeyHeld);
}

function pickBiomeAt(x, y) {
  if (x < 0 || y < 0 || x >= state.size || y >= state.size) return;
  state.selectedCode = state.grid[y][x];
  syncPaletteState();
  render();
}

function syncCanvasCursor() {
  if (state.replacePreviewActive) {
    canvas.style.cursor = "";
    hideBrushCursor();
    return;
  }
  if (state.optionKeyHeld) {
    canvas.style.cursor = EYEDROPPER_CURSOR;
    hideBrushCursor();
    return;
  }
  const isPaint = state.tool === "paint";
  canvas.style.cursor = isPaint && state.brushSize > 1 ? "none" : state.tool === "select" ? "crosshair" : "";
  if (state.lastCanvasPoint) updateBrushCursor(state.lastCanvasPoint);
  else hideBrushCursor();
}

function syncBrushSizeUi() {
  for (const button of els.brushSizeField.querySelectorAll("[data-brush-size]")) {
    button.classList.toggle("active", Number(button.dataset.brushSize) === state.brushSize);
  }
  syncCanvasCursor();
  updateInfo();
  renderGuide();
}

function hideBrushCursor() {
  brushCursor.hidden = true;
}

function updateBrushCursor(point) {
  if (state.replacePreviewActive) {
    hideBrushCursor();
    return;
  }
  if (state.optionKeyHeld || state.tool !== "paint" || state.brushSize === 1) {
    hideBrushCursor();
    return;
  }

  const shape = getBrushShape(state.brushSize);
  if (state.brushSize === 4) {
    const origin = brushOrigin(point.x, point.y, shape);
    const left = CANVAS_INSET + origin.x * state.zoom;
    const top = CANVAS_INSET + origin.y * state.zoom;
    const size = shape.width * state.zoom;
    brushCursor.hidden = false;
    brushCursor.style.width = `${size}px`;
    brushCursor.style.height = `${size}px`;
    brushCursor.style.left = `${left}px`;
    brushCursor.style.top = `${top}px`;
    return;
  }

  hideBrushCursor();
  if (state.tool === "paint" && (state.brushSize === 12 || state.brushSize === 21)) {
    renderGuide();
  }
}

function renderBrushCursor() {
  if (!state.lastCanvasPoint || state.replacePreviewActive || state.optionKeyHeld || state.tool !== "paint") {
    return;
  }
  if (state.brushSize !== 12 && state.brushSize !== 21) return;

  const cells = brushPaintCells(state.lastCanvasPoint.x, state.lastCanvasPoint.y, state.brushSize);
  if (!cells.length) return;

  guideCtx.save();
  guideCtx.imageSmoothingEnabled = false;
  const step = state.zoom;
  guideCtx.fillStyle = "rgba(255, 255, 255, 0.22)";
  guideCtx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  guideCtx.lineWidth = 1;
  for (const { x, y } of cells) {
    const px = x * step;
    const py = y * step;
    guideCtx.fillRect(px, py, step, step);
    if (step > 1) {
      guideCtx.strokeRect(px + 0.5, py + 0.5, step - 1, step - 1);
    }
  }
  guideCtx.restore();
}

function paintCell(cx, cy, code = state.selectedCode) {
  for (const { x, y } of brushPaintCells(cx, cy, state.brushSize)) {
    if (canPaint(x, y)) state.grid[y][x] = code;
  }
}

function linePaint(a, b, code = state.selectedCode) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(a.x + (dx * i) / steps);
    const y = Math.round(a.y + (dy * i) / steps);
    paintCell(x, y, code);
  }
}

function floodFill(x, y) {
  if (!canPaint(x, y)) return;
  const from = state.grid[y][x];
  const to = state.selectedCode;
  if (from === to) return;
  pushUndo();
  const queue = [{ x, y }];
  const seen = new Set();
  while (queue.length) {
    const point = queue.pop();
    const key = `${point.x},${point.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (point.x < 0 || point.y < 0 || point.x >= state.size || point.y >= state.size) continue;
    if (state.grid[point.y][point.x] !== from || state.mask.has(from)) continue;
    state.grid[point.y][point.x] = to;
    queue.push({ x: point.x + 1, y: point.y });
    queue.push({ x: point.x - 1, y: point.y });
    queue.push({ x: point.x, y: point.y + 1 });
    queue.push({ x: point.x, y: point.y - 1 });
  }
  render();
}

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((event.clientX - rect.left) / state.zoom);
  const y = Math.floor((event.clientY - rect.top) / state.zoom);
  return { x, y };
}

function buildPalette() {
  els.paletteList.innerHTML = "";
  for (const biome of BIOMES) {
    const row = document.createElement("div");
    row.className = "palette-row";
    row.dataset.code = biome.code;
    row.innerHTML = `
      <input class="highlight-toggle" type="checkbox" title="ハイライト">
      <input class="mask-toggle" type="checkbox" title="マスク">
      <span class="swatch" style="background:${biome.color}"></span>
      <span class="biome-name">
        <strong>${biome.jp}</strong>
        <span class="biome-meta">${biome.code}</span>
      </span>
    `;
    row.addEventListener("click", (event) => {
      if (event.target.matches("input")) return;
      state.selectedCode = biome.code;
      syncPaletteState();
      render();
    });
    row.querySelector(".highlight-toggle").addEventListener("change", (event) => {
      if (event.target.checked) state.highlight.add(biome.code);
      else state.highlight.delete(biome.code);
      render();
    });
    row.querySelector(".mask-toggle").addEventListener("change", (event) => {
      if (event.target.checked) state.mask.add(biome.code);
      else state.mask.delete(biome.code);
      syncPaletteState();
      scheduleAutosave();
    });
    els.paletteList.appendChild(row);
  }
  syncPaletteState();
}

function syncPaletteState() {
  for (const row of els.paletteList.querySelectorAll(".palette-row")) {
    const code = row.dataset.code;
    row.classList.toggle("selected", code === state.selectedCode);
    row.classList.toggle("masked", state.mask.has(code));
    row.querySelector(".highlight-toggle").checked = state.highlight.has(code);
    row.querySelector(".mask-toggle").checked = state.mask.has(code);
  }
}

function renderReplaceRules() {
  els.replaceRulesList.innerHTML = "";
  if (!state.replaceRules.length) {
    const empty = document.createElement("p");
    empty.className = "hint replace-rules-empty";
    empty.textContent = "ルールがありません。「ルール追加」で作成してください。";
    els.replaceRulesList.appendChild(empty);
    return;
  }

  state.replaceRules.forEach((rule, index) => {
    const card = document.createElement("div");
    card.className = "replace-rule";
    card.innerHTML = `
      <div class="replace-rule-head">
        <strong>ルール ${index + 1}</strong>
        <button class="replace-rule-remove" type="button" title="削除">×</button>
      </div>
      <div class="field">
        <label>条件</label>
        <select class="replace-mode">
          ${REPLACE_MODES.map(
            (item) => `<option value="${item.value}"${item.value === rule.mode ? " selected" : ""}>${item.label}</option>`,
          ).join("")}
        </select>
      </div>
      <div class="field replace-adjacent-field"${rule.mode === "always" ? " hidden" : ""}>
        <label>条件バイオーム（〇〇）</label>
        <select class="replace-adjacent">${biomeSelectOptions(rule.adjacent)}</select>
      </div>
      <div class="field">
        <label>対象（◇◇）</label>
        <select class="replace-from">${biomeSelectOptions(rule.from)}</select>
      </div>
      <div class="field">
        <label>置換先（△△）</label>
        <select class="replace-to">${biomeSelectOptions(rule.to)}</select>
      </div>
      <p class="hint replace-rule-summary"></p>
    `;

    const modeSelect = card.querySelector(".replace-mode");
    const adjacentField = card.querySelector(".replace-adjacent-field");
    const adjacentSelect = card.querySelector(".replace-adjacent");
    const fromSelect = card.querySelector(".replace-from");
    const toSelect = card.querySelector(".replace-to");
    const summary = card.querySelector(".replace-rule-summary");

    function syncRuleFromUi() {
      rule.mode = modeSelect.value;
      rule.adjacent = adjacentSelect.value;
      rule.from = fromSelect.value;
      rule.to = toSelect.value;
      adjacentField.hidden = rule.mode === "always";
      summary.textContent = describeReplaceRule(rule);
      scheduleAutosave();
      refreshReplacePreviewIfActive();
    }

    modeSelect.addEventListener("change", syncRuleFromUi);
    adjacentSelect.addEventListener("change", syncRuleFromUi);
    fromSelect.addEventListener("change", syncRuleFromUi);
    toSelect.addEventListener("change", syncRuleFromUi);
    card.querySelector(".replace-rule-remove").addEventListener("click", () => {
      state.replaceRules.splice(index, 1);
      renderReplaceRules();
      scheduleAutosave();
      refreshReplacePreviewIfActive();
    });

    adjacentField.hidden = rule.mode === "always";
    summary.textContent = describeReplaceRule(rule);
    els.replaceRulesList.appendChild(card);
  });
}

function describeReplaceRule(rule) {
  const from = biomeByCode.get(rule.from);
  const to = biomeByCode.get(rule.to);
  const adjacent = biomeByCode.get(rule.adjacent);
  if (rule.mode === "always") {
    return `${from.jp} を ${to.jp} に置換`;
  }
  if (rule.mode === "touching") {
    return `${adjacent.jp} に面した ${from.jp} を ${to.jp} に置換`;
  }
  return `${adjacent.jp} に面していない ${from.jp} を ${to.jp} に置換`;
}

function hasAdjacentBiome(x, y, code, grid) {
  return hasAdjacentBiomeAt(x, y, code, grid, state.size);
}

function cellMatchesReplaceRule(x, y, rule, grid) {
  return cellMatchesReplaceRuleAt(x, y, rule, grid, state.size);
}

function applyReplaceRules() {
  if (!state.replaceRules.length) {
    setMessage("置換ルールがありません");
    return;
  }

  pushUndo();
  let total = 0;
  for (const rule of state.replaceRules) {
    for (const { x, y } of getReplaceTargetsForRule(rule)) {
      if (!canPaint(x, y)) continue;
      state.grid[y][x] = rule.to;
      total++;
    }
  }

  state.replacePreviewActive = false;
  render();
  setMessage(total > 0 ? `置換完了: ${total} マス` : "置換対象はありませんでした");
}

function newMap(size) {
  pushUndo();
  state.size = size;
  state.grid = createGrid(size, "O");
  state.guidePoints = [];
  clearSelection();
  resizeCanvases();
  render();
  setMessage(`${size}×${size} を作成`);
}

function importJson(text, scaleMode = els.importScale.value) {
  const data = JSON.parse(text);
  const rows = data.rows;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("rows がありません");
  const sourceSize = rows.length;
  if (!rows.every((row) => typeof row === "string" && row.length === sourceSize)) {
    throw new Error("rows は正方形の文字列配列である必要があります");
  }
  for (const row of rows) {
    for (const code of row) {
      if (!biomeByCode.has(code)) throw new Error(`未知のバイオームコード: ${code}`);
    }
  }
  const { grid, size } = applyImportScale(rows.map((row) => row.split("")), sourceSize, scaleMode);
  pushUndo();
  state.size = size;
  state.grid = grid;
  state.guidePoints = [];
  clearSelection();
  resizeCanvases();
  render();
  const scaleLabel = scaleMode === "2" ? "・2倍拡大" : scaleMode === "half" ? "・半分" : "";
  setMessage(`JSON読込: ${sourceSize}×${sourceSize} → ${size}×${size}${scaleLabel}`);
}

function importImage(file, scaleMode = els.importScale.value) {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => {
    try {
      if (image.width !== image.height) {
        throw new Error("画像は正方形である必要があります");
      }
      const sourceSize = image.width;
      if (scaleMode === "2" && sourceSize !== 256) {
        throw new Error("2倍拡大は 256×256 画像のみ対応しています");
      }
      if (scaleMode === "half" && sourceSize !== 512) {
        throw new Error("半分に縮小は 512×512 画像のみ対応しています");
      }
      if (scaleMode === "1" && ![256, 512].includes(sourceSize)) {
        throw new Error("画像サイズは 256 または 512 である必要があります");
      }

      const off = document.createElement("canvas");
      off.width = sourceSize;
      off.height = sourceSize;
      const offCtx = off.getContext("2d");
      offCtx.imageSmoothingEnabled = false;
      offCtx.drawImage(image, 0, 0, sourceSize, sourceSize);
      const data = offCtx.getImageData(0, 0, sourceSize, sourceSize).data;
      const source = createGrid(sourceSize);
      for (let y = 0; y < sourceSize; y++) {
        for (let x = 0; x < sourceSize; x++) {
          const offset = (y * sourceSize + x) * 4;
          const biome = nearestBiome(data[offset], data[offset + 1], data[offset + 2]);
          source[y][x] = biome.code;
        }
      }
      const { grid, size } = applyImportScale(source, sourceSize, scaleMode);
      pushUndo();
      state.size = size;
      state.grid = grid;
      state.guidePoints = [];
      clearSelection();
      resizeCanvases();
      render();
      const scaleLabel = scaleMode === "2" ? "・2倍拡大" : scaleMode === "half" ? "・半分" : "";
      setMessage(`画像読込: ${sourceSize}×${sourceSize} → ${size}×${size}${scaleLabel}`);
    } catch (error) {
      setMessage(error.message || "画像読込に失敗しました");
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  image.src = url;
}

async function loadCurrentBiomeMap() {
  const candidates = [
    "../blockland/map/biome_map.json",
    "/Users/nakashima/works/blockland/map/biome_map.json",
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      importJson(await res.text());
      return;
    } catch {
      // try next
    }
  }
  setMessage("自動読込に失敗。ファイル選択で biome_map.json を読み込んでください。");
}

function exportPng() {
  const out = document.createElement("canvas");
  out.width = state.size;
  out.height = state.size;
  const outCtx = out.getContext("2d");
  const image = outCtx.createImageData(state.size, state.size);
  for (let y = 0; y < state.size; y++) {
    for (let x = 0; x < state.size; x++) {
      const rgb = hexToRgb(biomeByCode.get(state.grid[y][x]).color);
      const offset = (y * state.size + x) * 4;
      image.data[offset] = rgb.r;
      image.data[offset + 1] = rgb.g;
      image.data[offset + 2] = rgb.b;
      image.data[offset + 3] = 255;
    }
  }
  outCtx.putImageData(image, 0, 0);
  downloadUrl(out.toDataURL("image/png"), `biome_map_${state.size}.png`);
}

function exportJson() {
  const legend = {};
  for (const biome of BIOMES) {
    legend[biome.code] = { name: biome.name, jp: biome.jp, color: biome.color };
  }
  const data = {
    size: state.size,
    seed: null,
    scheme: "map-maker-v1",
    layer: "public",
    source: "Blockland Map Maker",
    px_means: "1px = 1 region",
    region_blocks: 64,
    world_blocks: state.size * 64,
    legend,
    rows: state.grid.map((row) => row.join("")),
    structures: [],
  };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  downloadUrl(URL.createObjectURL(blob), `biome_map_${state.size}.json`, true);
}

function downloadUrl(url, filename, revoke = false) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (revoke) URL.revokeObjectURL(url);
}

function applyNoise() {
  if (!state.guidePoints.length) {
    setMessage("ノイズガイドがありません");
    return;
  }
  pushUndo();
  const radius = Number(els.noiseRadius.value);
  const density = Number(els.noiseDensity.value) / 100;
  const jitter = Number(els.noiseJitter.value);
  const code = state.selectedCode;
  for (const point of state.guidePoints) {
    const repeats = Math.max(1, Math.round(radius * density * 2));
    for (let i = 0; i < repeats; i++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.random() * radius;
      const jx = Math.round((Math.random() - 0.5) * jitter);
      const jy = Math.round((Math.random() - 0.5) * jitter);
      const cx = Math.round(point.x + Math.cos(angle) * distance + jx);
      const cy = Math.round(point.y + Math.sin(angle) * distance + jy);
      const oldBrush = state.brushSize;
      state.brushSize = Math.max(1, Math.round(Math.random() * radius));
      paintCell(cx, cy, code);
      state.brushSize = oldBrush;
    }
  }
  render();
  setMessage(`ノイズ適用: ${biomeByCode.get(code).jp}`);
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(`${tab.dataset.tab}Tab`).classList.add("active");
    });
  });

  document.querySelectorAll("[data-new-size]").forEach((button) => {
    button.addEventListener("click", () => newMap(Number(button.dataset.newSize)));
  });
  document.getElementById("importInput").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.name.toLowerCase().endsWith(".json") || file.type.includes("json")) {
        importJson(await file.text());
      } else {
        importImage(file);
      }
    } catch (error) {
      setMessage(error.message || "読込に失敗しました");
    }
    event.target.value = "";
  });
  document.getElementById("loadCurrentBtn").addEventListener("click", loadCurrentBiomeMap);
  document.getElementById("exportPngBtn").addEventListener("click", exportPng);
  document.getElementById("exportJsonBtn").addEventListener("click", exportJson);
  document.getElementById("undoBtn").addEventListener("click", undo);
  document.getElementById("redoBtn").addEventListener("click", redo);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Alt") {
      state.optionKeyHeld = true;
      syncCanvasCursor();
    }
    if (event.key === "Escape") {
      if (state.selection || state.selectionDrag) {
        clearSelection();
        renderGuide();
        setMessage("選択を解除しました");
      }
      return;
    }
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const target = event.target;
    if (
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable) ||
      (target instanceof HTMLInputElement && !["range", "file", "button", "checkbox", "radio"].includes(target.type))
    ) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "c") {
      event.preventDefault();
      copySelection();
      return;
    }
    if (key === "v") {
      event.preventDefault();
      pasteClipboard();
      return;
    }
    if (key === "z" && event.shiftKey) {
      event.preventDefault();
      redo();
    } else if (key === "z") {
      event.preventDefault();
      undo();
    }
  });
  document.addEventListener("keyup", (event) => {
    if (event.key === "Alt") {
      state.optionKeyHeld = false;
      syncCanvasCursor();
    }
  });
  window.addEventListener("blur", () => {
    state.optionKeyHeld = false;
    syncCanvasCursor();
  });
  document.getElementById("fitBtn").addEventListener("click", () => {
    const zoom = Math.max(1, Math.floor(Math.min((wrap.clientWidth - 48) / state.size, (wrap.clientHeight - 48) / state.size)));
    state.zoom = Math.min(32, zoom);
    els.zoomRange.value = String(state.zoom);
    resizeCanvases();
    render();
  });
  document.getElementById("clearHighlightBtn").addEventListener("click", () => {
    state.highlight.clear();
    syncPaletteState();
    render();
  });
  document.getElementById("clearMaskBtn").addEventListener("click", () => {
    state.mask.clear();
    syncPaletteState();
    scheduleAutosave();
  });
  document.getElementById("maskAllBtn").addEventListener("click", () => {
    for (const biome of BIOMES) state.mask.add(biome.code);
    syncPaletteState();
    scheduleAutosave();
  });
  document.getElementById("applyNoiseBtn").addEventListener("click", applyNoise);
  document.getElementById("clearGuideBtn").addEventListener("click", () => {
    state.guidePoints = [];
    renderGuide();
    scheduleAutosave();
  });
  document.getElementById("addReplaceRuleBtn").addEventListener("click", () => {
    state.replaceRules.push(createReplaceRule());
    renderReplaceRules();
    scheduleAutosave();
    refreshReplacePreviewIfActive();
  });
  document.getElementById("previewReplaceRulesBtn").addEventListener("click", previewReplaceRules);
  document.getElementById("clearReplacePreviewBtn").addEventListener("click", clearReplacePreview);
  document.getElementById("runReplaceRulesBtn").addEventListener("click", applyReplaceRules);

  els.toolSelect.addEventListener("change", () => {
    state.tool = els.toolSelect.value;
    syncBrushSizeUi();
    scheduleAutosave();
  });
  els.brushSizeField.querySelectorAll("[data-brush-size]").forEach((button) => {
    button.addEventListener("click", () => {
      state.brushSize = Number(button.dataset.brushSize);
      syncBrushSizeUi();
      scheduleAutosave();
    });
  });
  els.zoomRange.addEventListener("input", () => {
    const wrapRect = wrap.getBoundingClientRect();
    applyZoom(Number(els.zoomRange.value), wrapRect.left + wrap.clientWidth / 2, wrapRect.top + wrap.clientHeight / 2);
    render();
  });
  els.showGridToggle.addEventListener("change", () => {
    state.showGrid = els.showGridToggle.checked;
    renderGuide();
    scheduleAutosave();
  });
  [els.noiseRadius, els.noiseDensity, els.noiseJitter].forEach((input) => {
    input.addEventListener("input", () => {
      updateInfo();
      scheduleAutosave();
    });
  });

  window.addEventListener("beforeunload", flushAutosave);

  bindPinchZoom();

  canvas.addEventListener("pointerdown", (event) => {
    if (state.isPinching || pinchZoomActivePointers.size > 1) return;
    const point = canvasPoint(event);
    if (isOptionPickActive(event)) {
      pickBiomeAt(point.x, point.y);
      return;
    }
    state.isDrawing = true;
    state.lastCell = point;
    canvas.setPointerCapture(event.pointerId);
    if (state.tool === "pan") {
      state.panStart = { x: event.clientX, y: event.clientY };
      state.wrapScrollStart = { x: wrap.scrollLeft, y: wrap.scrollTop };
      return;
    }
    if (state.tool === "picker") {
      if (point.x >= 0 && point.y >= 0 && point.x < state.size && point.y < state.size) {
        state.selectedCode = state.grid[point.y][point.x];
        syncPaletteState();
        render();
      }
      return;
    }
    if (state.tool === "fill") {
      floodFill(point.x, point.y);
      return;
    }
    if (state.tool === "guide") {
      state.guidePoints.push(point);
      renderGuide();
      return;
    }
    if (state.tool === "select") {
      state.selectionDrag = { start: point, current: point };
      state.selection = null;
      renderGuide();
      return;
    }
    pushUndo();
    paintCell(point.x, point.y);
    render();
  });

  canvas.addEventListener("pointermove", (event) => {
    const point = canvasPoint(event);
    state.lastCanvasPoint = point;
    els.cursorInfo.textContent = `x:${point.x} y:${point.y}`;
    syncCanvasCursor();
    if (state.isPinching) return;
    if (!state.isDrawing || isOptionPickActive(event)) return;
    if (state.tool === "pan") {
      wrap.scrollLeft = state.wrapScrollStart.x - (event.clientX - state.panStart.x);
      wrap.scrollTop = state.wrapScrollStart.y - (event.clientY - state.panStart.y);
      return;
    }
    if (state.tool === "guide") {
      state.guidePoints.push(point);
      renderGuide();
      return;
    }
    if (state.tool === "select" && state.selectionDrag) {
      state.selectionDrag.current = point;
      renderGuide();
      return;
    }
    if (state.tool !== "paint") return;
    linePaint(state.lastCell, point);
    state.lastCell = point;
    render();
  });

  canvas.addEventListener("pointerup", () => {
    if (state.selectionDrag) {
      state.selection = normalizeSelectionRect(state.selectionDrag.start, state.selectionDrag.current);
      state.selectionDrag = null;
      state.isDrawing = false;
      state.lastCell = null;
      renderGuide();
      return;
    }
    const wasDrawing = state.isDrawing;
    state.isDrawing = false;
    state.lastCell = null;
    if (wasDrawing) flushAutosave();
  });
  canvas.addEventListener("pointerenter", () => {
    if (state.optionKeyHeld) syncCanvasCursor();
  });
  canvas.addEventListener("pointerleave", () => {
    const wasDrawing = state.isDrawing;
    state.isDrawing = false;
    state.lastCell = null;
    state.lastCanvasPoint = null;
    hideBrushCursor();
    if (wasDrawing) flushAutosave();
  });
}

function init() {
  buildPalette();
  bindEvents();
  const restored = loadAutosave();
  if (!restored) {
    state.grid = createGrid(state.size, "O");
  }
  renderReplaceRules();
  syncPaletteState();
  syncBrushSizeUi();
  resizeCanvases();
  render();
  setMessage(restored ? "前回の作業を復元しました" : "準備完了");
}

init();
