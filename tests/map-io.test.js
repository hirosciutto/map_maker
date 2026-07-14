import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildCodeMatchers,
  chunkString,
  detectMapGeometry,
  parseRowRawCodes,
  recoverMixedCodeRows,
  sanitizeGridCodes,
} from "../map-io.js";

const LEGACY = { O: "OCN", P: "PLN", D: "DSR" };
const VALID = ["OCN", "PLN", "DSR", "DPO", "FOR", "ICE"];

assert.deepEqual(chunkString("OCNDPO", 3), ["OCN", "DPO"]);
assert.equal(detectMapGeometry(["OCNDPO", "FORICE"]).width, 2);
assert.equal(detectMapGeometry(["OCNDPO", "FOR"]), null);

const matchers = buildCodeMatchers(VALID, Object.keys(LEGACY));
assert.ok(matchers[0].length >= matchers.at(-1).length);
assert.deepEqual(parseRowRawCodes("DPODPOO", matchers), ["DPO", "DPO", "O"]);
assert.equal(parseRowRawCodes("ZZZ", matchers), null);

const recovered = recoverMixedCodeRows(["DPODPOO", "OCNDPOO"], {
  width: 3,
  height: 2,
  validCodes: VALID,
  legacyCodes: Object.keys(LEGACY),
  migrateCode: (code) => LEGACY[code] ?? code,
});
assert.ok(recovered);
assert.equal(recovered.geometry.width, 3);
assert.deepEqual(chunkString(recovered.rows[0], 3), ["DPO", "DPO", "OCN"]);
assert.deepEqual(chunkString(recovered.rows[1], 3), ["OCN", "DPO", "OCN"]);

const sanitized = sanitizeGridCodes(
  [["O", "DPO"], ["PLN", "X"]],
  (code) => LEGACY[code] ?? code,
  (code) => VALID.includes(code),
  "OCN",
);
assert.deepEqual(sanitized, [
  ["OCN", "DPO"],
  ["PLN", "OCN"],
]);

// Real corrupted export from selection-move writing "O"
const samplePath = "/Users/nakashima/Downloads/biome_map_512x256.json";
if (fs.existsSync(samplePath)) {
  const data = JSON.parse(fs.readFileSync(samplePath, "utf8"));
  // Use a large valid set from legend
  const validCodes = Object.keys(data.legend);
  const legacyCodes = ["O", "P", "D", "T", "Y", "V", "A", "R", "F", "1", "C", "H", "J", "G", "M", "K", "L", "E", "3", "4", "X", "Q", "Z", "S", "I", "U", "W", "2", "B", "N"];
  const legacyMap = {
    T: "TWN", P: "PLN", Y: "MDW", V: "SAV", A: "PLT",
    R: "FOR", F: "WDH", 1: "SUB", C: "TGA", H: "CTG",
    J: "JGL", G: "MJG", M: "MTN", K: "VOL", L: "RPL", E: "MSA",
    3: "ALG", 4: "ALT", X: "SNM",
    D: "DSR", Q: "DPL", Z: "HDS",
    S: "SNW", I: "GLC", U: "TND",
    W: "WET", 2: "MOR",
    O: "OCN", B: "BCH", N: "ISL",
  };
  const result = recoverMixedCodeRows(data.rows, {
    width: data.width,
    height: data.height,
    validCodes,
    legacyCodes,
    migrateCode: (code) => legacyMap[code] ?? code,
  });
  assert.ok(result, "should recover real export");
  assert.equal(result.geometry.width, 512);
  assert.equal(result.geometry.height, 256);
  assert.equal(result.rows.length, 256);
  assert.ok(result.rows.every((row) => row.length === 512 * 3));
  const counts = {};
  for (const row of result.rows) {
    for (const code of chunkString(row, 3)) counts[code] = (counts[code] || 0) + 1;
  }
  assert.ok(counts.DPO > 1000, "land/deep ocean data preserved");
  assert.ok((counts.OCN || 0) >= 2663, "legacy O migrated to OCN");
  assert.equal(counts.O, undefined);
}

console.log("map-io: all tests passed");
