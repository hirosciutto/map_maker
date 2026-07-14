import assert from "node:assert/strict";
import {
  ADJACENT_REPLACE_TARGET,
  LAND_SELECTOR,
  adjacentReplacementCandidates,
  cellMatchesReplaceRule,
  cellMatchesSelector,
  chooseAdjacentReplacement,
  collectReplacePreviewCells,
  getReplaceTargetsForRule,
  hasAdjacentBiome,
  cellKeysToCoords,
  makeFamilySelector,
} from "../replace-logic.js";

function gridFromRows(rows) {
  return rows.map((row) => row.split(""));
}

function alwaysPaintable() {
  return true;
}

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

// O=海 B=浜 P=平原
const map = gridFromRows([
  "OOO",
  "OBO",
  "OPO",
]);

test("面判定: 上下左右のみ（斜めは対象外）", () => {
  assert.equal(hasAdjacentBiome(1, 1, "O", map, 3), true);
  const diagonalOnly = gridFromRows([
    "O.P",
    ".B.",
    "P.O",
  ]);
  assert.equal(hasAdjacentBiome(1, 1, "O", diagonalOnly, 3), false);
});

test("面判定: マップ端は範囲外を隣接とみなさない", () => {
  const edge = gridFromRows([
    "BO",
    "PP",
  ]);
  assert.equal(hasAdjacentBiome(0, 0, "O", edge, 2), true);
  assert.equal(hasAdjacentBiome(1, 0, "O", edge, 2), false);
});

test("touching: 海に面した浜のみ一致", () => {
  const rule = { mode: "touching", adjacent: "O", from: "B", to: "P" };
  assert.equal(cellMatchesReplaceRule(1, 1, rule, map, 3), true);
  const isolated = gridFromRows([
    "PPP",
    "PBP",
    "PPP",
  ]);
  assert.equal(cellMatchesReplaceRule(1, 1, rule, isolated, 3), false);
});

test("not_touching: 海に面していない浜のみ一致", () => {
  const rule = { mode: "not_touching", adjacent: "O", from: "B", to: "P" };
  const isolated = gridFromRows([
    "PPP",
    "PBP",
    "PPP",
  ]);
  assert.equal(cellMatchesReplaceRule(1, 1, rule, isolated, 3), true);
  assert.equal(cellMatchesReplaceRule(1, 1, rule, map, 3), false);
});

test("always: 対象バイオームは条件なしで一致", () => {
  const rule = { mode: "always", adjacent: "O", from: "B", to: "P" };
  assert.equal(cellMatchesReplaceRule(1, 1, rule, map, 3), true);
  assert.equal(cellMatchesReplaceRule(0, 0, rule, map, 3), false);
});

test("複数隣接: 1方向でも面していれば touching", () => {
  const rule = { mode: "touching", adjacent: "O", from: "B", to: "P" };
  const oneSide = gridFromRows([
    "PPP",
    "PBO",
    "PPP",
  ]);
  assert.equal(cellMatchesReplaceRule(1, 1, rule, oneSide, 3), true);
});

test("getReplaceTargetsForRule: マスク相当セルを除外", () => {
  const rule = { mode: "touching", adjacent: "O", from: "B", to: "P" };
  const canPaint = (x, y, grid) => grid[y][x] !== "B" || (x !== 1 || y !== 1);
  const targets = getReplaceTargetsForRule(rule, map, 3, canPaint);
  assert.deepEqual(targets, []);
});

test("getReplaceTargetsForRule: 複数マスを抽出", () => {
  const rule = { mode: "always", adjacent: "O", from: "B", to: "P" };
  const twoBeaches = gridFromRows([
    "OBO",
    "BPB",
    "OOO",
  ]);
  const targets = getReplaceTargetsForRule(rule, twoBeaches, 3, alwaysPaintable);
  assert.equal(targets.length, 3);
});

test("プレビュー: 海に面していない浜だけが対象（座標一致）", () => {
  const rule = { mode: "not_touching", adjacent: "O", from: "B", to: "P" };
  const grid = gridFromRows([
    "OOO",
    "OBO",
    "PBP",
  ]);
  const cells = collectReplacePreviewCells([rule], grid, 3, alwaysPaintable);
  assert.deepEqual(cellKeysToCoords(cells), [[1, 2]]);
});

test("プレビュー: 海に面した浜は not_touching に含めない", () => {
  const rule = { mode: "not_touching", adjacent: "O", from: "B", to: "P" };
  const cells = collectReplacePreviewCells([rule], map, 3, alwaysPaintable);
  assert.equal(cells.size, 0);
});

test("プレビュー: 対象バイオーム以外はハイライトしない", () => {
  const rule = { mode: "always", adjacent: "O", from: "B", to: "P" };
  const plainsOnly = gridFromRows([
    "PPP",
    "PPP",
    "PPP",
  ]);
  const cells = collectReplacePreviewCells([rule], plainsOnly, 3, alwaysPaintable);
  assert.equal(cells.size, 0);
});

test("プレビュー: マスク中のセルはハイライトしない", () => {
  const rule = { mode: "always", adjacent: "O", from: "B", to: "P" };
  const grid = gridFromRows([
    "PBP",
    "PPP",
    "PPP",
  ]);
  const canPaint = (x, y, g) => g[y][x] !== "B";
  const cells = collectReplacePreviewCells([rule], grid, 3, canPaint);
  assert.equal(cells.size, 0);
});

test("プレビュー: getReplaceTargetsForRule の union と完全一致", () => {
  const rules = [
    { mode: "touching", adjacent: "O", from: "B", to: "P" },
    { mode: "not_touching", adjacent: "O", from: "B", to: "D" },
  ];
  const grid = gridFromRows([
    "OOO",
    "OBO",
    "PBP",
  ]);
  const fromPreview = collectReplacePreviewCells(rules, grid, 3, alwaysPaintable);
  const fromTargets = new Set();
  for (const rule of rules) {
    for (const { x, y } of getReplaceTargetsForRule(rule, grid, 3, alwaysPaintable)) {
      fromTargets.add(`${x},${y}`);
    }
  }
  assert.deepEqual(cellKeysToCoords(fromPreview), cellKeysToCoords(fromTargets));
  assert.deepEqual(cellKeysToCoords(fromPreview), [[1, 1], [1, 2]]);
});

test("面したバイオーム置換: 対象自身以外の上下左右候補だけを返す", () => {
  const grid = gridFromRows([
    "POF",
    "PBJ",
    "PDP",
  ]);
  assert.deepEqual(adjacentReplacementCandidates(1, 1, grid, 3), ["O", "D", "P", "J"]);
});

test("面したバイオーム置換: 同一バイオームだけに囲まれた対象は置換対象外", () => {
  const rule = { mode: "always", adjacent: "O", from: "B", to: ADJACENT_REPLACE_TARGET };
  const isolated = gridFromRows([
    "PPP",
    "PBP",
    "PPP",
  ]);
  const sameBiome = gridFromRows([
    "BBB",
    "BBB",
    "BBB",
  ]);
  assert.equal(cellMatchesReplaceRule(1, 1, rule, isolated, 3), true);
  assert.equal(cellMatchesReplaceRule(1, 1, rule, sameBiome, 3), false);
  assert.deepEqual(getReplaceTargetsForRule(rule, sameBiome, 3, alwaysPaintable), []);
});

test("面したバイオーム置換: 候補の中からランダムで選ぶ", () => {
  const grid = gridFromRows([
    "BOB",
    "BBB",
    "BDB",
  ]);
  assert.equal(chooseAdjacentReplacement(1, 1, grid, 3, () => 0), "O");
  assert.equal(chooseAdjacentReplacement(1, 1, grid, 3, () => 0.99), "D");
});

test("陸地全て / ファミリー選択子でマッチする", () => {
  const context = {
    familyCodes: new Map([
      ["grass", new Set(["P", "M"])],
      ["ocean_deep", new Set(["O"])],
    ]),
    landCodes: new Set(["P", "M", "B"]),
  };
  assert.equal(cellMatchesSelector("P", LAND_SELECTOR, context), true);
  assert.equal(cellMatchesSelector("O", LAND_SELECTOR, context), false);
  assert.equal(cellMatchesSelector("P", makeFamilySelector("grass"), context), true);
  assert.equal(cellMatchesSelector("B", makeFamilySelector("grass"), context), false);

  const grid = [
    ["O", "O", "O"],
    ["O", "P", "B"],
    ["O", "M", "O"],
  ];
  const landRule = { mode: "always", adjacent: "O", from: LAND_SELECTOR, to: "B" };
  const targets = getReplaceTargetsForRule(landRule, grid, 3, alwaysPaintable, context);
  assert.deepEqual(targets, [
    { x: 1, y: 1 },
    { x: 2, y: 1 },
    { x: 1, y: 2 },
  ]);

  const familyTouch = {
    mode: "touching",
    adjacent: makeFamilySelector("ocean_deep"),
    from: makeFamilySelector("grass"),
    to: "B",
  };
  assert.equal(cellMatchesReplaceRule(1, 1, familyTouch, grid, 3, context), true);
  assert.equal(cellMatchesReplaceRule(2, 1, familyTouch, grid, 3, context), false);
});

console.log("replace-logic: all tests passed");
