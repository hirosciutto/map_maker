export const ADJACENT_REPLACE_TARGET = "__adjacent__";
export const LAND_SELECTOR = "__land__";
export const FAMILY_PREFIX = "family:";

const NEIGHBOR_OFFSETS = [[0, -1], [0, 1], [-1, 0], [1, 0]];

/** @param {number | { width: number, height: number }} size */
export function resolveDims(size) {
  if (typeof size === "number") return { width: size, height: size };
  return { width: size.width, height: size.height };
}

export function isFamilySelector(value) {
  return typeof value === "string" && value.startsWith(FAMILY_PREFIX);
}

export function familyKeyFromSelector(value) {
  return isFamilySelector(value) ? value.slice(FAMILY_PREFIX.length) : null;
}

export function makeFamilySelector(familyKey) {
  return `${FAMILY_PREFIX}${familyKey}`;
}

/**
 * @param {string} cellCode
 * @param {string} selector
 * @param {{ familyCodes?: Map<string, Set<string>>, landCodes?: Set<string> } | null} context
 */
export function cellMatchesSelector(cellCode, selector, context = null) {
  if (!selector) return false;
  if (!context) return cellCode === selector;
  if (selector === LAND_SELECTOR) return Boolean(context.landCodes?.has(cellCode));
  if (isFamilySelector(selector)) {
    const family = familyKeyFromSelector(selector);
    return Boolean(context.familyCodes?.get(family)?.has(cellCode));
  }
  return cellCode === selector;
}

export function hasAdjacentBiome(x, y, code, grid, size) {
  const { width, height } = resolveDims(size);
  for (const [dx, dy] of NEIGHBOR_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < width && ny < height && grid[ny][nx] === code) {
      return true;
    }
  }
  return false;
}

export function hasAdjacentMatching(x, y, matches, grid, size) {
  const { width, height } = resolveDims(size);
  for (const [dx, dy] of NEIGHBOR_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < width && ny < height && matches(grid[ny][nx])) {
      return true;
    }
  }
  return false;
}

export function adjacentReplacementCandidates(x, y, grid, size) {
  const { width, height } = resolveDims(size);
  const current = grid[y][x];
  const candidates = [];
  const seen = new Set();
  for (const [dx, dy] of NEIGHBOR_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
    const code = grid[ny][nx];
    if (code === current || seen.has(code)) continue;
    seen.add(code);
    candidates.push(code);
  }
  return candidates;
}

export function chooseAdjacentReplacement(x, y, grid, size, random = Math.random) {
  const candidates = adjacentReplacementCandidates(x, y, grid, size);
  if (!candidates.length) return null;
  return candidates[Math.floor(random() * candidates.length)];
}

export function cellMatchesReplaceRule(x, y, rule, grid, size, context = null) {
  const cell = grid[y][x];
  if (!cellMatchesSelector(cell, rule.from, context)) return false;
  if (rule.to === ADJACENT_REPLACE_TARGET && adjacentReplacementCandidates(x, y, grid, size).length === 0) {
    return false;
  }
  if (rule.mode === "always") return true;
  const touching = context
    ? hasAdjacentMatching(
        x,
        y,
        (code) => cellMatchesSelector(code, rule.adjacent, context),
        grid,
        size,
      )
    : hasAdjacentBiome(x, y, rule.adjacent, grid, size);
  if (rule.mode === "touching") return touching;
  if (rule.mode === "not_touching") return !touching;
  return false;
}

export function getReplaceTargetsForRule(rule, grid, size, canPaint, context = null) {
  const { width, height } = resolveDims(size);
  const changes = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!cellMatchesReplaceRule(x, y, rule, grid, size, context)) continue;
      if (!canPaint(x, y, grid)) continue;
      changes.push({ x, y });
    }
  }
  return changes;
}

/** プレビュー・一斉置換で同じ抽出ロジックを使う（現在のグリッドに対する各ルールの union） */
export function collectReplacePreviewCells(rules, grid, size, canPaint, context = null) {
  const cells = new Set();
  for (const rule of rules) {
    for (const { x, y } of getReplaceTargetsForRule(rule, grid, size, canPaint, context)) {
      cells.add(`${x},${y}`);
    }
  }
  return cells;
}

export function cellKeysToCoords(keys) {
  return [...keys]
    .map((key) => key.split(",").map(Number))
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}
