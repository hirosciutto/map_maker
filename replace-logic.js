export function hasAdjacentBiome(x, y, code, grid, size) {
  for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < size && ny < size && grid[ny][nx] === code) {
      return true;
    }
  }
  return false;
}

export function cellMatchesReplaceRule(x, y, rule, grid, size) {
  if (grid[y][x] !== rule.from) return false;
  if (rule.mode === "always") return true;
  const touching = hasAdjacentBiome(x, y, rule.adjacent, grid, size);
  if (rule.mode === "touching") return touching;
  if (rule.mode === "not_touching") return !touching;
  return false;
}

export function getReplaceTargetsForRule(rule, grid, size, canPaint) {
  const changes = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!cellMatchesReplaceRule(x, y, rule, grid, size)) continue;
      if (!canPaint(x, y, grid)) continue;
      changes.push({ x, y });
    }
  }
  return changes;
}

/** プレビュー・一斉置換で同じ抽出ロジックを使う（現在のグリッドに対する各ルールの union） */
export function collectReplacePreviewCells(rules, grid, size, canPaint) {
  const cells = new Set();
  for (const rule of rules) {
    for (const { x, y } of getReplaceTargetsForRule(rule, grid, size, canPaint)) {
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
