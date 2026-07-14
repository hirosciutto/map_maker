import assert from "node:assert/strict";
import { HABITAT } from "../habitat-data.js";
import { buildCoverage, findDead, repaint } from "../coverage-logic.js";

// 生成データの健全性
assert.equal(HABITAT.species.length, 53, "53種");
assert.equal(Object.keys(HABITAT.roam).length, 62, "62 biome");
assert.equal(HABITAT.zones.length, 30, "30 zone");

const { alive, zok } = buildCoverage(HABITAT.species);
// ゴリラ = JGL(平地ジャングル) × AFW(中央西アフリカ)
assert.ok(alive.has("JGL|AFW"), "JGL×AFW は生存");
assert.ok(!alive.has("JGL|ARC"), "JGL×ARC は種族なし=デッド");
assert.ok(HABITAT.roam["JGL"] > 0, "JGL は roam>0");
assert.ok(zok["JGL"].has("AFW"), "JGL の復活zoneに AFW");

// 3x3: 中央だけ JGL×ARC(デッド)、周囲 JGL×AFW(生存)
const w = 3, h = 3;
const biome = Array.from({ length: h }, () => Array(w).fill("JGL"));
const zone = Array.from({ length: h }, () => Array(w).fill("AFW"));
zone[1][1] = "ARC";

const r = findDead(biome, zone, w, h, HABITAT.roam, alive);
assert.equal(r.checked, 9);
assert.deepEqual(r.dead, [[1, 1]]);
assert.deepEqual(r.byBiome, { JGL: 1 });

const { changes, unfixable } = repaint(biome, zone, w, h, r.dead, zok);
assert.deepEqual(changes, [[1, 1, "AFW"]], "中央を AFW へ塗替");
assert.deepEqual(unfixable, {});

// 修正不能: 種族が存在しない架空 biome(roam>0 とみなす)
const dead2 = [[0, 0]];
const { changes: c2, unfixable: u2 } = repaint([["ZZZ"]], [["AFW"]], 1, 1, dead2, zok);
assert.equal(c2.length, 0);
assert.ok("ZZZ" in u2, "ZZZ は修正不能");

console.log("coverage-logic.test.js OK");
